import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Colors } from '../src/theme';
import { registerForPushNotifications, useNotificationListeners } from '../src/push';

function RootNav() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

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
    if (loading) return;
    const inAuthGroup = segments[0] === '(auth)';
    const isWelcome = !segments[0] || segments[0] === ('index' as any);
    if (!user && !inAuthGroup && !isWelcome) {
      router.replace('/');
    } else if (user && (inAuthGroup || isWelcome)) {
      router.replace('/(tabs)/dashboard');
    }
  }, [user, loading, segments]);

  if (loading) {
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
