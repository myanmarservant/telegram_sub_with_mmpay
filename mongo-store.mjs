import { MongoClient } from 'mongodb';
import { PaymentStore } from './payment-store.mjs';

export class MongoPaymentStore extends PaymentStore {
  constructor(db) {
    super();
    const collection = db.collection('payment_orders');
    // Database outages must ask the payment provider to retry, not reject a verified payment.
    this.collection = Object.fromEntries(['createIndex', 'insertOne', 'findOne', 'updateOne', 'replaceOne'].map(method => [method, async (...args) => {
      try { return await collection[method](...args); }
      catch {
        const error = new Error('Payment database unavailable'); error.status = 503; throw error;
      }
    }]));
    this.settings = db.collection('bot_settings');
    this.rawOrders = collection;
  }
  async initialize() {
    await this.collection.createIndex({ order_id: 1 }, { unique: true });
    await this.collection.createIndex({ destination_chat_id: 1, 'user.id': 1, status: 1, paid_until: 1 });
    await this.collection.createIndex({ status: 1, expiry_processed: 1, paid_until: 1 });
  }
  async expiredSubscriptions(now = new Date(), destinationChatId) {
    return this.rawOrders.find({ status: 'SUCCESS', destination_chat_id: destinationChatId ?? { $type: 'number' },
      'user.id': { $type: 'number' }, paid_until: { $lte: now }, expiry_processed: { $ne: true } })
      .sort({ paid_until: 1 }).limit(100).toArray();
  }
  async markExpiry(orderId, fields) {
    await this.collection.updateOne({ order_id: orderId }, { $set: fields });
  }
  async register(payment, message, user) {
    super.register(payment, message, user);
    const order = super.get(payment.orderId);
    this.orders.delete(payment.orderId);
    if (user) {
      const config = await this.getSubscriptionConfig(message.chat.id);
      if (!config) throw new Error('Subscriptions are not configured. Run /subconfig first.');
      order.destination_chat_id = config.destination_chat_id;
      order.invite_url = config.invite_url;
    }
    await this.collection.insertOne(order);
  }
  get(id) { return this.collection.findOne({ order_id: id }); }
  async saveMessage(id, messageId) {
    await this.collection.updateOne({ order_id: id }, { $set: { message_id: messageId } });
  }
  async persist(order) {
    await this.collection.replaceOne({ order_id: order.order_id }, order);
  }
  async hasActiveSubscription(userId, destinationChatId, now = new Date()) {
    return Boolean(await this.collection.findOne({ 'user.id': userId,
      destination_chat_id: destinationChatId, status: 'SUCCESS', paid_until: { $gt: now } }));
  }
  getSubscriptionConfig(chatId) { return this.settings.findOne({ _id: `subscription:${chatId}` }); }
  async isSubscriptionDestination(chatId) {
    return Boolean(await this.settings.findOne({ kind: 'subscription_config', destination_chat_id: chatId }));
  }
  async saveSubscriptionConfig(sourceChatId, destinationChatId, inviteUrl, adminId) {
    await this.settings.updateOne({ _id: `subscription:${sourceChatId}` }, { $set: {
      kind: 'subscription_config', source_chat_id: sourceChatId, destination_chat_id: destinationChatId,
      invite_url: inviteUrl, configured_by: adminId, updated_at: new Date(),
    } }, { upsert: true });
  }
  async saveSetup(chatId, userId, promptId) {
    await this.settings.updateOne({ _id: `setup:${chatId}:${userId}` }, { $set: {
      prompt_id: promptId, expires_at: new Date(Date.now() + 15 * 60_000),
    } }, { upsert: true });
  }
  getSetup(chatId, userId) { return this.settings.findOne({ _id: `setup:${chatId}:${userId}` }); }
  async finishSetup(chatId, userId) {
    await this.settings.updateOne({ _id: `setup:${chatId}:${userId}` }, { $set: { expires_at: new Date(0) } });
  }
}

export async function connectMongoStore(uri, database) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const store = new MongoPaymentStore(client.db(database));
    await store.initialize();
    return { store, close: () => client.close() };
  } catch {
    await client.close();
    throw new Error('MongoDB connection failed. Check MONGODB_URI, network access, and database permissions.');
  }
}
