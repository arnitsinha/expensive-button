/**
 * Payments. With STRIPE_SECRET_KEY set, presses go through Stripe Checkout
 * and are recorded by the webhook (app/api/stripe/webhook). Without it the
 * app runs in test mode and records presses immediately.
 *
 * Flow (live):
 *   1. POST /api/press validates input, creates a Checkout Session with the
 *      press details in metadata, returns its URL; the client redirects.
 *   2. Stripe sends `checkout.session.completed` to the webhook, which
 *      calls press(). Nothing is recorded on the client's word alone.
 *   3. If the amount is below the minimum by then (someone else paid first),
 *      the webhook refunds the payment and marks the session refunded so the
 *      returning user is told what happened.
 */
import Stripe from "stripe";

export const stripeEnabled = !!process.env.STRIPE_SECRET_KEY;

let client: Stripe | null = null;
function stripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    client = new Stripe(key);
  }
  return client;
}

export type PressIntent = {
  amount: number; // whole dollars
  name: string;
  site: string | null;
};

/** Create a Checkout Session and return the URL to send the user to. */
export async function createCheckout(
  intent: PressIntent,
  origin: string,
): Promise<string> {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: intent.amount * 100,
          product_data: {
            name: "One press of The Expensive Button",
            description: `Puts "${intent.name}" on the button until someone pays more. All sales final.`,
            // Required for Stripe Managed Payments / Tax. "General -
            // Electronically Supplied Services": a digital placement.
            tax_code: process.env.STRIPE_TAX_CODE ?? "txcd_10000000",
          },
        },
      },
    ],
    metadata: {
      name: intent.name,
      site: intent.site ?? "",
      amount: String(intent.amount),
    },
    success_url: `${origin}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?canceled=1`,
    // Stripe requires expires_at to be at least 30 minutes out; use 60 so
    // clock skew can't reject it. Stale minimums are handled by the webhook.
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

/** Verify a webhook payload and return the event. Throws on bad signature. */
export function constructEvent(payload: string, signature: string) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return stripe().webhooks.constructEvent(payload, signature, secret);
}

export async function refundSession(session: Stripe.Checkout.Session) {
  const pi =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!pi) return;
  await stripe().refunds.create({ payment_intent: pi });
}

/** Test-mode "charge": always succeeds. Used when Stripe isn't configured. */
export async function fakeCharge(intent: PressIntent): Promise<string> {
  await new Promise((r) => setTimeout(r, 300));
  return `test_${Date.now().toString(36)}_${intent.amount}`;
}
