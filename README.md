# Telegram Payment Bot

Collect MMK payments with MyanMyanPay and manage paid Telegram group access.

## Quick start

You need **Node.js 24**, a bot token from [BotFather](https://t.me/BotFather), MyanMyanPay merchant keys, and a MongoDB database.

1. Download or clone this repository.
2. Run `npm ci`.
3. Copy `.env` to `.env.local` and enter your credentials.
4. Run `npm start`.
5. Add the bot as an administrator in your Telegram group.

To copy the settings on Windows PowerShell:

```powershell
Copy-Item .env .env.local
```

On macOS or Linux, use `cp .env .env.local`.

**The included `.env` is a public template. Keep real credentials in `.env.local`, which Git ignores. Never add credentials to the tracked templates.**

## Settings

| Variable | What to enter |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Your BotFather token |
| `PAYMENT_BASE_URL` | Your public HTTPS URL; localhost works for local page testing |
| `PAYMENT_PORT` | Local port, normally `3000` |
| `PAYMENT_LINK_SECRET` | A private random secret of at least 32 characters |
| `MMPAY_PUBLISHABLE_KEY` | Your MyanMyanPay publishable key |
| `MMPAY_SECRET_KEY` | Your MyanMyanPay merchant secret |
| `MONGODB_URI` | Your MongoDB connection string |
| `MONGODB_DATABASE` | Normally `telegram_payments` |

Generate a random signing secret with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Commands

| Command | What it does |
| --- | --- |
| `/charge 5000` | Creates one shared payment request for 5,000 MMK |
| `/subconfig` | Sets up the private group subscribers can join |
| `/groupid` | Shows the group ID for setup |
| `/sub 5000 60` | Lets members generate personal payment links for 60 days |
| `/sub 5000` | Uses the default duration of 30 days |
| `/check` | Removes expired subscribers from the configured group |

Payment and subscription management commands require group administrator access. Members can use the subscription payment buttons.

For subscriptions, make the bot an administrator in both groups. Give it **Manage Tags** in the payment group and **Invite Users** and **Ban Users** in the private members group. Run `/subconfig` in the payment group and follow the instructions.

Amounts must be whole numbers from 1,000 to 10,000,000 MMK. Subscription duration must be 1–3650 days. Payment links last 15 minutes.

Each successful subscription starts from its payment time, including renewals. An administrator must run `/check` to remove expired members; there is no automatic removal timer. Keep the members group private and revoke older direct-entry invite links.

## Deploy

The Dockerfile and Railway configuration are included.

1. Deploy the repository and enter your environment variables in the hosting service.
2. Set `PAYMENT_BASE_URL` to your public HTTPS URL.
3. Allow that URL in your MyanMyanPay merchant settings. Configure the POST callback to `https://your-domain.example/webhook`.
4. Run **one instance** and stop the local bot.
5. Check `/health`, then try a payment.

The Docker image excludes local environment files. Railway's `PORT` overrides `PAYMENT_PORT`. MongoDB must be reachable from the server. Keep the same signing secret across deployments.

Localhost cannot receive provider callbacks. Use public HTTPS for complete payment testing. `/health` checks the HTTP server, not Telegram connectivity.

## Tests and contributions

Run `npm test` before submitting a pull request. Tests use mocks and do not contact Telegram, MongoDB, or the payment provider.

Bug reports and pull requests are welcome. Remove credentials and personal payment information from reports and screenshots.

## License

[MIT](LICENSE)
