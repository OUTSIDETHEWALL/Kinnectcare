import { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Icon } from '../src/Icon';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';
import { api } from '../src/api';
import * as Location from 'expo-location';
import { geocodeLabelForCoord } from '../src/locationRefresh';

type CheckInState = 'checking' | 'success' | 'error';

export default function CheckInConfirm() {
  const router = useRouter();
  const { memberId, name } = useLocalSearchParams<{ memberId?: string; name?: string }>();
  const [state, setState] = useState<CheckInState>('checking');
  const [errorMsg, setErrorMsg] = useState('');
  const scale = useRef(new Animated.Value(0)).current;

  const runCheckIn = async () => {
    setState('checking');
    setErrorMsg('');
    try {
      let lat: number | undefined, lon: number | undefined, locationName: string | undefined;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          // GPS with a 5-second cap so a slow fix never leaves the user
          // staring at the spinner indefinitely. If it times out we
          // still submit the check-in without coordinates.
          const pos = await Promise.race<any>([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
          ]);
          if (pos?.coords) {
            lat = pos.coords.latitude;
            lon = pos.coords.longitude;
            locationName = (await geocodeLabelForCoord(lat!, lon!)) || undefined;
          }
        }
      } catch (_e) {
        // GPS is best-effort — proceed without coordinates
      }

      await api.post('/checkins', {
        member_id: memberId,
        latitude: lat,
        longitude: lon,
        location_name: locationName,
      });

      // Server confirmed — show success animation
      setState('success');
      Animated.spring(scale, {
        toValue: 1,
        friction: 5,
        tension: 80,
        useNativeDriver: true,
      }).start();
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Please check your connection and try again.';
      setErrorMsg(msg);
      setState('error');
    }
  };

  useEffect(() => {
    runCheckIn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'checking') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.content}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.checkingTitle}>Checking in...</Text>
          <Text style={styles.checkingSubtitle}>
            {name ? `Recording check-in for ${name}.` : 'Recording your check-in.'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (state === 'error') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.content}>
          <View style={styles.errorCircle}>
            <Icon name="close" size={64} color={Colors.surface} />
          </View>
          <Text style={styles.errorTitle}>Unable to complete check-in.</Text>
          <Text style={styles.errorMsg}>{errorMsg}</Text>
        </View>
        <View style={styles.bottom}>
          <TouchableOpacity
            testID="checkin-retry"
            onPress={runCheckIn}
            activeOpacity={0.85}
            style={styles.cta}
          >
            <Text style={styles.ctaText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="checkin-cancel"
            onPress={() => router.replace('/(tabs)/dashboard')}
            activeOpacity={0.7}
            style={styles.ctaSecondary}
          >
            <Text style={styles.ctaSecondaryText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Success
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <Animated.View style={[styles.checkCircle, { transform: [{ scale }] }]}>
          <Icon name="checkmark" size={80} color={Colors.surface} />
        </Animated.View>
        <Text testID="checkin-title" style={styles.title}>You're checked in!</Text>
        <Text style={styles.subtitle}>
          {name ? `${name} is safely checked in.` : 'Your family has been notified.'}
        </Text>
        <View style={styles.timeRow}>
          <Icon name="time-outline" size={16} color={Colors.textTertiary} />
          <Text style={styles.timeText}>Just now</Text>
        </View>
      </View>
      <View style={styles.bottom}>
        <TouchableOpacity
          testID="checkin-done"
          onPress={() => router.replace('/(tabs)/dashboard')}
          activeOpacity={0.85}
          style={styles.cta}
        >
          <Text style={styles.ctaText}>Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background, justifyContent: 'space-between' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  // Success
  checkCircle: {
    width: 160, height: 160, borderRadius: 80, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 12px 20px rgba(27,94,53,0.3)', elevation: 10,
  },
  title: { fontSize: 32, fontWeight: '800', color: Colors.textPrimary, marginTop: 36, textAlign: 'center' },
  subtitle: { fontSize: 17, color: Colors.textSecondary, marginTop: 12, textAlign: 'center', lineHeight: 26 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18 },
  timeText: { color: Colors.textTertiary, fontSize: 14 },
  // Checking
  checkingTitle: { fontSize: 22, fontWeight: '700', color: Colors.textPrimary, marginTop: 24, textAlign: 'center' },
  checkingSubtitle: { fontSize: 15, color: Colors.textSecondary, marginTop: 10, textAlign: 'center', lineHeight: 22 },
  // Error
  errorCircle: {
    width: 140, height: 140, borderRadius: 70, backgroundColor: Colors.error,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 10px 18px rgba(220,38,38,0.3)', elevation: 8,
  },
  errorTitle: { fontSize: 24, fontWeight: '800', color: Colors.textPrimary, marginTop: 32, textAlign: 'center' },
  errorMsg: { fontSize: 15, color: Colors.textSecondary, marginTop: 10, textAlign: 'center', lineHeight: 22 },
  // Shared bottom
  bottom: { paddingHorizontal: 24, paddingBottom: 24, gap: 12 },
  cta: { height: 60, backgroundColor: Colors.primary, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
  ctaSecondary: { height: 50, alignItems: 'center', justifyContent: 'center' },
  ctaSecondaryText: { color: Colors.textSecondary, fontSize: 15, fontWeight: '600' },
});
