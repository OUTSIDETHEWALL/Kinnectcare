import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Colors } from '../src/theme';
import { registerForPushNotifications, useNotificationListeners } from '../src/push';
import { setAppReadyForDeepLink } from '../src/push';
import { isOnboardingDone } from '../src/onboardingStore';
import { FallDetectionOverlay } from '../src/FallDetectionOverlay';
import { hasPinForUser, isUnlockedNow } from '../src/pinAuth';

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

  useEffect(() => {
    (async () => {
      const done = await isOnboardingDone();
      setNeedsOnboarding(!done);
      setOnboardingChecked(true);
    })();
  }, []);

  // Re-evaluate the PIN gate whenever the auth user changes. If the
  // user has a PIN saved AND they haven't unlocked-this-session yet,
  // we redirect to the PIN-login screen below.
  useEffect(() => {
    (async () => {
      if (!user?.id) {
        setNeedsPinUnlock(false);
        setPinChecked(true);
        return;
      }
      const hasPin = await hasPinForUser(user.id);
      if (hasPin && !isUnlockedNow(user.id)) {
        setNeedsPinUnlock(true);
      } else {
        setNeedsPinUnlock(false);
      }
      setPinChecked(true);
    })();
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
    // before anything else. Allow them to remain on the pin-login or
    // pin-setup screens; redirect from anywhere else.
    if (user && needsPinUnlock && !onPinScreen) {
      router.replace('/(auth)/pin-login');
      return;
    }
    if (user && !needsPinUnlock && (inAuthGroup || isWelcome || isOnboarding)) {
      // Only auto-bounce out of (auth) once they've cleared the PIN
      // gate (or there is no PIN gate). Otherwise the redirect above
      // would compete with this one.
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
  }, [user, loading, segments, onboardingChecked, needsOnboarding, pinChecked, needsPinUnlock]);

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
