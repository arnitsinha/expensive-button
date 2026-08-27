"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ButtonState, Press } from "@/lib/store";
import { hostnameOf } from "@/lib/site";

const POLL_MS = 3000;

/* ------------------------------------------------------------------ */
/* Persisted form fields (name, site) via localStorage + useSyncExternalStore
   so we never setState inside an effect and never mismatch on hydration. */

function persisted(key: string) {
  const listeners = new Set<() => void>();
  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    get() {
      try {
        return localStorage.getItem(key) ?? "";
      } catch {
        return "";
      }
    },
    getServer: () => "",
    set(v: string) {
      try {
        localStorage.setItem(key, v);
      } catch {}
      listeners.forEach((cb) => cb());
    },
  };
}
const nameStore = persisted("expensive-button:name");
const siteStore = persisted("expensive-button:site");

function usePersisted(store: ReturnType<typeof persisted>) {
  return useSyncExternalStore(store.subscribe, store.get, store.getServer);
}

/* ------------------------------------------------------------------ */

const inputClass =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-base text-zinc-900 outline-none focus:border-red-500 focus:ring-2 focus:ring-red-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

const stepperClass =
  "flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 border-zinc-300 bg-white text-2xl font-bold text-zinc-700 shadow transition select-none enabled:hover:border-red-500 enabled:hover:text-red-600 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 sm:h-14 sm:w-14 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";

function faviconSrc(site: string) {
  return `/api/favicon?site=${encodeURIComponent(site)}`;
}

function Favicon({ site, size }: { site: string; size: number }) {
  // Proxied through our own API; next/image adds nothing here.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={faviconSrc(site)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-md bg-white/90 object-contain p-0.5"
      style={{ width: size, height: size }}
    />
  );
}

function money(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function timeAgo(iso: string, now: number) {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${m}:${pad(sec)}`;
}

/** Ticks once a second, but only after mount (so SSR output is stable). */
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    // First tick on the next frame rather than synchronously in the effect.
    const raf = requestAnimationFrame(tick);
    return () => {
      clearInterval(id);
      cancelAnimationFrame(raf);
    };
  }, [intervalMs]);
  return now;
}

type Toast = { id: number; text: string; kind: "info" | "win" };

/* ------------------------------------------------------------------ */

export default function ExpensiveButton({ initial }: { initial: ButtonState }) {
  const [state, setState] = useState<ButtonState>(initial);
  const name = usePersisted(nameStore);
  const site = usePersisted(siteStore);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [copied, setCopied] = useState(false);
  // Extra dollars above the minimum the payer has chosen.
  const [extra, setExtra] = useState(0);
  const lastId = useRef(initial.presses[0]?.id ?? 0);
  const myLastPress = useRef<number | null>(null);
  const payBtn = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const now = useNow();

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const apply = useCallback(
    (next: ButtonState, mine = false) => {
      setState(next);
      const newest = next.presses[0];
      if (newest && newest.id !== lastId.current) {
        lastId.current = newest.id;
        setFlash(true);
        setTimeout(() => setFlash(false), 700);
        if (mine) {
          myLastPress.current = newest.id;
          toast(`You're on the button for ${money(newest.price)}!`, "win");
        } else if (myLastPress.current !== null) {
          toast(`${newest.name} just took it for ${money(newest.price)}.`);
        } else {
          toast(`${newest.name} pressed for ${money(newest.price)}.`);
        }
      }
    },
    [toast],
  );

  // Poll so every open tab sees new presses.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (res.ok && alive) apply((await res.json()) as ButtonState);
      } catch {}
    };
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [apply]);

  // Keyboard: Escape closes the modal; focus Pay when it opens.
  useEffect(() => {
    if (!confirming) return;
    payBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setConfirming(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, busy]);

  // Back from Stripe Checkout: find out what happened to the session.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const paid = params.get("paid") === "1";
    const canceled = params.get("canceled") === "1";
    if (!paid && !canceled) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (canceled) {
      const t = setTimeout(
        () => toast("Checkout canceled. The button is still waiting."),
        0,
      );
      return () => clearTimeout(t);
    }
    if (!sessionId) return;
    let alive = true;
    let tries = 0;
    const check = async () => {
      if (!alive) return;
      tries += 1;
      try {
        const res = await fetch(
          `/api/checkout?session_id=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        const { status } = (await res.json()) as { status: string };
        if (status === "pressed") {
          const fresh = await fetch("/api/state", { cache: "no-store" });
          if (fresh.ok && alive)
            apply((await fresh.json()) as ButtonState, true);
          return;
        }
        if (status === "refunded") {
          toast(
            "Someone paid more while you were checking out. You've been refunded in full.",
          );
          return;
        }
      } catch {}
      if (tries < 15)
        setTimeout(check, 1500); // webhook usually lands in <5s
      else toast("Payment received - the ledger will update shortly.");
    };
    const t = setTimeout(() => {
      toast("Confirming your payment…");
      check();
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [apply, toast]);

  const trimmed = name.trim();
  const trimmedSite = site.trim();
  const holder = state.presses[0] ?? null;
  const isHolder = !!trimmed && state.holder === trimmed;
  const minimum = state.price;
  const amount = minimum + extra;
  const step = amount >= 1000 ? 100 : amount >= 100 ? 10 : 1;
  const bump = (d: number) => setExtra((x) => Math.max(0, x + d));

  const biggest = state.presses.reduce<Press | null>(
    (best, p) => (best && best.price >= p.price ? best : p),
    null,
  );
  const reign = holder && now ? now - new Date(holder.at).getTime() : null;

  function openConfirm() {
    if (busy) return;
    if (!trimmed) {
      // No name yet: send them to the field instead of a dead button.
      nameInput.current?.focus();
      toast("Add your name first - it goes on the button.");
      return;
    }
    setError(null);
    setConfirming(true);
  }

  async function confirmPress() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/press", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          amount,
          site: trimmedSite || undefined,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && typeof data.minimum === "number") {
        // Outbid while deciding: adopt the new minimum, keep their extra.
        const fresh = await fetch("/api/state", { cache: "no-store" });
        if (fresh.ok) apply((await fresh.json()) as ButtonState);
        throw new Error(
          `Someone beat you to it - the minimum is now ${money(data.minimum)}. Pay that instead?`,
        );
      }
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      if (typeof data.checkoutUrl === "string") {
        // Live mode: off to Stripe Checkout. The webhook records the press
        // and we pick the result up from ?paid=1&session_id=... on return.
        window.location.assign(data.checkoutUrl);
        return;
      }
      apply(data as ButtonState, true);
      setExtra(0);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const text = holder
      ? `${holder.name} is on The Expensive Button for ${money(holder.price)}. Beat it for ${money(minimum)}.`
      : "The Expensive Button - one button, pay what you want, beat the last press.";
    const url = location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "The Expensive Button", text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text} ${url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-10">
      {/* Stats */}
      <div className="flex flex-wrap justify-center gap-x-8 gap-y-3 text-center text-xs text-zinc-500 sm:text-sm dark:text-zinc-400">
        <div>
          <div className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {state.presses.length.toLocaleString()}
          </div>
          presses
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {money(state.totalRaised)}
          </div>
          spent so far
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {biggest ? money(biggest.price) : "-"}
          </div>
          biggest press{biggest ? ` (${biggest.name})` : ""}
        </div>
      </div>

      {/* The button, flanked by pay-what-you-want steppers */}
      <div className="flex items-center gap-3 sm:gap-6">
        <button
          type="button"
          aria-label={`Pay $${step} less`}
          disabled={extra === 0 || busy}
          onClick={() => bump(-step)}
          className={stepperClass}
        >
          &minus;
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={openConfirm}
          className={`group relative flex aspect-square w-56 flex-col items-center justify-center rounded-full border-b-[14px] border-red-900 bg-red-600 text-white shadow-2xl transition-all duration-150 select-none sm:w-72
          enabled:hover:bg-red-500 enabled:active:translate-y-2 enabled:active:border-b-[6px]
          disabled:cursor-not-allowed disabled:opacity-60
          ${flash ? "scale-105 ring-8 ring-yellow-400/60" : ""}`}
        >
          {state.holderSite && (
            <span className="mb-2 rounded-xl bg-white p-1 shadow-lg">
              <Favicon site={state.holderSite} size={40} />
            </span>
          )}
          <span className="text-[10px] font-semibold uppercase tracking-[0.3em] text-red-200 sm:text-xs">
            {isHolder ? "you own this" : extra > 0 ? "flex for" : "press for"}
          </span>
          <span className="mt-1 text-5xl font-black tabular-nums drop-shadow sm:text-6xl">
            {money(amount)}
          </span>
          <span className="mt-3 max-w-[85%] truncate text-xs text-red-100 sm:text-sm">
            {state.holder ? (
              <>
                held by <b className="text-white">{state.holder}</b>
                {state.holderSite && (
                  <>
                    {" "}
                    &middot;{" "}
                    <a
                      href={state.holderSite}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      onClick={(e) => e.stopPropagation()}
                      className="text-white underline decoration-red-300 hover:decoration-white"
                    >
                      {hostnameOf(state.holderSite)}
                    </a>
                  </>
                )}
              </>
            ) : (
              "nobody has pressed it yet"
            )}
          </span>
          {reign !== null && (
            <span
              suppressHydrationWarning
              className="mt-1 text-[11px] tabular-nums text-red-200"
            >
              held for {duration(reign)}
            </span>
          )}
        </button>
        <button
          type="button"
          aria-label={`Pay $${step} more`}
          disabled={busy}
          onClick={() => bump(step)}
          className={stepperClass}
        >
          +
        </button>
      </div>
      <p className="-mt-6 text-xs text-zinc-500">
        Minimum {money(minimum)}
        {extra > 0 && (
          <>
            {" "}
            &middot; you&apos;re adding <b>{money(extra)}</b> &middot;{" "}
            <button
              type="button"
              onClick={() => setExtra(0)}
              className="underline"
            >
              reset
            </button>
          </>
        )}
      </p>

      {/* Name + website */}
      <form
        className="flex w-full max-w-md flex-col gap-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          openConfirm();
        }}
      >
        <label className="flex flex-1 flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
          Your name goes on the button
          <input
            ref={nameInput}
            value={name}
            onChange={(e) => nameStore.set(e.target.value)}
            maxLength={24}
            placeholder="e.g. arnit"
            className={inputClass}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
          Your website (optional)
          <span className="relative flex items-center">
            <input
              value={site}
              onChange={(e) => siteStore.set(e.target.value)}
              maxLength={200}
              placeholder="example.com"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={`${inputClass} w-full pr-9`}
            />
            {trimmedSite && (
              <span className="pointer-events-none absolute right-2">
                <Favicon site={trimmedSite} size={20} />
              </span>
            )}
          </span>
        </label>
        {/* Enter submits; the visible CTA is the big button itself. */}
        <button type="submit" hidden aria-hidden />
      </form>

      {/* Share */}
      <button
        type="button"
        onClick={share}
        className="-mt-4 text-xs text-zinc-500 underline decoration-zinc-300 hover:text-zinc-800 dark:hover:text-zinc-200"
      >
        {copied
          ? "Copied!"
          : isHolder
            ? "Brag about it - share"
            : "Share this page"}
      </button>

      {/* Ledger */}
      <section className="w-full">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
          Public ledger
        </h2>
        {state.presses.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Be the first. It only costs a dollar.
          </p>
        ) : (
          <ol className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {state.presses.map((p, i) => {
              const mine = p.name === trimmed && !!trimmed;
              return (
                <li
                  key={p.id}
                  className={`flex items-center justify-between gap-3 px-4 py-2 text-sm ${
                    i === 0 ? "bg-yellow-50 dark:bg-yellow-950/30" : ""
                  }`}
                >
                  <span className="w-10 shrink-0 tabular-nums text-zinc-400">
                    #{p.id}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2 truncate font-medium">
                    {p.site && <Favicon site={p.site} size={16} />}
                    <span className="truncate">{p.name}</span>
                    {mine && (
                      <span className="rounded bg-zinc-200 px-1 text-[10px] font-semibold uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        you
                      </span>
                    )}
                    {p.site && (
                      <a
                        href={p.site}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="truncate text-xs font-normal text-zinc-400 hover:underline"
                      >
                        {hostnameOf(p.site)}
                      </a>
                    )}
                  </span>
                  <span className="tabular-nums">{money(p.price)}</span>
                  <span
                    suppressHydrationWarning
                    className="w-16 shrink-0 text-right tabular-nums text-zinc-400"
                  >
                    {now ? timeAgo(p.at, now) : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* Toasts */}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-40 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-full px-4 py-2 text-sm shadow-lg ${
              t.kind === "win"
                ? "bg-yellow-400 font-semibold text-yellow-950"
                : "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>

      {/* Checkout (fake) */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => !busy && setConfirming(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkout-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm overflow-hidden rounded-xl bg-white text-zinc-900 shadow-2xl dark:bg-zinc-900 dark:text-zinc-50"
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <h3 id="checkout-title" className="font-semibold">
                Checkout
              </h3>
              <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                Test mode
              </span>
            </div>

            <div className="space-y-3 px-5 py-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">
                  One press of The Expensive Button
                </span>
                <span className="font-semibold tabular-nums">
                  {money(amount)}
                </span>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                {trimmedSite ? (
                  <Favicon site={trimmedSite} size={28} />
                ) : (
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-red-600 text-xs font-bold text-white">
                    {trimmed.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0">
                  <div className="truncate font-medium">{trimmed}</div>
                  {trimmedSite && (
                    <div className="truncate text-xs text-zinc-500">
                      {hostnameOf(trimmedSite)}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                <span>Card</span>
                <span className="font-mono text-xs">•••• •••• •••• 4242</span>
              </div>
              <p className="text-xs text-zinc-500">
                No real charge - this is a proof of concept. The next press will
                cost at least {money(amount + 1)}.
              </p>
              {error && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  {error}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="rounded-md px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                ref={payBtn}
                type="button"
                disabled={busy}
                onClick={confirmPress}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 focus:ring-2 focus:ring-red-500/40 focus:outline-none disabled:opacity-60"
              >
                {busy ? "One moment…" : `Pay ${money(amount)}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
