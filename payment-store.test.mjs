import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PaymentStore, paidUntilTag } from './payment-store.mjs';
import { createPaymentServer, personalPaymentLink, readPayment } from './payments.mjs';
import { handleMessage } from './bot.mjs';

test('paid-until tags add 30 days in Myanmar time across calendar boundaries', () => {
  for (const [now, expected] of [
    ['2026-10-10T00:00:00Z', 'Paid until 09/11'],
    ['2026-12-15T00:00:00Z', 'Paid until 14/01'],
    ['2028-01-31T00:00:00Z', 'Paid until 01/03'],
    ['2026-10-10T18:00:00Z', 'Paid until 10/11'],
  ]) {
    const tag = paidUntilTag(new Date(now));
    assert.equal(tag, expected);
    assert.equal(tag.length, 16);
  }
});

test('charge remembers amount and bot message without a database', async () => {
  const store = new PaymentStore();
  let reply;
  await handleMessage({ chat: { id: -12, type: 'supergroup' }, from: { id: 5 }, message_id: 10,
    message_thread_id: 7, text: '/charge 5000' }, async (method, body) => {
    if (method === 'getChatMember') return { status: 'administrator' };
    reply = body; return { message_id: 11 };
  }, () => {}, 'TestBot', 'link-secret', 'https://tg.myanmyanpay.com', store);
  const payment = readPayment(new URL(reply.reply_markup.inline_keyboard[0][0].url).hash.slice(1), 'link-secret');
  assert.equal(store.get(payment.orderId).message_id, 11);
  assert.equal(store.get(payment.orderId).amount, '5000');
});

test('verified webhooks edit original message; duplicates and invalid callbacks do not', async () => {
  const store = new PaymentStore();
  const url = new URL(personalPaymentLink('https://tg.myanmyanpay.com', { amount: '5000' }, 'link-secret'));
  const payment = readPayment(url.hash.slice(1), 'link-secret');
  store.register(payment, { chat: { id: -12 } });
  store.saveMessage(payment.orderId, 11);
  const calls = [];
  const server = createPaymentServer('link-secret', { store, api: async (method, body) => calls.push({ method, body }),
    merchantSecret: 'merchant-secret', publishableKey: 'pk-test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function webhook(payload, valid = true) {
    const body = JSON.stringify(payload), nonce = 'nonce';
    const signature = createHmac('sha256', valid ? 'merchant-secret' : 'wrong').update(`${nonce}.${body}`).digest('hex');
    return fetch(`${origin}/webhook`, { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'X-Mmpay-Nonce': nonce, 'X-Mmpay-Signature': signature } });
  }
  try {
    const payload = { orderId: payment.orderId, amount: 5000, currency: 'MMK', status: 'SUCCESS' };
    assert.equal((await webhook(payload, false)).status, 401);
    assert.equal((await webhook({ ...payload, amount: 6000 })).status, 400);
    assert.equal((await webhook({ ...payload, currency: 'USD' })).status, 400);
    assert.equal((await webhook({ ...payload, orderId: 'TG-UNKNOWN' })).status, 404);
    assert.equal(calls.length, 0);
    assert.equal((await webhook(payload)).status, 200);
    assert.equal((await webhook(payload)).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'editMessageText');
    assert.equal(calls[0].body.chat_id, -12);
    assert.equal(calls[0].body.message_id, 11);
    assert.deepEqual(calls[0].body.reply_markup.inline_keyboard, []);
    await webhook({ ...payload, status: 'FAILED' });
    assert.equal(calls.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('failed edits can be retried and failure edits replace the request', async () => {
  const store = new PaymentStore();
  store.register({ orderId: 'TG-ABC123', amount: '5000' }, { chat: { id: -12 } });
  store.saveMessage('TG-ABC123', 10);
  const payload = { orderId: 'TG-ABC123', amount: 5000, currency: 'MMK', status: 'FAILED' };
  await assert.rejects(store.receive(payload, async () => { throw new Error('Unavailable'); }), error => error.status === 503);
  assert.equal(store.get('TG-ABC123').status, 'PENDING');
  let reply;
  await store.receive(payload, async (method, body) => { reply = body; });
  assert.match(reply.text, /Payment failed/);
  assert.equal(reply.message_id, 10);
});

for (const status of ['SUCCESS', 'FAILED', 'FAIL', 'failed', 'CANCELLED', 'EXPIRED']) {
  test(`sub ${status} result mentions the payer by name`, async () => {
    const store = new PaymentStore();
    const user = { id: 77, first_name: 'Alice 😀', username: 'alice' };
    store.register({ orderId: 'TG-SUB123', amount: '5000', name: user.first_name }, { chat: { id: -12 } }, user);
    store.saveMessage('TG-SUB123', 55);
    let reply;
    await store.receive({ orderId: 'TG-SUB123', amount: 5000, currency: 'MMK', status }, async (method, body) => {
      if (method === 'editMessageText') reply = body;
      else {
        assert.equal(status, 'SUCCESS');
        assert.equal(method, 'setChatMemberTag');
      }
    });
    const icon = { SUCCESS: '✅', FAILED: '❌', FAIL: '❌', failed: '❌', CANCELLED: '🚫', EXPIRED: '⌛' }[status];
    assert.equal(reply.text.startsWith(`${user.first_name}\n\n${icon} Payment `), true);
    assert.deepEqual(reply.entities, [{ type: 'text_mention', offset: 0, length: user.first_name.length, user }]);
    assert.equal(reply.message_id, 55);
  });
}

test('sub success tags the payer once and retries failed tagging without repeating the message edit', async () => {
  const store = new PaymentStore();
  store.register({ orderId: 'TG-TAG123', amount: '5000', name: 'Alice' }, { chat: { id: -12 } }, { id: 77, first_name: 'Alice' });
  store.saveMessage('TG-TAG123', 55);
  const payload = { orderId: 'TG-TAG123', amount: 5000, currency: 'MMK', status: 'SUCCESS' };
  const calls = [];
  await assert.rejects(store.receive(payload, async (method, body) => {
    calls.push({ method, body });
    if (method === 'setChatMemberTag') throw new Error('Missing permission');
  }), error => error.status === 503);
  assert.equal(store.get(payload.orderId).status, 'SUCCESS');
  await store.receive(payload, async (method, body) => { calls.push({ method, body }); });
  assert.deepEqual(calls.map(call => call.method), ['editMessageText', 'setChatMemberTag', 'setChatMemberTag']);
  assert.deepEqual(calls[2].body, { chat_id: -12, user_id: 77, tag: store.get(payload.orderId).paid_until_tag });
  assert.match(calls[2].body.tag, /^Paid until \d{2}\/\d{2}$/);
  assert.equal(calls[1].body.tag, calls[2].body.tag);
  await store.receive(payload, () => assert.fail('Duplicate action'));
  await store.receive({ ...payload, status: 'FAILED' }, () => assert.fail('Success must remain final'));
});

for (const status of ['FAILED', 'FAIL', 'failed', 'EXPIRED']) {
  test(`${status} callback edits Telegram and exposes failure to the page`, async () => {
    const store = new PaymentStore();
    store.register({ orderId: 'TG-ABC123', amount: '5000' }, { chat: { id: -12 } });
    store.saveMessage('TG-ABC123', 10);
    const payload = { orderId: 'TG-ABC123', amount: 5000, currency: 'MMK', status };
    const calls = [];
    await store.receive(payload, async (method, body) => calls.push({ method, body }));
    assert.match(calls[0].body.text, /Payment failed/);
    assert.equal(store.get('TG-ABC123').status, status === 'EXPIRED' ? 'EXPIRED' : 'FAILED');
    await store.receive(payload, async () => assert.fail('Duplicate edit'));
  });
}
