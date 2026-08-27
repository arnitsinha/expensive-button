/**
 * Minimal name moderation. This is a starting blocklist, not a complete one:
 * extend it, and add words at runtime via BLOCKED_WORDS="foo,bar" in env.
 * Anything that slips through can be hidden with DELETE /api/admin/press.
 */
const BUILT_IN = [
  "nigg",
  "fagg",
  "kike",
  "chink",
  "spic",
  "tranny",
  "retard",
  "hitler",
  "nazi",
  "kys",
  "rape",
];

function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .replace(/[0@]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5\$/g, "s")
    .replace(/[^a-z]/g, ""); // drop spaces/punctuation so "n.i.g.g" is caught
}

let cached: string[] | null = null;
function words() {
  if (!cached) {
    const extra = (process.env.BLOCKED_WORDS ?? "")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    cached = [...BUILT_IN, ...extra].map(normalize).filter(Boolean);
  }
  return cached;
}

export function isBlocked(name: string): boolean {
  const n = normalize(name);
  return words().some((w) => n.includes(w));
}
