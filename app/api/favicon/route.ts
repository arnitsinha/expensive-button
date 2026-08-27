import {
  fetchFavicon,
  normalizeSiteUrl,
  type Icon,
  type Trace,
} from "@/lib/site";

export const dynamic = "force-dynamic";

// In-memory cache. Successes are held for a while; misses only briefly, so a
// transient cold-start timeout doesn't hide a real icon for hours.
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { icon: Icon | null; expires: number }>();
const inflight = new Map<string, Promise<Icon | null>>();

// 1x1 transparent PNG for sites with no discoverable icon.
const BLANK = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function lookup(site: string, trace?: Trace): Promise<Icon | null> {
  const hit = cache.get(site);
  if (hit && hit.expires > Date.now()) {
    trace?.push("cache hit");
    return hit.icon;
  }
  let p = inflight.get(site);
  if (!p) {
    p = fetchFavicon(site, trace)
      .catch(() => null)
      .then((icon) => {
        cache.set(site, {
          icon,
          expires: Date.now() + (icon ? OK_TTL_MS : MISS_TTL_MS),
        });
        inflight.delete(site);
        return icon;
      });
    inflight.set(site, p);
  }
  return p;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const raw = params.get("site") ?? "";
  const site = normalizeSiteUrl(raw);
  if (!site) return new Response("bad site", { status: 400 });

  // ?debug=1 bypasses the cache and reports what each discovery step did.
  if (params.get("debug") === "1") {
    const trace: Trace = [];
    cache.delete(site);
    inflight.delete(site);
    const icon = await lookup(site, trace);
    return Response.json(
      {
        site,
        found: !!icon,
        contentType: icon?.contentType ?? null,
        bytes: icon?.bytes.byteLength ?? 0,
        trace,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const icon = await lookup(site);
  const body = icon ? icon.bytes : BLANK;
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": icon ? icon.contentType : "image/png",
      // `private` keeps this out of Netlify's shared CDN, whose cache key
      // ignores the `site` query param and would otherwise serve one site's
      // favicon for every site. The browser still caches per full URL, and
      // the function keeps its own in-memory cache, so repeat loads are cheap.
      "Cache-Control": "private, max-age=86400",
      "Netlify-CDN-Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
