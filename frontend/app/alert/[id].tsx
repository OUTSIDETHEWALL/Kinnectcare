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
 *     • An authorized, source-labeled location with bounded fresh-fix waiting
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
import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Linking,
  Platform,
  Alert as RNAlert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../src/Icon';
import { Colors } from '../../src/theme';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import MemberMap from '../../src/MemberMap';
import { formatDateTimeLocal, formatRelativeLocal } from '../../src/timeFormat';
import { logResumeDecision, markAlertDismissed } from '../../src/resumeDiagnostics';
import { setActiveEmergency } from '../../src/activeEmergency';
import { hasSosCoordinates, isFreshSosFix, useSosDetailLocation, type FamilyAlert } from '../../src/sosDetailLocation';

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
  const { user } = useAuth();
  // A scope change must never render the previous screen's location.
  return <ScopedAlertDetail
    key={JSON.stringify([user?.id, user?.family_group_id, params.id])}
    id={params.id}
    familyId={user?.id ? user.family_group_id : null}
    memberPhoneParam={params.member_phone}
  />;
}

function ScopedAlertDetail({ id, familyId, memberPhoneParam }: {
  id?: string; familyId?: string | null; memberPhoneParam?: string;
}) {
  const router = useRouter();
  const [alert, setAlert] = useState<FamilyAlert | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  useEffect(() => {
    if (!id || !familyId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      try {
        const { data } = await api.get<FamilyAlert[]>('/alerts', { signal: controller.signal });
        if (controller.signal.aborted) return;
        const found = (data || []).find(a => a.id === id && a.type === 'sos' && a.family_group_id === familyId);
        if (!found || found.resolved) {
          markAlertDismissed(id);
          setActiveEmergency(null);
        }
        if (found) setAlert(found);
        else {
          logResumeDecision({ reason: 'get-404', alertId: id, detail: 'GET /alerts did not include this id' });
          setNotFound(true);
        }
      } catch (e: any) {
        if (controller.signal.aborted) return;
        markAlertDismissed(id);
        setActiveEmergency(null);
        logResumeDecision({
          reason: 'fetch-failed', alertId: id,
          detail: e?.response?.status ? `HTTP ${e.response.status}` : (e?.message || 'unknown'),
        });
        setNotFound(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [id, familyId]);

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

  const onIncidentEnded = useCallback((latest: FamilyAlert | null) => {
    if (id) markAlertDismissed(id);
    setActiveEmergency(null);
    setAlert(latest);
    if (!latest) setNotFound(true);
  }, [id]);
  const location = useSosDetailLocation(notFound ? null : alert, onIncidentEnded);

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
              setAlert(updated as FamilyAlert);
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

  const snapshot = hasSosCoordinates(alert.latitude, alert.longitude);
  // An older shared pin must not displace a location attached to the SOS.
  const fix = location.fix && (!snapshot || (location.fix.capturedAt
    && Date.parse(location.fix.capturedAt) > Date.parse(alert.created_at))) ? location.fix : null;
  const lat = fix?.latitude ?? alert.latitude;
  const lon = fix?.longitude ?? alert.longitude;
  const hasCoords = hasSosCoordinates(lat, lon);
  const address = fix?.address ?? null;
  const memberPhone = location.phone || alert.member_phone || memberPhoneParam || '';
  const memberLabel = alert.member_name || 'Family member';
  const resolved = !!alert.resolved;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      {/* Full-width primary return button — spec: 52dp height, 12dp radius,
          #1B5E35 fill, white text 18sp bold, arrow-back icon 24dp white,
          16dp horizontal padding, 16dp top margin, 20dp bottom margin.
          Must be unmistakably a button — not a breadcrumb or page title. */}
      <View style={styles.returnRow}>
        <TouchableOpacity
          testID="alert-back"
          onPress={() => router.replace('/(tabs)/dashboard')}
          style={styles.returnBtn}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Return to dashboard"
        >
          <Icon name="arrow-back" size={24} color="#FFFFFF" />
          <Text style={styles.returnBtnText}>Return to Dashboard</Text>
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

        {hasCoords && (
          <View style={styles.mapCard} testID="sos-map-card">
            <Text style={styles.noCoordsTitle} testID="sos-location-source">
              {fix ? (isFreshSosFix(fix, alert) ? 'Fresh location' : 'Last known location')
                : 'Location attached to SOS'}
            </Text>
            <Text style={styles.trackingSecondary} testID="sos-location-captured">
              {fix?.capturedAt ? `Captured ${formatDateTimeLocal(fix.capturedAt)}` : 'Capture time unavailable'}
            </Text>
            {fix?.accuracy != null && (
              <Text style={styles.trackingSecondary} testID="sos-location-accuracy">
                {`Accuracy about ${Math.round(fix.accuracy)} m`}
              </Text>
            )}
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
            <Text style={styles.noCoordsTitle}>
              {location.waiting ? 'Looking for a location…' : 'Location unavailable'}
            </Text>
            <Text style={styles.noCoordsBody}>
              {location.waiting ? 'Checking for a shared location.'
                : 'No shared location is available for this emergency right now.'}
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
  returnRow: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 20 },
  returnBtn: {
    height: 52, backgroundColor: '#1B5E35', borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 16, gap: 10,
  },
  returnBtnText: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
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

  memberName: { fontSize: 30, fontWeight: '800', color: Colors.textPrimary, lineHeight: 36 },
  addressLine: { fontSize: 15, color: Colors.textSecondary, marginTop: 6, lineHeight: 21 },

  trackingPillWrap: { marginTop: 12 },
  trackingSecondary: {
    marginTop: 4,
    fontSize: 12,
    color: Colors.textTertiary,
  },

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

  notFoundTitle: { fontSize: 20, fontWeight: '700', color: Colors.textPrimary, marginTop: 12 },
  notFoundBody: { fontSize: 15, color: Colors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 22 },
});
