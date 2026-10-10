import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('browser opens provider checkout with fixed order and webhook URL', async () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: true, disabled: false,
      addEventListener(event, fn) { this[event] = fn; } });
    return nodes.get(id);
  };
  let request, callback, verified = false;
  const context = vm.createContext({
    document: { getElementById: node }, location: { hash: '#signed-link' }, Date,
    setInterval() {}, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({
      orderId: 'TG-ABC123', amount: '5000', expires: Math.floor(Date.now() / 1000) + 900,
      status: verified ? 'SUCCESS' : 'PENDING', checkout: { publishableKey: 'pk-test', merchantName: 'Merchant', callbackUrl: 'https://tg.myanmyanpay.com/webhook' },
    }) }),
    window: { MMPaySDK: class {
      async showPaymentModal(payload, fn) { request = payload; callback = fn; }
    } },
  });
  vm.runInContext(await readFile(new URL('./payment-page/app.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(node('pay').disabled, false);
  await node('pay').click();
  assert.equal(request.amount, 5000);
  assert.equal(request.orderId, 'TG-ABC123');
  assert.equal(request.callbackUrl, 'https://tg.myanmyanpay.com/webhook');
  callback({ success: true });
  assert.equal(node('pay').disabled, true);
  assert.match(node('status').textContent, /verified confirmation/);
  assert.equal(node('success').hidden, false);
  assert.equal(node('pay').hidden, true);
  assert.equal(node('page-title').textContent, 'Payment successful');
  await new Promise(resolve => setImmediate(resolve));
  verified = true;
  await vm.runInContext('checkStatus()', context);
  assert.equal(node('status').textContent, 'Payment confirmed');
  assert.match(node('success-message').textContent, /received and confirmed/);
});

for (const result of ['failed', 'fail', 'expired', 'cancelled']) {
  test(`checkout ${result} shows failure and close button`, async () => {
    const nodes = new Map();
    const node = id => {
      if (!nodes.has(id)) nodes.set(id, { hidden: true, disabled: false,
        addEventListener(event, fn) { this[event] = fn; } });
      return nodes.get(id);
    };
    let callback, closed = false;
    const context = vm.createContext({
      document: { getElementById: node }, location: { hash: '#link' }, Date,
      setInterval() {}, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({ orderId: 'TG-ABC123', amount: '5000',
        expires: Math.floor(Date.now() / 1000) + 900, status: 'PENDING', checkout: { publishableKey: 'pk-test' } }) }),
      window: { close() { closed = true; }, MMPaySDK: class {
        async showPaymentModal(payload, fn) { callback = fn; }
      } },
    });
    vm.runInContext(await readFile(new URL('./payment-page/app.js', import.meta.url), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    await node('pay').click();
    callback({ [result]: true });
    assert.equal(node('failure').hidden, false);
    assert.equal(node('success').hidden, true);
    assert.equal(node('page-title').textContent, 'Payment failed');
    assert.equal(node('pay').hidden, true);
    assert.equal(node('close-page').hidden, false);
    node('close-page').click();
    assert.equal(closed, true);
    assert.equal(node('close-help').hidden, false);
  });
}
