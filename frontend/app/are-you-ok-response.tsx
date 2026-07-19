/**
 * Build XX — "Are You OK?" response screen.
 *
 * Joyce arrives here in two ways:
 *   1. She taps the notification body → _layout routes type='are_you_ok_request' here.
 *      She sees both buttons and chooses.
 *   2. She taps an action button (IM_OK / NEED_HELP) → push.ts enqueues the deep-link
 *      with _action set, _layout routes here, and the action fires immediately on mount.
 */
import { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../src/theme';
import { respondToCheckinRequest } from '../src/api';
import * as Location from 'expo-location';
import { geocodeLabelForCoord } from '../src/locationRefresh';

type State = 'prompt' | 'submitting' | 'success' | 'error';

export default function AreYouOkResponse() {
  const router = useRouter();
  const { requestId, memberId, action } = useLocalSearchParams<{
    requestId?: string;
    memberId?: string;
    action?: string; // 'im_ok' | 'need_help' | undefined (prompt)
  }>();

  const [state, setState] = useState<State>(action ? 'submitting' : 'prompt');
  const [errorMsg, setErrorMsg] = useState('');
  const scale = new Animated.Value(0);

  const handleImOk = async () => {
    if (!requestId || !memberId) {
      setErrorMsg('Missing request information.');
      setState('error');
      return;
    }
    setState('submitting');
    setErrorMsg('');
    try {
      let lat: number | undefined;
      let lon: number | undefined;
      let locationName: string | undefined;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
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
        // GPS is best-effort — proceed without coordinates.
      }

      await respondToCheckinRequest(requestId, {
        member_id: memberId,
        latitude: lat,
        longitude: lon,
        location_name: locationName,
      });

      setState('success');
      Animated.spring(scale, { toValue: 1, friction: 5, tension: 80, useNativeDriver: true }).start();
    } catch (e: any) {
      const msg =
        e?.response?.data?.detail ||
        e?.message ||
        'Please check your connection and try again.';
      setErrorMsg(msg);
      setState('error');
    }
  };

  const handleNeedHelp = () => {
    // Route to the SOS sending screen.  The existing SOS flow captures GPS
    // and notifies the family — no new logic needed here.
    router.replace('/sos-sending');
  };

  // Auto-fire if the user tapped an action button directly on the notification.
  useEffect(() => {
    if (action === 'im_ok') {
      handleImOk();
    } else if (action === 'need_help') {
      handleNeedHelp();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'submitting') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.content}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.checkingTitle}>Confirming you're OK…</Text>
          <Text style={styles.checkingSubtitle}>
            Capturing your location and notifying your family.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (state === 'success') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.content}>
          <Animated.View style={[styles.checkCircle, { transform: [{ scale }] }]}>
            <Text style={styles.bigEmoji}>✅</Text>
          </Animated.View>
          <Text style={styles.title}>You're confirmed OK!</Text>
          <Text style={styles.subtitle}>
            Your family has been notified that you're safe.
          </Text>
        </View>
        <View style={styles.bottom}>
          <TouchableOpacity
            testID="are-you-ok-done"
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

  if (state === 'error') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.content}>
          <Text style={styles.errorEmoji}>⚠️</Text>
          <Text style={styles.errorTitle}>Couldn't send confirmation</Text>
          <Text style={styles.errorMsg}>{errorMsg}</Text>
        </View>
        <View style={styles.bottom}>
          <TouchableOpacity
            testID="are-you-ok-retry"
            onPress={handleImOk}
            activeOpacity={0.85}
            style={styles.cta}
          >
            <Text style={styles.ctaText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity
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

  // Prompt — body-tap arrival: show both choices.
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <Text style={styles.promptEmoji}>❓</Text>
        <Text style={styles.title}>Are you okay?</Text>
        <Text style={styles.subtitle}>
          Your family is checking on you. Let them know how you're doing.
        </Text>
      </View>
      <View style={styles.bottom}>
        <TouchableOpacity
          testID="are-you-ok-im-ok"
          onPress={handleImOk}
          activeOpacity={0.85}
          style={styles.cta}
        >
          <Text style={styles.ctaText}>✅  I'm OK</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="are-you-ok-need-help"
          onPress={handleNeedHelp}
          activeOpacity={0.85}
          style={styles.ctaDanger}
        >
          <Text style={styles.ctaDangerText}>🚨  Need Help</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.replace('/(tabs)/dashboard')}
          activeOpacity={0.7}
          style={styles.ctaSecondary}
        >
          <Text style={styles.ctaSecondaryText}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background, justifyContent: 'space-between' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  promptEmoji: { fontSize: 64, marginBottom: 8 },
  bigEmoji: { fontSize: 72 },
  errorEmoji: { fontSize: 64, marginBottom: 8 },
  checkCircle: {
    width: 160, height: 160, borderRadius: 80,
    backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
  },
  title: { fontSize: 30, fontWeight: '800', color: Colors.textPrimary, marginTop: 24, textAlign: 'center' },
  subtitle: { fontSize: 17, color: Colors.textSecondary, marginTop: 12, textAlign: 'center', lineHeight: 26 },
  checkingTitle: { fontSize: 22, fontWeight: '700', color: Colors.textPrimary, marginTop: 24, textAlign: 'center' },
  checkingSubtitle: { fontSize: 15, color: Colors.textSecondary, marginTop: 10, textAlign: 'center', lineHeight: 22 },
  errorTitle: { fontSize: 24, fontWeight: '800', color: Colors.textPrimary, marginTop: 16, textAlign: 'center' },
  errorMsg: { fontSize: 15, color: Colors.textSecondary, marginTop: 10, textAlign: 'center', lineHeight: 22 },
  bottom: { paddingHorizontal: 24, paddingBottom: 24, gap: 12 },
  cta: { height: 60, backgroundColor: Colors.primary, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
  ctaDanger: { height: 60, backgroundColor: Colors.error, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ctaDangerText: { color: Colors.surface, fontSize: 17, fontWeight: '700' },
  ctaSecondary: { height: 50, alignItems: 'center', justifyContent: 'center' },
  ctaSecondaryText: { color: Colors.textSecondary, fontSize: 15, fontWeight: '600' },
});
