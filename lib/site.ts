/**
 * Website handling: URL normalization/validation and favicon discovery.
 * Everything here runs server-side only.
 */

const FETCH_TIMEOUT_MS = 5000;
const HTML_MAX_BYTES = 256 * 1024;
const ICON_MAX_BYTES = 512 * 1024;
const UA = "ExpensiveButtonBot/0.1 (+favicon fetch)";

/**
 * Accepts "example.com", "www.example.com/path", "https://example.com" etc.
 * Returns a normalized https?:// origin+path string, or null if unusable.
 * Rejects localhost, IP literals and non-public-looking hosts so we never
 * fetch from inside our own network.
 */
export function normalizeSiteUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();
  if (!isPublicHostname(host)) return null;

  url.hash = "";
  url.search = "";
  // Drop trailing slash on bare origins for tidiness.
  const s = url.toString();
  return s.endsWith("/") && url.pathname === "/" ? s.slice(0, -1) : s;
}

export function isPublicHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  // IPv4 / IPv6 literals
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.startsWith("[") || host.includes(":")) return false;
  // Must look like a real domain with a TLD.
  return /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(host);
}

export function hostnameOf(site: string): string {
  try {
    return new URL(site).hostname.replace(/^www\./, "");
  } catch {
    return site;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "*/*", ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

async function readCapped(
  res: Response,
  max: number,
): Promise<Uint8Array | null> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength > max ? null : buf;
}

/** Parse <link rel="icon"...> candidates out of an HTML document. */
export function extractIconHrefs(html: string, base: string): string[] {
  const out: { href: string; score: number }[] = [];
  const linkRe = /<link\b[^>]*>/gi;
  for (const m of html.matchAll(linkRe)) {
    const tag = m[0];
    const rel =
      /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!/\bicon\b/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href) continue;
    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    // Prefer explicit icons and larger sizes; apple-touch-icon is a fine fallback.
    const sizes = /\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1];
    let score = rel.includes("apple") ? 10 : 50;
    if (sizes) score += Math.min(Number(sizes), 512) / 10;
    if (/\.svg(\?|$)/i.test(abs)) score += 5;
    out.push({ href: abs, score });
  }
  return out
    .sort((a, b) => b.score - a.score)
    .map((x) => x.href)
    .filter((h, i, arr) => arr.indexOf(h) === i);
}

export type Icon = { bytes: Uint8Array; contentType: string };

async function tryIcon(url: string): Promise<Icon | null> {
  try {
    const u = new URL(url);
    if (!isPublicHostname(u.hostname.toLowerCase())) return null;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const ct =
      res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!ct.startsWith("image/") && ct !== "application/octet-stream")
      return null;
    const bytes = await readCapped(res, ICON_MAX_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;
    return {
      bytes,
      contentType: ct === "application/octet-stream" ? "image/x-icon" : ct,
    };
  } catch {
    return null;
  }
}

/**
 * Discover a site's favicon: <link rel=icon> from the homepage HTML,
 * then /favicon.ico, then Google's favicon service as a last resort.
 */
export async function fetchFavicon(site: string): Promise<Icon | null> {
  const origin = new URL(site).origin;

  // 1. Icons declared in the HTML.
  try {
    const res = await fetchWithTimeout(site, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (res.ok) {
      const bytes = await readCapped(res, HTML_MAX_BYTES);
      if (bytes) {
        const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        for (const href of extractIconHrefs(html, res.url || site).slice(
          0,
          4,
        )) {
          const icon = await tryIcon(href);
          if (icon) return icon;
        }
      }
    }
  } catch {}

  // 2. Conventional location.
  const ico = await tryIcon(`${origin}/favicon.ico`);
  if (ico) return ico;

  // 3. Google's cache (handles sites that block bots).
  const host = new URL(site).hostname;
  return tryIcon(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`,
  );
}
