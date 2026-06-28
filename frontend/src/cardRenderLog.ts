/**
 * Card Render & Broadcast Log — v1.2.0 (44) diagnostic instrumentation.
 *
 * Captures two distinct event streams into a single ring buffer so
 * they can be visualised as one interleaved timeline:
 *
 *   1. CARD RENDERS — every time the MemberCard for a tracked
 *      family member re-renders, we log:
 *        • the `member.last_seen` value the card actually received
 *          as a prop at render time
 *        • the `ageLabel` string the card displayed ("just now",
 *          "5 min ago", "5 hours ago", ...)
 *        • the `refreshing` boolean (spinner state)
 *      This is the GROUND TRUTH for "what did the UI actually
 *      paint" — independent from any API response.
 *
 *   2. BROADCASTS — every time `subscribeMember` in the dashboard
 *      fires with a new member doc (typically pushed by the
 *      `requestRefresh` active poller after seeing a fresh
 *      `last_seen`), we log:
 *        • the broadcast's incoming `last_seen`
 *        • the PRIOR `last_seen` for the same member in dashboard
 *          state at the moment of the broadcast
 *      This lets us detect race conditions where a STALE broadcast
 *      overwrites freshly-`setMembers`'d data — the leading hypothesis
 *      for build 44's investigation.
 *
 * Every entry carries:
 *   • `seq`  — global monotonic counter from `diagSeq` so two events
 *              with identical `at` timestamps still have an
 *              unambiguous ordering (sub-ms precision below
 *              Date.now() resolution otherwise hides race conditions).
 *   • `src`  — source tag ('card-render' or 'broadcast') for
 *              filtering / colour-coding in the diagnostics UI.
 *   • `at`   — epoch ms.
 *
 * Buffer size 100 (mix of renders + broadcasts) keeps the AsyncStorage
 * payload reasonable while still covering ~5-10 minutes of activity
 * even at the highest render rates we expect.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { nextSeq } from './diagSeq';
import { DIAG_BUFFER_SIZES, pruneBuffer } from './diagBufferConfig';

const KEY = '@kinnship/card_render_log_v1';
const MAX = DIAG_BUFFER_SIZES.cardRender;

export type CardRenderSource = 'card-render' | 'broadcast';

/**
 * Discriminated-union entry: card renders and broadcasts share the
 * common envelope (`seq`, `src`, `at`) but carry different payloads.
 */
export type CardRenderEntry =
  | {
      seq: number;
      src: 'card-render';
      at: number;
      member_id: string;
      /** Prop value as received by the card. */
      last_seen: string | null;
      /** Parsed epoch ms (or null if last_seen was null/invalid). */
      seen_ms: number | null;
      /** The computed text the card displayed (e.g. "5 hours ago"). */
      age_label: string;
      /** Whether the spinner was visible at this render. */
      refreshing: boolean;
    }
  | {
      seq: number;
      src: 'broadcast';
      at: number;
      member_id: string;
      /** last_seen carried by the broadcasted member doc. */
      broadcast_last_seen: string | null;
      /** last_seen value already in dashboard state for this member at the moment of broadcast. */
      prior_state_last_seen: string | null;
      /** Whether the broadcast's value is strictly newer than the prior state value. */
      is_newer: boolean;
    };

let buffer: CardRenderEntry[] = [];
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) buffer = JSON.parse(raw);
  } catch (_e) {
    buffer = [];
  }
  loaded = true;
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(buffer));
  } catch (_e) {
    // best-effort
  }
}

async function append(entry: CardRenderEntry): Promise<void> {
  await ensureLoaded();
  buffer.push(entry);
  buffer = pruneBuffer(buffer, (e) => e.at, MAX);
  await persist();
}

/**
 * Called from inside MemberCard render to record exactly what the
 * card painted.  Safe to call from any render path; never throws.
 *
 * Note: this fires from a React render function, which is supposed to
 * be pure.  The actual side effect (AsyncStorage write) is async and
 * does not block the render — we fire-and-forget the promise.  We
 * accept the minor "double-log on Strict Mode double-invoke" cost
 * because Strict Mode is disabled in the production build and the
 * extra entries are harmless in dev.
 */
export function logCardRender(args: {
  member_id: string;
  last_seen: string | null;
  age_label: string;
  refreshing: boolean;
}): void {
  const seen_ms = (() => {
    if (!args.last_seen) return null;
    const d = new Date(args.last_seen);
    const t = d.getTime();
    return Number.isNaN(t) ? null : t;
  })();
  const entry: CardRenderEntry = {
    seq: nextSeq(),
    src: 'card-render',
    at: Date.now(),
    member_id: args.member_id,
    last_seen: args.last_seen,
    seen_ms,
    age_label: args.age_label,
    refreshing: args.refreshing,
  };
  // fire-and-forget; never block render
  append(entry).catch(() => {});
}

/**
 * Called from the dashboard's `subscribeMember` handler whenever a
 * broadcast lands.  Captures both the incoming value and the prior
 * state value so we can detect stale-overwrite races.
 */
export function logBroadcast(args: {
  member_id: string;
  broadcast_last_seen: string | null;
  prior_state_last_seen: string | null;
}): void {
  const a = args.broadcast_last_seen ? new Date(args.broadcast_last_seen).getTime() : NaN;
  const b = args.prior_state_last_seen ? new Date(args.prior_state_last_seen).getTime() : NaN;
  const is_newer = Number.isFinite(a) && (!Number.isFinite(b) || a > b);
  const entry: CardRenderEntry = {
    seq: nextSeq(),
    src: 'broadcast',
    at: Date.now(),
    member_id: args.member_id,
    broadcast_last_seen: args.broadcast_last_seen,
    prior_state_last_seen: args.prior_state_last_seen,
    is_newer,
  };
  append(entry).catch(() => {});
}

/** Read the full buffer (oldest-first by append order; seq is the authoritative order). */
export async function getCardRenderLog(): Promise<CardRenderEntry[]> {
  await ensureLoaded();
  buffer = pruneBuffer(buffer, (e) => e.at, MAX);
  return [...buffer];
}

export async function clearCardRenderLog(): Promise<void> {
  buffer = [];
  await persist();
}
