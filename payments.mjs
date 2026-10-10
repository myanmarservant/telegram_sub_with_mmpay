import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

function sign(value, secret) {
  if (!secret) throw new Error('Bot token is required for payment links.');
  return createHmac('sha256', secret).update(value).digest('base64url');
}
function equal(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function chargeButton(amount, chatId, secret, days = 30) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Invalid subscription duration.');
  const body = `charge:${amount}:${randomBytes(4).toString('hex')}:${days}`;
  return `${body}:${sign(`${chatId}:${body}`, secret).slice(0, 16)}`;
}
export function readChargeButton(data, chatId, secret) {
  const match = /^charge:(\d{1,9}(?:\.\d{1,2})?):([a-f0-9]{8})(?::(\d{1,4}))?:([\w-]{16})$/.exec(data || '');
  if (!match || Number(match[1]) <= 0) throw new Error('Invalid payment button.');
  const body = data.slice(0, -17);
  const days = Number(match[3] || 30);
  if (days < 1 || days > 3650 || !equal(match[4], sign(`${chatId}:${body}`, secret).slice(0, 16))) throw new Error('Invalid payment button.');
  return { amount: match[1], reference: match[2], days };
}
export function personalPaymentLink(baseUrl, payment, secret) {
  const url = new URL(baseUrl);
  // Telegram rejects bare localhost hostnames in inline URL buttons.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PAYMENT_BASE_URL must be an HTTP or HTTPS URL.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const orderId = `TG-${Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('')}`;
  const payload = Buffer.from(JSON.stringify({ ...payment, orderId, expires: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
  url.hash = `${payload}.${sign(payload, secret)}`;
  return url.href;
}
export function readPayment(value, secret, now = Math.floor(Date.now() / 1000)) {
  const [payload, signature, extra] = (value || '').split('.');
  if (!payload || !signature || extra || !equal(signature, sign(payload, secret))) throw new Error('Invalid payment link.');
  const payment = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (!Number.isInteger(payment.expires) || payment.expires <= now) {
    const error = new Error('Payment link expired. Ask for a new link in the group.');
    error.code = 'LINK_EXPIRED';
    throw error;
  }
  return payment;
}
export function verifyWebhook(body, nonce, signature, secret) {
  if (!secret || typeof nonce !== 'string' || !nonce || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(nonce).update('.').update(body).digest('hex');
  return equal(signature, expected);
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) { const error = new Error('Request too large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createPaymentServer(secret, config = {}) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
      return;
    }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (req.method === 'GET' && files[path]) {
      try {
        const [file, type] = files[path];
        res.setHeader('Content-Type', `${type}; charset=utf-8`);
        res.end(await readFile(new URL(`./payment-page/${file}`, import.meta.url)));
      } catch { res.writeHead(500).end('Page unavailable'); }
      return;
    }
    if (req.method === 'POST' && path === '/webhook') {
      try {
        if (!config.merchantSecret || !config.store || !config.api) {
          config.logger?.('Payment webhook rejected', { reason: 'Webhook not configured', statusCode: 503 });
          res.writeHead(503).end('Webhook not configured'); return;
        }
        const raw = await readBody(req);
        if (!verifyWebhook(raw, req.headers['x-mmpay-nonce'], req.headers['x-mmpay-signature'], config.merchantSecret)) {
          config.logger?.('Payment webhook rejected', { reason: 'Invalid signature or missing signature headers', statusCode: 401 });
          res.writeHead(401).end('Invalid signature'); return;
        }
        if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end('Expected JSON'); return; }
        const payload = JSON.parse(raw.toString('utf8'));
        const updated = await config.store.receive(payload, config.api);
        config.logger?.('Payment webhook handled', { orderId: payload.orderId, status: payload.status, updated });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ received: true, updated }));
      } catch (error) {
        config.logger?.('Payment webhook rejected', { reason: error.message, statusCode: error.status || 400 });
        res.writeHead(error.status || 400).end('Webhook rejected');
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/payment') {
      try {
        const body = await readBody(req);
        const payment = readPayment(JSON.parse(body.toString()).token, secret);
        if (config.store) {
          const order = await config.store.get(payment.orderId);
          if (!order || order.amount !== payment.amount) throw new Error('Unknown order');
          if (!config.publishableKey) { res.writeHead(503).end(JSON.stringify({ error: 'Checkout is not configured. Contact the bot owner.' })); return; }
          payment.status = order.status;
          payment.currency = order.currency;
          payment.checkout = { publishableKey: config.publishableKey, merchantName: config.merchantName || 'MyanMyanPay',
            baseUrl: config.baseUrl || '', callbackUrl: config.callbackUrl };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payment));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'This link is invalid or expired. Request a new link in the group.',
          ...(error.code === 'LINK_EXPIRED' ? { code: error.code } : {}) }));
      }
      return;
    }
    res.writeHead(404).end('Not found');
  });
}
