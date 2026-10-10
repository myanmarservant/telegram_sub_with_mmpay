import test from 'node:test';
import assert from 'node:assert/strict';
import { handleJoinRequest, handleSubscriptionSetup, removeExpiredMembers } from './subscriptions.mjs';
import { MongoPaymentStore } from './mongo-store.mjs';

// Models collection persistence independently of a store instance.
function database() {
  const collections = new Map();
  return { collection(name) {
    if (collections.has(name)) return collections.get(name);
    const docs = [];
    const matches = (doc, query) => Object.entries(query).every(([key, value]) => {
      const actual = key.split('.').reduce((object, part) => object?.[part], doc);
      if (value?.$gt) return actual > value.$gt;
      if (value?.$lte) return actual instanceof Date && actual <= value.$lte;
      if (value?.$type) return typeof actual === value.$type;
      if (value && Object.hasOwn(value, '$ne')) return actual !== value.$ne;
      return actual === value;
    });
    const collection = {
      async createIndex() {},
      async insertOne(doc) { docs.push(structuredClone(doc)); },
      async findOne(query) { return structuredClone(docs.find(doc => matches(doc, query)) || null); },
      find(query) {
        let rows = docs.filter(doc => matches(doc, query));
        return { sort() { rows.sort((a, b) => a.paid_until - b.paid_until); return this; },
          limit(count) { rows = rows.slice(0, count); return this; }, async toArray() { return structuredClone(rows); } };
      },
      async replaceOne(query, doc) { const index = docs.findIndex(item => matches(item, query)); assert.ok(index >= 0); docs[index] = structuredClone(doc); },
      async updateOne(query, update, options) {
        let doc = docs.find(item => matches(item, query));
        if (!doc && options?.upsert) { doc = { ...query }; docs.push(doc); }
        assert.ok(doc); Object.assign(doc, structuredClone(update.$set));
      },
    };
    collections.set(name, collection);
    return collection;
  } };
}

test('Mongo-backed subscriptions survive store recreation and only verified source-group sub payments grant access', async () => {
  const db = database();
  const options = { sourceChatId: -12, destinationChatId: -99, inviteUrl: 'https://t.me/+request' };
  let store = new MongoPaymentStore(db, options);
  await store.initialize();
  await store.saveSubscriptionConfig(-12, -99, options.inviteUrl, 42);
  const user = { id: 77, first_name: 'Alice' };
  const payment = { orderId: 'TG-MONGO1', amount: '5000', name: 'Alice', days: 60 };
  await store.register(payment, { chat: { id: -12 } }, user);
  await store.saveMessage(payment.orderId, 55);
  assert.equal(await store.hasActiveSubscription(77, -99), false);
  const calls = [];
  const payload = { orderId: payment.orderId, amount: 5000, currency: 'MMK', status: 'SUCCESS' };
  await assert.rejects(store.receive({ ...payload, amount: 1 }, () => assert.fail('Invalid amount')));
  assert.equal(await store.hasActiveSubscription(77, -99), false);
  await store.receive(payload, async (method, body) => { calls.push({ method, body }); });
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].url, options.inviteUrl);
  const until = (await store.get(payment.orderId)).paid_until;
  store = new MongoPaymentStore(db, options);
  assert.equal((await store.get(payment.orderId)).days, 60);
  assert.equal(await store.hasActiveSubscription(77, -99), true);
  assert.equal(await store.hasActiveSubscription(88, -99), false);
  assert.equal(await store.hasActiveSubscription(77, -100), false);
  assert.equal(await store.hasActiveSubscription(77, -99, until), false);
  await store.receive(payload, () => assert.fail('Duplicate side effect after restart'));
  assert.equal((await store.get(payment.orderId)).paid_until.getTime(), until.getTime());
  await store.saveSubscriptionConfig(-13, -100, 'https://t.me/+other', 88);
  for (const [id, chat, payer, status] of [
    ['TG-OTHER1', -13, { id: 88 }, 'SUCCESS'],
    ['TG-CHARGE', -12, undefined, 'SUCCESS'],
    ['TG-FAILED', -12, { id: 88 }, 'FAILED'],
  ]) {
    await store.register({ ...payment, orderId: id }, { chat: { id: chat } }, payer);
    await store.saveMessage(id, 56);
    await store.receive({ ...payload, orderId: id, status }, async () => {});
  }
  assert.equal(await store.hasActiveSubscription(88, -99), false);
  assert.equal(await store.hasActiveSubscription(88, -100), true);
});

test('shared invite approves only the requester with an active subscription', async () => {
  const calls = [];
  const store = { async isSubscriptionDestination(id) { return id === -99; }, async hasActiveSubscription(userId, chatId) { assert.equal(chatId, -99); return userId === 77; } };
  for (const id of [77, 88]) {
    await handleJoinRequest({ chat: { id: -99 }, from: { id }, invite_link: { invite_link: 'shared' } },
      async (method, body) => calls.push({ method, body }), store);
  }
  assert.deepEqual(calls, [
    { method: 'approveChatJoinRequest', body: { chat_id: -99, user_id: 77 } },
    { method: 'declineChatJoinRequest', body: { chat_id: -99, user_id: 88 } },
  ]);
  await handleJoinRequest({ chat: { id: -100 }, from: { id: 77 } }, () => assert.fail('Other group'), store);
  await assert.rejects(handleJoinRequest({ chat: { id: -99 }, from: { id: 77 } }, () => assert.fail('Never approve during outage'),
    { async isSubscriptionDestination() { return true; }, async hasActiveSubscription() { throw new Error('Database offline'); } }));
});

test('expiry scan selects only expired successful subscriptions and persists completion across restart', async () => {
  const db = database();
  const collection = db.collection('payment_orders');
  const now = new Date('2026-11-01T00:00:00Z');
  const base = { user: { id: 77 }, destination_chat_id: -99, status: 'SUCCESS', paid_until: now };
  for (const [id, overrides] of [
    ['expired', {}], ['active', { paid_until: new Date(now.getTime() + 1) }],
    ['failed', { status: 'FAILED' }], ['charge', { user: undefined }],
    ['no destination', { destination_chat_id: undefined }], ['processed', { expiry_processed: true }],
  ]) await collection.insertOne({ ...base, ...overrides, order_id: id });
  let store = new MongoPaymentStore(db);
  assert.deepEqual((await store.expiredSubscriptions(now)).map(order => order.order_id), ['expired']);
  await store.markExpiry('expired', { expiry_processed: true });
  store = new MongoPaymentStore(db);
  assert.deepEqual(await store.expiredSubscriptions(now), []);
});

test('expired members are removed, renewals and admins are protected, and failures retry', async () => {
  for (const scenario of ['expired', 'renewed', 'renewed during lookup', 'administrator', 'creator', 'left', 'kicked', 'api failure', 'database failure']) {
    const order = { order_id: 'TG-EXPIRE', user: { id: 77 }, destination_chat_id: -99 };
    const calls = [];
    let checks = 0;
    let marked = false;
    const store = {
      async expiredSubscriptions() { return [order]; },
      async hasActiveSubscription() {
        if (scenario === 'database failure') throw new Error('Offline');
        return scenario === 'renewed' || scenario === 'renewed during lookup' && ++checks === 2;
      },
      async markExpiry(id, fields) { assert.equal(id, order.order_id); marked = fields.expiry_processed; },
    };
    await removeExpiredMembers(async (method, body) => {
      calls.push({ method, body });
      if (method === 'getChatMember') return { status: ['administrator', 'creator', 'left', 'kicked'].includes(scenario) ? scenario : 'member' };
      if (scenario === 'api failure') throw new Error('Missing permission');
    }, store);
    const kicks = calls.filter(call => call.method === 'unbanChatMember');
    assert.equal(kicks.length, ['expired', 'api failure'].includes(scenario) ? 1 : 0, scenario);
    if (kicks.length) assert.deepEqual(kicks[0].body, { chat_id: -99, user_id: 77, only_if_banned: false });
    assert.equal(marked, ['expired', 'renewed', 'left', 'kicked'].includes(scenario), scenario);
  }
});

test('check is admin-only, scoped to the configured destination, and reports removals', async () => {
  for (const scenario of ['allowed', 'source member', 'destination member', 'unconfigured', 'destination command']) {
    const replies = [];
    let scanned = false;
    const chatId = scenario === 'destination command' ? -99 : -12;
    const store = {
      async getSubscriptionConfig() { return scenario === 'unconfigured' || chatId === -99 ? null : { destination_chat_id: -99 }; },
      async isSubscriptionDestination(id) { return id === -99; },
      async expiredSubscriptions(now, destination) {
        assert.equal(destination, -99); scanned = true;
        return [{ order_id: 'expired', destination_chat_id: -99, user: { id: 77 } }];
      },
      async hasActiveSubscription() { return false; },
      async markExpiry() {},
    };
    await handleSubscriptionSetup({ chat: { id: chatId, type: 'supergroup' }, from: { id: 42 }, message_id: 1, text: '/check@TestBot' },
      async (method, body) => {
        if (method === 'getChatMember') {
          if (body.user_id === 77) return { status: 'member' };
          return { status: scenario === 'source member' && body.chat_id === -12 || scenario === 'destination member' && body.chat_id === -99 ? 'member' : 'administrator' };
        }
        if (method === 'sendMessage') { replies.push(body.text); return {}; }
        assert.equal(method, 'unbanChatMember'); assert.equal(body.chat_id, -99);
      }, store, 'TestBot');
    assert.equal(scanned, ['allowed', 'destination command'].includes(scenario));
    if (scanned) assert.match(replies[0], /Removed: 1/);
    if (scenario === 'source member') assert.equal(replies.length, 0);
  }
});

test('subconfig asks the admin, verifies destination permissions, and persists per-group settings', async () => {
  const db = database();
  let store = new MongoPaymentStore(db);
  const base = { chat: { id: -12, type: 'supergroup' }, from: { id: 42 }, message_id: 1, message_thread_id: 8 };
  const calls = [];
  const api = async (method, body) => {
    calls.push({ method, body });
    if (method === 'getChatMember') return { status: 'administrator', can_invite_users: true, can_restrict_members: true };
    if (method === 'getChat') return { id: body.chat_id, type: 'supergroup', title: 'Members' };
    if (method === 'getMe') return { id: 1 };
    if (method === 'createChatInviteLink') return { invite_link: `https://t.me/+${body.chat_id}` };
    return { message_id: 10 };
  };
  assert.equal(await handleSubscriptionSetup({ ...base, text: '/subconfig@TestBot' }, api, store, 'TestBot'), true);
  assert.equal(calls[1].body.reply_markup.force_reply, true);
  assert.equal(calls[1].body.message_thread_id, 8);
  store = new MongoPaymentStore(db); // Pending questions survive restart.
  const answer = { ...base, message_id: 11, text: '-99', reply_to_message: { message_id: 10 } };
  assert.equal(await handleSubscriptionSetup({ ...answer, from: { id: 88 } }, api, store, 'TestBot'), false);
  assert.equal(await handleSubscriptionSetup({ ...answer, reply_to_message: { message_id: 9 } }, api, store, 'TestBot'), false);
  await handleSubscriptionSetup(answer, api, store, 'TestBot');
  const config = await store.getSubscriptionConfig(-12);
  assert.equal(config.destination_chat_id, -99);
  assert.equal(config.configured_by, 42);
  assert.equal(await store.isSubscriptionDestination(-99), true);
  assert.equal(calls.find(call => call.method === 'createChatInviteLink').body.creates_join_request, true);
  assert.equal(await handleSubscriptionSetup(answer, api, store, 'TestBot'), false);
  assert.equal(await store.getSubscriptionConfig(-13), null);
});

test('subconfig rejects non-admins, public destinations, missing permissions, and invalid replies', async () => {
  for (const scenario of ['source member', 'destination member', 'bot missing permission', 'public', 'invalid', 'same group']) {
    const store = new MongoPaymentStore(database());
    await store.saveSetup(-12, 42, 10);
    const message = { chat: { id: -12, type: 'supergroup' }, from: { id: 42 }, message_id: 11,
      text: scenario === 'invalid' ? 'hello' : scenario === 'same group' ? '-12' : '-99', reply_to_message: { message_id: 10 } };
    await handleSubscriptionSetup(message, async (method, body) => {
      if (method === 'getChatMember') {
        return { status: scenario === 'source member' && body.chat_id === -12 || scenario === 'destination member' && body.chat_id === -99 && body.user_id === 42 ? 'member' : 'administrator',
          can_invite_users: scenario !== 'bot missing permission' };
      }
      if (method === 'getChat') return { type: 'supergroup', ...(scenario === 'public' ? { username: 'publicgroup' } : {}) };
      if (method === 'getMe') return { id: 1 };
      assert.equal(method, 'sendMessage');
      return { message_id: 20 };
    }, store, 'TestBot');
    assert.equal(await store.getSubscriptionConfig(-12), null, scenario);
  }
});

