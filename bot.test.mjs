import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PaymentStore, paidUntilTag } from './payment-store.mjs';
import { handleMessage as processMessage, handleCallback as processCallback, isBotMentioned } from './bot.mjs';
import { chargeButton, readChargeButton, readPayment, personalPaymentLink, createPaymentServer } from './payments.mjs';

function configuredStore() {
  const store = new PaymentStore();
  store.getSubscriptionConfig = async () => ({ destination_chat_id: -99, invite_url: 'https://t.me/+paid' });
  return store;
}
const handleCallback = (query, api, secret, baseUrl, logger, store = configuredStore()) =>
  processCallback(query, api, secret, baseUrl, logger, store);
const handleMessage = (message, api) => processMessage(message, (method, body) => method === 'getChatMember'
  ? { status: message.from.id === 42 ? 'administrator' : 'member' } : api(method, body),
() => {}, 'TestBot', 'test-secret', 'http://localhost:3000', configuredStore());

const message = { chat: { id: -123, type: 'supergroup' }, from: { id: 42, is_bot: false }, message_id: 7,
  text: '@TestBot', entities: [{ type: 'mention', offset: 0, length: 8 }] };

test('sub requires setup for its own group while charge remains available', async () => {
  const store = new PaymentStore();
  store.getSubscriptionConfig = async chatId => {
    assert.equal(chatId, -123);
    return null;
  };
  for (const text of ['/sub 5000 60', '/sub@TestBot 5000', '/sub']) {
    const calls = [];
    await processMessage({ ...message, text }, async (method, body) => {
      calls.push({ method, body });
      return method === 'getChatMember' ? { status: 'administrator' } : { message_id: 11 };
    }, () => {}, 'TestBot', 'test-secret', 'https://example.com', store);
    assert.deepEqual(calls.map(call => call.method), ['getChatMember', 'sendMessage']);
    assert.match(calls[1].body.text, /Run \/subconfig first/);
    assert.equal(calls[1].body.reply_markup, undefined);
    assert.equal(store.orders.size, 0);
  }
  let reply;
  await processMessage({ ...message, text: '/charge 5000' }, async (method, body) => {
    if (method === 'getChatMember') return { status: 'administrator' };
    reply = body; return { message_id: 11 };
  }, () => {}, 'TestBot', 'test-secret', 'https://example.com', store);
  assert.equal(reply.reply_markup.inline_keyboard[0][0].text, 'Pay now');
});

test('unconfigured groups cannot generate personal links from old buttons', async () => {
  const store = new PaymentStore();
  store.getSubscriptionConfig = async () => null;
  const calls = [];
  await processCallback({ id: 'query', data: chargeButton('5000', -123, 'test-secret'),
    from: { id: 77, first_name: 'Alice' }, message }, async (method, body) => { calls.push({ method, body }); },
  'test-secret', 'https://example.com', () => {}, store);
  assert.deepEqual(calls.map(call => call.method), ['answerCallbackQuery']);
  assert.match(calls[0].body.text, /\/subconfig first/);
  assert.equal(calls[0].body.show_alert, true);
  assert.equal(store.orders.size, 0);
});

test('group admin receives a mention reply', async () => {
  const calls = [];
  await processMessage(message, async (method, body) => {
    calls.push({ method, body });
    return method === 'getChatMember' ? { status: 'administrator' } : {};
  }, () => {}, 'TestBot');
  assert.deepEqual(calls.map(call => call.method), ['getChatMember', 'sendMessage']);
  assert.equal(calls[1].body.text, 'Yes');
});

test('new group admins and owners can charge and sub using group roles', async () => {
  for (const status of ['administrator', 'creator']) {
    for (const command of ['charge', 'sub']) {
      const calls = [];
      await processMessage({ ...message, text: `/${command} 5000`, from: { id: 999 }, entities: [] }, async (method, body) => {
        calls.push({ method, body });
        return method === 'getChatMember' ? { status } : { message_id: 11 };
      }, () => {}, 'TestBot', 'test-secret', 'https://example.com', configuredStore());
      assert.deepEqual(calls.map(call => call.method), ['getChatMember', 'sendMessage']);
      assert.deepEqual(calls[0].body, { chat_id: -123, user_id: 999 });
      assert.ok(calls[1].body.reply_markup);
    }
  }
});

test('regular members cannot create requests and role lookup errors send no reply', async () => {
  for (const command of ['charge', 'sub']) {
    for (const status of ['member', 'restricted', 'left', 'kicked']) {
      await processMessage({ ...message, text: `/${command} 5000` }, async method => {
        assert.equal(method, 'getChatMember');
        return { status };
      }, () => {}, 'TestBot', 'test-secret', 'https://example.com', configuredStore());
    }
    await assert.rejects(processMessage({ ...message, text: `/${command} 5000` }, async method => {
      assert.equal(method, 'getChatMember');
      throw new Error('Role lookup unavailable');
    }, () => {}, 'TestBot', 'test-secret', 'https://example.com'), /Role lookup unavailable/);
  }
});

test('regular member mentions receive no reply', async () => {
  await handleMessage({ ...message, from: { id: 99 } }, () => assert.fail('Unexpected API call'));
});

test('private, bot, anonymous and service messages are ignored', async () => {
  for (const input of [
    { ...message, chat: { id: 42, type: 'private' } },
    { ...message, from: { id: 42, is_bot: true } },
    { ...message, sender_chat: { id: -123 } },
    { ...message, text: undefined },
  ]) await handleMessage(input, () => assert.fail('Unexpected API call'));
});

test('send failures propagate for logging', async () => {
  const calls = [];
  await assert.rejects(handleMessage(message, async method => {
    calls.push(method);
    throw new Error('Unavailable');
  }));
  assert.deepEqual(calls, ['sendMessage']);
});

test('caption replies preserve topic and reply target', async () => {
  let reply;
  await handleMessage({ ...message, text: undefined, caption: '@TestBot',
    caption_entities: message.entities, message_thread_id: 12 }, async (method, body) => {
    if (method === 'sendMessage') reply = body;
    return { status: 'administrator' };
  });
  assert.equal(reply.message_thread_id, 12);
  assert.deepEqual(reply.reply_parameters, { message_id: 7 });
});

test('untagged admin messages never call Telegram', async () => {
  await handleMessage({ ...message, text: 'Hello', entities: [] }, () => assert.fail('Unexpected API call'));
});

test('only exact bot mentions and addressed commands match', () => {
  assert.equal(isBotMentioned(message, 'testbot'), true);
  assert.equal(isBotMentioned(message, 'OtherBot'), false);
  assert.equal(isBotMentioned({ text: '/check@TestBot', entities: [{ type: 'bot_command', offset: 0, length: 14 }] }, 'TestBot'), true);
  assert.equal(isBotMentioned({ text: '/check', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }, 'TestBot'), false);
  assert.equal(isBotMentioned({ text: '@TestBotExtra', entities: [{ type: 'mention', offset: 0, length: 13 }] }, 'TestBot'), false);
  assert.equal(isBotMentioned({ text: '😀 @TestBot', entities: [{ type: 'mention', offset: 3, length: 8 }] }, 'TestBot'), true);
});

test('admin charge generates a signed payment button', async () => {
  let reply;
  await handleMessage({ ...message, text: '/charge 2500' }, async (method, body) => {
    if (method === 'sendMessage') reply = body;
    return { status: 'administrator' };
  });
  assert.match(reply.text, /<b>Payment request<\/b>/);
  assert.doesNotMatch(reply.text, /Group payment|Demo preview|No money is collected/);
  assert.equal(reply.parse_mode, 'HTML');
  const button = reply.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, 'Pay now');
  assert.equal(readPayment(new URL(button.url).hash.slice(1), 'test-secret').amount, '2500');
  assert.match(reply.text, /Amount: <b>2,500 MMK<\/b>/);
});

test('regular members cannot charge', async () => {
  const calls = [];
  await handleMessage({ ...message, text: '/charge 5000', from: { id: 99 } }, async method => {
    calls.push(method);
    return { status: 'member' };
  });
  assert.deepEqual(calls, []);
});

test('invalid charge arguments show usage only to admins', async () => {
  for (const text of ['/charge', '/charge alice123 10', '/charge extra',
    '/charge 0', '/charge -10', '/charge 1.234',
    '/charge 10 extra', '/charge 1e3']) {
    let reply;
    await handleMessage({ ...message, text }, async (method, body) => {
      if (method === 'sendMessage') reply = body;
      return { status: 'creator' };
    });
    assert.match(reply.text, /^Usage:/);
    assert.equal(reply.reply_markup, undefined);
  }
});

test('whole amounts are formatted and other bot tags are ignored', async () => {
  let reply;
  await handleMessage({ ...message, text: '/charge@testbot 5000' }, async (method, body) => {
    if (method === 'sendMessage') reply = body;
    return { status: 'administrator' };
  });
  assert.match(reply.text, /Amount: <b>5,000 MMK<\/b>/);
  await handleMessage({ ...message, text: '@OtherBot @alice123 25', entities: [{ type: 'mention', offset: 0, length: 9 }] }, () => assert.fail('Unexpected API call'));
  await handleMessage({ ...message, text: '/charge@OtherBot @alice123 25', entities: [] }, () => assert.fail('Unexpected API call'));
});

test('charge is for everyone and preserves amount', async () => {
  for (const text of ['/charge 1500', '/charge@TestBot 1500']) {
    let reply;
    await handleMessage({ ...message, text, entities: [] }, async (method, body) => {
      if (method === 'sendMessage') reply = body;
      return { status: 'administrator' };
    });
    assert.match(reply.text, /<b>Payment request<\/b>/);
    assert.match(reply.text, /Amount: <b>1,500 MMK<\/b>/);
    const button = reply.reply_markup.inline_keyboard[0][0];
    assert.equal(button.text, 'Pay now');
    assert.equal(button.callback_data, undefined);
    const url = new URL(button.url);
    assert.equal(url.origin, 'http://127.0.0.1:3000');
    assert.equal(readPayment(url.hash.slice(1), 'test-secret').amount, '1500');
  }
});

test('each clicking user gets a personal link posted in the original group topic', async () => {
  const data = chargeButton('1500', -123, 'test-secret');
  for (const user of [{ id: 77, first_name: 'Alice', username: 'alice123' }, { id: 88, first_name: 'Bob' }]) {
    const calls = [];
    await handleCallback({ id: 'query', data, from: user,
      message: { ...message, message_thread_id: 12 } }, async (method, body) => calls.push({ method, body }),
    'test-secret', 'https://tg.myanmyanpay.com', () => {});
    assert.equal(calls[0].method, 'answerCallbackQuery');
    assert.equal(calls[1].method, 'sendMessage');
    assert.equal(calls[1].body.chat_id, -123);
    assert.equal(calls[1].body.message_thread_id, 12);
    const url = new URL(calls[1].body.reply_markup.inline_keyboard[0][0].url);
    const payment = readPayment(url.hash.slice(1), 'test-secret');
    assert.equal(url.origin, 'https://tg.myanmyanpay.com');
    assert.equal(payment.userId, user.id);
    assert.equal(payment.name, user.first_name);
    assert.equal(payment.amount, '1500');
    if (!user.username) assert.equal(calls[1].body.entities[0].user.id, 88);
  }
});

test('tampered buttons and payment links are rejected', () => {
  const data = chargeButton('1500', -123, 'test-secret');
  assert.throws(() => readChargeButton(data.replace('1500', '2500'), -123, 'test-secret'));
  assert.throws(() => readChargeButton(data, -456, 'test-secret'));
  const url = new URL(personalPaymentLink('https://tg.myanmyanpay.com', { amount: '1500', userId: 77 }, 'test-secret'));
  assert.throws(() => readPayment(url.hash.slice(1), 'different-secret'));
  assert.throws(() => readPayment(url.hash.slice(1), 'test-secret', Math.floor(Date.now() / 1000) + 8 * 86400));
});

test('unconfigured payment page answers the click without posting a broken link', async () => {
  const calls = [];
  await handleCallback({ id: 'query', data: chargeButton('1500', -123, 'test-secret'),
    from: { id: 77, first_name: 'Alice' }, message }, async (method, body) => calls.push({ method, body }),
  'test-secret', '', () => {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'answerCallbackQuery');
  assert.equal(calls[0].body.show_alert, true);
});

test('payment server serves page and verifies signed payment identity', async () => {
  const server = createPaymentServer('test-secret');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const page = await fetch(origin);
    const html = await page.text();
    assert.match(html, /Order ID/);
    assert.doesNotMatch(html, /Requested for|Telegram user ID|Username|Reference/);
    const url = new URL(personalPaymentLink(origin, { amount: '1500', userId: 77, name: 'Alice' }, 'test-secret'));
    const response = await fetch(`${origin}/api/payment`, { method: 'POST', body: JSON.stringify({ token: url.hash.slice(1) }) });
    assert.equal(response.status, 200);
    const payment = await response.json();
    assert.equal(payment.userId, 77);
    assert.match(payment.orderId, /^TG-[A-Z0-9]{6}$/);
    const invalid = await fetch(`${origin}/api/payment`, { method: 'POST', body: JSON.stringify({ token: 'fake' }) });
    assert.equal(invalid.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('charge validates arguments and ignores non-admins', async () => {
  for (const text of ['/charge', '/charge 0', '/charge -1', '/charge 1.234', '/charge 1500 extra']) {
    let reply;
    await handleMessage({ ...message, text, entities: [] }, async (method, body) => {
      if (method === 'sendMessage') reply = body;
      return { status: 'creator' };
    });
    assert.match(reply.text, /^Usage: \/charge/);
    assert.equal(reply.reply_markup, undefined);
  }
  const calls = [];
  await handleMessage({ ...message, text: '/charge 1500', entities: [], from: { id: 99 } }, async method => {
    calls.push(method);
    return { status: 'member' };
  });
  assert.deepEqual(calls, []);
  await handleMessage({ ...message, text: '/charge@OtherBot 1500', entities: [] }, () => assert.fail('Unexpected API call'));
});


test('sub creates a signed generation button only for group admins', async () => {
  for (const text of ['/sub 5000', '/sub@TestBot 5000']) {
    let reply;
    await handleMessage({ ...message, text, entities: [] }, async (method, body) => { reply = body; });
    const button = reply.reply_markup.inline_keyboard[0][0];
    assert.equal(button.text, 'Generate a payment link');
    assert.equal(button.url, undefined);
    assert.equal(readChargeButton(button.callback_data, -123, 'test-secret').amount, '5000');
    assert.match(reply.text, /5,000 MMK/);
  }
  await handleMessage({ ...message, text: '/sub 5000', from: { id: 99 }, entities: [] }, () => assert.fail('Unexpected API call'));
  await handleMessage({ ...message, text: '/sub@OtherBot 5000', entities: [] }, () => assert.fail('Unexpected API call'));
  for (const text of ['/sub', '/sub 999', '/sub 5000.50', '/sub 5000 extra', '/sub 10000001']) {
    let reply;
    await handleMessage({ ...message, text, entities: [] }, async (method, body) => { reply = body; });
    assert.match(reply.text, /^Usage: \/sub amount/);
    assert.equal(reply.reply_markup, undefined);
  }
});

test('sub personal orders are registered and payment results edit the personal message', async () => {
  const store = configuredStore();
  const calls = [];
  const api = async (method, body) => { calls.push({ method, body }); return { message_id: 55 }; };
  await handleCallback({ id: 'query', data: chargeButton('5000', -123, 'test-secret'),
    from: { id: 99, first_name: 'Alice', username: 'alice' }, message: { ...message, message_thread_id: 12 } },
  api, 'test-secret', 'https://example.com', () => {}, store);
  const reply = calls[1].body;
  const payment = readPayment(new URL(reply.reply_markup.inline_keyboard[0][0].url).hash.slice(1), 'test-secret');
  assert.equal(payment.userId, 99);
  assert.equal(reply.entities[0].user.id, 99);
  assert.equal(reply.text.startsWith('Alice\n'), true);
  assert.doesNotMatch(reply.text, /Demo|No money/);
  assert.equal(store.get(payment.orderId).message_id, 55);
  assert.equal(store.get(payment.orderId).thread_id, 12);
  await store.receive({ orderId: payment.orderId, amount: '5000', currency: 'MMK', status: 'SUCCESS' }, api);
  assert.equal(calls[2].method, 'editMessageText');
  assert.equal(calls[2].body.message_id, 55);
  assert.equal(calls[2].body.text.startsWith('Alice\n\n✅ Payment successful'), true);
  assert.deepEqual(calls[2].body.entities, reply.entities);
});

test('sub duration follows the signed button into checkout, expiry, and member tag', async () => {
  let preview;
  await handleMessage({ ...message, text: '/sub 5000 60' }, async (method, body) => { preview = body; });
  assert.match(preview.text, /60 days/);
  const data = preview.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(readChargeButton(data, -123, 'test-secret').days, 60);
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.throws(() => readChargeButton(data.replace(':60:', ':90:'), -123, 'test-secret'));
  const store = configuredStore();
  const calls = [];
  await handleCallback({ id: 'query', data, from: { id: 77, first_name: 'Alice' }, message }, async (method, body) => {
    calls.push({ method, body }); return { message_id: 55 };
  }, 'test-secret', 'https://example.com', () => {}, store);
  const payment = readPayment(new URL(calls[1].body.reply_markup.inline_keyboard[0][0].url).hash.slice(1), 'test-secret');
  assert.equal(payment.days, 60);
  assert.equal(store.get(payment.orderId).days, 60);
  const before = Date.now();
  await store.receive({ orderId: payment.orderId, amount: 5000, currency: 'MMK', status: 'SUCCESS' }, async () => {});
  const until = store.get(payment.orderId).paid_until.getTime();
  assert.ok(until >= before + 60 * 86400_000 && until <= Date.now() + 60 * 86400_000);
  assert.equal(store.get(payment.orderId).paid_until_tag, paidUntilTag(until, 0));
});

test('sub validates days and legacy buttons default to 30 days', async () => {
  for (const days of ['0', '-1', '1.5', '1e2', '3651', '60 extra']) {
    let reply;
    await handleMessage({ ...message, text: `/sub 5000 ${days}` }, async (method, body) => { reply = body; });
    assert.match(reply.text, /^Usage: \/sub/);
    assert.equal(reply.reply_markup, undefined);
  }
  const body = 'charge:5000:1234abcd';
  const sig = createHmac('sha256', 'test-secret').update(`-123:${body}`).digest('base64url').slice(0, 16);
  assert.equal(readChargeButton(`${body}:${sig}`, -123, 'test-secret').days, 30);
});

test('charge no longer accepts usernames', async () => {
  let reply;
  await handleMessage({ ...message, text: '/charge @alice123 5000', entities: [] }, async (method, body) => {
    if (method === 'sendMessage') reply = body;
    return { status: 'administrator' };
  });
  assert.match(reply.text, /^Usage: \/charge amount/);
});

test('amount includes 1000 and rejects decimals and out-of-range values', async () => {
  for (const [amount, valid] of [['1000', true], ['10000000', true], ['999', false],
    ['10000001', false], ['1000.00', false], ['1500.50', false]]) {
    let reply;
    await handleMessage({ ...message, text: `/charge ${amount}`, entities: [] }, async (method, body) => {
      reply = body;
      return { message_id: 11 };
    });
    assert.equal(Boolean(reply.reply_markup), valid, amount);
    if (!valid) assert.match(reply.text, /No decimals/);
  }
});
