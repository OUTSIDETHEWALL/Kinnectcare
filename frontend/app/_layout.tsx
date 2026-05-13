import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Colors } from '../src/theme';
import { registerForPushNotifications, useNotificationListeners } from '../src/push';
import { isOnboardingDone } from '../src/onboardingStore';

function RootNav() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useEffect(() => {
    (async () => {
      const done = await isOnboardingDone();
      setNeedsOnboarding(!done);
      setOnboardingChecked(true);
    })();
  }, []);

  useNotificationListeners((data) => {
    if (data?.type === 'sos' || data?.type === 'missed_checkin' || data?.type === 'medication' || data?.type === 'routine') {
      router.push('/(tabs)/alerts');
    }
  });

  useEffect(() => {
    if (user) {
      registerForPushNotifications().catch(() => {});
    }
  }, [user?.id]);

  useEffect(() => {
    if (loading || !onboardingChecked) return;
    const inAuthGroup = segments[0] === '(auth)';
    const isWelcome = !segments[0] || segments[0] === ('index' as any);
    const isOnboarding = segments[0] === 'onboarding';
    const isPublic =
      segments[0] === 'privacy-policy' || segments[0] === 'terms-of-service';

    // First-time users (not logged in, no onboarding flag) go to onboarding first.
    // Re-verify the storage flag whenever we'd redirect — handles the case where the
    // user just pressed "Get Started" / Skip and the in-memory flag is stale.
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
    } else if (user && (inAuthGroup || isWelcome || isOnboarding)) {
      router.replace('/(tabs)/dashboard');
    }
  }, [user, loading, segments, onboardingChecked, needsOnboarding]);

  if (loading || !onboardingChecked) {
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
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <RootNav />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
