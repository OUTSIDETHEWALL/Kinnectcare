import AsyncStorage from '@react-native-async-storage/async-storage';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DISCLAIMER_ACK_KEY, setDisclaimerAck } from '../src/disclaimerStore';

// Re-export for legacy imports that still pull DISCLAIMER_ACK_KEY
// from this module (kept until all call-sites are migrated).
export { DISCLAIMER_ACK_KEY };

/**
 * Health Disclaimer Screen — first launch only.
 *
 * Spec (v1.1.7 — Google Play medical-disclaimer requirement):
 *   • Shown ONCE per device install, before onboarding / signup.
 *   • Acknowledgment persisted via AsyncStorage key 'disclaimer_accepted'.
 *   • The gate in app/_layout.tsx checks that key on every cold start —
 *     if present, this screen is skipped entirely.
 *   • White background, Kinnship logo top, "Important Notice" bold title,
 *     centered body ≥18pt dark gray, single full-width green button.
 *   • No checkboxes, no scrolling, no extra steps.
 *
 * v1.1.8 — ack now flows through src/disclaimerStore so RootNav can
 * react synchronously and avoid the strobe-loop where the disclaimer
 * and onboarding screens fought each other at startup.
 */

export default function DisclaimerScreen() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const accept = async () => {
    if (submitting) return;
    setSubmitting(true);
    // setDisclaimerAck() updates AsyncStorage AND synchronously
    // notifies RootNav's subscriber so the gate flips
    // `needsDisclaimer` to false in the same tick.  Without the
    // synchronous notify, the router.replace('/') below would
    // bounce us straight back to /disclaimer because RootNav still
    // believed the flag was unread.
    await setDisclaimerAck();
    // Send them to the welcome screen — the existing RootNav gate in
    // _layout.tsx will take them onward (to /onboarding for first-time
    // users, or straight to /(tabs)/dashboard for already-authed users).
    router.replace('/');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.container}>
        {/* Top: Logo */}
        <View style={styles.logoWrap}>
          <View style={styles.logoFrame}>
            <Image
              source={require('../assets/images/kinnship-logo-dark.png')}
              style={styles.logoImage}
              resizeMode="contain"
              accessibilityLabel="Kinnship"
            />
          </View>
        </View>

        {/* Middle: Title + body */}
        <View style={styles.contentBlock}>
          <Text style={styles.title}>Important Notice</Text>
          <Text style={styles.body} accessibilityRole="text">
            Kinnship is not a medical device. It does not diagnose, treat, or prevent
            any medical condition. For medical advice, always consult your doctor.
            In an emergency, call 911.
          </Text>
        </View>

        {/* Bottom: Single full-width CTA */}
        <View style={styles.ctaWrap}>
          <TouchableOpacity
            testID="disclaimer-acknowledge-btn"
            accessibilityRole="button"
            accessibilityLabel="I understand"
            style={styles.cta}
            activeOpacity={0.85}
            onPress={accept}
            disabled={submitting}
          >
            <Text style={styles.ctaText}>I Understand</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' },
  container: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 32,
    paddingBottom: 24,
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
  },
  logoWrap: { alignItems: 'center' },
  logoFrame: {
    width: 140,
    height: 140,
    borderRadius: 32,
    backgroundColor: '#072815',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoImage: { width: 124, height: 124 },
  contentBlock: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  title: {
    fontSize: 30,
    fontWeight: '800',
    color: '#1A1A1A',
    textAlign: 'center',
    marginBottom: 24,
  },
  body: {
    fontSize: 19,
    lineHeight: 30,
    color: '#3A3A3A',
    textAlign: 'center',
  },
  ctaWrap: { width: '100%' },
  cta: {
    width: '100%',
    minHeight: 60,
    backgroundColor: '#1B5E35',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
  },
  ctaText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
