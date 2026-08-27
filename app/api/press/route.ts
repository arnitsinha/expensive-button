import { press, PriceTooLowError, ConflictError } from "@/lib/store";
import { normalizeSiteUrl } from "@/lib/site";
import { createCheckout, fakeCharge, stripeEnabled } from "@/lib/payments";
import { isBlocked } from "@/lib/moderation";

export const dynamic = "force-dynamic";

const NAME_MAX = 24;
const AMOUNT_MAX = 1_000_000;
const SITE_MAX = 200;

// Per-IP rate limit: one press every RATE_MS. In-memory, so best-effort
// across serverless instances; Stripe Checkout is the real throttle.
const RATE_MS = 2000;
const lastPressByIp = new Map<string, number>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const last = lastPressByIp.get(ip) ?? 0;
  if (now - last < RATE_MS) return true;
  lastPressByIp.set(ip, now);
  if (lastPressByIp.size > 10_000) {
    for (const [k, t] of lastPressByIp)
      if (now - t > RATE_MS) lastPressByIp.delete(k);
  }
  return false;
}

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (
    fwd?.split(",")[0].trim() || request.headers.get("x-real-ip") || "local"
  );
}

function siteOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.URL;
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    url.host;
  return `${proto}://${host}`;
}

// Control characters (C0 + DEL), written as escapes so they survive editors.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

export async function POST(request: Request) {
  if (rateLimited(clientIp(request))) {
    return Response.json(
      { error: "Easy there - one press every couple of seconds." },
      { status: 429, headers: { "Retry-After": "2" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const obj = (typeof body === "object" && body ? body : {}) as Record<
    string,
    unknown
  >;
  const rawName = obj.name;
  const amount = obj.amount;
  const rawSite = obj.site;

  if (typeof rawName !== "string") {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  // Strip control chars, collapse whitespace, cap length.
  const name = rawName
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);

  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  if (isBlocked(name)) {
    return Response.json(
      { error: "That name isn't allowed on the button." },
      { status: 400 },
    );
  }

  if (
    typeof amount !== "number" ||
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > AMOUNT_MAX
  ) {
    return Response.json(
      { error: "amount must be a whole number of dollars" },
      { status: 400 },
    );
  }

  let site: string | null = null;
  if (rawSite !== undefined && rawSite !== null && rawSite !== "") {
    if (typeof rawSite !== "string" || rawSite.length > SITE_MAX) {
      return Response.json({ error: "site must be a URL" }, { status: 400 });
    }
    site = normalizeSiteUrl(rawSite);
    if (!site) {
      return Response.json(
        { error: "That doesn't look like a public website (e.g. example.com)" },
        { status: 400 },
      );
    }
  }

  try {
    if (stripeEnabled) {
      // Live: hand off to Stripe Checkout. The webhook records the press.
      const checkoutUrl = await createCheckout(
        { amount, name, site },
        siteOrigin(request),
      );
      return Response.json({ checkoutUrl });
    }
    // Test mode: record immediately.
    const ref = await fakeCharge({ amount, name, site });
    return Response.json(await press(name, amount, site, ref));
  } catch (e) {
    if (e instanceof PriceTooLowError) {
      // Someone outbid them while they were deciding.
      return Response.json(
        {
          error: `Too slow - the minimum is now $${e.minimum}`,
          minimum: e.minimum,
        },
        { status: 409 },
      );
    }
    if (e instanceof ConflictError) {
      return Response.json({ error: "Busy - try again" }, { status: 503 });
    }
    console.error("press failed", e);
    return Response.json({ error: "Payment setup failed" }, { status: 500 });
  }
}
