import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { useEffect, useState, useRef } from 'react';
import { View, ActivityIndicator, AppState, AppStateStatus } from 'react-native';
import { Colors } from '../src/theme';
import { registerForPushNotifications, useNotificationListeners } from '../src/push';
import { setAppReadyForDeepLink } from '../src/push';
import { isOnboardingDone } from '../src/onboardingStore';
import { FallDetectionOverlay } from '../src/FallDetectionOverlay';
import { hasPinForUser, isUnlockedNow, forgetSessionUnlock } from '../src/pinAuth';
import { wasPinSetupDismissed } from '../src/pinSetupPrompt';

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
    (async () => {
      if (!user?.id) {
        setNeedsPinUnlock(false);
        setNeedsPinSetup(false);
        setPinChecked(true);
        return;
      }
      const hasPin = await hasPinForUser(user.id);
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
        setNeedsPinSetup(!dismissed);
      }
      setPinChecked(true);
    })();
  }, [user?.id]);

  // ----- Re-lock the PIN on app foreground/background transitions -----
  //
  // React Native does NOT kill the JS process on background→foreground
  // transitions — the in-memory `unlockedSessions` Set inside pinAuth
  // persists across these transitions, so without explicit handling
  // the PIN gate would only re-trigger after a true cold start (where
  // the OS reclaimed the process). That's almost never observable by
  // a user — they get a "PIN-free" experience after their first
  // unlock-per-process which is wrong for a senior-safety app and
  // also a security regression.
  //
  // Fix: subscribe to AppState. When the app moves to background or
  // becomes inactive, drop the in-memory unlock flag AND mark the
  // gate as needing unlock so the routing effect redirects to
  // /(auth)/pin-login the moment the app returns to foreground.
  //
  // We don't add a grace period — banking / 1Password / Authy all
  // re-lock on every background transition, and senior-safety
  // similarly wants the screen lock to be a real lock.
  //
  // The pin-setup and pin-login screens themselves are exempt — if
  // the user is mid-setup or mid-unlock, we don't want to thrash
  // the state on a quick app-switch.
  const lastAppStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    if (!user?.id) return;
    const uid = user.id;
    const onChange = async (state: AppStateStatus) => {
      const prev = lastAppStateRef.current;
      lastAppStateRef.current = state;
      if ((state === 'background' || state === 'inactive') && prev === 'active') {
        // Going background. If the user has a PIN, drop the unlock
        // flag so re-foregrounding triggers pin-login.
        try {
          const hasPin = await hasPinForUser(uid);
          if (hasPin) {
            forgetSessionUnlock(uid);
            setNeedsPinUnlock(true);
          }
        } catch (_e) {}
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [user?.id]);

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
      router.replace('/(tabs)/alerts');
    }
  });

  useEffect(() => {
    if (user) {
      registerForPushNotifications().catch(() => {});
    }
  }, [user?.id]);

  useEffect(() => {
    if (loading || !onboardingChecked || !pinChecked) return;
    const inAuthGroup = segments[0] === '(auth)';
    const isWelcome = !segments[0] || segments[0] === ('index' as any);
    const isOnboarding = segments[0] === 'onboarding';
    const isPublic =
      segments[0] === 'privacy-policy' || segments[0] === 'terms-of-service';
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
  }, [user, loading, segments, onboardingChecked, needsOnboarding, pinChecked, needsPinUnlock, needsPinSetup]);

  if (loading || !onboardingChecked || (user && !pinChecked)) {
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
      <Stack.Screen name="upgrade" />
      <Stack.Screen name="sos-confirmation" />
      <Stack.Screen name="fall-detection-test" />
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
