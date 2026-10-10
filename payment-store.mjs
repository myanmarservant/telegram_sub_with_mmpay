export function amountMinor(value) {
  const raw = String(value);
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(raw)) throw new Error('Invalid amount');
  const [whole, fraction = ''] = raw.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function paidUntilTag(now = Date.now(), days = 30) {
  const until = new Date(Number(now) + days * 86400_000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Rangoon', day: '2-digit', month: '2-digit',
  }).formatToParts(until);
  const day = parts.find(part => part.type === 'day').value;
  const month = parts.find(part => part.type === 'month').value;
  return `Paid until ${day}/${month}`;
}

export class PaymentStore {
  constructor() { this.orders = new Map(); this.updates = new Map(); }
  register(payment, message, user) {
    this.orders.set(payment.orderId, { order_id: payment.orderId, amount: payment.amount,
      ...(user ? { user, name: payment.name, days: payment.days ?? 30 } : {}),
      chat_id: message.chat.id, thread_id: message.message_thread_id, status: 'PENDING' });
  }
  get(id) { return this.orders.get(id); }
  saveMessage(id, messageId) { this.get(id).message_id = messageId; }
  async persist(order) {}
  async tagPaidMember(order, api) {
    if (order.status !== 'SUCCESS' || !order.user || order.paid_tag_applied) return;
    try {
      order.paid_until_tag ??= order.paid_until ? paidUntilTag(order.paid_until, 0) : paidUntilTag(Date.now(), order.days ?? 30);
      await api('setChatMemberTag', { chat_id: order.chat_id, user_id: order.user.id, tag: order.paid_until_tag });
      order.paid_tag_applied = true;
      await this.persist(order);
    } catch {
      const error = new Error('Payment succeeded, but setting the Paid member tag failed. Check the bot Manage Tags permission and that the payer is a regular member.');
      error.status = 503;
      throw error;
    }
  }
  async receive(payload, api) {
    const previous = this.updates.get(payload.orderId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.applyResult(payload, api));
    this.updates.set(payload.orderId, current);
    try { return await current; }
    finally { if (this.updates.get(payload.orderId) === current) this.updates.delete(payload.orderId); }
  }
  async applyResult(payload, api) {
    const order = await this.get(payload.orderId);
    if (!order) { const error = new Error('Unknown order'); error.status = 404; throw error; }
    if (amountMinor(payload.amount) !== amountMinor(order.amount) || payload.currency !== 'MMK') throw new Error('Amount or currency mismatch');
    const rawStatus = typeof payload.status === 'string' ? payload.status.trim().toUpperCase() : '';
    const status = rawStatus === 'FAIL' ? 'FAILED' : rawStatus;
    if (!['SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status)) return false;
    if (order.status === status || order.status === 'SUCCESS') {
      await this.tagPaidMember(order, api);
      return false;
    }
    if (!order.message_id) { const error = new Error('Payment message not ready'); error.status = 503; throw error; }
    if (status === 'SUCCESS' && order.user && !order.paid_until) {
      order.paid_until = new Date(Date.now() + (order.days ?? 30) * 86400_000);
      await this.persist(order);
    }
    const title = { SUCCESS: '✅ Payment successful', FAILED: '❌ Payment failed', CANCELLED: '🚫 Payment cancelled', EXPIRED: '⌛ Payment failed — expired' }[status];
    try {
      await api('editMessageText', {
        chat_id: order.chat_id, message_id: order.message_id,
        text: `${order.user ? `${order.name}\n\n` : ''}${title}\n\n🧾 Order ID: ${order.order_id}\n💵 Amount: ${Number(order.amount).toLocaleString('en-US')} MMK\n\n${status === 'SUCCESS'
          ? 'Thank you! Your payment has been received.' : 'Please ask an admin for a new payment request.'}`,
        ...(order.user ? { entities: [{ type: 'text_mention', offset: 0, length: order.name.length, user: order.user }] } : {}),
        reply_markup: { inline_keyboard: status === 'SUCCESS' && order.destination_chat_id && order.invite_url
          ? [[{ text: 'Join paid members group', url: order.invite_url }]] : [] },
      });
    } catch (error) {
      if (!error.message?.includes('message is not modified')) {
        const retry = new Error('Telegram message update failed'); retry.status = 503; throw retry;
      }
    }
    order.status = status;
    await this.persist(order);
    await this.tagPaidMember(order, api);
    return true;
  }
}
