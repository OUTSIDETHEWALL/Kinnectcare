import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  RefreshControl, Alert as RNAlert, Linking, ActivityIndicator, Modal, Platform,
  AppState,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Colors, StatusColor } from '../../src/theme';
import { api, Member, MemberSummary, getBillingStatus, BillingStatus } from '../../src/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { geocodeLabelForCoord } from '../../src/locationRefresh';
import {
  requestRefresh as requestMemberRefresh,
  clearIfNewer as clearRefreshIfNewer,
  subscribeRefreshing,
  STALE_THRESHOLD_MS,
} from '../../src/locationRefreshState';
import { formatTimeAgo } from '../../src/timeFormat';
import { logScreenRender } from '../../src/screenRenderLog';
import {
  startLoad as dashStartLoad,
  markGetSent as dashMarkGetSent,
  markGetReceived as dashMarkGetReceived,
  markSetState as dashMarkSetState,
  recordStalenessTrigger as dashRecordStaleness,
  markError as dashMarkError,
  DashboardLoadTrigger,
} from '../../src/dashboardLoadLog';
import { logCardRender } from '../../src/cardRenderLog';
import { useAuth } from '../../src/AuthContext';
import * as memberStore from '../../src/store/memberStore';
import { useActiveEmergency } from '../../src/activeEmergency';

export default function Dashboard() {
  const router = useRouter();
  const { user, logout } = useAuth();
  // Build 47 — Dashboard no longer owns a local copy of the members
  // array.  Every consumer reads from `memberStore` so coordinates,
  // last_seen, location_name, and accuracy can never drift apart
  // between this screen and the Member detail screen.  The previous
  // setMembers() + subscribeMember() merge dance has been deleted in
  // favour of the canonical store.
  const members = memberStore.useAllMembers();
  const [summary, setSummary] = useState<MemberSummary[]>([]);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Build 50 hotfix — banner surfaces stale-but-unresolved emergencies
  // (>5 min old) instead of auto-yanking the user to the incident screen.
  const activeEmergency = useActiveEmergency();
  // SOS confirmation modal — purposefully in-app (NOT Alert.alert) so:
  //   1. Cancel responds instantly with no system animation lag
  //   2. The dialer launch fires from a clean synchronous event handler,
  //      avoiding the Android activity-launch race that occurred when an
  //      Alert.alert's dismiss animation overlapped with Linking.openURL
  //   3. The styling matches the rest of the app (large finger-friendly
  //      buttons for senior users, high-contrast brand colors)
  const [sosConfirmOpen, setSosConfirmOpen] = useState(false);
  // 'idle' | 'dialing' — guards the "Yes, Call 911" button so multiple rapid
  // taps cannot race the Linking.openURL intent (was failing ~1/10 times).
  const [sosDialState, setSosDialState] = useState<'idle' | 'dialing'>('idle');
  // Ref-based mutex — state updates batch async, so a second tap inside the
  // same event loop tick can still see `sosDialState === 'idle'`. The ref is
  // checked synchronously and is bulletproof against double-tap races.
  const sosDialingRef = useRef(false);

  // Build 47 — the dashboard's old "subscribe to fresh-member broadcasts
  // and merge into local state" useEffect has been DELETED.  Member
  // updates now arrive through `useAllMembers()` from the canonical
  // store, which atomically replaces records and notifies every
  // consumer (this dashboard, the member detail screen, Leonidas,
  // SOS, etc.) simultaneously.  No more setMembers((prev) => ...)
  // merge races.

  const load = async (trigger: DashboardLoadTrigger = 'unknown') => {
    // ============================================================
    //  v1.2.0 (43) — Dashboard Refresh Log (pure additive)
    // ============================================================
    //  Open a new entry on every load() invocation regardless of
    //  trigger.  All timestamps + raw response + cascade are written
    //  here; this is the canonical source of truth for "what did the
    //  /members API return to Charles" during a stale-render incident.
    const dlogId = await dashStartLoad(trigger).catch(() => '');
    try {
      // Mark the moment axios.get('/members') is about to fire.  We
      // do this BEFORE Promise.all so a slow /summary doesn't skew
      // the timing of the /members request.
      if (dlogId) await dashMarkGetSent(dlogId).catch(() => {});
      let mRes: any = null;
      try {
        // Build 47 — INTENTIONALLY retains a direct `api.get('/members')`
        // here (rather than `memberStore.fetchAll()`) because the
        // dashboard load log captures the raw axios response —
        // status code + Date header + raw_members payload — for
        // the diagnostic ring buffer.  The store's fetchAll()
        // returns only the parsed array, losing those forensic
        // fields that were critical to diagnosing the Build 41-46
        // stale-render incidents.
        //
        // This is NOT a state-ownership bypass: the line directly
        // below feeds `m.data` into the canonical store via
        // `memberStore.upsertMany()`, so every consumer of
        // `useAllMembers()` / `useMember(id)` sees the same record
        // this dashboard renders.  The dashboard is one of several
        // writers into the canonical store, not an owner of
        // independent state.
        const [m, s, b] = await Promise.all([
          api.get('/members'),
          api.get('/summary'),
          getBillingStatus().catch(() => null),
        ]);
        mRes = m;
        // Capture full raw response + status + Date header BEFORE any
        // mutation.  This is the immutable record of "what the API
        // returned to this device at this exact moment in time".
        if (dlogId) {
          await dashMarkGetReceived(dlogId, {
            status: m?.status ?? null,
            raw_members: Array.isArray(m?.data) ? m.data : null,
            server_date_header:
              (m?.headers?.date as string | undefined) ||
              (m?.headers?.Date as string | undefined) ||
              null,
          }).catch(() => {});
        }
        // v1.2.8 instrumentation (kept for backwards compat with
        // existing tests that read the screenRenderLog).
        try {
          const list: any[] = Array.isArray(m.data) ? m.data : [];
          await logScreenRender({
            src: 'dashboard-fetch',
            memberCount: list.length,
          });
          for (const mb of list) {
            await logScreenRender({
              src: 'dashboard-fetch',
              memberId: mb?.id,
              lat: mb?.latitude,
              lon: mb?.longitude,
              lastSeen: mb?.last_seen ?? null,
              locationName: mb?.location_name ?? null,
            });
          }
        } catch (_e) {}
        // Build 47 — atomic write to the canonical store.  Every
        // subscriber (this dashboard via useAllMembers, the member
        // detail screen, Leonidas via getMyLastSeenMs, etc.) sees the
        // exact same record at the same moment.  Never partial:
        // upsertMany replaces each member's full object reference.
        memberStore.upsertMany(Array.isArray(m.data) ? m.data : []);
        setSummary(s.data.members || []);
        if (b) setBilling(b);
        if (dlogId) await dashMarkSetState(dlogId).catch(() => {});
      } catch (e: any) {
        if (dlogId) {
          await dashMarkError(
            dlogId,
            String(e?.response?.status ? `HTTP ${e.response.status}` : e?.message || e),
          ).catch(() => {});
        }
        throw e;
      }

      // v1.3.2 — pull-on-stale: 60 s freshness threshold (was 2 min).
      // For any family member whose last_seen is older than 60 s, ask
      // the backend to send a silent push to that member's device
      // requesting a fresh GPS upload.  The locationRefreshState
      // helper marks the member as "refreshing" so MemberCard can
      // show a spinner indicator, and the next /members poll clears
      // the spinner once a newer last_seen arrives.
      try {
        const list: any[] = Array.isArray(mRes?.data) ? mRes.data : [];
        const now = Date.now();
        for (const mb of list) {
          if (!mb?.id) continue;
          const seenMs = mb?.last_seen ? new Date(mb.last_seen).getTime() : 0;
          // Clear any in-flight refresh marker that has a newer last_seen.
          if (seenMs) clearRefreshIfNewer(mb.id, seenMs);
          // Skip my OWN member row — I never need to pull-on-stale
          // for myself; this device uploads its own GPS directly.
          if (user?.id && mb?.user_id === user.id) continue;
          if (!seenMs || (now - seenMs) >= STALE_THRESHOLD_MS) {
            requestMemberRefresh(mb.id, seenMs || null);
            // Record exactly which members triggered the silent-push
            // cascade.  This is what links Joyce's per-minute "K"
            // notifications back to Charles's pull-on-stale logic.
            if (dlogId) await dashRecordStaleness(dlogId, mb.id).catch(() => {});
          }
        }
      } catch (_e) {}
    } catch (_e) {
      // Top-level catch — already recorded as error on the entry.
    }
  };

  useFocusEffect(useCallback(() => {
    // Stale-while-revalidate: only show the spinner on the VERY FIRST load
    // (when members is empty). Subsequent tab focuses revalidate silently in
    // the background to avoid the jarring spinner-flash that v6 testers
    // reported as a perceived perf regression.
    setLoading((prev) => members.length === 0 ? true : prev);
    load('focus').finally(() => setLoading(false));

    // ============================================================
    //  v1.2.2 — Dashboard freshness improvements
    // ============================================================
    //
    //  Until v1.2.1, the only triggers that refetched /members and
    //  /summary were (a) tab focus, (b) pull-to-refresh, and (c) the
    //  load() inside quickCheckIn.  Symptom: Charles could sit on
    //  Dashboard for hours with Joyce's location going stale in
    //  React state while the backend was being updated normally —
    //  he'd only see fresh data after switching tabs or pull-down.
    //
    //  Three new triggers, all gated to this tab being focused so we
    //  never refetch in the background or on screens that don't
    //  care:
    //
    //   1. Visible-tab polling — every 60 s while focused.  Cheap;
    //      /members and /summary are both small JSON payloads with
    //      no DB indexes that would hot-spot.
    //
    //   2. AppState 'active' — refetch the instant the user brings
    //      the app back to foreground (most common path for "I just
    //      opened the app and Joyce's dot is wrong").
    //
    //   3. Notification arrival — refetch whenever ANY push lands
    //      while focused (member checked in, fall, missed check-in,
    //      etc.).  Uses Notifications.addNotificationReceivedListener
    //      directly so it stacks with the global routing listener in
    //      _layout.tsx without clobbering it.
    //
    //  All three handlers are torn down in the cleanup so leaving
    //  Dashboard (tab switch, navigate to /settings, etc.) stops the
    //  polling and unsubscribes the listeners — no background work.
    const pollId = setInterval(() => {
      load('interval-60s').catch(() => {});
    }, 60_000);

    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') load('appstate-active').catch(() => {});
    });

    const notifSub = Notifications.addNotificationReceivedListener(() => {
      load('notif-received').catch(() => {});
    });

    // v1.2.9 — active-mode location watcher.
    //
    // While this tab is focused (the user is actively looking at the
    // family map), subscribe to high-accuracy position updates and
    // upload directly on every >50 m / >15 s of movement.  This is
    // the "near-realtime tracking while in the app" mode — the
    // background task can still throttle, but as long as Joyce has
    // the app open while moving, her dot keeps pace with her.
    //
    // Auto-tears down on tab blur, so battery cost only applies
    // during active engagement.  Falls back silently if permission
    // is denied or the platform is web.
    let watcherSub: any = null;
    (async () => {
      try {
        if (Platform.OS === 'web') return;
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted') return;
        watcherSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            distanceInterval: 50,
            timeInterval: 15_000,
          },
          async (pos) => {
            try {
              const memberId = await AsyncStorage.getItem('kc_my_member_id_v1');
              if (!memberId) return;
              const label = await geocodeLabelForCoord(pos.coords.latitude, pos.coords.longitude);
              const body: any = {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
              };
              if (label) body.location_name = label;
              const resp = await api.put(`/members/${memberId}/location`, body);
              // Build 48 — upsert canonical post-write doc into store so
              // Dashboard and Member screen see the fresh timestamp
              // without waiting for the 60 s /members poll.
              if (resp?.data?.id) {
                try { memberStore.upsertOne(resp.data); } catch (_e) {}
              }
            } catch (_e) {}
          },
        );
      } catch (_e) {}
    })();

    return () => {
      clearInterval(pollId);
      appStateSub.remove();
      notifSub.remove();
      try { watcherSub?.remove?.(); } catch (_e) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.length]));

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted' || members.length === 0 || !user?.id) return;

        // ============================================================
        //  CRITICAL: send the GPS to MY OWN member record, not members[0]
        // ============================================================
        //
        // Earlier code did: api.put(`/members/${members[0].id}/location`)
        //
        // That blindly wrote THIS device's coordinates onto whichever
        // member happened to be first in the family-group list.  Two
        // problems:
        //
        //   1. Caregivers (who don't have a member record of their own)
        //      were overwriting the senior's coordinates.
        //   2. With multiple seniors in one group (e.g. Charles + Joyce),
        //      whoever opened the app would overwrite the other's
        //      location — symptom Charles reported: "Joyce's location
        //      shows Charles's stale coords; Joyce has moved 10mi but
        //      her dot never updates."
        //
        // Correct match: members[].user_id === current user.id.  This
        // requires the backend's member↔user linkage (commit bef9f37)
        // to be populated.  If no match is found (e.g. caregiver, or
        // pre-linkage account), we DO NOT send — silently no-op rather
        // than corrupt someone else's record.
        const me = members.find((m) => m.user_id === user.id);
        if (!me) {
          // Caregiver, unlinked senior, or stale token.  Logging only
          // in __DEV__ to keep production console clean.
          if (__DEV__) {
            console.log(
              '[dashboard] skipping location update — no member row ' +
              'with user_id matching current user.id'
            );
          }
          return;
        }

        const pos = await Location.getCurrentPositionAsync({});
        // v1.2.7 — reverse-geocode so the dashboard's
        // `📍 {member.location_name}` label refreshes too, not just
        // the lat/lon under the hood.  Best-effort; caller's PUT
        // omits location_name if geocode failed.
        const label = await geocodeLabelForCoord(pos.coords.latitude, pos.coords.longitude);
        const body: any = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        };
        if (label) body.location_name = label;
        // Build 48 — upsert the post-write Member doc into the
        // canonical store so the senior's own Dashboard re-renders
        // with the fresh timestamp instantly.
        const resp = await api.put(`/members/${me.id}/location`, body).catch(() => null);
        if (resp && (resp as any).data?.id) {
          try { memberStore.upsertOne((resp as any).data); } catch (_e) {}
        }
      } catch (_e) {}
    })();
  }, [members.length, user?.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load('pull-to-refresh');
    setRefreshing(false);
  };

  // Step 1 — user tapped the SOS button. Show the in-app confirmation modal.
  // This is intentionally light: no API calls, no GPS request, no permissions.
  // We want the modal to appear in <50ms so Cancel is instantly responsive.
  const triggerSOS = () => {
    setSosConfirmOpen(true);
  };

  // Step 2 — user confirmed in the modal.
  //
  // v6.6 SOS final reliability fix (was 10/20 in v6.5):
  //
  // ROOT CAUSE OF v6.5 REGRESSION:
  //   The v6.5 attempt kept the React-Native Modal open for 250ms during
  //   the Linking.openURL dispatch, showing a "Calling 911..." state.
  //   React Native's Modal uses a SEPARATE ANDROID WINDOW that sits on top
  //   of all other activities in our app.  When the dialer activity tries
  //   to come to the foreground, our Modal window competes for focus and
  //   sometimes wins back — producing the "flash then back to main screen"
  //   symptom Charles described (10/20 failure rate).
  //
  // THE FIX (returns to the proven v6.2 ordering):
  //   1) Close the Modal SYNCHRONOUSLY in the same event tick.  This
  //      schedules the Modal's Window dismissal immediately.  Android's
  //      activity manager will not have a competing Window above the
  //      dialer when it tries to take focus.
  //   2) Fire Linking.openURL in a setTimeout(0) so it runs AFTER React
  //      has committed the modal-close state update but is still queued
  //      in the very next microtask — earlier than any other work.
  //   3) Use a pure .catch() promise chain for retries — no awaits,
  //      no yields, no chance of being preempted by other JS work.
  //   4) Background work (GPS + /sos + alerts refresh) runs in a separate
  //      IIFE and is COMPLETELY DECOUPLED from the dialer launch.  It
  //      starts AFTER the dialer scheduling so it can never preempt it.
  //   5) Ref mutex prevents double-tap from triggering twice; released
  //      after 3s (not coupled to dialer completion, so user can re-tap
  //      after a real call without being permanently locked).
  const confirmSOS = useCallback(() => {
    // Synchronous mutex: refs aren't batched, so two taps within the
    // same React commit cycle are perfectly serialised.
    if (sosDialingRef.current) return;
    sosDialingRef.current = true;

    // STEP 1 — Close the modal FIRST, in this same event tick. This is
    // the single most important change versus v6.5. The Modal window
    // must dismiss BEFORE the dialer tries to take foreground focus.
    setSosConfirmOpen(false);
    setSosDialState('idle');

    // STEP 2 — Schedule the dialer in the very next microtask (setTimeout 0).
    // This runs AFTER React commits the modal-close above (so the Modal
    // Window is already in the process of dismissing) but BEFORE any other
    // JS work queues up. We use a pure promise chain — no awaits — so
    // nothing can preempt the intent dispatch.
    const dialOnce = () => Linking.openURL('tel:911');
    setTimeout(() => {
      dialOnce().catch(() => {
        // Retry once after a small delay if the first dispatch was rejected.
        setTimeout(() => {
          dialOnce().catch(() => {
            // Final fallback for the rare hard-failure case (WiFi-only
            // tablet, no dialer app installed, etc.).
            RNAlert.alert(
              '🆘 Call 911',
              "Your phone's dialer couldn't be opened. Please dial 911 manually right now.",
              [{ text: 'OK' }],
            );
          });
        }, 250);
      });
    }, 0);

    // STEP 3 — Fire-and-forget background work AFTER the dialer is queued.
    // Order matters: by the time this microtask runs, the dialer intent
    // has already been pushed to the OS's intent broker. GPS + /sos + alert
    // refresh now run on a separate async task and never touch the dialer.
    (async () => {
      try {
        let lat: number | undefined, lon: number | undefined;
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const pos = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            lat = pos.coords.latitude;
            lon = pos.coords.longitude;
          }
        } catch (_e) {}
        await api.post('/sos', { latitude: lat, longitude: lon });
        // Fix #4 of v1.2 beta: bump the background location service
        // to 10-second cadence for the next 30 min (or until the SOS
        // is resolved, whichever comes first) so the caregiver sees
        // a moving dot in real-time during the emergency.
        try {
          const bg = await import('../../src/backgroundLocation');
          await bg.beginSosBoost();
        } catch (_e) {}
        load('quick-checkin').catch(() => {});
        try {
          (globalThis as any).__kinnshipAlertsBump = Date.now();
        } catch (_e) {}
      } catch (_e) {}
    })();

    // STEP 4 — Release the mutex after 3s. Decoupled from dialer success
    // so the user can re-tap SOS after dismissing the dialer if they
    // need to call back. (If they re-tap inside 3s, the second tap is
    // safely ignored as a double-tap.)
    setTimeout(() => {
      sosDialingRef.current = false;
    }, 3000);
  }, [load]);

  const quickCheckIn = (m: Member) => {
    // INSTANT: navigate immediately so the confirmation screen renders <1s.
    router.push({ pathname: '/check-in', params: { name: m.name } });
    // Backend work runs in the background.
    (async () => {
      try {
        let lat: number | undefined, lon: number | undefined, name: string | undefined;
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const pos = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            lat = pos.coords.latitude;
            lon = pos.coords.longitude;
            // v1.2.7 — was hardcoded 'Current Location' literal which
            // made every member's dashboard label read identically
            // and never actually changed.  Real reverse-geocode now.
            name = (await geocodeLabelForCoord(lat, lon)) || undefined;
          }
        } catch (_e) {}
        await api.post('/checkins', { member_id: m.id, latitude: lat, longitude: lon, location_name: name });
        load('quick-checkin').catch(() => {});
      } catch (_e) {
        // Silent failure on the network side; the user already saw the confirmation.
      }
    })();
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const seniors = members.filter(m => m.role === 'senior');
  const family = members.filter(m => m.role === 'family');
  const sumOf = (id: string) => summary.find(s => s.member_id === id);
  const totalMedMissed = summary.reduce((a, s) => a + s.medication_missed, 0);
  const totalCheckedIn = summary.filter(s => s.role === 'senior' && s.checked_in_today).length;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 130 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.hello}>Hello,</Text>
            <Text style={styles.name}>{user?.full_name?.split(' ')[0] || 'there'} 👋</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity testID="dashboard-settings" onPress={() => router.push('/settings')} style={styles.iconBtn}>
              <Icon name="settings" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity testID="dashboard-logout" onPress={logout} style={styles.iconBtn}>
              <Icon name="log-out-outline" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Build 50 hotfix — Active-Emergency banner.  Shown when an
            unresolved SOS is detected in the family group.  The banner
            is passive (never yanks the user), always visible until the
            alert is resolved or auto-dismissed by a 404. */}
        {activeEmergency ? (
          <TouchableOpacity
            testID="dashboard-active-emergency-banner"
            style={styles.emergencyBanner}
            onPress={() => router.push(`/alert/${activeEmergency.id}`)}
            activeOpacity={0.85}
          >
            <Text style={styles.emergencyBannerEmoji}>🆘</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.emergencyBannerTitle}>
                Unresolved emergency — {activeEmergency.member_name}
              </Text>
              <Text style={styles.emergencyBannerBody}>
                Tap to open the incident screen and resolve.
              </Text>
            </View>
            <Icon name="chevron-forward" size={22} color={Colors.surface} />
          </TouchableOpacity>
        ) : null}

        <View style={styles.summaryCard}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryNum}>{members.length}</Text>
            <Text style={styles.summaryLbl}>Members</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryNum}>{totalCheckedIn}/{seniors.length}</Text>
            <Text style={styles.summaryLbl}>Checked in</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryNum, totalMedMissed > 0 && { color: Colors.warning }]}>{totalMedMissed}</Text>
            <Text style={styles.summaryLbl}>Missed meds</Text>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Your Family</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              testID="refresh-all-btn"
              onPress={() => {
                // Manual "refresh all" — re-poll + fire pull-on-stale for every
                // member regardless of their freshness, so the user can force a
                // GPS update without waiting for the 60 s threshold to elapse.
                onRefresh().catch(() => {});
                try {
                  for (const mb of members) {
                    if (!mb?.id) continue;
                    if (user?.id && mb?.user_id === user.id) continue;
                    requestMemberRefresh(
                      mb.id,
                      mb.last_seen ? new Date(mb.last_seen).getTime() : null,
                    );
                  }
                } catch (_e) {}
              }}
              style={styles.refreshAllBtn}
              activeOpacity={0.85}
            >
              <Text style={styles.refreshAllText}>🔄 Refresh</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="add-member-btn" onPress={() => router.push('/add-member')} style={styles.addBtn}>
              <Icon name="add" size={16} color={Colors.primary} />
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>

        {seniors.length > 0 && <Text style={styles.subSection}>👴 Seniors</Text>}
        {seniors.map(m => (
          <MemberCard key={m.id} member={m} sum={sumOf(m.id)} isSenior
            onPress={() => router.push(`/member/${m.id}`)}
            onCheckIn={() => quickCheckIn(m)}
          />
        ))}

        {family.length > 0 && <Text style={styles.subSection}>👨‍👩‍👧 Family</Text>}
        {family.map(m => (
          <MemberCard key={m.id} member={m} sum={sumOf(m.id)}
            onPress={() => router.push(`/member/${m.id}`)}
            onCheckIn={() => quickCheckIn(m)}
          />
        ))}

        {members.length === 0 && (
          <View style={styles.empty}>
            <Text style={{ fontSize: 36 }}>👨‍👩‍👧</Text>
            <Text style={styles.emptyText}>No family members yet. Tap "Add" to get started.</Text>
          </View>
        )}

        {billing && billing.plan === 'free' && members.length > 0 && (
          <TouchableOpacity
            testID="dashboard-upgrade-banner"
            activeOpacity={0.85}
            onPress={() => router.push('/upgrade')}
            style={styles.upgradeBanner}
          >
            <View style={styles.upgradeIconWrap}>
              <Text style={styles.upgradeIcon}>⭐</Text>
            </View>
            <View style={styles.upgradeTextBlock}>
              <Text style={styles.upgradeTitle} numberOfLines={2}>Upgrade to Family Plan</Text>
              <Text style={styles.upgradeSub} numberOfLines={2}>
                Add unlimited members for <Text style={styles.upgradePrice}>$9.99/mo</Text>
              </Text>
              {typeof billing.members_remaining === 'number' && billing.member_limit !== null ? (
                <Text style={styles.upgradeUsage} numberOfLines={1}>
                  {billing.members_remaining > 0
                    ? `${billing.members_remaining} of ${billing.member_limit} slots left`
                    : `All ${billing.member_limit} free slots used`}
                </Text>
              ) : null}
            </View>
            <View testID="dashboard-upgrade-cta" style={styles.upgradeCta}>
              <Text style={styles.upgradeCtaText}>Upgrade</Text>
            </View>
          </TouchableOpacity>
        )}
      </ScrollView>

      <TouchableOpacity testID="sos-button" onPress={triggerSOS} activeOpacity={0.85} style={styles.sosBtn}>
        <Text style={styles.sosEmoji}>🆘</Text>
        <Text style={styles.sosText}>SOS Emergency</Text>
      </TouchableOpacity>

      {/*
        In-app SOS confirmation modal. Replaces the previous Alert.alert
        approach so the dialer can fire from a clean synchronous event
        handler (no system-alert animation race with Linking.openURL).
        Buttons are oversized (60pt tall) for senior accessibility.
      */}
      <Modal
        visible={sosConfirmOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => sosDialState === 'idle' && setSosConfirmOpen(false)}
      >
        <View style={styles.sosBackdrop}>
          <View style={styles.sosCard} testID="sos-confirm-modal">
            <Text style={styles.sosCardEmoji}>🆘</Text>
            <Text style={styles.sosCardTitle}>Are you sure?</Text>
            <Text style={styles.sosCardBody}>
              Your phone's dialer will open with 911 pre-filled and your family will be alerted with your location.
            </Text>

            <TouchableOpacity
              testID="sos-confirm-yes"
              style={[styles.sosCardConfirm, sosDialState === 'dialing' && styles.sosCardConfirmDisabled]}
              onPress={confirmSOS}
              activeOpacity={0.85}
              disabled={sosDialState === 'dialing'}
            >
              {sosDialState === 'dialing' ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <ActivityIndicator color={Colors.surface} />
                  <Text style={styles.sosCardConfirmText}>Calling 911...</Text>
                </View>
              ) : (
                <Text style={styles.sosCardConfirmText}>Yes, Call 911</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              testID="sos-confirm-cancel"
              style={styles.sosCardCancel}
              onPress={() => sosDialState === 'idle' && setSosConfirmOpen(false)}
              activeOpacity={0.85}
              disabled={sosDialState === 'dialing'}
            >
              <Text style={[
                styles.sosCardCancelText,
                sosDialState === 'dialing' && { opacity: 0.4 },
              ]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function MemberCard({ member, sum, isSenior, onPress, onCheckIn }: {
  member: Member; sum?: MemberSummary; isSenior?: boolean;
  onPress: () => void; onCheckIn: () => void;
}) {
  const initials = member.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const dot = member.status === 'healthy' ? '🟢' : member.status === 'warning' ? '🟡' : '🔴';

  // v1.3.2 — live refresh indicator + relative "last updated" timestamp.
  // We subscribe to the locationRefreshState bus per-member and re-tick
  // every 20 s so the "X min ago" label stays accurate without a
  // full dashboard refetch.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => subscribeRefreshing(member.id, setRefreshing), [member.id]);
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 20_000);
    return () => clearInterval(id);
  }, []);
  const seenMs = member.last_seen ? new Date(member.last_seen).getTime() : 0;
  const ageLabel = seenMs ? formatTimeAgo(seenMs) : '';

  // v1.2.0 (44) — log every render with the exact prop value the card
  // received and the ageLabel it rendered.  Fire-and-forget; the helper
  // never blocks render.  This pairs with the broadcast log in the
  // diagnostics timeline so we can see whether the card painted the
  // value that was just broadcast, or a stale earlier value.
  try {
    logCardRender({
      member_id: member.id,
      last_seen: member.last_seen ?? null,
      age_label: ageLabel,
      refreshing,
    });
  } catch (_e) {}

  return (
    <View testID={`member-card-${member.id}`} style={styles.memberCard}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={styles.memberMain}>
        <View style={styles.avatarWrap}>
          {member.avatar_url ? (
            <Image source={{ uri: member.avatar_url }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
          )}
          <View style={[styles.statusDot, { backgroundColor: StatusColor(member.status) }]} />
        </View>
        <View style={{ flex: 1, marginLeft: 14 }}>
          <View style={styles.nameRow}>
            <Text style={styles.memberName}>{member.name}, {member.age}</Text>
            <Text style={styles.statusEmoji}>{dot}</Text>
          </View>
          <Text style={styles.memberMeta}>📍 {member.location_name || 'Unknown'}</Text>
          {refreshing ? (
            <View style={styles.freshnessRow} testID={`member-refreshing-${member.id}`}>
              <ActivityIndicator size="small" color={Colors.primary} />
              <Text style={styles.freshnessRefreshing}>Refreshing location…</Text>
            </View>
          ) : ageLabel ? (
            <Text
              style={styles.freshnessLabel}
              testID={`member-freshness-${member.id}`}
            >
              🕒 Updated {ageLabel}
            </Text>
          ) : null}
          {isSenior && sum && (
            <View style={styles.medRow}>
              <View style={styles.medChip}>
                <Text style={styles.medChipEmoji}>💊</Text>
                <Text style={styles.medChipText}>
                  {sum.medication_taken}/{sum.medication_total} taken
                </Text>
              </View>
              {sum.medication_missed > 0 && (
                <View style={[styles.medChip, { backgroundColor: Colors.warningBg }]}>
                  <Text style={[styles.medChipText, { color: Colors.warning }]}>
                    {sum.medication_missed} missed
                  </Text>
                </View>
              )}
              {sum.weekly_compliance_percent != null && (
                <View testID={`compliance-chip-${member.id}`} style={[
                  styles.medChip,
                  { backgroundColor: sum.weekly_compliance_percent >= 80 ? Colors.successBg : Colors.warningBg }
                ]}>
                  <Text style={styles.medChipEmoji}>📊</Text>
                  <Text style={[styles.medChipText, {
                    color: sum.weekly_compliance_percent >= 80 ? Colors.success : Colors.warning,
                  }]}>
                    {sum.weekly_compliance_percent}% this week
                  </Text>
                </View>
              )}
              {sum.checked_in_today && (
                <View style={[styles.medChip, { backgroundColor: Colors.successBg }]}>
                  <Text style={[styles.medChipText, { color: Colors.success }]}>✅ Checked in</Text>
                </View>
              )}
            </View>
          )}
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        testID={`member-checkin-${member.id}`}
        onPress={onCheckIn}
        activeOpacity={0.85}
        style={styles.checkinPill}
      >
        <Text style={styles.checkinPillText}>✅ Check In</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 12, paddingBottom: 16 },
  hello: { fontSize: 16, color: Colors.textTertiary },
  name: { fontSize: 28, fontWeight: '800', color: Colors.textPrimary, marginTop: 2 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border },
  headerActions: { flexDirection: 'row', gap: 10 },
  emergencyBanner: {
    marginHorizontal: 24,
    marginTop: 4,
    marginBottom: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.error,
    boxShadow: '0px 6px 14px rgba(220,38,38,0.30)',
    elevation: 4,
  },
  emergencyBannerEmoji: { fontSize: 26 },
  emergencyBannerTitle: {
    color: Colors.surface,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  emergencyBannerBody: {
    color: Colors.surface,
    fontSize: 12.5,
    opacity: 0.92,
    marginTop: 2,
  },
  summaryCard: {
    marginHorizontal: 24, padding: 18, backgroundColor: Colors.surface, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center',
    boxShadow: '0px 4px 12px rgba(27,94,53,0.06)', elevation: 2,
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryNum: { fontSize: 24, fontWeight: '800', color: Colors.primary },
  summaryLbl: { fontSize: 11, color: Colors.textTertiary, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'center' },
  summaryDivider: { width: 1, height: 36, backgroundColor: Colors.border },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: 24, marginTop: 28, marginBottom: 8 },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: Colors.textPrimary },
  addBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.tertiary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, gap: 4 },
  addBtnText: { color: Colors.primary, fontWeight: '700' },
  subSection: { fontSize: 13, fontWeight: '700', color: Colors.textTertiary, marginHorizontal: 24, marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  memberCard: {
    marginHorizontal: 24, marginTop: 10, padding: 14, backgroundColor: Colors.surface, borderRadius: 18,
    boxShadow: '0px 3px 10px rgba(27,94,53,0.06)', elevation: 2,
  },
  memberMain: { flexDirection: 'row', alignItems: 'center' },
  avatarWrap: { position: 'relative' },
  avatar: { width: 56, height: 56, borderRadius: 28 },
  avatarFallback: { backgroundColor: Colors.tertiary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: Colors.primary, fontWeight: '700' },
  statusDot: { position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: Colors.surface },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  memberName: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  statusEmoji: { fontSize: 12 },
  memberMeta: { fontSize: 13, color: Colors.textTertiary, marginTop: 2 },
  freshnessLabel: { fontSize: 11, color: Colors.textTertiary, marginTop: 2, fontWeight: '600' },
  freshnessRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  freshnessRefreshing: { fontSize: 11, color: Colors.primary, fontWeight: '700' },
  refreshAllBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.tertiary,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, gap: 4,
  },
  refreshAllText: { color: Colors.primary, fontWeight: '700', fontSize: 13 },
  medRow: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  medChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.tertiary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  medChipEmoji: { fontSize: 12 },
  medChipText: { fontSize: 12, fontWeight: '700', color: Colors.primary },
  checkinPill: {
    marginTop: 12, height: 42, borderRadius: 12, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  checkinPillText: { color: Colors.surface, fontWeight: '700', fontSize: 14 },
  empty: { alignItems: 'center', padding: 24, marginHorizontal: 24, marginTop: 8 },
  emptyText: { color: Colors.textTertiary, marginTop: 8, textAlign: 'center' },
  sosBtn: {
    position: 'absolute', bottom: 24, left: 24, right: 24,
    height: 64, backgroundColor: Colors.sos, borderRadius: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
    boxShadow: '0px 8px 16px rgba(220,38,38,0.4)', elevation: 8,
  },
  sosEmoji: { fontSize: 24 },
  sosText: { color: Colors.surface, fontSize: 18, fontWeight: '800', letterSpacing: 0.3 },
  upgradeBanner: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 20, marginTop: 24, padding: 14,
    backgroundColor: Colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: Colors.tertiary,
    boxShadow: '0px 6px 16px rgba(27,94,53,0.10)' as any,
  },
  upgradeIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.tertiary,
    alignItems: 'center', justifyContent: 'center',
  },
  upgradeIcon: { fontSize: 20 },
  upgradeTextBlock: { flex: 1, marginLeft: 12, marginRight: 8, minWidth: 0 },
  upgradeTitle: { fontSize: 14, fontWeight: '800', color: Colors.textPrimary, lineHeight: 18 },
  upgradeSub: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  upgradePrice: { fontWeight: '800', color: Colors.primary },
  upgradeUsage: { fontSize: 10.5, color: Colors.textTertiary, marginTop: 3, fontWeight: '600' },
  upgradeCta: {
    paddingHorizontal: 14, paddingVertical: 9,
    backgroundColor: Colors.primary, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  upgradeCtaText: { color: Colors.surface, fontSize: 13, fontWeight: '800' },
  upgradeCtaArrow: { color: Colors.surface, fontSize: 16, fontWeight: '700' },

  // In-app SOS confirmation modal — designed for senior accessibility:
  // oversized 60pt touch targets, ≥14:1 contrast, big readable type, urgent
  // red "Yes, Call 911" button anchored at the bottom of the modal so it
  // sits within thumb-reach.
  sosBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center', padding: 22,
  },
  sosCard: {
    width: '100%', maxWidth: 400, backgroundColor: Colors.surface,
    borderRadius: 22, padding: 24, alignItems: 'center',
    boxShadow: '0px 12px 32px rgba(0,0,0,0.35)' as any,
    ...Platform.select({ android: { elevation: 16 } }),
  },
  sosCardEmoji: { fontSize: 48, marginBottom: 4 },
  sosCardTitle: {
    fontSize: 24, fontWeight: '900', color: Colors.textPrimary,
    textAlign: 'center', marginTop: 4,
  },
  sosCardBody: {
    fontSize: 15.5, color: Colors.textSecondary,
    textAlign: 'center', marginTop: 12, lineHeight: 22,
  },
  sosCardConfirm: {
    marginTop: 22, alignSelf: 'stretch',
    height: 60, backgroundColor: Colors.sos, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 6px 14px rgba(220,38,38,0.45)' as any,
    ...Platform.select({ android: { elevation: 6 } }),
  },
  sosCardConfirmDisabled: { opacity: 0.75 },
  sosCardConfirmText: {
    color: Colors.surface, fontSize: 17, fontWeight: '900', letterSpacing: 0.3,
  },
  sosCardCancel: {
    marginTop: 10, alignSelf: 'stretch',
    height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 2, borderColor: Colors.border,
  },
  sosCardCancelText: { color: Colors.textPrimary, fontSize: 16, fontWeight: '800' },
});
