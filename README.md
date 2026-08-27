# The Expensive Button

One button. Pay what you want, as long as it beats the last press. Your name
(and your site's favicon) stays on the button until someone pays more.

Next.js 16 (App Router) · Tailwind · Stripe Checkout · Netlify Blobs

## Run locally

```bash
npm install
npm run dev
```

With no env vars set the app runs in **test mode**: payments are faked, the
ledger lives in `data/button.json`, and a "Test mode" badge shows on the page.

## Deploy to Netlify

1. Push this repo to GitHub.
2. Netlify → **Add new site → Import from Git** → pick the repo. The
   `netlify.toml` already sets the build command and the Next.js plugin.
3. **Site configuration → Environment variables**, add:

   | Variable | Value |
   | --- | --- |
   | `STRIPE_SECRET_KEY` | `sk_live_...` (or `sk_test_...` while testing) |
   | `STRIPE_WEBHOOK_SECRET` | from step 5 |
   | `ADMIN_TOKEN` | any long random string (used to hide abusive presses) |
   | `NEXT_PUBLIC_SITE_URL` | `https://your-domain.com` (no trailing slash) |
   | `NEXT_PUBLIC_CONTACT_EMAIL` | address shown in the footer |

   The ledger is stored in Netlify Blobs automatically; nothing to configure.
4. Deploy.
5. Stripe Dashboard → **Developers → Webhooks → Add endpoint**:
   - URL: `https://your-domain.com/api/stripe/webhook`
   - Event: `checkout.session.completed`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy.
6. Do one real $1 press with your own card. Check the Stripe dashboard shows
   the payment and the ledger shows the press.

## How a paid press works

```text
browser  --POST /api/press-->  server creates Stripe Checkout Session
browser  --redirect-------->  Stripe Checkout (card entry)
Stripe   --webhook--------->  /api/stripe/webhook verifies signature,
                              records the press (idempotent on session id)
browser  <--redirect--------  /?paid=1&session_id=... polls /api/checkout
                              until the webhook has landed
```

If two people pay at once and the second payment arrives below the new
minimum, the webhook refunds it in full and the returning user is told.

## Moderation

- Names go through a small blocklist (`lib/moderation.ts`). Add more words
  with `BLOCKED_WORDS=word1,word2`.
- Hide a press from the ledger (the minimum price is kept):

  ```bash
  curl -X DELETE "https://your-domain.com/api/admin/press?id=42" \
       -H "Authorization: Bearer $ADMIN_TOKEN"
  ```

## API

| Route | Purpose |
| --- | --- |
| `GET /api/state` | current price, holder, ledger |
| `POST /api/press` `{name, amount, site?}` | start a press (returns `checkoutUrl` live, or the new state in test mode) |
| `GET /api/checkout?session_id=` | `pressed` / `refunded` / `pending` |
| `GET /api/favicon?site=` | cached favicon proxy for the button and ledger |
| `POST /api/stripe/webhook` | Stripe → record press |
| `DELETE /api/admin/press?id=` | hide a press (admin) |

## Notes

- Rate limiting and the favicon cache are in-memory (best effort per
  serverless instance). Stripe Checkout is the real throttle on presses.
- Favicon fetching blocks localhost, IP literals and `.local`/`.internal`
  hosts, but not public hostnames that resolve to private IPs.
