/**
 * =========================================================================
 * Missed Check-in Detail Screen
 * =========================================================================
 *
 * Destination for `missed_checkin` push-notification deep links.
 *
 * This screen is intentionally separate from `alert/[id].tsx` (the SOS
 * Incident Screen).  A missed check-in is a welfare concern, not an
 * emergency — the UI must reflect that distinction clearly.
 *
 * What this screen shows:
 *   • Amber "Missed Check-in" banner (not red, not "EMERGENCY")
 *   • Member name + the backend's human-readable message (what was
 *     expected and when)
 *   • Location map + tracking status if coords are available
 *   • "Call [member]" button if an emergency contact phone is on file
 *   • "I've checked on them" button — resolves the alert via the same
 *     backend endpoint as SOS resolve, but with calm copy
 *
 * What this screen deliberately omits:
 *   • Call 911 button
 *   • SOS banner / red colours
 *   • "Resolve emergency" or any emergency-language CTA
 *   • Any live-tracking pulse loop (not needed for a welfare check)
 *
 * Layout (top → bottom):
 *   Header bar → Amber / Acknowledged banner → Member name →
 *   Alert message → Address → Tracking pill → Map → Call → Acknowledge
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
  Alert as RNAlert,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../src/Icon';
import { Colors } from '../../src/theme';
import { api, Alert } from '../../src/api';
import MemberMap from '../../src/MemberMap';
import { formatRelativeLocal } from '../../src/timeFormat';
import * as memberStore from '../../src/store/memberStore';
import { TrackingStatusPill } from '../../src/tracking/TrackingStatusPill';

function openMaps(lat: number, lon: number, label: string) {
  const q = `${lat},${lon}`;
  const url =
    `geo:${q}?q=${q}(${encodeURIComponent(label)})`;
  Linking.openURL(url).catch(() => {
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`);
  });
}

export default function MissedCheckinDetail() {
  const params = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const [alert, setAlert] = useState<Alert | null>(null);
  const [loading, setLoading] = useState(true);
  const [acknowledging, setAcknowledging] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [, forceTick] = useState(0);

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
        setNotFound(true);
      } else {
        setAlert(found);
        if (found.member_id) {
          memberStore.fetchOne(found.member_id).catch(() => {});
        }
      }
    } catch (_e) {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  // Bounce to dashboard if the alert is no longer available.
  useEffect(() => {
    if (!notFound) return;
    const t = setTimeout(() => router.replace('/(tabs)/dashboard'), 1500);
    return () => clearTimeout(t);
  }, [notFound, router]);

  // Keep relative timestamps accurate.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);

  // -----------------------------------------------------------------------
  //  Acknowledge — marks the alert resolved so every family member's device
  //  clears the notification.  Uses the same backend endpoint as SOS resolve
  //  because the data model is shared; only the copy differs here.
  // -----------------------------------------------------------------------
  const onAcknowledge = useCallback(() => {
    if (!alert || acknowledging) return;
    RNAlert.alert(
      'Mark as checked?',
      `This will let every family member know you've checked on ${alert.member_name}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: "I've checked on them",
          style: 'default',
          onPress: async () => {
            setAcknowledging(true);
            try {
              const res = await api.post(`/alerts/${alert.id}/resolve`);
              const updated = res?.data?.alert ?? { ...alert, resolved: true };
              setAlert(updated as Alert);
              // Dismiss the sticky missed-checkin notification for this member
              // now that the caregiver has explicitly acknowledged it.
              // Fire-and-forget — a dismiss failure is purely cosmetic.
              try {
                await Notifications.dismissNotificationAsync(`miss_${alert.member_id}`);
              } catch (_e) {}
            } catch (e: any) {
              const status = e?.response?.status;
              if (status === 404) {
                // Already resolved by another family member.
                setNotFound(true);
                return;
              }
              RNAlert.alert(
                'Could not update',
                e?.response?.data?.detail || 'Please try again.',
              );
            } finally {
              setAcknowledging(false);
            }
          },
        },
      ],
    );
  }, [alert, acknowledging]);

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
          This check-in alert has been resolved or is no longer available.
          Taking you to the dashboard…
        </Text>
      </SafeAreaView>
    );
  }

  const liveLat = typeof liveMember?.latitude === 'number' ? liveMember.latitude : null;
  const liveLon = typeof liveMember?.longitude === 'number' ? liveMember.longitude : null;
  const usingLiveCoords = liveLat !== null && liveLon !== null;
  const lat = usingLiveCoords ? liveLat : alert.latitude;
  const lon = usingLiveCoords ? liveLon : alert.longitude;
  const hasCoords = typeof lat === 'number' && typeof lon === 'number';
  const effectiveLastSeen: string | null | undefined = usingLiveCoords
    ? liveMember?.last_seen
    : alert.created_at;
  const address = liveMember?.location_name || null;
  const memberPhone = liveMember?.emergency_contact_phone || '';
  const memberLabel = alert.member_name || 'Family member';
  const resolved = !!alert.resolved;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.headerBar}>
        <TouchableOpacity
          testID="checkin-back"
          onPress={() => router.replace('/(tabs)/dashboard')}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to dashboard"
        >
          <Icon name="chevron-back" size={26} color={Colors.textPrimary} />
          <Text style={styles.backText}>Dashboard</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Status banner: amber (unacknowledged) or muted green (acknowledged). */}
        <View
          testID={resolved ? 'checkin-banner-resolved' : 'checkin-banner-active'}
          style={[styles.banner, resolved ? styles.bannerResolved : styles.bannerActive]}
        >
          <Text style={styles.bannerEmoji}>{resolved ? '✅' : '⚠️'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.bannerTitle}>
              {resolved ? 'Check-in acknowledged' : 'Missed Check-in'}
            </Text>
            <Text style={styles.bannerSub}>
              {resolved
                ? `Acknowledged by ${alert.resolved_by_name || 'a family member'}`
                : `Noticed ${formatRelativeLocal(alert.created_at)}`}
            </Text>
          </View>
        </View>

        <Text style={styles.memberName}>{memberLabel}</Text>

        {/* Human-readable context from the backend — e.g. "Expected by
            09:00 (America/New_York) today. They haven't checked in yet." */}
        {!!alert.message && (
          <Text style={styles.alertMessage}>{alert.message}</Text>
        )}

        {address ? (
          <Text style={styles.addressLine}>📍 {address}</Text>
        ) : null}

        {/* Tracking status — same shared component used on SOS and dashboard. */}
        <TrackingStatusPill
          hasCoords={hasCoords}
          lastSeenIso={effectiveLastSeen}
          screen="alert"
          style={styles.trackingPillWrap}
          testID="tracking-status-pill"
        />
        {effectiveLastSeen ? (
          <Text style={styles.trackingSecondary} testID="tracking-status-secondary">
            Last updated {formatRelativeLocal(effectiveLastSeen)}
          </Text>
        ) : null}

        {/* Location map — gives the caregiver a sense of where the member
            was last seen, which is useful for a welfare check. */}
        {hasCoords && (
          <View style={styles.mapCard} testID="checkin-map-card">
            <MemberMap
              latitude={lat as number}
              longitude={lon as number}
              memberName={memberLabel}
              locationName={address || undefined}
              height={220}
            />
            <TouchableOpacity
              testID="checkin-open-in-maps"
              style={styles.mapsBtn}
              onPress={() => openMaps(lat as number, lon as number, memberLabel)}
              activeOpacity={0.85}
            >
              <Icon name="navigate" size={20} color={Colors.surface} />
              <Text style={styles.mapsBtnText}>Open in Maps</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Call the member's phone — primary action for a welfare check. */}
        {!!memberPhone && (
          <TouchableOpacity
            testID="checkin-call-member"
            style={styles.callMemberBtn}
            onPress={() => Linking.openURL(`tel:${memberPhone}`).catch(() => {})}
            activeOpacity={0.85}
          >
            <Icon name="call" size={22} color={Colors.surface} />
            <Text style={styles.callMemberText}>Call {memberLabel}</Text>
          </TouchableOpacity>
        )}

        {/* Acknowledge — resolves the alert and notifies the family. */}
        {!resolved && (
          <TouchableOpacity
            testID="checkin-acknowledge"
            style={[styles.acknowledgeBtn, acknowledging && styles.btnDisabled]}
            onPress={onAcknowledge}
            disabled={acknowledging}
            activeOpacity={0.85}
          >
            {acknowledging ? (
              <ActivityIndicator color={Colors.surface} />
            ) : (
              <>
                <Icon name="checkmark-circle" size={22} color={Colors.surface} />
                <Text style={styles.acknowledgeBtnText}>I&apos;ve checked on them</Text>
              </>
            )}
          </TouchableOpacity>
        )}

        {resolved && (
          <View style={styles.resolvedFooter} testID="checkin-resolved-footer">
            <Text style={styles.resolvedFooterText}>
              {alert.resolved_by_name
                ? `${alert.resolved_by_name} acknowledged this`
                : 'This check-in was acknowledged'}
              {alert.resolved_at ? ` ${formatRelativeLocal(alert.resolved_at)}` : ''}.
              {' '}Every family member has been notified.
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
  backText: { fontSize: 17, color: Colors.textPrimary, marginLeft: 2 },
  body: { paddingHorizontal: 20, paddingBottom: 40, paddingTop: 8 },

  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 16, paddingHorizontal: 16,
    borderRadius: 14, marginBottom: 16,
  },
  bannerActive: {
    backgroundColor: Colors.warning,
  },
  bannerResolved: {
    backgroundColor: '#4B5563',
  },
  bannerEmoji: { fontSize: 30 },
  bannerTitle: { color: Colors.surface, fontSize: 16, fontWeight: '800', letterSpacing: 0.5 },
  bannerSub: { color: Colors.surface, fontSize: 13, opacity: 0.92, marginTop: 2 },

  memberName: { fontSize: 30, fontWeight: '800', color: Colors.textPrimary, lineHeight: 36 },
  alertMessage: {
    fontSize: 15, color: Colors.textSecondary, marginTop: 8, lineHeight: 22,
  },
  addressLine: { fontSize: 15, color: Colors.textSecondary, marginTop: 6, lineHeight: 21 },

  trackingPillWrap: { marginTop: 12 },
  trackingSecondary: {
    marginTop: 4, fontSize: 12, color: Colors.textTertiary,
  },

  mapCard: { marginTop: 20, borderRadius: 14, overflow: 'hidden' },
  mapsBtn: {
    marginTop: 10, height: 50, backgroundColor: Colors.primary,
    borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  mapsBtnText: { color: Colors.surface, fontSize: 16, fontWeight: '700' },

  callMemberBtn: {
    marginTop: 22, height: 60,
    backgroundColor: Colors.primary, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  callMemberText: { color: Colors.surface, fontSize: 17, fontWeight: '800' },

  acknowledgeBtn: {
    marginTop: 12, height: 54,
    backgroundColor: Colors.success, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  acknowledgeBtnText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
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
