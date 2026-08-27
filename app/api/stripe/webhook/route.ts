import type Stripe from "stripe";
import { constructEvent, refundSession, stripeEnabled } from "@/lib/payments";
import { markRefunded, press, PriceTooLowError } from "@/lib/store";
import { normalizeSiteUrl } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * Stripe -> us. This is the ONLY place a paid press gets recorded.
 * Configure the endpoint in the Stripe dashboard for the event
 * `checkout.session.completed` and put its signing secret in
 * STRIPE_WEBHOOK_SECRET.
 */
export async function POST(request: Request) {
  if (!stripeEnabled) {
    return new Response("Stripe not configured", { status: 404 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    // Raw body is required for signature verification.
    event = constructEvent(await request.text(), signature);
  } catch (e) {
    console.warn("webhook signature failed", e);
    return new Response("Bad signature", { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return Response.json({ received: true, ignored: event.type });
  }

  const session = event.data.object;
  if (session.payment_status !== "paid") {
    return Response.json({ received: true, ignored: "unpaid" });
  }

  const name = (session.metadata?.name ?? "").slice(0, 24).trim();
  const site = session.metadata?.site
    ? normalizeSiteUrl(session.metadata.site)
    : null;
  // Trust Stripe's amount, not metadata.
  const amount = Math.round((session.amount_total ?? 0) / 100);

  if (!name || amount < 1) {
    console.error("webhook: malformed session", session.id);
    return Response.json({ received: true, ignored: "malformed" });
  }

  try {
    await press(name, amount, site, session.id);
    return Response.json({ received: true, recorded: true });
  } catch (e) {
    if (e instanceof PriceTooLowError) {
      // Someone else's payment landed first. Give the money back.
      try {
        await refundSession(session);
        await markRefunded(session.id);
        console.info("webhook: refunded outbid session", session.id);
      } catch (re) {
        console.error("webhook: refund failed", session.id, re);
        // 500 so Stripe retries; refund + markRefunded are safe to repeat.
        return new Response("Refund failed", { status: 500 });
      }
      return Response.json({ received: true, refunded: true });
    }
    console.error("webhook: press failed", e);
    return new Response("Store error", { status: 500 }); // Stripe will retry
  }
}
