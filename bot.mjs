import { pathToFileURL } from 'node:url';
import { chargeButton, readChargeButton, personalPaymentLink, createPaymentServer } from './payments.mjs';
import { readPayment } from './payments.mjs';
import { amountMinor } from './payment-store.mjs';
import { connectMongoStore } from './mongo-store.mjs';
import { handleJoinRequest, handleSubscriptionSetup } from './subscriptions.mjs';

function formatAmount(amount) {
  const [whole, fraction] = amount.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}

function log(event, details = {}) {
  console.log(`${new Date().toISOString()} ${event} ${JSON.stringify(details)}`);
}

export function isBotMentioned(message, username) {
  if (!username) return false;
  const text = message.text || message.caption || '';
  const entities = message.text ? message.entities : message.caption_entities;
  const tag = `@${username}`.toLowerCase();
  return (entities || []).some(entity => {
    const value = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    return (entity.type === 'mention' && value === tag)
      || (entity.type === 'bot_command' && value.endsWith(tag));
  });
}

export async function handleMessage(message, api, logger = log, botUsername, secret = process.env.TELEGRAM_BOT_TOKEN, baseUrl = process.env.PAYMENT_BASE_URL || 'http://127.0.0.1:3000', store) {
  const context = { chatId: message?.chat?.id, chatType: message?.chat?.type,
    userId: message?.from?.id, messageId: message?.message_id };
  logger('Message received', context);
  const ignore = reason => logger('Message ignored', { ...context, reason });
  if (!['group', 'supergroup'].includes(message?.chat?.type)) return ignore('Not a group');
  // Channel identities and anonymous admins cannot be verified as individual users.
  if (message.sender_chat) return ignore('Anonymous admin or channel sender');
  if (!message.from || message.from.is_bot) return ignore('Missing user or bot sender');
  if (!message.text && !message.caption) return ignore('No text or caption');
  const text = message.text || message.caption || '';
  const parts = text.trim().split(/\s+/);
  const command = /^\/(charge|sub)(?:@([a-z0-9_]+))?$/i.exec(parts[0]);
  if (command?.[2] && command[2].toLowerCase() !== botUsername?.toLowerCase()) return ignore('Command addressed to another bot');
  if (!command && !isBotMentioned(message, botUsername)) return ignore('Bot was not tagged');

  const member = await api('getChatMember', { chat_id: message.chat.id, user_id: message.from.id });
  if (!['administrator', 'creator'].includes(member?.status)) return ignore('Sender is not a group admin');
  logger('Group admin verified', context);

  let reply = { text: 'Yes' };
  let orderId;
  if (command) {
    const rawAmount = parts[1] || '';
    const isSub = command[1].toLowerCase() === 'sub';
    const rawDays = parts[2] ?? '30';
    const days = Number(rawDays);
    const validDays = /^\d{1,4}$/.test(rawDays) && days >= 1 && days <= 3650;
    const validAmount = /^\d{1,9}$/.test(rawAmount) && amountMinor(rawAmount) >= 100000 && amountMinor(rawAmount) <= 1000000000;
    if (isSub && !await store?.getSubscriptionConfig?.(message.chat.id)) {
      reply = { text: 'Subscriptions are not configured for this group. Run /subconfig first, then use /sub amount days.' };
    } else if (!validAmount || (isSub ? !validDays || ![2, 3].includes(parts.length) : parts.length !== 2)) {
      reply = { text: isSub
        ? 'Usage: /sub amount [days]\nExample: /sub 5000 60\nEnter a whole-number amount from 1,000 to 10,000,000 MMK. No decimals.\nDays: 1 to 3650. Defaults to 30 when omitted.'
        : 'Usage: /charge amount\nExample: /charge 1000\nEnter a whole-number amount from 1,000 to 10,000,000 MMK. No decimals.' };
    } else {
      const [whole, fraction] = rawAmount.split('.');
      const amount = `${Number(whole)}${fraction === undefined ? '' : `.${fraction.padEnd(2, '0')}`}`;
      const displayAmount = formatAmount(amount);
      if (command[1].toLowerCase() === 'sub') {
        reply = {
          parse_mode: 'HTML',
          text: `<b>Payment request</b>\n\nAmount: <b>${displayAmount} MMK</b>\nDuration: <b>${days} days</b>\n\nTap below to generate your personal payment link.`,
          reply_markup: { inline_keyboard: [[{
            text: 'Generate a payment link', callback_data: chargeButton(amount, message.chat.id, secret, days),
          }]] },
        };
      } else {
      let paymentUrl;
      for (let attempt = 0; attempt < 10; attempt++) {
        paymentUrl = personalPaymentLink(baseUrl, { amount }, secret);
        const payment = readPayment(new URL(paymentUrl).hash.slice(1), secret);
        if (await store?.get(payment.orderId)) continue;
        await store?.register(payment, message);
        orderId = payment.orderId;
        break;
      }
      if (!orderId) throw new Error('Could not allocate an order ID. Try again.');
      reply = {
        parse_mode: 'HTML',
        text: [
          '<b>Payment request</b>',
          '',
          `Amount: <b>${displayAmount} MMK</b>`,
          '',
          'Tap <b>Pay now</b> to view your order and continue.',
        ].join('\n'),
        reply_markup: { inline_keyboard: [[{
          text: 'Pay now', url: paymentUrl,
        }]] },
      };
      }
    }
  }
  logger(command ? 'Sending charge preview' : 'Sending Yes reply', context);
  const sent = await api('sendMessage', {
    chat_id: message.chat.id,
    ...reply,
    reply_parameters: { message_id: message.message_id },
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
  });
  if (orderId && store && sent?.message_id) await store.saveMessage(orderId, sent.message_id);
  logger('Reply sent', context);
}

export async function handleCallback(query, api, secret, baseUrl, logger = log, store) {
  if (!query.data?.startsWith('charge:')) return;
  const message = query.message;
  if (!['group', 'supergroup'].includes(message?.chat?.type) || !query.from || query.from.is_bot) return;
  let request;
  try { request = readChargeButton(query.data, message.chat.id, secret); }
  catch {
    await api('answerCallbackQuery', { callback_query_id: query.id, text: 'This payment button is invalid.', show_alert: true });
    return;
  }
  if (!baseUrl) {
    await api('answerCallbackQuery', { callback_query_id: query.id, text: 'Payment page is not configured yet. Ask the bot owner to set PAYMENT_BASE_URL.', show_alert: true });
    return;
  }
  if (!await store?.getSubscriptionConfig?.(message.chat.id)) {
    await api('answerCallbackQuery', { callback_query_id: query.id,
      text: 'Subscriptions are not configured for this group. Ask a group admin to run /subconfig first.', show_alert: true });
    return;
  }
  const user = query.from;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id);
  let url;
  let orderId;
  for (let attempt = 0; attempt < 10; attempt++) {
    url = personalPaymentLink(baseUrl, { ...request, reference: `${request.reference}-${user.id}`,
      userId: user.id, name, username: user.username || null }, secret);
    const payment = readPayment(new URL(url).hash.slice(1), secret);
    if (await store?.get(payment.orderId)) continue;
    await store?.register(payment, message, user);
    orderId = payment.orderId;
    break;
  }
  if (!orderId) throw new Error('Could not allocate an order ID. Try again.');
  await api('answerCallbackQuery', { callback_query_id: query.id, text: 'Your payment link is being posted in this group.' });
  const mention = name;
  const text = `${mention}\n\nYour payment link is ready\nAmount: ${formatAmount(request.amount)} MMK\nDuration: ${request.days} days\n\nTap below to open your payment page.`;
  const sent = await api('sendMessage', {
    chat_id: message.chat.id, text,
    entities: [{ type: 'text_mention', offset: 0, length: mention.length, user }],
    reply_parameters: { message_id: message.message_id },
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    reply_markup: { inline_keyboard: [[{ text: 'Pay now', url }]] },
  });
  if (store && sent?.message_id) await store.saveMessage(orderId, sent.message_id);
  logger('Personal payment link posted in group', { chatId: message.chat.id, userId: user.id });
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI to persist payment orders and subscriptions.');
  if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in your environment or local .env file.');
  const linkSecret = process.env.PAYMENT_LINK_SECRET;
  if (!linkSecret || linkSecret.length < 32) throw new Error('Set PAYMENT_LINK_SECRET to at least 32 characters.');
  if (!process.env.MMPAY_PUBLISHABLE_KEY || !process.env.MMPAY_SECRET_KEY) throw new Error('Set MMPAY_PUBLISHABLE_KEY and MMPAY_SECRET_KEY.');
  const port = Number(process.env.PORT || process.env.PAYMENT_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  if (process.env.PAYMENT_BASE_URL) {
    const url = new URL(process.env.PAYMENT_BASE_URL);
    if (!['https:', 'http:'].includes(url.protocol) || url.hash || url.search || url.pathname !== '/') {
      throw new Error('PAYMENT_BASE_URL must be the payment server origin, such as https://tg.myanmyanpay.com.');
    }
  }
  const shutdown = new AbortController();
  const redact = value => String(value).split(token).join('[REDACTED]');
  const api = async (method, body = {}) => {
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(45_000), shutdown.signal]),
      });
    } catch (cause) {
      throw new Error(`Telegram ${method} network request failed: ${redact(cause.cause?.code || cause.name)}.`);
    }
    const data = await response.json();
    if (!data.ok) {
      const error = new Error(`Telegram ${method} failed (${data.error_code}): ${redact(data.description || 'Unknown error')}`);
      error.retryAfter = data.parameters?.retry_after;
      throw error;
    }
    return data.result;
  };
  const bot = await api('getMe');
  log('Bot connected', { username: bot.username, botId: bot.id,
    canJoinGroups: bot.can_join_groups, receivesAllGroupMessages: bot.can_read_all_group_messages });
  if (bot.can_join_groups === false) {
    log('Group joining disabled', { action: 'In @BotFather use /setjoingroups and enable it for this bot.' });
  }
  if (!bot.can_read_all_group_messages) {
    log('Group privacy enabled', { action: `Promote the bot to group admin. To test delivery, send /check@${bot.username} in the group.` });
  }
  const webhook = await api('getWebhookInfo');
  if (webhook.url) throw new Error('A webhook is configured. Remove it before running this polling bot.');
  log('Polling started. Press Ctrl+C to stop.');
  let offset = 0;
  let stopped = false;
  const database = await connectMongoStore(process.env.MONGODB_URI, process.env.MONGODB_DATABASE || 'telegram_payments');
  const store = database.store;
  const baseUrl = process.env.PAYMENT_BASE_URL || 'http://127.0.0.1:3000';
  const paymentServer = createPaymentServer(linkSecret, { store, api, logger: log,
    publishableKey: process.env.MMPAY_PUBLISHABLE_KEY, merchantSecret: process.env.MMPAY_SECRET_KEY,
    merchantName: process.env.MMPAY_MERCHANT_NAME, baseUrl: process.env.MMPAY_BASE_URL,
    callbackUrl: new URL('/webhook', baseUrl).href });
  paymentServer.on('error', error => {
    log('Payment server failed', { code: error.code });
    stopped = true;
    process.exitCode = 1;
  });
  paymentServer.listen(port, '0.0.0.0', () => {
    log('Payment page running', { port: paymentServer.address().port, publicUrlConfigured: Boolean(process.env.PAYMENT_BASE_URL) });
  });
  const stop = () => {
    stopped = true;
    shutdown.abort();
    paymentServer.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopped) {
    try {
      const updates = await api('getUpdates', {
        offset, timeout: 30, allowed_updates: ['message', 'my_chat_member', 'callback_query', 'chat_join_request'],
      });
      log('Poll completed', { updateCount: updates.length });
      for (const update of updates) {
        // Failed checks stay silent; avoid replaying messages after a send failure.
        offset = update.update_id + 1;
        try {
          if (update.my_chat_member) {
            const membership = update.my_chat_member;
            const status = membership.new_chat_member.status;
            log('Bot membership changed', { chatId: membership.chat.id,
              chatType: membership.chat.type, previousStatus: membership.old_chat_member.status, status });
            if (['group', 'supergroup'].includes(membership.chat.type) && status === 'member') {
              log('Group setup needed', { chatId: membership.chat.id,
                action: 'Promote the bot to administrator to receive group messages and reliably check sender roles.' });
            }
          }
          if (update.message && !await handleSubscriptionSetup(update.message, api, store, bot.username)) {
            await handleMessage(update.message, api, log, bot.username, linkSecret, baseUrl, store);
          }
          if (update.callback_query) await handleCallback(update.callback_query, api, linkSecret, baseUrl, log, store);
          if (update.chat_join_request) await handleJoinRequest(update.chat_join_request, api, store, log);
        } catch (error) {
          log('Message handling failed', { updateId: update.update_id, error: redact(error.message) });
          if (error.retryAfter) await new Promise(resolve => setTimeout(resolve, error.retryAfter * 1000));
        }
      }
    } catch (error) {
      if (stopped) break;
      log('Polling failed', { error: redact(error.message), retryInSeconds: error.retryAfter || 3 });
      await new Promise(resolve => setTimeout(resolve, (error.retryAfter || 3) * 1000));
    }
  }
  log('Bot stopped');
  paymentServer.close();
  await database.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
