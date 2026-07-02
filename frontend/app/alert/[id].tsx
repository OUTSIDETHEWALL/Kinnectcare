/**
 * =========================================================================
 * Build #50 — SOS Emergency Incident Screen
 * =========================================================================
 *
 * Destination for `sos` push-notification deep links AND the smart-resume
 * AppState navigation in `_layout.tsx`.  When an SOS is unresolved, this
 * is the ONLY screen the app tries to surface the user to — replacing
 * the previous multi-tap "notification → Dashboard → Alerts → detail"
 * flow with an instant, glanceable live-incident cockpit.
 *
 * Screen layout (top → bottom):
 *
 *   [Header]
 *     • ACTIVE SOS red banner (only when `alert.resolved === false`)
 *     • RESOLVED gray banner (when resolved, with resolver name)
 *     • Member name (large) + relative timestamp
 *   [Live map card]
 *     • MemberMap centred on member's current lat/lon
 *     • Auto-refresh every 15 s via memberStore.requestRefresh(memberId)
 *     • Tracking status pill:
 *         🟢 Tracking Healthy       — last_seen ≤ 60 s ago
 *         🟡 Location updating…      — last_seen 60 s – 5 min ago
 *         🔴 Location unavailable    — no fix, or last_seen > 5 min
 *     • "Open in Maps" button below map
 *   [Action grid]
 *     • 📞 Call 911               — always visible (primary red)
 *     • 🧭 Navigate to member     — only when we have coords
 *     • 📞 Call {member}          — only when emergency_contact_phone on file
 *     • ✅ Resolve emergency      — visible only when unresolved
 *
 * Resolve behaviour (Build 50 spec): ANY family member can resolve.
 * Backend `POST /api/alerts/{id}/resolve` fans out an `alert_resolved`
 * push to every device in the family group so every caregiver's UI
 * clears the banner in step.
 *
 * If the alert cannot be reached (already pruned or cross-tenant),
 * we show a friendly empty state and bounce to `/(tabs)/alerts` after
 * 2 s so the user is never dead-ended.
 */
import { useCallback, useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Linking,
  Platform,
  AppState,
  Alert as RNAlert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../src/Icon';
import { Colors } from '../../src/theme';
import { api, Alert, Member } from '../../src/api';
import MemberMap from '../../src/MemberMap';
import { formatRelativeLocal } from '../../src/timeFormat';
import * as memberStore from '../../src/store/memberStore';
import { logResumeDecision, markAlertDismissed } from '../../src/resumeDiagnostics';
import { setActiveEmergency } from '../../src/activeEmergency';

// -------------------------------------------------------------------------
// Tracking-status helper
// -------------------------------------------------------------------------
// Turns coord-availability + `last_seen` freshness into a caregiver-grade
// traffic-light status.  Rules (Build 51 refinement):
//
//   🟢 Tracking healthy      — coords present AND last_seen ≤ 60 s ago
//   🟡 Location updating…    — coords present AND last_seen 60 s – 5 min
//   🟡 Last known location   — coords present but stale (>5 min) OR no
//                              last_seen timestamp available
//   🔴 Location unavailable  — RESERVED for the true "no coords at all"
//                              case (member's device has never uploaded)
//
// The critical invariant: **the pill and MemberMap MUST derive from the
// same canonical state**.  Callers pass in the same `hasCoords` /
// `lastSeenIso` values they used to render the map, so the pill can
// never say "unavailable" while a marker is visible on the map.
// -------------------------------------------------------------------------
type TrackingStatus = { color: string; bg: string; label: string; emoji: string };

const STATUS_HEALTHY:  TrackingStatus = { color: '#166534', bg: '#DCFCE7', label: 'Tracking healthy',    emoji: '🟢' };
const STATUS_UPDATING: TrackingStatus = { color: '#92400E', bg: '#FEF3C7', label: 'Location updating…', emoji: '🟡' };
const STATUS_LAST_KNOWN: TrackingStatus = { color: '#92400E', bg: '#FEF3C7', label: 'Last known location', emoji: '🟡' };
const STATUS_UNAVAILABLE: TrackingStatus = { color: Colors.error, bg: '#FEE2E2', label: 'Location unavailable', emoji: '🔴' };

function trackingStatus(hasCoords: boolean, lastSeenIso: string | null | undefined): TrackingStatus {
  if (!hasCoords) return STATUS_UNAVAILABLE;
  const lastSeenMs = lastSeenIso ? new Date(lastSeenIso).getTime() : 0;
  if (!lastSeenMs) {
    // Coords exist (from the alert doc or memberStore) but we have no
    // freshness signal — show yellow "Last known location" rather than
    // red "unavailable", because the marker on the map IS valid data.
    return STATUS_LAST_KNOWN;
  }
  const ageMs = Date.now() - lastSeenMs;
  if (ageMs <= 60 * 1000)      return STATUS_HEALTHY;
  if (ageMs <= 5 * 60 * 1000)  return STATUS_UPDATING;
  return STATUS_LAST_KNOWN;
}

function openMaps(lat: number, lon: number, label: string) {
  const q = `${lat},${lon}`;
  const url = Platform.select({
    ios: `https://maps.apple.com/?q=${encodeURIComponent(label)}&ll=${q}`,
    android: `geo:${q}?q=${q}(${encodeURIComponent(label)})`,
    default: `https://www.google.com/maps/search/?api=1&query=${q}`,
  }) as string;
  Linking.openURL(url).catch(() => {
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`);
  });
}

export default function AlertDetail() {
  const params = useLocalSearchParams<{ id?: string; member_phone?: string }>();
  const router = useRouter();
  const [alert, setAlert] = useState<Alert | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // 20 s force-tick so the "5 min ago" label and traffic-light status
  // stay accurate even when memberStore didn't broadcast an update.
  const [, forceTick] = useState(0);

  // Live subscription to the canonical member store so coords + last_seen
  // repaint automatically as fresh uploads arrive.  Build 50 rule: we
  // never own a local `member` state here — always read from the store.
  const liveMember = memberStore.useMember(alert?.member_id) ?? null;

  const load = useCallback(async () => {
    if (!params.id) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      const res = await api.get('/alerts');
      const list: Alert[] = res.data || [];
      const found = list.find((a) => a.id === params.id) || null;
      if (!found) {
        // Alert no longer exists — mark it dismissed so the auto-resume
        // detector never routes back here in this session, clear the
        // shared active-emergency store (so the dashboard banner
        // disappears too), and log the reason.
        if (params.id) markAlertDismissed(params.id as string);
        setActiveEmergency(null);
        logResumeDecision({
          reason: 'get-404',
          alertId: (params.id as string) || null,
          detail: 'GET /alerts did not include this id',
        });
        setNotFound(true);
      } else if (found.resolved === true) {
        // Already resolved — surface briefly then bounce to dashboard.
        if (params.id) markAlertDismissed(params.id as string);
        setActiveEmergency(null);
        setAlert(found);
      } else {
        setAlert(found);
        // Prime the canonical store immediately.  If the caller hasn't
        // fetched this member yet (e.g. deep-link cold-start), pull it
        // once so the map has coords to render.
        if (found.member_id) {
          memberStore.fetchOne(found.member_id).catch(() => {});
        }
      }
    } catch (e: any) {
      // Treat auth/network as not-found so we don't trap. The
      // auto-resume detector will re-validate on the next
      // AppState → active anyway.
      if (params.id) markAlertDismissed(params.id as string);
      setActiveEmergency(null);
      logResumeDecision({
        reason: 'fetch-failed',
        alertId: (params.id as string) || null,
        detail: e?.response?.status ? `HTTP ${e.response.status}` : (e?.message || 'unknown'),
      });
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  // If the alert vanished from the server (resolved-and-pruned or
  // cross-tenant), bounce out after a short grace so the user isn't
  // stuck staring at an empty state.  Build 50 hotfix: bounce to the
  // Dashboard (not /(tabs)/alerts) so the user lands in a stable,
  // safe location.  The Dashboard's banner will pick up any genuinely
  // still-active emergency from activeEmergency store.
  useEffect(() => {
    if (!notFound) return;
    const t = setTimeout(() => router.replace('/(tabs)/dashboard'), 1500);
    return () => clearTimeout(t);
  }, [notFound, router]);

  // -----------------------------------------------------------------------
  //  Auto-refresh: every 15 s while the incident is unresolved AND the
  //  app is foregrounded, ask the member's device (via silent push) for
  //  a fresh GPS upload.  We do NOT re-fetch the alert doc itself — it's
  //  immutable until someone taps Resolve.
  //
  //  Design guarantees:
  //    • Stops the moment `alert.resolved === true` (server flip during
  //      cascade OR after our own resolve tap).
  //    • Stops when the app backgrounds (no reason to burn battery on
  //      an incident the caregiver isn't looking at).
  //    • Fires an immediate refresh on mount + on every foreground
  //      transition so the map has fresh coords within seconds.
  // -----------------------------------------------------------------------
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const memberId = alert?.member_id;
    const isResolved = !!alert?.resolved;
    if (!memberId || isResolved) return;

    const pulse = () => {
      memberStore.requestRefresh(memberId).catch(() => {});
    };
    pulse();
    refreshTimerRef.current = setInterval(pulse, 15_000);

    const appSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        pulse();
      }
    });

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
      appSub.remove();
    };
  }, [alert?.member_id, alert?.resolved]);

  // Force a re-render every 20 s so the relative timestamp + tracking-
  // status pill drift correctly even without a memberStore broadcast.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);

  // -----------------------------------------------------------------------
  //  Resolve action.  Optimistic UI: flip the local alert to resolved
  //  immediately, then hit the backend.  If the backend errors, roll back
  //  and show the failure — the resolve endpoint is idempotent so double-
  //  taps are safe.
  // -----------------------------------------------------------------------
  const onResolve = useCallback(() => {
    if (!alert || resolving) return;
    RNAlert.alert(
      'Resolve emergency?',
      `This will mark ${alert.member_name}'s SOS as resolved and notify every family member.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Resolve',
          style: 'default',
          onPress: async () => {
            setResolving(true);
            try {
              const res = await api.post(`/alerts/${alert.id}/resolve`);
              const updated = res?.data?.alert ?? { ...alert, resolved: true };
              setAlert(updated as Alert);
              // Clear the shared active-emergency store so the dashboard
              // banner disappears everywhere at once.
              setActiveEmergency(null);
              markAlertDismissed(alert.id);
              // Stop the tracking pulse loop by falling through the
              // useEffect above (resolved flag flip triggers cleanup).
            } catch (e: any) {
              const status = e?.response?.status;
              if (status === 404) {
                // The alert no longer exists (deleted by another
                // caregiver, TTL-expired, cross-tenant, etc.) — never
                // trap the user here.  Clear all cached emergency
                // state, log the decision, and bounce to Dashboard.
                markAlertDismissed(alert.id);
                setActiveEmergency(null);
                logResumeDecision({
                  reason: 'resolve-404',
                  alertId: alert.id,
                  detail: 'POST /alerts/{id}/resolve returned 404',
                });
                setResolving(false);
                setNotFound(true); // triggers 1.5s bounce to /(tabs)/dashboard
                return;
              }
              RNAlert.alert(
                'Could not resolve',
                e?.response?.data?.detail || 'Please try again.',
              );
            } finally {
              setResolving(false);
            }
          },
        },
      ],
    );
  }, [alert, resolving]);

  // -----------------------------------------------------------------------
  //  Render
  // -----------------------------------------------------------------------
  if (loading) {
    return (
      <SafeAreaView style={styles.center} edges={['top', 'bottom']}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </SafeAreaView>
    );
  }

  if (notFound || !alert) {
    return (
      <SafeAreaView style={styles.center} edges={['top', 'bottom']}>
        <Icon name="checkmark-circle-outline" size={64} color={Colors.success} />
        <Text style={styles.notFoundTitle}>Alert no longer active</Text>
        <Text style={styles.notFoundBody}>
          This alert has been resolved or is no longer available.
          Taking you to the alerts list…
        </Text>
      </SafeAreaView>
    );
  }

  // Canonical coord + freshness resolution.  Both the map and the
  // tracking-status pill derive from these SAME variables so they
  // can never disagree ("map shows a marker, pill says unavailable"
  // was Bug #2 in Build #51 QA).  Priority:
  //   1. liveMember (memberStore) — freshest, updated every 15 s via
  //      auto-refresh loop and by any silent-push location upload.
  //   2. alert.latitude/longitude — snapshot captured at SOS trigger.
  //      When used as fallback, the effective "last seen" is the
  //      alert's own created_at (that's when the coord was valid).
  const liveLat = typeof liveMember?.latitude === 'number' ? liveMember.latitude : null;
  const liveLon = typeof liveMember?.longitude === 'number' ? liveMember.longitude : null;
  const usingLiveCoords = liveLat !== null && liveLon !== null;
  const lat = usingLiveCoords ? liveLat : alert.latitude;
  const lon = usingLiveCoords ? liveLon : alert.longitude;
  const hasCoords = typeof lat === 'number' && typeof lon === 'number';
  // When we're using liveMember's coord, its `last_seen` drives freshness.
  // When we're falling back to the alert doc's coord, that coord was
  // captured at alert creation, so `alert.created_at` is the correct
  // freshness stamp — NOT any live memberStore timestamp (which would
  // otherwise make us claim "healthy" for the wrong data source).
  const effectiveLastSeen: string | null | undefined = usingLiveCoords
    ? liveMember?.last_seen
    : alert.created_at;
  const address = liveMember?.location_name || null;
  const memberPhone = liveMember?.emergency_contact_phone
    || (params.member_phone as string | undefined)
    || '';
  const memberLabel = alert.member_name || 'Family member';
  const resolved = !!alert.resolved;
  const status = trackingStatus(hasCoords, effectiveLastSeen);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.headerBar}>
        <TouchableOpacity
          testID="alert-back"
          onPress={() => router.replace('/(tabs)/dashboard')}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to dashboard"
        >
          <Icon name="chevron-back" size={26} color={Colors.text} />
          <Text style={styles.backText}>Dashboard</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Status banner: ACTIVE (red, unresolved) or RESOLVED (gray). */}
        <View
          testID={resolved ? 'sos-banner-resolved' : 'sos-banner-active'}
          style={[styles.banner, resolved ? styles.bannerResolved : styles.bannerActive]}
        >
          <Text style={styles.bannerEmoji}>{resolved ? '✅' : '🆘'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.bannerTitle}>
              {resolved ? 'SOS RESOLVED' : 'ACTIVE SOS EMERGENCY'}
            </Text>
            <Text style={styles.bannerSub}>
              {resolved
                ? `Resolved by ${alert.resolved_by_name || 'a family member'}`
                : `Triggered ${formatRelativeLocal(alert.created_at)}`}
            </Text>
          </View>
        </View>

        <Text style={styles.memberName}>{memberLabel}</Text>
        {address ? (
          <Text style={styles.addressLine}>📍 {address}</Text>
        ) : null}

        {/* Tracking-status traffic-light pill. */}
        <View
          testID="tracking-status-pill"
          style={[styles.trackingPill, { backgroundColor: status.bg }]}
        >
          <Text style={styles.trackingEmoji}>{status.emoji}</Text>
          <Text style={[styles.trackingLabel, { color: status.color }]}>{status.label}</Text>
        </View>

        {/* Live map — auto-refreshes coords every 15 s while unresolved. */}
        {hasCoords && (
          <View style={styles.mapCard} testID="sos-map-card">
            <MemberMap
              latitude={lat as number}
              longitude={lon as number}
              memberName={memberLabel}
              locationName={address || undefined}
              height={240}
            />
            <TouchableOpacity
              testID="sos-open-in-maps"
              style={styles.mapsBtn}
              onPress={() => openMaps(lat as number, lon as number, memberLabel)}
              activeOpacity={0.85}
            >
              <Icon name="navigate" size={20} color={Colors.surface} />
              <Text style={styles.mapsBtnText}>Open in Maps</Text>
            </TouchableOpacity>
          </View>
        )}

        {!hasCoords && (
          <View style={styles.noCoordsCard} testID="sos-no-coords">
            <Icon name="location-outline" size={32} color={Colors.textTertiary} />
            <Text style={styles.noCoordsTitle}>Waiting for location…</Text>
            <Text style={styles.noCoordsBody}>
              We&apos;re asking {memberLabel}&apos;s phone for a fresh GPS fix.
              This usually takes 10–30 seconds.
            </Text>
          </View>
        )}

        {/* Primary action: Call 911 (always visible, red). */}
        <TouchableOpacity
          testID="sos-call-911"
          style={styles.callEmergencyBtn}
          onPress={() => Linking.openURL('tel:911').catch(() => {})}
          activeOpacity={0.85}
        >
          <Icon name="call" size={26} color={Colors.surface} />
          <Text style={styles.callEmergencyText}>Call 911</Text>
        </TouchableOpacity>

        {/* Secondary action: Call the member's designated contact / phone. */}
        {!!memberPhone && (
          <TouchableOpacity
            testID="sos-call-member"
            style={styles.callMemberBtn}
            onPress={() => Linking.openURL(`tel:${memberPhone}`).catch(() => {})}
            activeOpacity={0.85}
          >
            <Icon name="call-outline" size={22} color={Colors.primary} />
            <Text style={styles.callMemberText}>Call {memberLabel}</Text>
          </TouchableOpacity>
        )}

        {/* Resolve emergency — hidden once resolved. */}
        {!resolved && (
          <TouchableOpacity
            testID="sos-resolve"
            style={[styles.resolveBtn, resolving && styles.btnDisabled]}
            onPress={onResolve}
            disabled={resolving}
            activeOpacity={0.85}
          >
            {resolving ? (
              <ActivityIndicator color={Colors.surface} />
            ) : (
              <>
                <Icon name="checkmark-circle" size={22} color={Colors.surface} />
                <Text style={styles.resolveBtnText}>Resolve emergency</Text>
              </>
            )}
          </TouchableOpacity>
        )}

        {resolved && (
          <View style={styles.resolvedFooter} testID="sos-resolved-footer">
            <Text style={styles.resolvedFooterText}>
              This emergency was marked resolved
              {alert.resolved_at ? ` ${formatRelativeLocal(alert.resolved_at)}` : ''}
              . Every family member has been notified.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  center: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  headerBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 8 },
  backBtn: { flexDirection: 'row', alignItems: 'center', padding: 8 },
  backText: { fontSize: 17, color: Colors.text, marginLeft: 2 },
  body: { paddingHorizontal: 20, paddingBottom: 40, paddingTop: 8 },

  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 16, paddingHorizontal: 16,
    borderRadius: 14, marginBottom: 16,
  },
  bannerActive: {
    backgroundColor: Colors.error,
    boxShadow: '0px 6px 16px rgba(220,38,38,0.35)' as any,
  },
  bannerResolved: {
    backgroundColor: '#4B5563',
  },
  bannerEmoji: { fontSize: 30 },
  bannerTitle: { color: Colors.surface, fontSize: 16, fontWeight: '800', letterSpacing: 0.5 },
  bannerSub: { color: Colors.surface, fontSize: 13, opacity: 0.92, marginTop: 2 },

  memberName: { fontSize: 30, fontWeight: '800', color: Colors.text, lineHeight: 36 },
  addressLine: { fontSize: 15, color: Colors.textSecondary, marginTop: 6, lineHeight: 21 },

  trackingPill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    gap: 6, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 999, marginTop: 12,
  },
  trackingEmoji: { fontSize: 12 },
  trackingLabel: { fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },

  mapCard: { marginTop: 20, borderRadius: 14, overflow: 'hidden' },
  mapsBtn: {
    marginTop: 10, height: 50, backgroundColor: Colors.primary,
    borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  mapsBtnText: { color: Colors.surface, fontSize: 16, fontWeight: '700' },

  noCoordsCard: {
    marginTop: 20, borderRadius: 14, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface, padding: 20, alignItems: 'center', gap: 8,
  },
  noCoordsTitle: { fontSize: 15, fontWeight: '800', color: Colors.textPrimary },
  noCoordsBody: { fontSize: 13, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 },

  callEmergencyBtn: {
    marginTop: 22, height: 64,
    backgroundColor: Colors.error, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    boxShadow: '0px 6px 14px rgba(220,38,38,0.28)' as any,
  },
  callEmergencyText: { color: Colors.surface, fontSize: 18, fontWeight: '800', letterSpacing: 0.4 },

  callMemberBtn: {
    marginTop: 12, height: 54,
    backgroundColor: 'transparent', borderRadius: 12,
    borderWidth: 2, borderColor: Colors.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  callMemberText: { color: Colors.primary, fontSize: 15, fontWeight: '800' },

  resolveBtn: {
    marginTop: 12, height: 54,
    backgroundColor: Colors.primary, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  resolveBtnText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  btnDisabled: { opacity: 0.6 },

  resolvedFooter: {
    marginTop: 16, padding: 14, borderRadius: 12,
    backgroundColor: Colors.tertiary, borderWidth: 1, borderColor: Colors.border,
  },
  resolvedFooterText: {
    fontSize: 13, color: Colors.textSecondary, lineHeight: 19, textAlign: 'center',
  },

  notFoundTitle: { fontSize: 20, fontWeight: '700', color: Colors.text, marginTop: 12 },
  notFoundBody: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 22 },
});
