const status = document.getElementById('status');
const pay = document.getElementById('pay');
let payment, sdk, busy = false, completed = false;
let pollTimer, checking = false;
function showSuccess(verified = false) {
  completed = true;
  document.getElementById('success').hidden = false;
  document.getElementById('failure').hidden = true;
  document.getElementById('close-page').hidden = false;
  document.getElementById('page-title').textContent = 'Payment successful';
  document.getElementById('page-intro').hidden = true;
  document.getElementById('payment-notice').hidden = true;
  document.getElementById('success-message').textContent = verified
    ? 'Your payment has been received and confirmed.' : 'Checkout reported your payment as successful.';
  pay.hidden = true;
  status.textContent = verified ? 'Payment confirmed' : 'Waiting for verified confirmation...';
  document.title = 'Thank you | MyanMyanPay';
  if (verified) clearInterval(pollTimer);
  tick();
}
function showFailure(reason = 'failed') {
  completed = true;
  document.getElementById('success').hidden = true;
  document.getElementById('failure').hidden = false;
  document.getElementById('page-title').textContent = 'Payment failed';
  document.getElementById('page-intro').hidden = true;
  document.getElementById('payment-notice').hidden = true;
  document.getElementById('failure-message').textContent = reason === 'expired'
    ? 'Your payment expired. Please request a new link in your Telegram chat.'
    : reason === 'cancelled' ? 'Your payment was cancelled. Please request a new link in your Telegram chat.'
      : 'Your payment did not go through. Please request a new link in your Telegram chat.';
  document.getElementById('close-page').hidden = false;
  pay.hidden = true;
  pay.disabled = true;
  status.textContent = 'You can close this page now to continue.';
  document.title = 'Payment failed | MyanMyanPay';
  clearInterval(pollTimer);
}
document.getElementById('close-page').addEventListener('click', () => {
  if (window.Telegram?.WebApp?.close) window.Telegram.WebApp.close();
  else window.close();
  document.getElementById('close-help').hidden = false;
});
async function checkStatus() {
  if (checking || !payment || payment.expires <= Math.floor(Date.now() / 1000)) return;
  checking = true;
  try {
    const response = await fetch('/api/payment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: location.hash.slice(1) }),
    });
    if (!response.ok) return;
    const latest = await response.json();
    if (latest.status === 'SUCCESS') showSuccess(true);
    else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(latest.status)) showFailure(latest.status.toLowerCase());
  } catch { /* Keep checking after a temporary network failure. */ }
  finally { checking = false; }
}
function tick() {
  const expired = payment && payment.expires <= Math.floor(Date.now() / 1000);
  pay.disabled = !sdk || busy || completed || expired;
  if (expired && !completed) showFailure('expired');
}
async function load() {
  const token = location.hash.slice(1);
  if (!token) { status.textContent = 'Open Pay now from the payment message in your Telegram group.'; return; }
  try {
    const response = await fetch('/api/payment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    payment = await response.json();
    if (!response.ok) {
      if (payment.code === 'LINK_EXPIRED') { showFailure('expired'); return; }
      throw new Error(payment.error);
    }
    document.getElementById('amount').textContent = `${Number(payment.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} MMK`;
    document.getElementById('order-id').textContent = payment.orderId;
    document.getElementById('details').hidden = false;
    if (payment.status === 'SUCCESS') { showSuccess(true); return; }
    if (payment.status !== 'PENDING') {
      showFailure(payment.status.toLowerCase());
      return;
    }
    if (!window.MMPaySDK || !payment.checkout?.publishableKey) throw new Error('Checkout could not load. Refresh the page or contact support.');
    sdk = new window.MMPaySDK(payment.checkout.publishableKey, {
      merchantName: payment.checkout.merchantName,
      ...(payment.checkout.baseUrl ? { baseUrl: payment.checkout.baseUrl } : {}),
      design: { mode: 'dark', color: '#DE3163' },
    });
    status.textContent = 'Ready to pay';
    tick();
    setInterval(tick, 1000);
    pollTimer = setInterval(checkStatus, 3000);
  } catch (error) { status.textContent = error.message || 'Could not load payment details.'; }
}
const errors = {
  R000: 'Checkout is temporarily unavailable. Contact support.',
  R001: 'The merchant payment key is invalid. Contact support.',
  R002: 'The merchant payment key is not live yet. Contact support.',
  R003: 'This website must be allowed in the merchant settings.',
  R004: 'Checkout requires HTTPS. Open the secure payment link.',
  '429': 'Too many requests. Please wait and try again.',
};
pay.addEventListener('click', async () => {
  tick();
  if (pay.disabled) return;
  busy = true;
  tick();
  try {
    await sdk.showPaymentModal({ orderId: payment.orderId, amount: Number(payment.amount),
      currency: 'MMK', callbackUrl: payment.checkout.callbackUrl }, result => {
      if (!result || completed) return;
      if (result.success) {
        showSuccess();
        checkStatus();
      } else if (result.cancelled || result.failed || result.fail || result.expired || ['FAIL', 'FAILED', 'EXPIRED'].includes(String(result.status || '').toUpperCase())) {
        showFailure(result.expired ? 'expired' : result.cancelled ? 'cancelled' : 'failed');
      } else if (result.created) status.textContent = 'Your payment QR is ready. Follow the checkout instructions.';
      tick();
    });
  } catch (error) {
    const code = String(error?.code || error?.message || error).match(/R00[0-4]|429/)?.[0];
    status.textContent = errors[code] || 'Checkout could not open. Please try again or contact support.';
  } finally { busy = false; tick(); }
});
load();
