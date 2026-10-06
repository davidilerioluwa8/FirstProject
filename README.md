# WhatsApp Lists

Email-style mailing lists for WhatsApp. Create as many lists as you like, share a link or QR code, and anyone can join — **without you saving their number** — then send or schedule broadcasts to each list.

Built on the **official WhatsApp Business Cloud API** (no unofficial libraries, no risk of your number being banned for automation).

```
 Subscriber taps your link                Your server                       You (dashboard)
 wa.me/<number>?text=JOIN news   ──►  /webhook adds them to "news"   ◄──  create lists, copy join links/QR
 ◄── "Welcome! Reply STOP news…"       stores opt-in in SQLite             compose / schedule messages
                                       scheduler sends at the set time ──► delivery + read stats
 ◄── broadcast (template message)      status webhooks update stats
```

## Features

- **Multiple lists**, each with its own keyword, join link (`wa.me`) and QR code
- **Self-service opt-in/opt-out** over WhatsApp:
  | Subscriber sends | Effect |
  |---|---|
  | `JOIN <list>` | joins the list (the join link pre-fills this) |
  | `STOP <list>` | leaves that list |
  | `STOP` / `UNSUBSCRIBE` / a template's "Stop promotions" button | leaves every list |
  | `LISTS` | shows which lists they're on |
  | `HELP` | shows the commands |
- **Scheduled messages** — send now or pick a date/time; survives restarts and resumes half-sent broadcasts without double-sending
- **Personalisation** — `{{name}}` is replaced with each person's WhatsApp name
- **Delivery tracking** — sent / delivered / read / failed per recipient, from WhatsApp's status webhooks
- **Inbox** — see everything people send to your number
- **Mock mode + Simulator** — try the whole flow locally before you have a Meta account

## Quick start (mock mode — no Meta account needed)

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there are no native dependencies).

```bash
npm install
cp .env.example .env      # defaults to WHATSAPP_MODE=mock
npm run dev
```

Open http://localhost:3000 (login `admin` / the `ADMIN_PASSWORD` in `.env`), then:

1. **Lists** → create a list, e.g. keyword `newsletter`.
2. **Simulator** → send `JOIN newsletter` from a couple of made-up numbers. You'll see the welcome replies.
3. **Messages** → send a template message now, or schedule one. Watch it appear in the Simulator's outgoing messages.

Other commands: `npm test`, `npm run typecheck`, `npm run build && npm start` (production).

## Going live with WhatsApp

Budget an afternoon for the Meta setup plus a day or so for template approval.

### 1. Create the Meta app

1. Create a **Meta Business portfolio** at [business.facebook.com](https://business.facebook.com) if you don't have one.
2. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app** → choose the **Business** type → add the **WhatsApp** product.
3. In **WhatsApp → API Setup** you get a free **test number**. Copy its **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
   The test number can message up to 5 recipient numbers you verify there — enough to test end-to-end.
4. Copy **App settings → Basic → App secret** → `WHATSAPP_APP_SECRET`.

### 2. Get a permanent access token

The token shown on the API Setup page expires after 24 hours. For a permanent one:
**Business settings → Users → System users → Add** (Admin) → **Assign assets** (your app + WhatsApp account) → **Generate token** with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions → `WHATSAPP_ACCESS_TOKEN`.

### 3. Deploy and connect the webhook

WhatsApp needs a public **HTTPS** URL to deliver incoming messages.

- **Testing from your laptop:** `npx cloudflared tunnel --url http://localhost:3000` (or ngrok) gives you a temporary HTTPS URL.
- **Production:** any Node host works (Render, Railway, Fly.io, a VPS). Use a **persistent disk** for `DATABASE_PATH` and run a **single instance** (SQLite + in-process scheduler).

Set `.env` (or your host's environment variables):

```bash
WHATSAPP_MODE=cloud
WHATSAPP_BUSINESS_PHONE=2348012345678   # the number people will message, digits only
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=any-long-random-string
ADMIN_PASSWORD=a-strong-password
```

Then in the Meta app: **WhatsApp → Configuration → Webhook → Edit**
- Callback URL: `https://your-domain/webhook`
- Verify token: the same `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and save**, then **subscribe to the `messages` field**.

Send `JOIN <your-list>` to the business number from your phone — you should get the welcome reply and see yourself on the list.

### 4. Create message templates

Outside the 24-hour window after someone last messaged you, WhatsApp only lets businesses send **pre-approved templates**. Since broadcasts usually go out days later, you'll mostly send templates.

Create them in [WhatsApp Manager → Message templates](https://business.facebook.com/wa/manage/message-templates/). A reusable "newsletter" template might look like:

> **Name:** `list_update` · **Category:** Marketing · **Language:** English (US)
>
> Hi {{1}}, here's the latest from our community: {{2}}
>
> Reply STOP to unsubscribe.

In the dashboard you'd then send template `list_update`, language `en_US`, with parameters:

```
{{name}}
Sunday service starts at 9am this week — see you there!
```

Tips:
- Meta rejects templates that are almost all variables, or that start/end with a variable — keep some fixed text around them.
- Parameters can't contain line breaks, tabs or more than 4 spaces in a row (the dashboard checks this for you). For multi-paragraph content, put the fixed structure in the template itself.
- Add a quick-reply button "Stop promotions" — taps are handled as an unsubscribe from all lists.
- Template approval usually takes minutes to a day.

### 5. Use your real number and add billing

- **Add your own phone number** in WhatsApp Manager. It **can't be registered in the regular WhatsApp or WhatsApp Business app** at the same time — use a new number, or delete the WhatsApp account on it first.
- **Add a payment method** in WhatsApp Manager. Meta charges **per template message delivered**; the price depends on the category (marketing costs the most, utility less) and the recipient's country. Replies within 24 hours of a user's message are free. See [Meta's pricing page](https://developers.facebook.com/docs/whatsapp/pricing).
- **Verify your business** (Business settings → Security centre) to raise your messaging limit. New accounts can only start conversations with a limited number of unique people per 24 hours; the limit grows with verification and good quality ratings.

## Rules worth knowing

- **Opt-in only.** People are added only when *they* message you. There is deliberately no "import numbers" feature — messaging people who didn't opt in gets your number's quality rating lowered and eventually restricted.
- **Free-text messages** only reach people who messaged you in the last 24 hours; everyone else is marked *skipped*. Use templates for broadcasts.
- **Make leaving easy.** Every welcome message says how to leave; keep a "Reply STOP to unsubscribe" line in your templates.
- High block/report rates lower your quality rating. Send things people signed up for.

## Project structure

```
src/
  server.ts          entry point: config, database, WhatsApp client, scheduler, HTTP server
  app.ts             Express app: public /webhook, password-protected dashboard + /api
  config.ts          environment variables
  db.ts              SQLite schema (node:sqlite)
  store.ts           all database queries
  commands.ts        parses JOIN / STOP / LISTS / HELP; builds wa.me join links
  inbound.ts         handles incoming messages and delivery status webhooks
  webhook.ts         webhook verification + X-Hub-Signature-256 check
  scheduler.ts       sends due messages with rate limiting, resume-after-restart, 24h-window check
  api.ts             JSON API for the dashboard (+ simulator endpoints in mock mode)
  auth.ts            HTTP basic auth for the dashboard
  whatsapp/client.ts Cloud API client (with retry on throttling) and the mock client
public/              dashboard (plain HTML/CSS/JS, no build step)
test/                node:test suites
```

## Ideas for next steps

- Pull approved templates from the API (`GET /<WABA_ID>/message_templates`) into a dropdown with a preview
- Header images/documents in templates, and media in free-text messages
- Recurring schedules (e.g. every Monday 9am)
- Replying to people from the Inbox
- Multiple admin users; Postgres for multi-instance deployments
