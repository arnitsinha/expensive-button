import { fetchFavicon, normalizeSiteUrl, type Icon } from "@/lib/site";

export const dynamic = "force-dynamic";

// Simple in-memory cache so a popular holder doesn't hammer their own site.
const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { icon: Icon | null; expires: number }>();
const inflight = new Map<string, Promise<Icon | null>>();

// 1x1 transparent PNG for sites with no discoverable icon.
const BLANK = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function lookup(site: string): Promise<Icon | null> {
  const hit = cache.get(site);
  if (hit && hit.expires > Date.now()) return hit.icon;
  let p = inflight.get(site);
  if (!p) {
    p = fetchFavicon(site)
      .catch(() => null)
      .then((icon) => {
        cache.set(site, { icon, expires: Date.now() + TTL_MS });
        inflight.delete(site);
        return icon;
      });
    inflight.set(site, p);
  }
  return p;
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("site") ?? "";
  const site = normalizeSiteUrl(raw);
  if (!site) return new Response("bad site", { status: 400 });

  const icon = await lookup(site);
  const body = icon ? icon.bytes : BLANK;
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": icon ? icon.contentType : "image/png",
      "Cache-Control": "public, max-age=21600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
