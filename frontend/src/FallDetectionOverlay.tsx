/**
 * Global fall-detection overlay.
 *
 * Subscribes to the accelerometer (via `useFallDetector`) whenever the user is
 * logged in. When a fall is detected, it pops a modal asking "Fall detected —
 * are you okay?" with a 30-second countdown. If the user taps "I'm okay" the
 * modal closes and the detector resumes. If the 30 seconds elapse without
 * input, we automatically:
 *   1) Dial 911 (tel:911 via Linking)
 *   2) Navigate to /sos-confirmation (re-uses the existing instant SOS screen)
 *   3) Fire POST /api/sos with current GPS coordinates in the background, which
 *      triggers the push notification to all family devices.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, Animated, Easing, Linking, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { Colors } from './theme';
import { useFallDetector } from './fallDetector';
import { api } from './api';
import { useAuth } from './AuthContext';

const COUNTDOWN_SECONDS = 30;

export function FallDetectionOverlay() {
  const { user } = useAuth();
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progress = useRef(new Animated.Value(0)).current;

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    progress.stopAnimation();
  };

  // Trigger SOS in the same way the manual SOS button does.
  const triggerSOS = () => {
    // INSTANT: dial 911 + navigate to confirmation
    Linking.openURL('tel:911').catch(() => {});
    router.push({ pathname: '/sos-confirmation', params: { reason: 'fall' } });
    // Background: best-effort GPS + push to family.
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
        await api.post('/sos', {
          latitude: lat,
          longitude: lon,
          // We re-use the SOS endpoint; family receives the same push, just with
          // an alert-type hint that this came from automatic fall detection.
          fall_detected: true,
        });
      } catch (_e) {}
    })();
  };

  const handleFall = () => {
    if (visible) return; // already showing
    setRemaining(COUNTDOWN_SECONDS);
    setVisible(true);
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: COUNTDOWN_SECONDS * 1000,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
    let secs = COUNTDOWN_SECONDS;
    timerRef.current = setInterval(() => {
      secs -= 1;
      setRemaining(secs);
      if (secs <= 0) {
        stopTimer();
        setVisible(false);
        triggerSOS();
      }
    }, 1000);
  };

  // Only run detector when there is a logged-in user.
  const { enabled, available } = useFallDetector({
    onFallDetected: handleFall,
  });

  useEffect(() => () => stopTimer(), []);

  // If user logs out while modal is open, dismiss.
  useEffect(() => {
    if (!user && visible) {
      stopTimer();
      setVisible(false);
    }
  }, [user, visible]);

  const onCancel = () => {
    stopTimer();
    setVisible(false);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <View style={styles.card} testID="fall-modal">
          <Text style={styles.emoji}>🚨</Text>
          <Text style={styles.title}>Fall detected — are you okay?</Text>
          <Text style={styles.body}>
            We sensed a sudden fall. If you don't respond in time, KinnectCare
            will automatically call 911 and alert your family.
          </Text>

          <View style={styles.barTrack}>
            <Animated.View
              style={[
                styles.barFill,
                {
                  width: progress.interpolate({ inputRange: [0, 1], outputRange: ['100%', '0%'] }),
                },
              ]}
            />
          </View>
          <Text testID="fall-countdown" style={styles.countdown}>
            {remaining}s remaining
          </Text>

          <TouchableOpacity
            testID="fall-cancel"
            style={styles.primary}
            onPress={onCancel}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryText}>✅ I'm okay — cancel</Text>
          </TouchableOpacity>

          <TouchableOpacity
            testID="fall-call-now"
            style={styles.secondary}
            onPress={() => { stopTimer(); setVisible(false); triggerSOS(); }}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryText}>📞 I need help — call 911 now</Text>
          </TouchableOpacity>

          {!available && Platform.OS !== 'web' ? (
            <Text style={styles.foot}>
              (Accelerometer unavailable on this device.)
            </Text>
          ) : null}
          {/* enabled state is informational only */}
          <Text style={styles.foot}>
            Fall detection is {enabled ? 'on' : 'off'}. Manage in Settings.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center', justifyContent: 'center', padding: 22,
  },
  card: {
    width: '100%', maxWidth: 380, backgroundColor: Colors.surface,
    borderRadius: 20, padding: 22, alignItems: 'center',
    boxShadow: '0px 16px 32px rgba(0,0,0,0.25)' as any,
    borderWidth: 2, borderColor: Colors.sos,
  },
  emoji: { fontSize: 44, marginBottom: 4 },
  title: { fontSize: 19, fontWeight: '800', color: Colors.textPrimary, textAlign: 'center' },
  body: {
    fontSize: 14, color: Colors.textSecondary, textAlign: 'center',
    marginTop: 10, lineHeight: 20,
  },
  barTrack: {
    alignSelf: 'stretch', height: 10, borderRadius: 5,
    backgroundColor: Colors.tertiary, overflow: 'hidden', marginTop: 18,
  },
  barFill: { height: '100%', backgroundColor: Colors.sos },
  countdown: {
    marginTop: 6, fontSize: 13, color: Colors.sos, fontWeight: '800',
  },
  primary: {
    alignSelf: 'stretch', marginTop: 18, height: 54, borderRadius: 14,
    backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
  secondary: {
    alignSelf: 'stretch', marginTop: 10, height: 50, borderRadius: 14,
    borderWidth: 2, borderColor: Colors.sos, alignItems: 'center', justifyContent: 'center',
  },
  secondaryText: { color: Colors.sos, fontSize: 15, fontWeight: '800' },
  foot: {
    marginTop: 12, fontSize: 11, color: Colors.textTertiary, textAlign: 'center',
  },
});
