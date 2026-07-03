/**
 * Build #52 — Shared Tracking Status component + logic
 * ============================================================================
 *
 * Single source of truth for how Kinnship communicates location freshness
 * to caregivers.  Every screen that displays a member's location — SOS
 * incident screen, member detail, family dashboard cards, and any future
 * location-status surface — MUST use the same computation and the same
 * visual language so a caregiver can never see contradictory signals.
 *
 * Design language (approved by Charles, Build #52):
 *
 *   🟢 Tracking healthy        coords present AND last_seen ≤ 60 s
 *   🟡 Location updating…      coords present AND last_seen 60 s – 5 min
 *   🟡 Last known location     coords present AND (>5 min OR no timestamp)
 *   🔴 Location unavailable    RESERVED for the true no-coords case
 *
 * The caregiver's first impression should answer:
 *   "Can I trust that I'm seeing this person's current location?"
 * NOT:
 *   "How many minutes ago was this updated?"
 *
 * The timestamp is still available as tiny secondary text below the pill
 * (rendered by the consuming screen), but the pill is the primary signal.
 *
 * ============================================================================
 * Usage:
 *
 *   import { TrackingStatusPill, computeTrackingStatus } from
 *     '../../src/tracking/TrackingStatusPill';
 *
 *   <TrackingStatusPill
 *     hasCoords={typeof lat === 'number'}
 *     lastSeenIso={member?.last_seen}
 *     testID="member-tracking-status"
 *   />
 *
 * Consumers that also want to alter surrounding UI based on the status
 * (e.g. hide a "Refreshing…" spinner when we're already Healthy) can
 * call `computeTrackingStatus()` directly.
 * ============================================================================
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { Colors } from '../theme';
import { logTrackingPillDecision } from './trackingPillDiagnostics';

export type TrackingStatusKind = 'healthy' | 'updating' | 'last-known' | 'unavailable';

export type TrackingStatus = {
  kind: TrackingStatusKind;
  color: string;    // text + emoji colour
  bg: string;       // pill background
  label: string;    // primary caregiver-facing label
  emoji: string;    // traffic-light emoji
};

// ---------------------------------------------------------------------------
//  Pure computation
// ---------------------------------------------------------------------------

const STATUS: Record<TrackingStatusKind, Omit<TrackingStatus, 'kind'>> = {
  healthy:      { color: '#166534',       bg: '#DCFCE7', label: 'Tracking healthy',          emoji: '🟢' },
  updating:     { color: '#92400E',       bg: '#FEF3C7', label: 'Tracking needs attention',  emoji: '🟡' },
  'last-known': { color: '#92400E',       bg: '#FEF3C7', label: 'Tracking needs attention',  emoji: '🟡' },
  unavailable:  { color: Colors.error,    bg: '#FEE2E2', label: 'Tracking offline',          emoji: '🔴' },
};

// Build 54 — Health-based, NOT freshness-based.
//
//   🟢 Healthy   — has coords AND we haven't hit a hard-fail signal.
//                  A phone sitting idle overnight is HEALTHY: absence of
//                  motion is not evidence of failure.
//   🟡 Attention — reserved for real failure evidence: explicit upload/auth
//                  failure, or the local engine self-reports unhealthy.
//                  In Build 54 the memberStore doesn't publish these yet,
//                  so the pill effectively never turns yellow.  Kept as
//                  an escape hatch for Build 55+ backend health signal.
//   🔴 Offline   — no coords ever, OR last_seen older than 72 h (device
//                  has been silent for 3+ days — this IS evidence), OR
//                  the caller passes an explicit `isTrackingDisabled` /
//                  permissions-revoked flag.
//
// This intentionally does NOT flip to Attention/Offline just because
// time elapsed.  Charles's philosophy for Build 54: "Do not turn
// yellow simply because someone hasn't moved."
const OFFLINE_MS = 72 * 60 * 60 * 1000; // 72 h — 3-day silence = broken

export type ComputeStatusOptions = {
  /** Local caller only — true when the user has explicitly turned tracking off. */
  isTrackingDisabled?: boolean;
  /** Local caller only — true when foreground permissions are revoked. */
  permissionsRevoked?: boolean;
  /** Any surface can pass this when the backend/memberStore reports a real
      upload or auth failure has occurred — flips the pill to Attention.
      Kept optional so the default (no data-driven failure signal) simply
      leaves the pill Healthy. */
  hasKnownFailure?: boolean;
};

export function computeTrackingStatus(
  hasCoords: boolean,
  lastSeenIso: string | null | undefined,
  nowMs: number = Date.now(),
  opts?: ComputeStatusOptions,
): TrackingStatus {
  // Hard-fail signals first (only reach this branch when the caller
  // actually knows something is wrong locally).
  if (opts?.isTrackingDisabled || opts?.permissionsRevoked) {
    return { kind: 'unavailable', ...STATUS.unavailable };
  }
  if (!hasCoords) return { kind: 'unavailable', ...STATUS.unavailable };

  // Real evidence of a problem (upload/auth failure surfaced by caller).
  if (opts?.hasKnownFailure) {
    return { kind: 'updating', ...STATUS.updating };
  }

  // Genuine long-silence = something IS broken.
  const lastSeenMs = lastSeenIso ? new Date(lastSeenIso).getTime() : 0;
  if (lastSeenMs && nowMs - lastSeenMs > OFFLINE_MS) {
    return { kind: 'unavailable', ...STATUS.unavailable };
  }

  // Default = Healthy.  Idle overnight, stationary, on a charger — all healthy.
  return { kind: 'healthy', ...STATUS.healthy };
}

// ---------------------------------------------------------------------------
//  <TrackingStatusPill /> — the visual component every screen shares
// ---------------------------------------------------------------------------

export type TrackingStatusPillProps = {
  hasCoords: boolean;
  lastSeenIso?: string | null;
  /**
   * Which surface is rendering this pill.  Used only by the temporary
   * decision-log diagnostic (Build 53) to attribute decisions to the
   * calling screen.  Recommended values: 'alert' | 'member' |
   * 'dashboard-card' | 'diagnostics' — but any string is accepted.
   */
  screen?: string;
  /**
   * Compact ("dashboard card") vs. default ("detail screens").  Compact
   * uses smaller padding + font — appropriate for dense list rows.
   */
  size?: 'compact' | 'default';
  /**
   * If true, the pill re-renders itself every 20 s so the "Healthy →
   * Updating → Last known" transitions happen automatically even when
   * no props change.  On by default; disable only for pure/static
   * previews (e.g. Storybook / diagnostics).
   */
  autoTick?: boolean;
  style?: ViewStyle;
  labelStyle?: TextStyle;
  testID?: string;
};

export function TrackingStatusPill({
  hasCoords,
  lastSeenIso,
  screen = 'unknown',
  size = 'default',
  autoTick = true,
  style,
  labelStyle,
  testID,
}: TrackingStatusPillProps) {
  // Auto-tick so the pill drifts through Healthy → Updating → Last known
  // even when the underlying data doesn't change.  20 s cadence matches
  // the rest of the app's "freshness re-render" convention.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!autoTick) return;
    const t = setInterval(() => forceTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [autoTick]);

  const s = computeTrackingStatus(hasCoords, lastSeenIso);
  const containerStyle = size === 'compact' ? styles.pillCompact : styles.pill;
  const textStyle = size === 'compact' ? styles.labelCompact : styles.label;

  // Build 53 — temporary decision log.  Each pill render records its
  // inputs + chosen kind so we can post-mortem "why yellow when Joyce
  // is fine".  Written best-effort to AsyncStorage; disabled behaviour
  // change is zero.  Will be removed before RC.
  useEffect(() => {
    const ageMs = lastSeenIso ? Date.now() - new Date(lastSeenIso).getTime() : null;
    const reason =
      s.kind === 'unavailable'
        ? (!hasCoords ? 'no-coords' : 'silent >72h or explicit-offline')
        : s.kind === 'healthy'
        ? 'has-coords + not-silent-72h'
        : 'known-failure-signal';
    logTrackingPillDecision({
      screen,
      hasCoords,
      lastSeenIso: lastSeenIso || null,
      ageMs,
      kind: s.kind,
      reason,
    });
    // Only log when inputs change — not on every 20-s auto-tick re-render.
  }, [screen, hasCoords, lastSeenIso, s.kind]);

  return (
    <View
      style={[containerStyle, { backgroundColor: s.bg }, style]}
      testID={testID || 'tracking-status-pill'}
      accessibilityRole="text"
      accessibilityLabel={`Tracking status: ${s.label}`}
    >
      <Text style={styles.emoji}>{s.emoji}</Text>
      <Text style={[textStyle, { color: s.color }, labelStyle]}>{s.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pillCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
  },
  emoji: { fontSize: 12 },
  label: { fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
  labelCompact: { fontSize: 11.5, fontWeight: '800', letterSpacing: 0.25 },
});
