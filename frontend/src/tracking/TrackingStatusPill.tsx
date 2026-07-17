/**
 * Build 64 — Tracking Status Pill: freshness + movement-aware location health
 * ============================================================================
 *
 * The pill answers exactly one question for a caregiver:
 *   "Can I trust that I'm seeing this person's current location right now?"
 *
 * NOT: "Is the background service technically running?"
 *
 * Design language (approved by Charles, Build 64):
 *
 *   🟢 Tracking healthy    upload is fresh relative to member's movement state
 *   🟡 Tracking delayed    engine probably running; location becoming stale
 *   🔴 Tracking degraded   stale beyond movement-appropriate limit
 *   ◯  Tracking unavailable structural gap: no perms, engine off, no coords
 *   🔒 Location sharing off intentional privacy choice (never red/yellow)
 *
 * Build 54 design flaw (now fixed):
 *   The pill was green as long as last_seen < 72 hours.  That was an
 *   ENGINE-health signal, not a location-pipeline signal.  A caregiver
 *   could see "Tracking healthy" while the map displayed a 45-minute-stale
 *   position for a member who was actively driving.  Build 64 replaces
 *   this with freshness thresholds that mirror the Leonidas internal
 *   constants and scale to the member's actual movement state.
 *
 * ============================================================================
 * Usage:
 *
 *   <TrackingStatusPill
 *     hasCoords={typeof lat === 'number'}
 *     lastSeenIso={member?.last_seen}
 *     isMoving={member?.is_moving ?? null}
 *     locationSharingEnabled={member?.location_sharing_enabled}
 *   />
 * ============================================================================
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { logTrackingPillDecision } from './trackingPillDiagnostics';

export type TrackingStatusKind =
  | 'healthy'       // 🟢 upload fresh for movement state
  | 'delayed'       // 🟡 becoming stale; engine probably running
  | 'degraded'      // 🔴 stale beyond movement-appropriate limit
  | 'unavailable'   // ◯  structural: no perms, engine off, no coords
  | 'sharing-off';  // 🔒 intentional privacy choice

export type TrackingStatus = {
  kind: TrackingStatusKind;
  color: string;    // text + emoji colour
  bg: string;       // pill background
  label: string;    // primary caregiver-facing label
  emoji: string;    // traffic-light emoji
};

// ---------------------------------------------------------------------------
//  Visual definitions
// ---------------------------------------------------------------------------

// Unavailable is GRAY (#F3F4F6), NOT red.  It signals a structural issue
// (permissions revoked, engine disabled, no coordinates) — something that
// cannot be fixed by refreshing location data.
//
// Red ("degraded") is reserved for: pipeline is running BUT the data the
// caregiver is looking at on the map is too stale to be trustworthy given
// the member's current movement state.
const STATUS: Record<TrackingStatusKind, Omit<TrackingStatus, 'kind'>> = {
  healthy:       { color: '#166534', bg: '#DCFCE7', label: 'Tracking healthy',     emoji: '🟢' },
  delayed:       { color: '#92400E', bg: '#FEF3C7', label: 'Tracking delayed',     emoji: '🟡' },
  degraded:      { color: '#991B1B', bg: '#FEE2E2', label: 'Tracking degraded',    emoji: '🔴' },
  unavailable:   { color: '#6B7280', bg: '#F3F4F6', label: 'Tracking unavailable', emoji: '◯' },
  'sharing-off': { color: '#374151', bg: '#E5E7EB', label: 'Location sharing off', emoji: '🔒' },
};

// ---------------------------------------------------------------------------
//  Freshness thresholds — mirror Leonidas constants in leonidas/types.ts
// ---------------------------------------------------------------------------
//
//  MOVING   healthy ≤ 2 min  | delayed 2–10 min  | degraded > 10 min
//  STILL    healthy ≤ 15 min | delayed 15–30 min | degraded > 30 min
//  UNKNOWN  healthy ≤ 5 min  | delayed 5–30 min  | degraded > 30 min
//
//  If you update these, update the Leonidas constants too.  They must
//  stay in sync so the badge and the health monitor speak the same language.

const MOVING_HEALTHY_MAX_MS  = 2 * 60 * 1000;  // Leonidas: MOVING_HEALTHY_MAX_MINUTES
const MOVING_DEGRADED_MS     = 5 * 60 * 1000;  // Leonidas: MOVING_CRITICAL_MINUTES (spec: >5 min = degraded)
const STATIONARY_DELAYED_MS  = 15 * 60 * 1000;  // Leonidas: STATIONARY_RECOVERY_MIN_MINUTES
const STATIONARY_DEGRADED_MS = 30 * 60 * 1000;  // Leonidas: STATIONARY_RECOVERY_MAX_MINUTES
const UNKNOWN_DELAYED_MS     = 5  * 60 * 1000;
const UNKNOWN_DEGRADED_MS    = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
//  Options
// ---------------------------------------------------------------------------

export type ComputeStatusOptions = {
  /** True when the user has explicitly turned tracking off locally. */
  isTrackingDisabled?: boolean;
  /** True when foreground location permissions have been revoked. */
  permissionsRevoked?: boolean;
  /**
   * @deprecated Pre-Build-64 escape hatch.  No current caller sets this.
   * Kept for API compatibility only.
   */
  hasKnownFailure?: boolean;
  /**
   * Build #56 — When explicitly false, renders the 🔒 privacy pill and
   * bypasses all freshness logic.  Default undefined → treat as enabled
   * (backwards-compatible with pre-Build-56 member docs).
   */
  locationSharingEnabled?: boolean;
  /**
   * Build 64 — Whether the member's device is currently in MOVING mode.
   * Populated from the `is_moving` field on the member doc, which is
   * written by the backend from the Transistor SDK upload payload.
   *
   *   true  → tight thresholds (2 min healthy / 10 min degraded)
   *   false → lenient thresholds (15 min healthy / 30 min degraded)
   *   null / undefined → conservative unknown defaults
   *
   * Never pass this from the local device's Leonidas engine — Leonidas
   * knows the current user's own movement, not other members'.
   */
  isMoving?: boolean | null;
};

// ---------------------------------------------------------------------------
//  Pure computation
// ---------------------------------------------------------------------------

export function computeTrackingStatus(
  hasCoords: boolean,
  lastSeenIso: string | null | undefined,
  nowMs: number = Date.now(),
  opts?: ComputeStatusOptions,
): TrackingStatus {
  // Privacy takes absolute precedence.  When Location Sharing is OFF we
  // show the lock pill and skip every other check, including freshness.
  if (opts?.locationSharingEnabled === false) {
    return { kind: 'sharing-off', ...STATUS['sharing-off'] };
  }

  // Structural failures → gray "Tracking unavailable".  These cannot be
  // resolved by refreshing — a system-level action (grant permissions,
  // re-enable the engine) is required.
  if (opts?.isTrackingDisabled || opts?.permissionsRevoked) {
    return { kind: 'unavailable', ...STATUS.unavailable };
  }
  if (!hasCoords) {
    return { kind: 'unavailable', ...STATUS.unavailable };
  }

  // Coords exist but no server-contact timestamp → can't assess freshness.
  // Return unavailable rather than falsely showing green.
  const lastSeenMs = lastSeenIso ? new Date(lastSeenIso).getTime() : 0;
  if (!lastSeenMs) {
    return { kind: 'unavailable', ...STATUS.unavailable };
  }

  const ageMs = nowMs - lastSeenMs;

  // Movement-aware freshness ladder.
  // `isMoving` reflects the member's device state at last upload time.
  // It comes from the member doc (backend-populated), NOT from local Leonidas.
  const isMoving = opts?.isMoving;

  if (isMoving === true) {
    // MOVING: SDK uploads every 10–30 s.  A 2-minute gap is unusual;
    // 10+ minutes means the pipeline has stalled while the member is in
    // transit — exactly the scenario that must show red to a caregiver.
    if (ageMs > MOVING_DEGRADED_MS)    return { kind: 'degraded', ...STATUS.degraded };
    if (ageMs > MOVING_HEALTHY_MAX_MS) return { kind: 'delayed',  ...STATUS.delayed  };
    return { kind: 'healthy', ...STATUS.healthy };
  }

  if (isMoving === false) {
    // STATIONARY: heartbeat uploads every 15–30 min are expected behaviour.
    // Only escalate when the gap exceeds the heartbeat window.
    if (ageMs > STATIONARY_DEGRADED_MS) return { kind: 'degraded', ...STATUS.degraded };
    if (ageMs > STATIONARY_DELAYED_MS)  return { kind: 'delayed',  ...STATUS.delayed  };
    return { kind: 'healthy', ...STATUS.healthy };
  }

  // Movement state unknown (pre-Build-64 device, cold start, first upload).
  // Conservative thresholds: err toward caution because we don't know
  // whether the member is in a vehicle doing 60 mph.
  if (ageMs > UNKNOWN_DEGRADED_MS) return { kind: 'degraded', ...STATUS.degraded };
  if (ageMs > UNKNOWN_DELAYED_MS)  return { kind: 'delayed',  ...STATUS.delayed  };
  return { kind: 'healthy', ...STATUS.healthy };
}

// ---------------------------------------------------------------------------
//  <TrackingStatusPill /> — shared visual component
// ---------------------------------------------------------------------------

export type TrackingStatusPillProps = {
  hasCoords: boolean;
  lastSeenIso?: string | null;
  /**
   * Build #56 — mirrored from the member doc's `location_sharing_enabled`
   * field.  When explicitly false the pill renders "🔒 Location sharing off"
   * and bypasses all freshness computation.
   */
  locationSharingEnabled?: boolean;
  /**
   * Build 64 — Whether the member's device is currently in MOVING mode.
   * Read from the member doc's `is_moving` field (written from the SDK
   * upload payload).  Drives movement-aware freshness thresholds.
   */
  isMoving?: boolean | null;
  /**
   * Which surface is rendering this pill.  Used only by the Build 53
   * decision-log diagnostic.  'alert' | 'member' | 'dashboard-card' | etc.
   */
  screen?: string;
  /** Compact ("dashboard card") vs. default ("detail screens"). */
  size?: 'compact' | 'default';
  /**
   * When true the pill re-renders every 20 s so freshness transitions
   * happen automatically even when props don't change.
   * Disable only for static previews.
   */
  autoTick?: boolean;
  style?: ViewStyle;
  labelStyle?: TextStyle;
  testID?: string;
};

export function TrackingStatusPill({
  hasCoords,
  lastSeenIso,
  locationSharingEnabled,
  isMoving,
  screen = 'unknown',
  size = 'default',
  autoTick = true,
  style,
  labelStyle,
  testID,
}: TrackingStatusPillProps) {
  // 20-second auto-tick so freshness transitions (healthy → delayed → degraded)
  // happen without a new backend response.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!autoTick) return;
    const t = setInterval(() => forceTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [autoTick]);

  const s = computeTrackingStatus(hasCoords, lastSeenIso, undefined, {
    locationSharingEnabled,
    isMoving,
  });
  const containerStyle = size === 'compact' ? styles.pillCompact : styles.pill;
  const textStyle = size === 'compact' ? styles.labelCompact : styles.label;

  // Build 53 — temporary decision log.  Records pill inputs + outcome
  // so we can post-mortem "why was this green when Joyce was stale?"
  // Only fires when inputs change (not on every 20-s auto-tick).
  useEffect(() => {
    const ageMs = lastSeenIso ? Date.now() - new Date(lastSeenIso).getTime() : null;
    const reason =
      s.kind === 'unavailable'
        ? (!hasCoords ? 'no-coords' : !lastSeenIso ? 'no-timestamp' : 'explicit-offline')
        : s.kind === 'degraded'
        ? `degraded·isMoving=${isMoving ?? 'unknown'}`
        : s.kind === 'delayed'
        ? `delayed·isMoving=${isMoving ?? 'unknown'}`
        : 'healthy';
    logTrackingPillDecision({
      screen,
      hasCoords,
      lastSeenIso: lastSeenIso || null,
      ageMs,
      kind: s.kind,
      reason,
    });
  }, [screen, hasCoords, lastSeenIso, s.kind, isMoving]);

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
