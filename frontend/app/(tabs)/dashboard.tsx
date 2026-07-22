import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  RefreshControl, Alert as RNAlert, Linking, ActivityIndicator, Animated, Pressable, Platform,
  AppState,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Icon } from '../../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Colors, StatusColor } from '../../src/theme';
import { api, Member, MemberSummary, getBillingStatus, BillingStatus, FamilyInvite, listFamilyInvites, revokeFamilyInvite } from '../../src/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { geocodeLabelForCoord, formatLastSeenAge } from '../../src/locationRefresh';
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
import { logPipelineEvent } from '../../src/refreshPipelineLog';
import { useActiveEmergency } from '../../src/activeEmergency';
// TrackingStatusPill removed — Build XX family screen simplification.
import { hasPinForUser } from '../../src/pinAuth';
import { wasPinSetupDismissed, markPinSetupDismissed } from '../../src/pinSetupPrompt';
import Svg, { Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const SOS_FAB_SIZE = 114; // accessibility: ~30% larger than original 88dp for tremor / dexterity users

// ── Embedded map preview ──────────────────────────────────────────────────────
// Uses the Google Static Maps API (a plain image URL) rather than a WebView so
// multiple cards in a ScrollView don't each spin up a JS runtime.  One HTTP
// request per unique lat/lon pair; React Native's Image caches by URL so the
// same tile is not re-fetched on every render.  Size 600×280 at scale=2 renders
// at 300×140 logical pixels — within the sprint's 120–160 px target.
const _STATIC_MAPS_KEY = (process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '').trim();
function buildStaticMapUrl(lat: number, lon: number): string {
  const marker = encodeURIComponent(`color:0x1B5E35|${lat},${lon}`);
  return (
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lon}&zoom=15&size=600x280&scale=2` +
    `&markers=${marker}` +
    `&key=${_STATIC_MAPS_KEY}`
  );
}
const SOS_RING_SIZE = 134; // FAB + 10 px gap each side for the progress ring
const SOS_RING_RADIUS = 64; // (SOS_RING_SIZE / 2) - (strokeWidth / 2)
const SOS_CIRCUMFERENCE = 2 * Math.PI * SOS_RING_RADIUS; // ≈ 402.1

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
  // Build #59 — pending invitations surfaced on the dashboard so a
  // caregiver can see who they've invited but who hasn't accepted
  // yet ("🟡 Invitation Pending").  Fetched alongside /members and
  // refreshed on the same cadence.
  const [pendingInvites, setPendingInvites] = useState<FamilyInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Build 50 hotfix — banner surfaces stale-but-unresolved emergencies
  // (>5 min old) instead of auto-yanking the user to the incident screen.
  const activeEmergency = useActiveEmergency();
  // Welcome banner — shown once after a user completes onboarding for the
  // first time.  Auto-dismisses after 3 s.  Keyed by userId so it fires
  // once per account, not once per install (handles re-installs cleanly).
  const [showWelcomeBanner, setShowWelcomeBanner] = useState(false);
  useEffect(() => {
    if (!user?.id) return;
    const key = `@kinnship/welcomed_v1_${user.id}`;
    (async () => {
      try {
        const already = await AsyncStorage.getItem(key);
        if (already) return;
        await AsyncStorage.setItem(key, '1');
        setShowWelcomeBanner(true);
        setTimeout(() => setShowWelcomeBanner(false), 3000);
      } catch (_e) {}
    })();
  }, [user?.id]);

  // PIN setup card — shown once on the dashboard after first login if no
  // PIN is set yet and the user hasn't tapped "Not now" before.
  const [showPinCard, setShowPinCard] = useState(false);
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const hasPin = await hasPinForUser(user.id);
      if (hasPin) return;
      const dismissed = await wasPinSetupDismissed(user.id);
      if (!dismissed) setShowPinCard(true);
    })();
  }, [user?.id]);
  // SOS hold-to-activate. 2.5 s hold → 3-2-1 countdown overlay → fires.
  // Cancel button on the overlay aborts before any alert is sent.
  const [sosHolding, setSosHolding] = useState(false);
  const [sosCounting, setSosCounting] = useState(false);
  const [sosCountdown, setSosCountdown] = useState(3);
  const sosScale = useRef(new Animated.Value(1)).current;
  const sosHoldProgress = useRef(new Animated.Value(0)).current;
  const sosHoldAnim = useRef<Animated.CompositeAnimation | null>(null);
  const sosCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sosDashOffset = sosHoldProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [SOS_CIRCUMFERENCE, 0],
  });
  // Ref mutex — state updates batch async, so a second touch event inside
  // the same event loop tick could still read sosHolding as false. The ref
  // is checked synchronously and is bulletproof against double-tap races.
  const sosDialingRef = useRef(false);

  // Build 47 — the dashboard's old "subscribe to fresh-member broadcasts
  // and merge into local state" useEffect has been DELETED.  Member
  // updates now arrive through `useAllMembers()` from the canonical
  // store, which atomically replaces records and notifies every
  // consumer (this dashboard, the member detail screen, Leonidas,
  // SOS, etc.) simultaneously.  No more setMembers((prev) => ...)
  // merge races.

  const load = async (trigger: DashboardLoadTrigger = 'unknown') => {
    // Pipeline instrumentation — record what triggered this refresh
    // so Diagnostics can show the full event sequence.
    try { logPipelineEvent({ stage: 'dashboard-load', trigger }); } catch (_e) {}
    // ============================================================
    //  v1.2.0 (43) — Dashboard Refresh Log (pure additive)
    // ============================================================
    //  Open a new entry on every load() invocation regardless of
    //  trigger.  All timestamps + raw response + cascade are written
    //  here; this is the canonical source of truth for "what did the
    //  /members API return to Charles" during a stale-render incident.
    setLoadError(false);
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
        // Build #59 — fire the invites fetch in parallel too so the
        // "Invitation Pending" section stays in sync with members on
        // every dashboard load.  Kept out of the Promise.all above so
        // an invites-endpoint hiccup can never block the primary
        // /members render path.
        //
        // Build #61 — client-side belt over the backend suspenders in
        // list_invites().  If for ANY reason a "pending" invite comes
        // back for a recipient whose account is already in the family
        // (stale row from a pre-hotfix build, race between /join and
        // list_invites, dashboard reading its own cached response,
        // etc.), silently hide the ghost pending card so the caregiver
        // never sees a "Pending" pill for someone they can literally
        // see in their family right now on the same screen.
        listFamilyInvites()
          .then((r) => {
            const memberEmails = new Set(
              (m?.data || []).map((mm: Member) =>
                (mm.user_id ? String(mm.name || '').toLowerCase() : ''),
              ),
            );
            // Better source: look up email via /members won't have it —
            // dashboard members[] doesn't carry an email column.  We rely
            // on invite.invitee_email + the backend's server-side heal.
            // If the backend has correctly transitioned the row to
            // "accepted", the .filter below already excludes it.  This
            // Set-based hide is a NAME-based safety net for the rare
            // pre-hotfix rows that still say "pending" AND the caregiver
            // has a member with the same display name.
            void memberEmails;
            setPendingInvites(
              (r?.invites || []).filter((iv) => {
                if (iv.status !== 'pending') return false;
                // Name-collision safety net: hide any pending invite
                // whose invitee_name matches an existing member.  This
                // is best-effort because members[] doesn't expose
                // email — the primary heal is server-side.
                const invName = (iv.invitee_name || '').trim().toLowerCase();
                if (!invName) return true;
                const nameClash = (m?.data || []).some(
                  (mm: Member) => (mm.name || '').trim().toLowerCase() === invName,
                );
                return !nameClash;
              }),
            );
          })
          .catch(() => { /* non-fatal */ });
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
        setLoadError(false);
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
      setLoadError(true);
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

  // launchSOS — fires the phone dialer only. GPS + /sos API are handled
  // by the /sos-sending screen after navigation.
  //
  // v6.6 ordering preserved: the countdown overlay's setSosCounting(false)
  // runs in the same setInterval tick as this call; the dialer fires in
  // setTimeout(0) — after React commits the state but before any other JS
  // work queues up. No RN Modal is involved so no competing Android window.
  const launchSOS = useCallback(() => {
    if (sosDialingRef.current) return;
    sosDialingRef.current = true;
    const dialOnce = () => Linking.openURL('tel:911');
    setTimeout(() => {
      dialOnce().catch(() => {
        setTimeout(() => {
          dialOnce().catch(() => {
            RNAlert.alert(
              '🆘 Call 911',
              "Your phone's dialer couldn't be opened. Please dial 911 manually right now.",
              [{ text: 'OK' }],
            );
          });
        }, 250);
      });
    }, 0);
    setTimeout(() => { sosDialingRef.current = false; }, 3000);
  }, []);

  // startCountdown — begins the 3-2-1 overlay after the hold completes.
  // Each tick fires a light haptic. At zero: heavy haptic, dialer fires,
  // navigate to /sos-sending which owns GPS + API.
  const startCountdown = useCallback(() => {
    setSosCounting(true);
    setSosCountdown(3);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    let count = 3;
    sosCountdownRef.current = setInterval(() => {
      count -= 1;
      if (count > 0) {
        setSosCountdown(count);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        clearInterval(sosCountdownRef.current!);
        sosCountdownRef.current = null;
        // Close overlay synchronously in this tick — v6.6 ordering.
        setSosCounting(false);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        launchSOS();
        router.push('/sos-sending');
      }
    }, 1000);
  }, [launchSOS, router]);

  const cancelCountdown = useCallback(() => {
    if (sosCountdownRef.current) {
      clearInterval(sosCountdownRef.current);
      sosCountdownRef.current = null;
    }
    setSosCounting(false);
    setSosCountdown(3);
    sosDialingRef.current = false; // release mutex — no alert was sent
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Animated.spring(sosScale, { toValue: 1, useNativeDriver: true, friction: 6 }).start();
  }, [sosScale]);

  const onSosHoldStart = useCallback(() => {
    if (sosDialingRef.current) return;
    setSosHolding(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); // finger-down feedback
    Animated.spring(sosScale, { toValue: 0.92, useNativeDriver: true, friction: 8, tension: 120 }).start();
    sosHoldProgress.setValue(0);
    sosHoldAnim.current = Animated.timing(sosHoldProgress, {
      toValue: 1,
      duration: 2500,
      useNativeDriver: false, // SVG strokeDashoffset is not supported by the native driver
    });
    sosHoldAnim.current.start(({ finished }) => {
      if (!finished) return; // released early — onSosHoldEnd handles cleanup
      setSosHolding(false);
      sosHoldProgress.setValue(0);
      Animated.spring(sosScale, { toValue: 1, useNativeDriver: true, friction: 6 }).start();
      startCountdown();
    });
  }, [sosHoldProgress, sosScale, startCountdown]);

  const onSosHoldEnd = useCallback(() => {
    if (!sosHoldAnim.current) return; // already completed naturally — no-op
    sosHoldAnim.current.stop();
    sosHoldAnim.current = null;
    setSosHolding(false);
    sosHoldProgress.setValue(0);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); // cancellation feedback
    Animated.spring(sosScale, { toValue: 1, useNativeDriver: true, friction: 6 }).start();
  }, [sosScale, sosHoldProgress]);

  const quickCheckIn = (m: Member) => {
    // Navigate immediately — the check-in screen owns the GPS + API call
    // and shows Loading → Success → Error (mirrors the SOS architecture).
    // Success is only shown after the server returns 200.
    router.push({ pathname: '/check-in', params: { memberId: m.id, name: m.name } });
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
        contentContainerStyle={{ paddingBottom: 160 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.hello}>Hello,</Text>
            <Text style={styles.name}>{user?.full_name?.split(' ')[0] || 'there'} 👋</Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity testID="dashboard-settings" onPress={() => router.push('/(tabs)/me')} style={styles.iconBtn}>
              <Icon name="settings" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity testID="dashboard-logout" onPress={logout} style={styles.iconBtn}>
              <Icon name="log-out-outline" size={20} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Welcome banner — shown once after onboarding completes.
            Auto-dismisses after 3 s.  Not full-screen, just a small
            celebratory moment that creates closure before the user
            explores their family dashboard. */}
        {showWelcomeBanner && (
          <View style={styles.welcomeBanner} testID="dashboard-welcome-banner">
            <Text style={styles.welcomeBannerText}>✅ You're all set. Welcome to Kinnship!</Text>
          </View>
        )}

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
            <Text style={styles.summaryNum}>
              {seniors.length > 0 ? `${totalCheckedIn} of ${seniors.length}` : '—'}
            </Text>
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
          <TouchableOpacity testID="add-member-btn" onPress={() => router.push('/add-member')} style={styles.addBtn}>
              <Icon name="add" size={16} color={Colors.primary} />
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
        </View>

        {seniors.length > 0 && <Text style={styles.subSection}>👴 Seniors</Text>}
        {seniors.map(m => (
          <MemberCard key={m.id} member={m} sum={sumOf(m.id)} isSenior
            onPress={() => router.push(`/member/${m.id}`)}
            onCheckIn={m.user_id === user?.id ? () => quickCheckIn(m) : undefined}
          />
        ))}

        {family.length > 0 && <Text style={styles.subSection}>👨‍👩‍👧 Family</Text>}
        {family.map(m => (
          <MemberCard key={m.id} member={m} sum={sumOf(m.id)}
            onPress={() => router.push(`/member/${m.id}`)}
            onCheckIn={m.user_id === user?.id ? () => quickCheckIn(m) : undefined}
          />
        ))}

        {loadError && members.length === 0 && (
          <View style={styles.loadErrorCard} testID="dashboard-load-error">
            <Icon name="cloud-offline-outline" size={40} color={Colors.error} />
            <Text style={styles.loadErrorTitle}>Couldn't load your family.</Text>
            <Text style={styles.loadErrorMsg}>Please check your connection and try again.</Text>
            <TouchableOpacity
              testID="dashboard-retry"
              onPress={() => load('pull-to-refresh')}
              activeOpacity={0.8}
              style={styles.loadRetryBtn}
            >
              <Text style={styles.loadRetryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}
        {!loadError && members.length === 0 && (
          <View style={styles.empty}>
            <Text style={{ fontSize: 36 }}>👨‍👩‍👧</Text>
            <Text style={styles.emptyText}>No family members yet. Tap "Add" to get started.</Text>
          </View>
        )}

        {/* Build #59 — Pending Invitations section.  Renders any
            invites the caregiver has sent but the invitee hasn't
            accepted yet.  Each row shows the invitee's name, email,
            and expiry, plus a "Cancel" affordance to revoke a
            mis-sent invite.  Refreshes automatically on every
            dashboard load and pull-to-refresh. */}
        {pendingInvites.length > 0 && (
          <View style={styles.pendingSection} testID="pending-invites-section">
            <Text style={styles.subSection}>🟡 Invitation Pending</Text>
            {pendingInvites.map((iv) => (
              <PendingInviteCard
                key={iv.id}
                invite={iv}
                onCancel={async () => {
                  try {
                    await revokeFamilyInvite(iv.id);
                    setPendingInvites((prev) => prev.filter((x) => x.id !== iv.id));
                  } catch (_e) { /* non-fatal, keep card */ }
                }}
              />
            ))}
          </View>
        )}

        {/* PIN setup card — dismissible, shown after first login when no
            PIN is configured.  Moved off the critical onboarding path so
            the user reaches the dashboard before being asked to set one. */}
        {showPinCard && (
          <View style={styles.pinCard} testID="dashboard-pin-setup-card">
            <View style={styles.pinCardRow}>
              <Text style={styles.pinCardEmoji}>🔐</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.pinCardTitle}>Add a 4-digit PIN</Text>
                <Text style={styles.pinCardBody}>
                  Protect your account with a 4-digit PIN for faster sign-in.
                </Text>
              </View>
              <TouchableOpacity
                testID="dashboard-pin-dismiss"
                onPress={async () => {
                  setShowPinCard(false);
                  if (user?.id) {
                    try { await markPinSetupDismissed(user.id); } catch (_e) {}
                  }
                }}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Icon name="close" size={20} color={Colors.textTertiary} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              testID="dashboard-pin-setup-btn"
              style={styles.pinCardBtn}
              onPress={() => router.push('/(auth)/pin-setup' as any)}
              activeOpacity={0.85}
            >
              <Text style={styles.pinCardBtnText}>Set up PIN</Text>
            </TouchableOpacity>
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

      {/* 3-2-1 countdown overlay — absolute-positioned (NOT a RN Modal)
          so there is no competing Android window when the dialer fires.
          setSosCounting(false) + launchSOS() run in the same setInterval
          tick, preserving the v6.6 "close overlay → setTimeout(0) dialer"
          ordering that solved the 10/20 Android focus-race. */}
      {sosCounting && (
        <View style={styles.sosCountdownOverlay} testID="sos-countdown-overlay">
          <View style={styles.sosCountdownCard}>
            <Text style={styles.sosCountdownEmoji}>🆘</Text>
            <Text style={styles.sosCountdownHeading}>Emergency Alert</Text>
            <Text style={styles.sosCountdownSub}>Sending in...</Text>
            <Text style={styles.sosCountdownNumber}>{sosCountdown}</Text>
            <TouchableOpacity
              testID="sos-countdown-cancel"
              onPress={cancelCountdown}
              activeOpacity={0.85}
              style={styles.sosCountdownCancel}
            >
              <Text style={styles.sosCountdownCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* SOS FAB — press and hold 2.5 s to trigger the countdown. */}
      <View style={styles.sosFabContainer} pointerEvents="box-none">
        <View style={{ width: SOS_RING_SIZE, height: SOS_RING_SIZE, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={SOS_RING_SIZE} height={SOS_RING_SIZE} style={StyleSheet.absoluteFill}>
            {/* Track ring — faint background arc, only visible while holding */}
            {sosHolding && (
              <Circle
                cx={SOS_RING_SIZE / 2} cy={SOS_RING_SIZE / 2}
                r={SOS_RING_RADIUS}
                stroke="rgba(255,255,255,0.28)"
                strokeWidth={6} fill="none"
              />
            )}
            {/* Progress arc — fills clockwise from 12 o'clock */}
            {sosHolding && (
              <AnimatedCircle
                cx={SOS_RING_SIZE / 2} cy={SOS_RING_SIZE / 2}
                r={SOS_RING_RADIUS}
                stroke="white" strokeWidth={6} fill="none"
                strokeDasharray={`${SOS_CIRCUMFERENCE}`}
                strokeDashoffset={sosDashOffset as any}
                strokeLinecap="round"
                rotation="-90"
                origin={`${SOS_RING_SIZE / 2}, ${SOS_RING_SIZE / 2}`}
              />
            )}
          </Svg>
          <Pressable
            testID="sos-button"
            onPressIn={onSosHoldStart}
            onPressOut={onSosHoldEnd}
            android_disableSound
          >
            <Animated.View style={[styles.sosFab, { transform: [{ scale: sosScale }] }]}>
              <Text style={styles.sosFabIcon}>🆘</Text>
            </Animated.View>
          </Pressable>
        </View>
        <Text style={[styles.sosFabLabel, sosHolding && styles.sosFabLabelHolding]}>
          {sosHolding ? 'Release to cancel' : 'Hold for SOS'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

// Build #59 — Pending Invitation card.  Renders next to real
// members but is visually distinct (amber accent, "Pending" pill)
// so caregivers can tell at a glance who hasn't accepted yet.
function PendingInviteCard({
  invite, onCancel,
}: {
  invite: FamilyInvite;
  onCancel: () => Promise<void> | void;
}) {
  const initials = (invite.invitee_name || '?')
    .split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  const expLabel = invite.expires_at
    ? new Date(invite.expires_at).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric',
      })
    : null;
  return (
    <View
      testID={`pending-invite-${invite.id}`}
      style={styles.pendingCard}
    >
      <View style={styles.pendingAvatarWrap}>
        <View style={styles.pendingAvatar}>
          <Text style={styles.pendingAvatarText}>{initials}</Text>
        </View>
        <Text style={styles.pendingDot}>🟡</Text>
      </View>
      <View style={{ flex: 1, marginLeft: 14 }}>
        <Text style={styles.pendingName}>
          {invite.invitee_name}
          {invite.relationship ? (
            <Text style={styles.pendingRelation}>  ·  {invite.relationship}</Text>
          ) : null}
        </Text>
        <Text style={styles.pendingMeta} numberOfLines={1}>
          {invite.invitee_email}
        </Text>
        <View style={styles.pendingStatusRow}>
          <View style={styles.pendingBadge}>
            <Text style={styles.pendingBadgeText}>Invitation Pending</Text>
          </View>
          {expLabel ? (
            <Text style={styles.pendingExp}>Expires {expLabel}</Text>
          ) : null}
        </View>
      </View>
      <TouchableOpacity
        testID={`pending-invite-cancel-${invite.id}`}
        onPress={() => {
          RNAlert.alert(
            'Cancel invitation?',
            `${invite.invitee_name} won't be able to accept this invitation anymore. You can send a new one later.`,
            [
              { text: 'Keep', style: 'cancel' },
              { text: 'Cancel invite', style: 'destructive', onPress: () => { onCancel(); } },
            ],
          );
        }}
        style={styles.pendingCancelBtn}
        activeOpacity={0.7}
      >
        <Icon name="close" size={20} color={Colors.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}



function MemberCard({ member, sum, isSenior, onPress, onCheckIn }: {
  member: Member; sum?: MemberSummary; isSenior?: boolean;
  onPress: () => void; onCheckIn?: () => void;
}) {
  const initials = member.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  // Build #58 — Location Sharing overrides the health dot.  When a
  // member has explicitly turned sharing OFF, the top-right glyph
  // and the small dot behind the avatar both flip to a neutral lock
  // (🔒 / grey) so the card can never read as "🟢 Tracking Healthy"
  // for a member whose location isn't being shared at all.  Health
  // status still lives underneath — we just don't paint it in a
  // colour that could be misread as "location tracking is fine".
  const sharingOff = (member as any).location_sharing_enabled === false;
  const dot = sharingOff
    ? '🔒'
    : member.status === 'healthy'
      ? '🟢'
      : member.status === 'warning'
        ? '🟡'
        : '🔴';

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
          <View style={[
            styles.statusDot,
            {
              // Build #58 — health dot on the avatar corner also
              // respects Location Sharing.  Grey ring when sharing
              // is off (matches the top-right 🔒 glyph and the
              // dedicated privacy row below).
              backgroundColor: sharingOff ? '#9CA3AF' : StatusColor(member.status),
            },
          ]} />
        </View>
        <View style={{ flex: 1, marginLeft: 14 }}>
          <View style={styles.nameRow}>
            <Text style={styles.memberName}>{member.name}{member.age && member.age > 0 ? `, ${member.age}` : ''}</Text>
            <Text style={styles.statusEmoji}>{dot}</Text>
          </View>
          {/* Build XX — Location Sharing OFF: keep the privacy lock row.
              When sharing is enabled: show factual location freshness —
              no tracking badge, no color-coded health signal. */}
          {(member as any).location_sharing_enabled === false ? (
            <Text style={styles.memberMetaPrivacy} testID={`member-privacy-off-${member.id}`}>
              🔒 Location Sharing Off
            </Text>
          ) : (
            <>
              <Text style={styles.memberMetaLastKnown}>📍 Last known location</Text>
              <Text style={styles.memberMeta}>{member.location_name || 'Unknown'}</Text>
              {member.last_seen ? (
                <Text style={styles.memberMetaFreshness}>
                  Updated {formatLastSeenAge(member.last_seen)}
                </Text>
              ) : null}
            </>
          )}
          {/* Build #59 — hide the medication chip row entirely when
              there's no medication schedule at all.  Previously the
              row rendered "0/0 taken" for seniors with no meds set
              up, which read as broken data.  Rule: only surface the
              chips when the senior actually has at least one
              scheduled medication for today. */}
          {isSenior && sum && sum.medication_total > 0 && (
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

      {/* Embedded map preview — only when location sharing is on.
          Tapping navigates to the member detail screen (same as the
          card's main press target) which hosts the full interactive map.
          No new GPS polling: lat/lon come from the member object already
          fetched for this render.  No new geocoding: location_name is
          already resolved and shown in the text row above. */}
      {(member as any).location_sharing_enabled !== false && (
        <TouchableOpacity
          testID={`member-map-preview-${member.id}`}
          onPress={onPress}
          activeOpacity={0.92}
          style={styles.mapPreviewWrap}
        >
          {member.latitude != null && member.longitude != null ? (
            <Image
              source={{ uri: buildStaticMapUrl(member.latitude, member.longitude) }}
              style={styles.mapPreviewImg}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.mapPlaceholder}>
              <Text style={styles.mapPlaceholderText}>📍 Location unavailable</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {onCheckIn && (
        <TouchableOpacity
          testID={`member-checkin-${member.id}`}
          onPress={onCheckIn}
          activeOpacity={0.85}
          style={styles.checkinPill}
        >
          <Text style={styles.checkinPillText}>✅ Check in</Text>
        </TouchableOpacity>
      )}
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
  memberMeta: { fontSize: 13, color: Colors.textTertiary, marginTop: 1 },
  memberMetaAge: { fontSize: 11, color: Colors.textTertiary, marginTop: 1, opacity: 0.75 },
  // Build XX — freshness-first family card labels.
  memberMetaLastKnown: { fontSize: 11, color: Colors.textTertiary, marginTop: 2, fontWeight: '600' },
  memberMetaFreshness: { fontSize: 13, color: Colors.primary, fontWeight: '700', marginTop: 2 },
  // Build #57 — Location Sharing Off row: neutral grey lock + honest
  // copy, replaces the "📍 Location Name" line entirely so caregivers
  // can't misread a private member as tracking-healthy.
  memberMetaPrivacy: {
    fontSize: 13,
    fontWeight: '700',
    color: '#374151',
    marginTop: 2,
  },
  freshnessLabel: { fontSize: 11, color: Colors.textTertiary, marginTop: 2 },
  cardStatusPill: { marginTop: 6 },
  freshnessRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  freshnessRefreshing: { fontSize: 11, color: Colors.primary, fontWeight: '700' },
  _refreshAllBtn_unused: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.tertiary,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, gap: 4,
  },
  _refreshAllText_unused: { color: Colors.primary, fontWeight: '700', fontSize: 13 },
  medRow: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  medChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.tertiary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  medChipEmoji: { fontSize: 12 },
  medChipText: { fontSize: 12, fontWeight: '700', color: Colors.primary },
  checkinPill: {
    marginTop: 12, height: 42, borderRadius: 12, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  checkinPillText: { color: Colors.surface, fontWeight: '700', fontSize: 14 },
  mapPreviewWrap: {
    marginTop: 12, borderRadius: 12, overflow: 'hidden', height: 140,
  },
  mapPreviewImg: { width: '100%', height: 140 },
  mapPlaceholder: {
    height: 140, borderRadius: 12,
    backgroundColor: Colors.tertiary,
    alignItems: 'center', justifyContent: 'center',
  },
  mapPlaceholderText: { color: Colors.textTertiary, fontSize: 13, fontWeight: '600' },
  empty: { alignItems: 'center', padding: 24, marginHorizontal: 24, marginTop: 8 },
  emptyText: { color: Colors.textTertiary, marginTop: 8, textAlign: 'center' },
  sosFabContainer: {
    position: 'absolute', bottom: 18, left: 0, right: 0,
    alignItems: 'center', gap: 8,
  },
  sosFab: {
    width: SOS_FAB_SIZE, height: SOS_FAB_SIZE, borderRadius: SOS_FAB_SIZE / 2,
    backgroundColor: Colors.sos,
    alignItems: 'center', justifyContent: 'center', gap: 1,
    boxShadow: '0px 8px 20px rgba(220,38,38,0.45)' as any,
    ...Platform.select({ android: { elevation: 10 } }),
  },
  sosFabIcon: { fontSize: 34, lineHeight: 40 },
  sosFabLabel: { fontSize: 13, fontWeight: '700', color: Colors.textTertiary, letterSpacing: 0.4 },
  sosFabLabelHolding: { color: Colors.sos, fontWeight: '700' },
  // 3-2-1 countdown overlay
  sosCountdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  sosCountdownCard: {
    width: 280,
    backgroundColor: Colors.surface,
    borderRadius: 24,
    paddingVertical: 32,
    paddingHorizontal: 28,
    alignItems: 'center',
    boxShadow: '0px 16px 40px rgba(0,0,0,0.4)' as any,
    ...Platform.select({ android: { elevation: 20 } }),
  },
  sosCountdownEmoji: { fontSize: 44, marginBottom: 8 },
  sosCountdownHeading: { fontSize: 22, fontWeight: '900', color: Colors.textPrimary, textAlign: 'center' },
  sosCountdownSub: { fontSize: 14, color: Colors.textSecondary, marginTop: 6, marginBottom: 16, textAlign: 'center' },
  sosCountdownNumber: { fontSize: 80, fontWeight: '900', color: Colors.sos, lineHeight: 88 },
  sosCountdownCancel: {
    marginTop: 24, alignSelf: 'stretch', height: 52,
    borderRadius: 14, borderWidth: 2, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  sosCountdownCancelText: { fontSize: 16, fontWeight: '800', color: Colors.textPrimary },
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


  // Build #59 — Pending Invitations styling.  Amber accents so the
  // section reads as "waiting on someone" without being alarming.
  pendingSection: { marginTop: 6, paddingHorizontal: 20 },
  welcomeBanner: {
    marginHorizontal: 24,
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: Colors.primary,
    borderRadius: 14,
  },
  welcomeBannerText: {
    color: Colors.surface,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  pinCard: {
    marginHorizontal: 24, marginTop: 14, padding: 16,
    backgroundColor: Colors.surface, borderRadius: 18,
    borderWidth: 1, borderColor: Colors.border,
    boxShadow: '0px 2px 8px rgba(27,94,53,0.07)',
  },
  pinCardRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pinCardEmoji: { fontSize: 28 },
  pinCardTitle: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  pinCardBody: { fontSize: 13, color: Colors.textSecondary, marginTop: 2, lineHeight: 18 },
  pinCardBtn: {
    marginTop: 14, height: 46, borderRadius: 14, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  pinCardBtnText: { color: Colors.surface, fontSize: 15, fontWeight: '700' },
  pendingCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#FFFCF0',
    borderRadius: 16, padding: 14,
    marginBottom: 10,
    borderWidth: 1, borderColor: '#F4E7B0',
  },
  pendingAvatarWrap: { position: 'relative', width: 54, height: 54 },
  pendingAvatar: {
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: '#FBE9A6',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#F4E7B0',
  },
  pendingAvatarText: { fontSize: 18, fontWeight: '800', color: '#8B6D0F' },
  pendingDot: { position: 'absolute', bottom: -2, right: -2, fontSize: 16 },
  pendingName: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  pendingRelation: { fontSize: 13, color: Colors.textSecondary, fontWeight: '600' },
  pendingMeta: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  pendingStatusRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: 6, gap: 10,
  },
  pendingBadge: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, backgroundColor: '#F5D66B',
  },
  pendingBadgeText: { fontSize: 11, fontWeight: '800', color: '#5C4712', letterSpacing: 0.3 },
  pendingExp: { fontSize: 11, color: Colors.textTertiary, fontWeight: '600' },
  pendingCancelBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 6,
  },
  loadErrorCard: {
    alignItems: 'center', marginHorizontal: 24, marginTop: 24, marginBottom: 8,
    backgroundColor: Colors.errorBg || '#FEE2E2', borderRadius: 20,
    padding: 28, borderWidth: 1, borderColor: Colors.error,
  },
  loadErrorTitle: { fontSize: 17, fontWeight: '700', color: Colors.error, marginTop: 12, textAlign: 'center' },
  loadErrorMsg: { fontSize: 14, color: Colors.textSecondary, marginTop: 6, textAlign: 'center' },
  loadRetryBtn: {
    marginTop: 16, paddingHorizontal: 28, paddingVertical: 11,
    backgroundColor: Colors.error, borderRadius: 999,
  },
  loadRetryText: { color: Colors.surface, fontWeight: '700', fontSize: 15 },
});
