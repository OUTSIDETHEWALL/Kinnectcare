import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator, AppState, Platform } from 'react-native';
import { Colors } from '../src/theme';
import { registerForPushNotifications, setupNotificationsForOS, useNotificationListeners, setAppReadyForDeepLink, refreshPushTokenIfStale } from '../src/push';
import { isOnboardingDone } from '../src/onboardingStore';
import { FallDetectionOverlay } from '../src/FallDetectionOverlay';
import { hasPinForUser, isUnlockedNow } from '../src/pinAuth';
import { wasPinSetupDismissed } from '../src/pinSetupPrompt';
import { startBackgroundLocation, stopBackgroundLocation } from '../src/backgroundLocation';
import { refreshLocationIfStale, setMyMemberId, setMyUserId } from '../src/locationRefresh';
import * as locationEngine from '../src/locationEngine';
import * as leonidas from '../src/leonidas';
import * as memberStore from '../src/store/memberStore';
import { api, getCurrentToken, subscribeToTokenChanges } from '../src/api';
import {
  loadDisclaimerAck,
  subscribeDisclaimerAck,
  getDisclaimerAckSync,
} from '../src/disclaimerStore';

function RootNav() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  // PIN gate state: whether THIS user has a PIN set on this device, and
  // whether they've already unlocked-it-this-session. We re-check the
  // "has PIN" flag whenever the authenticated user changes (sign-in,
  // sign-out, account switch on the same device).
  const [pinChecked, setPinChecked] = useState(false);
  const [needsPinUnlock, setNeedsPinUnlock] = useState(false);
  // Set after first successful login when no PIN is configured AND the
  // user hasn't tapped "Not now" before. This is the source of truth
  // for the post-login "Set up a 4-digit PIN?" prompt — putting it
  // here in RootNav eliminates the race we had when login.tsx tried
  // to navigate to /(auth)/pin-setup itself (RootNav would overwrite
  // with /(tabs)/dashboard since both runs were redirecting at the
  // same time).
  const [needsPinSetup, setNeedsPinSetup] = useState(false);
  // Health disclaimer gate — first-launch only.  Acknowledgment stored in
  // AsyncStorage under DISCLAIMER_ACK_KEY.  Required for Google Play
  // medical-disclaimer compliance (v1.1.7).
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);
  const [needsDisclaimer, setNeedsDisclaimer] = useState(false);

  useEffect(() => {
    // Cold-start load + subscribe-for-future-changes.  Runs ONCE on
    // mount.  The subscriber fires when the disclaimer screen calls
    // setDisclaimerAck() so we flip needsDisclaimer to false in the
    // same tick the user taps "I Understand" — preventing the bounce-
    // back-to-disclaimer loop that v1.1.7 hit.
    let mounted = true;
    (async () => {
      const acked = await loadDisclaimerAck();
      if (mounted) {
        setNeedsDisclaimer(!acked);
        setDisclaimerChecked(true);
      }
    })();
    const unsubscribe = subscribeDisclaimerAck(() => {
      if (!mounted) return;
      const acked = getDisclaimerAckSync();
      setNeedsDisclaimer(!acked);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    (async () => {
      const done = await isOnboardingDone();
      setNeedsOnboarding(!done);
      setOnboardingChecked(true);
    })();
  }, []);

  // ============================================================
  //  v1.2.1 (build 41) — Lifecycle diagnostics
  // ============================================================
  //  Logs `app_launched` once on mount and `app_foregrounded` /
  //  `app_backgrounded` on every AppState transition.  These entries
  //  land in the same ring buffer as the location-engine events so
  //  the Diagnostics screen can show the FULL timeline (e.g.
  //  "app_backgrounded at 21:14, no SDK heartbeat since 21:13 →
  //  engine not running in background").
  useEffect(() => {
    void locationEngine.logEvent('app_launched', {
      platform: Platform.OS,
      initialAppState: AppState.currentState,
    });
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void locationEngine.logEvent('app_foregrounded');
      } else if (next === 'background' || next === 'inactive') {
        void locationEngine.logEvent('app_backgrounded', { state: next });
      }
    });
    return () => {
      try { sub.remove(); } catch (_e) {}
    };
  }, []);

  // Re-evaluate the PIN gate whenever the auth user changes. If the
  // user has a PIN saved AND they haven't unlocked-this-session yet,
  // we redirect to the PIN-login screen below. If they have NO PIN
  // saved AND they haven't dismissed the setup prompt yet, we route
  // them to /(auth)/pin-setup.
  useEffect(() => {
    // CRITICAL RACE FIX (v1.2-hotfix): reset pinChecked to false at
    // the START of every re-run.  Previously the effect only set
    // pinChecked=TRUE at the end — when the cached-user restore on
    // cold-start changed user.id from null → set, this effect kicked
    // off a fresh async hasPinForUser() check, but during that ~30ms
    // await the routing effect would fire with the STALE
    // pinChecked=true (from the prior user=null run, where we'd set
    // needsPinUnlock=false).  RootNav saw a logged-in user with
    // "PIN already checked, no unlock needed" and routed straight to
    // the dashboard (OR back to welcome, depending on segment
    // alignment) — skipping the PIN entirely.  Symptom: "notification
    // tap routes to OTP/welcome instead of PIN after device reboot".
    //
    // By resetting pinChecked=false at the top, the routing effect's
    // `if (loading || !pinChecked) return;` guard keeps the spinner
    // visible until we've recomputed needsPinUnlock against the new
    // user.  The spinner is invisible-to-fast for most users (<50ms)
    // and is the correct UX in the genuine "we don't know yet" state.
    let cancelled = false;
    setPinChecked(false);
    (async () => {
      if (!user?.id) {
        if (cancelled) return;
        setNeedsPinUnlock(false);
        setNeedsPinSetup(false);
        setPinChecked(true);
        return;
      }
      const hasPin = await hasPinForUser(user.id);
      if (cancelled) return;
      if (hasPin) {
        // Existing PIN — gate behind unlock unless we've already
        // unlocked-this-session (e.g. after a fresh email login,
        // login.tsx calls markUnlocked).
        if (!isUnlockedNow(user.id)) setNeedsPinUnlock(true);
        else setNeedsPinUnlock(false);
        setNeedsPinSetup(false);
      } else {
        // No PIN yet — prompt unless the user previously tapped
        // "Not now". The flag is per-user so signing in with a
        // different account re-prompts that account.
        setNeedsPinUnlock(false);
        const dismissed = await wasPinSetupDismissed(user.id);
        if (cancelled) return;
        setNeedsPinSetup(!dismissed);
      }
      setPinChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // ----- PIN re-prompt cadence: COLD START ONLY -----
  //
  // v6.10 re-locked the PIN on every background/foreground transition
  // (banking-app pattern). v6.11 switches to the "every cold start
  // only" pattern per user feedback — elderly users found the
  // every-resume re-prompt annoying when they briefly switched to a
  // calendar / SMS / phone call and came back. The PIN unlock now
  // sticks until the JS process actually dies (which happens on a
  // true app kill or an OS process-reclaim under memory pressure).
  //
  // If the user wants tighter re-lock cadence later they can opt in
  // via Settings — for now we ship the friendlier default.
  //
  // NOTE: previous AppState listener has been intentionally removed.

  useNotificationListeners((data) => {
    // Deep-link by notification type. Uses router.replace (not push)
    // so the user can't accidentally hit "back" and land on a
    // half-rendered intermediate screen during cold-start. The
    // pending-deep-link queue in push.ts has already guaranteed
    // that this callback only fires AFTER the auth + PIN gate in
    // RootNav has cleared, so there's no router race anymore.
    const t = data?.type;
    const subtype = data?.subtype;
    const stage = data?.stage;
    // P6 BETA DIAGNOSTICS — capture routing decision pre-navigation.
    // TODO: remove this block + the routeDiagnostics import once
    // stabilization sprint completes.  Logs to AsyncStorage only
    // (no network, no PII), bounded at 50 entries.
    const __logRoute = (toRoute: string) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const diag = require('../src/routeDiagnostics');
        void diag.logRouteDecision({
          type: typeof t === 'string' ? t : 'unknown',
          loggedIn: !!user?.id,
          hasPin: pinChecked ? !needsPinUnlock || !needsPinSetup : null,
          pinUnlocked: !needsPinUnlock,
          fromSegment: (segments && (segments as string[]).join('/')) || 'unknown',
          toRoute,
          reason: 'tap',
          alertId: typeof data?.alert_id === 'string' ? (data.alert_id as string) : null,
        });
      } catch (_e) {}
    };
    if ((t === 'medication' && (subtype === 'self_due' || !subtype)) ||
        (t === 'routine')) {
      __logRoute('/(modals)/acknowledge');
      try {
        router.replace({
          pathname: '/(modals)/acknowledge',
          params: {
            type: t,
            reminder_id: data?.reminder_id || '',
            title: data?.title || '',
            dosage: data?.dosage || '',
            member_name: data?.member_name || '',
            stage: stage || '',
          },
        } as any);
      } catch (_e) {
        router.replace('/(tabs)/alerts');
      }
      return;
    }
    if (t === 'medication' && (subtype === 'family_alert' || stage === 'family_alert')) {
      // Family alert → also open the acknowledge panel but in
      // "checked on them" mode (the screen detects this via stage).
      try {
        router.replace({
          pathname: '/(modals)/acknowledge',
          params: {
            type: 'medication',
            reminder_id: data?.reminder_id || '',
            title: data?.title || '',
            member_name: data?.member_name || '',
            stage: 'family_alert',
          },
        } as any);
      } catch (_e) {
        router.replace('/(tabs)/alerts');
      }
      return;
    }
    if (t === 'sos' || t === 'missed_checkin' || t === 'fall_detected') {
      // Fix #3 (v1.2 beta): deep-link straight to the SPECIFIC alert
      // (not the generic alerts list).  This preserves the user's
      // intent — they tapped the notification because THAT alert
      // needed their attention.  If the push didn't carry an
      // alert_id (legacy build, or the rare missing-id race), fall
      // back to the alerts list so the user isn't dead-ended.
      const aid = data?.alert_id;
      if (aid) {
        __logRoute(`/alert/${aid}`);
        router.replace({ pathname: '/alert/[id]', params: { id: aid } } as any);
      } else {
        __logRoute('/(tabs)/alerts');
        router.replace('/(tabs)/alerts');
      }
    }
  });

  useEffect(() => {
    // OS-side notification setup runs on EVERY launch, BEFORE auth.
    // This guarantees the notification channels (meds_v2, routines,
    // sos, ...) and categories (action buttons) exist on the device
    // before any push can arrive — fixing the #1 pre-launch safety
    // bug where medication / check-in / fall-detected pushes were
    // silently dropped when the app was killed or the user was
    // logged out, because the channels were only created
    // post-authentication.
    setupNotificationsForOS().catch(() => {});
  }, []);

  useEffect(() => {
    if (user) {
      registerForPushNotifications().catch(() => {});
    }
  }, [user?.id]);

  // ============================================================
  //  Auto push-token refresh on app foreground (v1.2.1)
  // ============================================================
  //
  // Joyce reported SOS deliveries silently failing after extended
  // idle periods (multi-day on-charger). Root cause: Expo/FCM
  // occasionally rotates the device push token AND the JS process
  // can stay alive across days without any useEffect re-running —
  // so the existing `useEffect([user?.id])` registration above
  // never re-fires. The backend keeps a stale token, the push
  // relay drops it silently.
  //
  // Fix: listen for AppState 'active' transitions and silently
  // re-register. `refreshPushTokenIfStale` self-throttles to once
  // per 30 minutes per successful sync (see push.ts), so rapid
  // bg/fg flips don't hammer Expo or our /auth/push-token.
  //
  // We do NOT react to 'inactive' or 'background' — only fresh
  // 'active' transitions. We also gate on a signed-in user (no
  // token to authenticate the API call otherwise).
  useEffect(() => {
    if (!user?.id) return;
    // Fire once on mount so the throttle is primed; the existing
    // useEffect above already triggers an initial register, this
    // is the no-op fallback for cases where AppState was already
    // 'active' before the user signed in (e.g. cold-start via
    // notification tap → OTP → returns to 'active').
    refreshPushTokenIfStale('mount').catch(() => {});
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refreshPushTokenIfStale('foreground').catch(() => {});
      }
    });
    return () => sub.remove();
  }, [user?.id]);

  // ============================================================
  //  v1.2.2 — Cache "my member id" + foreground location refresh
  // ============================================================
  //
  //  Joyce's location went stale on Charles's dashboard despite the
  //  backend holding fresh data.  Adding (a) a 60-second visible-tab
  //  poll, (b) an AppState 'active' refetch, and (c) a notification-
  //  arrival refetch on Dashboard handles the read side.  This
  //  effect handles the corresponding WRITE side — every foreground
  //  transition (on Joyce's own phone) also uploads a fresh GPS fix
  //  to /members/{id}/location, so even if the OS-owned background
  //  task has been throttled into silence by Android App Standby,
  //  the backend stays current.
  //
  //  We need a member_id to know whose row to update.  Fetch it once
  //  after login by matching members[].user_id === current user.id
  //  (same logic as dashboard.tsx) and cache it via
  //  setMyMemberId() — refreshLocationIfStale reads from that
  //  cache, so we don't hit /members on every foreground.
  useEffect(() => {
    if (!user?.id) {
      setMyMemberId(null).catch(() => {});
      setMyUserId(null).catch(() => {});
      return;
    }
    let cancelled = false;
    // Cache user_id immediately (synchronously usable on the next bg
    // task tick) so a slow /members fetch doesn't leave the bg log
    // without a writer identity field for the first few minutes.
    setMyUserId(user.id).catch(() => {});
    (async () => {
      try {
        // Build 47 — route through the canonical store.  This both
        // resolves "my member id" AND hydrates the store before
        // Dashboard mounts, so the first paint reads canonical data
        // and Leonidas's first patrol has a real last_seen instead
        // of falling back to the engine log.
        const arr = await memberStore.fetchAll();
        if (cancelled) return;
        const me = (arr as any[]).find((m) => m.user_id === user.id);
        await setMyMemberId(me ? me.id : null);
      } catch (_e) {
        // Network failure here is OK — dashboard's mount effect is
        // the safety net and the next /auth/me success will retry.
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // AppState 'active' → push refresh (existing) + location refresh (new).
  // Same listener pattern as the push effect; same self-throttle
  // approach (locationRefresh has its own 60-second floor).
  useEffect(() => {
    if (!user?.id) return;
    // Prime once on mount.
    refreshLocationIfStale('mount').catch(() => {});
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refreshLocationIfStale('foreground').catch(() => {});
      }
    });
    return () => sub.remove();
  }, [user?.id]);

  // ============================================================
  //  Build 47 — canonical member-store foreground sync
  // ============================================================
  //  Per the Build 47 architectural directive: whenever the
  //  caregiver application returns to the foreground (including
  //  after PIN unlock), automatically perform
  //  `memberStore.fetchAll()`.  This mirrors the observed user
  //  experience where opening Kinnship and entering the PIN
  //  immediately corrected stale location data — the cause was
  //  that the AuthProvider's session bootstrap refetched the
  //  /members endpoint, which then atomically replaced the
  //  member records.  We promote that behaviour from a happy
  //  side-effect into a deliberate guarantee.
  //
  //  The store dedupes concurrent fetchAll() calls, so this is
  //  safe to fire on every 'active' transition without hammering
  //  the API.  It runs on BOTH caregiver and senior devices —
  //  every consumer of useAllMembers()/useMember() gets the
  //  freshest backend record the instant the app comes back to
  //  the foreground.
  // ============================================================
  useEffect(() => {
    if (!user?.id) return;
    // Prime once on mount so the very first paint after PIN unlock
    // already has the freshest data (Charles's PIN-unlock = fresh
    // location refresh in his observed test).
    memberStore.fetchAll().catch(() => {});
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        memberStore.fetchAll().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [user?.id]);

  // ============================================================
  //  Background location foreground service (Fix #1 of v1.2 beta)
  // ============================================================
  //
  // Once the user is authenticated AND we've identified their own
  // member record (the row whose `user_id` matches their user.id),
  // start the OS-owned foreground service that posts location to
  // the backend every ~5 min (and every ~10 sec while SOS is
  // active — Fix #4).  The service surfaces a persistent
  // notification "🛡️ Kinnship is protecting your family" so users
  // can see at a glance that monitoring is on.
  //
  // We gate on member.user_id linkage because the bg task POSTs to
  // /api/members/{memberId}/location — without a member_id we have
  // nowhere to write to.  Caregivers (who own the group but have no
  // member row of their own) intentionally don't run the service —
  // they're tracking, not being tracked.
  //
  // Stops on logout (user becomes null).  Permission UI is handled
  // contextually by startBackgroundLocation() per
  // handle_permissions_contract.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // ============================================================
      //  v1.2.2 (build 42) — Legacy engine runtime gate
      // ============================================================
      //  Source code for the expo-location TaskManager path remains in
      //  the repo per the Phase 5 cleanup directive (don't remove yet),
      //  but the legacy engine is NOT invoked at runtime when the
      //  Transistor build is available.  Reason: running both engines
      //  concurrently risks (a) a second foreground-service slot in
      //  Android's notification shade and (b) duplicate PUTs to
      //  /api/members/{id}/location for every fix.  Transistor is the
      //  single source of truth on this build.  If a future fallback
      //  OTA ships without Transistor, this gate returns false and the
      //  legacy path resumes automatically.
      if (locationEngine.isAvailable()) return;

      if (!user?.id) {
        await stopBackgroundLocation();
        return;
      }
      try {
        // Build 47 — canonical store fetch.  The store dedupes
        // concurrent fetchAll() calls so this shares the in-flight
        // promise with the foreground-sync effect above.
        const arr = await memberStore.fetchAll();
        if (cancelled) return;
        const me = (arr || []).find((m: any) => m.user_id === user.id);
        if (!me) {
          await stopBackgroundLocation();
          return;
        }
        await startBackgroundLocation(me.id);
      } catch (_e) {
        // Silent — next session retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // ============================================================
  //  v1.4 (Phase 2) — Transistor Location Engine wiring
  // ============================================================
  //
  //  Companion to the legacy expo-location effect above.  Starts the
  //  Transistor `react-native-background-geolocation` engine after
  //  successful authentication AND once we've identified the
  //  current user's member row.  The engine's native HTTP transport
  //  posts location fixes DIRECTLY from the OS service to
  //  `PUT /api/members/{member_id}/location` — no JS round-trip,
  //  no React lifecycle dependency, no Android-Doze suppression.
  //  Payload carries `"provider":"transistor"` so backend logs (and
  //  future analytics) can distinguish engine source from the legacy
  //  expo-location path.
  //
  //  Phase 2 strict-scope decisions (per founder directive):
  //   • Engine runs IN PARALLEL with the legacy expo-location task
  //     during the validation window.  Both write to the same
  //     idempotent latest-wins endpoint.  Legacy is NOT removed —
  //     Phase 5 cleanup decommissions it once Walmart + Overnight
  //     field tests pass.
  //   • Engine is opt-in via runtime detection: if the native module
  //     is absent (web, Expo Go, or a future fallback OTA build),
  //     this effect is a clean no-op and the legacy path remains
  //     authoritative.
  //   • Caregivers who don't own a member row (no `user_id` match
  //     in /members) intentionally don't run the engine — they're
  //     tracking, not being tracked.  Same logic as the legacy
  //     effect above.
  //
  //  JWT sync: subscribes to api.ts's token-change registry so every
  //  saveToken() (verifyOtp + rolling X-Refresh-Token refresh) fans
  //  out to locationEngine.setAuthToken().  Per Transistor docs we
  //  patch the `authorization` config, not the `headers` field —
  //  the SDK's HTTP interceptor rebinds the new token on the next
  //  outgoing PUT.
  useEffect(() => {
    let cancelled = false;
    let unsubscribeToken: (() => void) | null = null;

    (async () => {
      if (!user?.id) {
        try { leonidas.stop(); } catch (_e) {}
        await locationEngine.stop();
        return;
      }
      if (!locationEngine.isAvailable()) {
        // Web / Expo Go / non-Transistor build — legacy engine remains
        // authoritative on this device.  Leonidas is a no-op without
        // the Transistor engine, so we skip starting it here too.
        return;
      }
      try {
        // Build 47 — canonical store fetch (shared in-flight with
        // the other two bootstrap effects above via store-level
        // dedupe).
        const arr = await memberStore.fetchAll();
        if (cancelled) return;
        const me = (arr || []).find((m: any) => m.user_id === user.id);
        if (!me) {
          // Caregiver-only or unlinked — nothing to upload from this
          // device.  Ensure engine is stopped in case it was running
          // from a previous session.
          try { leonidas.stop(); } catch (_e) {}
          await locationEngine.stop();
          return;
        }
        const jwt = await getCurrentToken();
        const backendBaseUrl = process.env.EXPO_PUBLIC_BACKEND_URL || '';
        if (!jwt || !backendBaseUrl) {
          // Missing config — bail rather than start with broken auth.
          return;
        }
        await locationEngine.start({
          backendBaseUrl,
          memberId: me.id,
          jwt,
        });
        // Leonidas v1.0 — passive health monitor.  Boots in lockstep
        // with the location engine; tears down on sign-out via the
        // cleanup block below.  No-op if already active.
        try { leonidas.start(); } catch (_e) {}
        // Subscribe AFTER successful start so any rolling token
        // refresh during the live session flows through.
        unsubscribeToken = subscribeToTokenChanges((tok) => {
          if (tok) {
            locationEngine.setAuthToken(tok).catch(() => {});
          }
        });
      } catch (_e) {
        // Silent — without an authenticated /members fetch we can't
        // identify the member row to upload to.  Next session retries.
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribeToken) {
        unsubscribeToken();
        unsubscribeToken = null;
      }
      // Stop Leonidas on cleanup so a user.id change tears down the
      // patrol loop in lockstep with the engine restart.
      try { leonidas.stop(); } catch (_e) {}
    };
  }, [user?.id]);

  useEffect(() => {
    if (loading || !onboardingChecked || !pinChecked || !disclaimerChecked) return;
    const inAuthGroup = segments[0] === '(auth)';
    const isWelcome = !segments[0] || segments[0] === ('index' as any);
    const isOnboarding = segments[0] === 'onboarding';
    const isDisclaimer = segments[0] === 'disclaimer';
    const isPublic =
      segments[0] === 'privacy-policy' || segments[0] === 'terms-of-service';

    // ===== FIRST-LAUNCH HEALTH DISCLAIMER GATE (v1.1.7) =====
    // Must run BEFORE the onboarding / auth checks below so the very
    // first thing a brand-new install sees is the medical disclaimer.
    // Once acknowledged (AsyncStorage flag), this branch never fires
    // again on this device.
    if (needsDisclaimer && !isDisclaimer && !isPublic) {
      router.replace('/disclaimer');
      return;
    }
    // While ON the disclaimer screen, short-circuit the rest of the
    // gate.  This is the v1.1.8 fix for the strobe-loop: v1.1.7's
    // later branches (onboarding redirect, welcome redirect, etc.)
    // would fire one after another while we were on /disclaimer,
    // each kicking us off the disclaimer to another screen, which
    // then re-triggered the first branch above to put us back on
    // /disclaimer — visible to the user as rapid flashing between
    // screens.  Halting here keeps the user on /disclaimer until
    // setDisclaimerAck() flips needsDisclaimer to false, at which
    // point the gate falls through cleanly to onboarding/auth.
    if (isDisclaimer) {
      setAppReadyForDeepLink(true);
      return;
    }
    // Which (auth) sub-route we're on, so we can let pin-login &
    // pin-setup live "inside" the authenticated session without
    // bouncing the user back to the dashboard.
    const authSubroute = ((segments as unknown as string[])[1] || '') as string;
    const onPinScreen = inAuthGroup && (authSubroute === 'pin-login' || authSubroute === 'pin-setup');

    // First-time users (not logged in, no onboarding flag) go to onboarding first.
    if (!user && needsOnboarding && !isOnboarding && !isPublic) {
      (async () => {
        const stillNeeds = !(await isOnboardingDone());
        if (stillNeeds) {
          router.replace('/onboarding');
        } else {
          setNeedsOnboarding(false);
        }
      })();
      return;
    }
    // DEFENSIVE: an unauthenticated user must NEVER be on a PIN
    // screen. PIN is per-account; without an account there's
    // nothing to set up or unlock. The v6.9 bug was a stale
    // Keychain token from a previous install briefly making
    // `user` truthy → RootNav routed to pin-setup → token
    // eventually got cleared by /auth/me failing → user back to
    // null but already stuck on pin-setup with no way out.
    //
    // Belt-and-suspenders fix: if we ever see user==null while
    // currently on a PIN screen, force-redirect to welcome.
    // (The pin-setup.tsx and pin-login.tsx screens have their
    // own identical guard, but doing it here too means we don't
    // depend on those screens having mounted yet.)
    if (!user && onPinScreen) {
      router.replace('/');
      return;
    }
    if (!user && !inAuthGroup && !isWelcome && !isOnboarding && !isPublic) {
      router.replace('/');
      return;
    }
    // PIN GATE — authenticated user with a saved PIN must enter it
    // before anything else. Same async-recheck pattern as the PIN
    // setup branch below: the cached `needsPinUnlock` state only
    // refreshes when user.id changes, but pin-login mutates the
    // in-memory unlocked-session flag (via markUnlocked) WITHOUT
    // changing user.id. Without this re-verify, a successful PIN
    // entry → router.replace('/dashboard') → segments change →
    // cached needsPinUnlock still true → bounced back to pin-login
    // → infinite loop. Identical class of bug to the setup-loop
    // the user reported; fixing both up front.
    if (user && needsPinUnlock && !onPinScreen) {
      (async () => {
        const hasPin = await hasPinForUser(user.id);
        if (hasPin && !isUnlockedNow(user.id)) {
          router.replace('/(auth)/pin-login');
        } else {
          // Unlocked-this-session (or PIN cleared) — drop the stale
          // gate flag so subsequent renders fall through.
          setNeedsPinUnlock(false);
        }
      })();
      return;
    }
    // PIN SETUP — authenticated user with NO PIN yet (and who hasn't
    // dismissed the prompt) must be routed to the setup screen.
    //
    // We RE-VERIFY the verdict inside the effect (rather than blindly
    // trusting the cached `needsPinSetup` state) because the cached
    // value is only refreshed when user.id changes — and pin-setup
    // mutates SecureStore (saves a PIN) without changing user.id.
    // Without this re-verify the screen got stuck in an infinite
    // loop: save PIN → route to /dashboard → segments change →
    // cached needsPinSetup still true → bounced back to pin-setup
    // → fresh mount with empty firstPin → user re-enters → save →
    // loop. Same async-recheck pattern that needsOnboarding uses
    // above for the analogous AsyncStorage-mutates-without-user.id-
    // change case.
    if (user && needsPinSetup && !onPinScreen) {
      (async () => {
        const hasPin = await hasPinForUser(user.id);
        const dismissed = await wasPinSetupDismissed(user.id);
        const stillNeeds = !hasPin && !dismissed;
        if (stillNeeds) {
          router.replace('/(auth)/pin-setup');
        } else {
          // PIN was just saved (or prompt dismissed) — clear the
          // cached flag so subsequent renders fall through to the
          // dashboard branch below.
          setNeedsPinSetup(false);
        }
      })();
      return;
    }
    if (user && !needsPinUnlock && !needsPinSetup && !onPinScreen && (inAuthGroup || isWelcome || isOnboarding)) {
      // Only auto-bounce out of (auth) once both PIN gates have
      // cleared. The !onPinScreen guard prevents this branch from
      // racing with the two redirects above and dragging the user
      // back to the dashboard mid-setup.
      router.replace('/(tabs)/dashboard');
      return;
    }
    // GATE CLEARED — let push.ts flush any queued notification
    // deep-link so the user lands directly on the acknowledge / alerts
    // screen they were intending to open. Runs both for fully-public
    // states (welcome / onboarding / public) and authenticated states
    // where no further redirect is needed, so taps from any state are
    // honoured once routing has settled.
    setAppReadyForDeepLink(true);
  }, [user, loading, segments, onboardingChecked, needsOnboarding, pinChecked, needsPinUnlock, needsPinSetup, disclaimerChecked, needsDisclaimer]);

  if (loading || !onboardingChecked || !disclaimerChecked || (user && !pinChecked)) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background }}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="add-member" options={{ presentation: 'modal' }} />
      <Stack.Screen name="add-medication/[memberId]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="add-routine/[memberId]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="edit-medication/[reminderId]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="check-in" />
      <Stack.Screen name="member/[id]" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="privacy-policy" />
      <Stack.Screen name="terms-of-service" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="disclaimer" />
      <Stack.Screen name="upgrade" />
      <Stack.Screen name="sos-confirmation" />
      <Stack.Screen name="fall-detection-test" />
      <Stack.Screen name="alert/[id]" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <RootNav />
        <FallDetectionOverlay />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
