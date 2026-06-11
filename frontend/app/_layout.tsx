import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Colors } from '../src/theme';
import { registerForPushNotifications, setupNotificationsForOS, useNotificationListeners, setAppReadyForDeepLink } from '../src/push';
import { isOnboardingDone } from '../src/onboardingStore';
import { FallDetectionOverlay } from '../src/FallDetectionOverlay';
import { hasPinForUser, isUnlockedNow } from '../src/pinAuth';
import { wasPinSetupDismissed } from '../src/pinSetupPrompt';
import { startBackgroundLocation, stopBackgroundLocation } from '../src/backgroundLocation';
import { api } from '../src/api';
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
    if ((t === 'medication' && (subtype === 'self_due' || !subtype)) ||
        (t === 'routine')) {
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
        router.replace({ pathname: '/alert/[id]', params: { id: aid } } as any);
      } else {
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
      if (!user?.id) {
        await stopBackgroundLocation();
        return;
      }
      try {
        const res = await api.get('/members');
        if (cancelled) return;
        const me = (res.data || []).find((m: any) => m.user_id === user.id);
        if (!me) {
          // User is a caregiver-only — no member row tied to them yet.
          // Do NOT start the service.  When they're linked later
          // (via INV-invite auto-bind or retro-link script), the
          // next /members fetch will pick it up.
          await stopBackgroundLocation();
          return;
        }
        await startBackgroundLocation(me.id);
      } catch (_e) {
        // Silent — without an authenticated /members fetch we can't
        // start anyway, and the next session will retry.
      }
    })();
    return () => {
      cancelled = true;
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
