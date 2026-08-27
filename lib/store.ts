import { promises as fs } from "fs";
import path from "path";

export type Press = {
  id: number;
  name: string;
  price: number; // dollars paid for this press
  at: string; // ISO timestamp
  site?: string; // normalized https?:// URL the presser wants shown
  paymentRef?: string; // Stripe checkout session id (or test ref)
};

export type ButtonState = {
  price: number; // MINIMUM the next press costs (last paid + 1)
  holder: string | null;
  holderSite: string | null;
  presses: Press[]; // newest first, visible only
  totalRaised: number;
  /** Checkout sessions that were refunded because they arrived below minimum. */
  refunded?: string[];
  /** Next id to hand out; survives hides. */
  nextId?: number;
};

const START_PRICE = 1;
const MAX_LEDGER = 500;
const MAX_REFUNDS = 100;

const initial: ButtonState = {
  price: START_PRICE,
  holder: null,
  holderSite: null,
  presses: [],
  totalRaised: 0,
  refunded: [],
  nextId: 1,
};

/* ------------------------------------------------------------------ */
/* Storage backends. `etag` is an opaque version token used for
   compare-and-swap; backends without CAS return undefined and rely on
   the in-process queue below. */

type Loaded = { state: ButtonState; etag?: string };
interface Backend {
  load(): Promise<Loaded>;
  /** Returns false if the version changed underneath us. */
  save(state: ButtonState, etag?: string): Promise<boolean>;
}

const fileBackend: Backend = (() => {
  const DATA_DIR = path.join(process.cwd(), "data");
  const DATA_FILE = path.join(DATA_DIR, "button.json");
  return {
    async load() {
      try {
        const raw = await fs.readFile(DATA_FILE, "utf8");
        return { state: { ...initial, ...(JSON.parse(raw) as ButtonState) } };
      } catch {
        return { state: { ...initial } };
      }
    },
    async save(state) {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2));
      await fs.rename(tmp, DATA_FILE);
      return true;
    },
  };
})();

const blobsBackend: Backend = (() => {
  const KEY = "state";
  async function store() {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: "expensive-button", consistency: "strong" });
  }
  return {
    async load() {
      const s = await store();
      const res = await s.getWithMetadata(KEY, { type: "json" });
      if (!res) return { state: { ...initial } };
      return {
        state: { ...initial, ...(res.data as ButtonState) },
        etag: res.etag,
      };
    },
    async save(state, etag) {
      const s = await store();
      const res = await s.set(
        KEY,
        JSON.stringify(state),
        etag ? { onlyIfMatch: etag } : { onlyIfNew: true },
      );
      return res.modified;
    },
  };
})();

function shouldUseBlobs() {
  if (process.env.STORE === "file") return false;
  if (process.env.STORE === "blobs") return true;
  return process.env.NETLIFY === "true" || !!process.env.NETLIFY_BLOBS_CONTEXT;
}
const backend: Backend = shouldUseBlobs() ? blobsBackend : fileBackend;

/* ------------------------------------------------------------------ */

// Serialize writes within this process; CAS handles cross-instance races.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export class ConflictError extends Error {}

/** Read-modify-write with retry on version conflict. */
function update(
  mutate: (state: ButtonState) => ButtonState | null, // null = no change
): Promise<ButtonState> {
  return serialized(async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { state, etag } = await backend.load();
      const next = mutate(state);
      if (next === null) return state;
      if (await backend.save(next, etag)) return next;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
    throw new ConflictError("Too many concurrent writes; try again");
  });
}

export async function getState(): Promise<ButtonState> {
  const { state } = await backend.load();
  return state;
}

export class PriceTooLowError extends Error {
  constructor(public minimum: number) {
    super(`Minimum is $${minimum}`);
  }
}

/**
 * Record a press. `amount` must be >= the current minimum.
 * Idempotent on `paymentRef`: replaying a webhook won't double-record.
 */
export function press(
  name: string,
  amount: number,
  site: string | null = null,
  paymentRef?: string,
): Promise<ButtonState> {
  let tooLow: number | null = null;
  return update((state) => {
    if (paymentRef && state.presses.some((p) => p.paymentRef === paymentRef)) {
      return null; // already recorded
    }
    if (amount < state.price) {
      tooLow = state.price;
      return null;
    }
    const id = state.nextId ?? (state.presses[0]?.id ?? 0) + 1;
    const entry: Press = {
      id,
      name,
      price: amount,
      at: new Date().toISOString(),
      ...(site ? { site } : {}),
      ...(paymentRef ? { paymentRef } : {}),
    };
    return {
      ...state,
      price: amount + 1,
      holder: name,
      holderSite: site,
      presses: [entry, ...state.presses].slice(0, MAX_LEDGER),
      totalRaised: state.totalRaised + entry.price,
      nextId: id + 1,
    };
  }).then((state) => {
    if (tooLow !== null) throw new PriceTooLowError(tooLow);
    return state;
  });
}

/** Remember that a checkout session was refunded (arrived below minimum). */
export function markRefunded(sessionId: string): Promise<ButtonState> {
  return update((state) => {
    const refunded = state.refunded ?? [];
    if (refunded.includes(sessionId)) return null;
    return {
      ...state,
      refunded: [sessionId, ...refunded].slice(0, MAX_REFUNDS),
    };
  });
}

/** Moderation: remove a press from the ledger. The minimum price is kept. */
export function hidePress(id: number): Promise<ButtonState> {
  return update((state) => {
    if (!state.presses.some((p) => p.id === id)) return null;
    const presses = state.presses.filter((p) => p.id !== id);
    const top = presses[0] ?? null;
    return {
      ...state,
      presses,
      holder: top?.name ?? null,
      holderSite: top?.site ?? null,
    };
  });
}

/** Where did a checkout session end up? */
export async function sessionStatus(
  sessionId: string,
): Promise<"pressed" | "refunded" | "pending"> {
  const state = await getState();
  if (state.presses.some((p) => p.paymentRef === sessionId)) return "pressed";
  if (state.refunded?.includes(sessionId)) return "refunded";
  return "pending";
}
