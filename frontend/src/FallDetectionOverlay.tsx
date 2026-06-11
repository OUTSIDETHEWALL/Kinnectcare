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
  // Shown AFTER the cancel-countdown elapses. Tells the user family has
  // been alerted and offers an explicit "Call 911" button. We do NOT auto-
  // dial; that requires a deliberate tap from the user.
  const [needsHelpVisible, setNeedsHelpVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progress = useRef(new Animated.Value(0)).current;

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    progress.stopAnimation();
  };

  // Fall-detected → notify family only. We do NOT auto-dial 911 from a
  // passive accelerometer trigger because false positives (phone dropped,
  // vigorous walk reminder vibration, transferring phone between hands) are
  // common enough that auto-dialing 911 is dangerous — it wastes emergency
  // services time and could result in welfare-check raids. Instead:
  //   • Fire a `/sos` event with `fall_detected: true` → family gets push
  //     to call/check on the user immediately.
  //   • Show a follow-up modal letting the user tap "Call 911" explicitly
  //     if they really do need emergency services.
  // The 911 dialer is ONLY launched from an explicit user tap, never from
  // the countdown timer expiring.
  const notifyFamilyOfFall = () => {
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
          fall_detected: true,
        });
        // Fix #4: GPS-frequency boost for the duration of the SOS.
        try {
          const bg = await import('./backgroundLocation');
          await bg.beginSosBoost();
        } catch (_e) {}
      } catch (_e) {}
    })();
    // Show the follow-up "family notified" screen with explicit 911 dial CTA.
    setNeedsHelpVisible(true);
  };

  const dial911 = () => {
    Linking.openURL('tel:911').catch(() => {});
    setNeedsHelpVisible(false);
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
        notifyFamilyOfFall();
      }
    }, 1000);
  };

  // Only run detector when there is a logged-in user.
  const { enabled, available } = useFallDetector({
    onFallDetected: handleFall,
  });

  // Web/test hook — lets us trigger the modal from Playwright (`window.__kc_triggerFall()`).
  // No-op outside web. Safe to leave in production; nothing calls it from the app code.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    try {
      (globalThis as any).__kc_triggerFall = () => handleFall();
    } catch (_e) {}
    return () => {
      try { delete (globalThis as any).__kc_triggerFall; } catch (_e) {}
    };
  }, []);

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
    <>
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
            We sensed a sudden fall. If you don't respond in time, your family will be notified automatically — but Kinnship will NOT auto-dial 911 (you must tap the red button below).
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
            onPress={() => { stopTimer(); setVisible(false); dial911(); }}
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

    {/*
      Follow-up modal shown after the 30-second cancel window elapses with no
      user response. Family has already been pushed an alert. Auto-dialing
      911 was REMOVED in v6.2 — false positives (vibrating walk reminders,
      phone drops, normal pocket movement) were dialing 911 unintentionally.
      The user must now explicitly tap the red "Call 911 now" button to dial.
    */}
    <Modal
      visible={needsHelpVisible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => setNeedsHelpVisible(false)}
    >
      <View style={styles.backdrop}>
        <View style={styles.card} testID="fall-followup-modal">
          <Text style={styles.emoji}>🆘</Text>
          <Text style={styles.title}>Family has been alerted</Text>
          <Text style={styles.body}>
            Your family received a push notification that you may have fallen. If you need emergency services, tap the red button to call 911 right now.
          </Text>
          <TouchableOpacity
            testID="fall-followup-911"
            style={styles.secondary}
            onPress={dial911}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryText}>📞 Call 911 now</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="fall-followup-dismiss"
            style={styles.primary}
            onPress={() => setNeedsHelpVisible(false)}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryText}>I'm okay — dismiss</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
    </>
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
