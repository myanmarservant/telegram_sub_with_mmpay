export async function handleJoinRequest(request, api, store, logger = () => {}) {
  const destinationChatId = request.chat?.id;
  if (!request.from || request.from.is_bot || !await store.isSubscriptionDestination(destinationChatId)) return;
  // Any shared join-request link is safe: access is based on the requester ID, never the link owner.
  const active = await store.hasActiveSubscription(request.from.id, destinationChatId);
  await api(active ? 'approveChatJoinRequest' : 'declineChatJoinRequest', {
    chat_id: destinationChatId, user_id: request.from.id,
  });
  logger('Paid group join request handled', { chatId: destinationChatId, userId: request.from.id, approved: active });
}

const isAdmin = member => ['administrator', 'creator'].includes(member?.status);

export async function removeExpiredMembers(api, store, logger = () => {}, destinationChatId) {
  const orders = await store.expiredSubscriptions(new Date(), destinationChatId);
  const result = { checked: orders.length, removed: 0, skipped: 0, failed: 0 };
  for (const order of orders) {
    const context = { chatId: order.destination_chat_id, userId: order.user.id, orderId: order.order_id };
    const body = { chat_id: context.chatId, user_id: context.userId };
    try {
      if (await store.hasActiveSubscription(context.userId, context.chatId)) {
        await store.markExpiry(order.order_id, { expiry_processed: true });
        result.skipped++;
        continue;
      }
      const member = await api('getChatMember', body);
      if (isAdmin(member)) {
        result.skipped++;
        logger('Expired member is a group admin; removal skipped', context);
        continue;
      }
      if (!['left', 'kicked'].includes(member.status)) {
        // Recheck after the Telegram lookup so a renewal takes precedence.
        if (await store.hasActiveSubscription(context.userId, context.chatId)) { result.skipped++; continue; }
        // Telegram's default unban behavior also removes current members while allowing a future rejoin.
        await api('unbanChatMember', { ...body, only_if_banned: false });
        result.removed++;
      } else result.skipped++;
      await store.markExpiry(order.order_id, { expiry_processed: true });
      logger('Expired subscription removal completed', context);
    } catch (error) {
      result.failed++;
      logger('Expired subscription removal failed; will retry', { ...context, error: error.message });
      if (error.retryAfter) break;
    }
  }
  return result;
}

export async function handleSubscriptionSetup(message, api, store, botUsername) {
  if (!['group', 'supergroup'].includes(message.chat?.type) || !message.from || message.from.is_bot || message.sender_chat || !message.text) return false;
  const match = /^\/(subconfig|groupid|check)(?:@([a-z0-9_]+))?\s*$/i.exec(message.text.trim());
  if (match?.[2] && match[2].toLowerCase() !== botUsername?.toLowerCase()) return false;
  if (!match) {
    if (!message.reply_to_message || !store.getSetup) return false;
    const pending = await store.getSetup(message.chat.id, message.from.id);
    if (!pending || pending.expires_at <= new Date() || pending.prompt_id !== message.reply_to_message.message_id) return false;
  }
  if (!isAdmin(await api('getChatMember', { chat_id: message.chat.id, user_id: message.from.id }))) return true;
  const reply = text => api('sendMessage', { chat_id: message.chat.id, text,
    reply_parameters: { message_id: message.message_id },
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
  });
  if (match?.[1].toLowerCase() === 'groupid') {
    await reply(`Group ID: ${message.chat.id}`);
    return true;
  }
  if (match?.[1].toLowerCase() === 'check') {
    const config = await store.getSubscriptionConfig(message.chat.id);
    const destination = config?.destination_chat_id
      || (await store.isSubscriptionDestination(message.chat.id) ? message.chat.id : undefined);
    if (!destination) { await reply('Set up subscriptions with /subconfig first.'); return true; }
    if (destination !== message.chat.id && !isAdmin(await api('getChatMember', { chat_id: destination, user_id: message.from.id }))) {
      await reply('You must be an admin in the paid members group to run /check.'); return true;
    }
    const result = await removeExpiredMembers(api, store, () => {}, destination);
    await reply(`Subscription check complete\n\nRemoved: ${result.removed}\nSkipped (active, admin, or already left): ${result.skipped}\nFailed: ${result.failed}\n\nChecked ${result.checked} expired payment records (up to 100 per command).${result.checked === 100 || result.failed ? '\nRun /check again to continue or retry after checking bot permissions.' : ''}`);
    return true;
  }
  if (match) {
    const prompt = await api('sendMessage', { chat_id: message.chat.id,
      text: 'Which private group should paid subscribers join?\n\nAdd me as an admin there with Invite Users and Ban Users permissions. You must be an admin in both groups. Send /groupid there to get its ID, then reply to this message with that ID (for example -1001234567890).\n\nChoose the duration when charging: /sub 5000 60 for 60 days. Setup expires in 15 minutes.',
      reply_markup: { force_reply: true, selective: true },
      reply_parameters: { message_id: message.message_id },
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    });
    await store.saveSetup(message.chat.id, message.from.id, prompt.message_id);
    return true;
  }
  const raw = message.text.trim();
  if (!/^-\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) === message.chat.id) {
    await reply('Reply to the setup question with a different group’s numeric ID. Use /groupid in the destination group to find it.');
    return true;
  }
  const destination = Number(raw);
  let chat;
  try {
    chat = await api('getChat', { chat_id: destination });
    if (!['group', 'supergroup'].includes(chat.type) || chat.username) {
      await reply('Choose a private group so users cannot bypass paid join approval.');
      return true;
    }
    if (!isAdmin(await api('getChatMember', { chat_id: destination, user_id: message.from.id }))) {
      await reply('You must be an admin or owner in the destination group too.'); return true;
    }
    const bot = await api('getMe');
    const botMember = await api('getChatMember', { chat_id: destination, user_id: bot.id });
    if (!isAdmin(botMember) || !botMember.can_invite_users || !botMember.can_restrict_members) {
      await reply('Give me admin status with Invite Users and Ban Users permissions in the destination group, then reply again.');
      return true;
    }
  } catch {
    await reply('I could not verify that group. Check its ID and add me as an admin there, then reply again.');
    return true;
  }
  const invite = await api('createChatInviteLink', { chat_id: destination, name: `Paid: ${message.chat.id}`, creates_join_request: true });
  await store.saveSubscriptionConfig(message.chat.id, destination, invite.invite_link, message.from.id);
  await store.finishSetup(message.chat.id, message.from.id);
  await reply(`✅ Subscription setup saved\n\nPaid members group: ${chat.title || destination}\nDuration: chosen per /sub request (default 30 days)\n\nUse /sub 5000 60 to create a 60-day payment request. Successful payments include a join-request link. Only paid Telegram accounts are approved. Revoke older direct-entry invite links in the destination group.\n\nRun /check as a group admin to remove expired members. They can pay and request to rejoin.`);
  return true;
}
