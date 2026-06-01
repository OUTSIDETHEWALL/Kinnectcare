/**
 * otp-verify.tsx — enter the 6-digit code emailed by the backend.
 *
 * Reached from:
 *   • /(auth)/login.tsx after the user requests a sign-in code.
 *   • /(auth)/signup.tsx after the user requests a sign-up code.
 *   • /(auth)/pin-login.tsx via the "Email me a code instead" fallback.
 *
 * On a correct code: AuthContext.verifyOtp persists the JWT, sets the
 * user, and RootNav routes to /(tabs)/dashboard. On wrong code: the
 * backend returns 400 with a remaining-attempts message — we shake
 * the dots and surface the hint.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';
import PinPad, { PinPadHandle } from '../../src/PinPad';

const OTP_LENGTH = 6;
// Resend cooldown — matches the backend's OTP_RESEND_COOLDOWN_S = 60.
const RESEND_COOLDOWN_S = 60;

export default function OtpVerify() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    email?: string;
    purpose?: string;
    fullName?: string;
    inviteCode?: string;
  }>();
  const { verifyOtp, resendOtp } = useAuth();

  const email = String(params?.email || '');
  const purpose = (params?.purpose === 'signup' ? 'signup' : 'login') as 'login' | 'signup';
  const fullName = String(params?.fullName || '');
  const inviteCode = String(params?.inviteCode || '');

  const padRef = useRef<PinPadHandle>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string>('');
  const [hintTone, setHintTone] = useState<'normal' | 'error' | 'success'>('normal');
  const [errorState, setErrorState] = useState(false);
  const [resendIn, setResendIn] = useState(RESEND_COOLDOWN_S);

  // Tick the resend countdown once per second.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => {
      setResendIn((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  // Defensive guard: if we arrived here without an email, kick back
  // to login. (Should never happen — login/signup always push with
  // a populated email param — but better to fail soft than to render
  // an unusable screen.)
  useEffect(() => {
    if (!email) {
      router.replace('/(auth)/login');
    }
  }, [email]);

  const onComplete = async (code: string) => {
    if (busy) return;
    setBusy(true);
    setHint('Checking…');
    setHintTone('normal');
    try {
      await verifyOtp({ email, code });
      setHint('Signed in!');
      setHintTone('success');
      // RootNav will take it from here — it will route the now-
      // authenticated user to PIN setup or dashboard depending on
      // whether they have a PIN saved.
    } catch (e: any) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail || 'Invalid code. Please try again.';
      setErrorState(true);
      setTimeout(() => setErrorState(false), 600);
      padRef.current?.reset();
      setHint(detail);
      setHintTone('error');
      if (status === 429) {
        // Out of attempts — gently send them back to request a new code.
        Alert.alert(
          'Too many attempts',
          'Please request a new 6-digit code.',
          [{ text: 'OK', onPress: () => setResendIn(0) }],
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const onResend = async () => {
    if (resendIn > 0) return;
    setBusy(true);
    try {
      await resendOtp({
        email,
        purpose,
        fullName: fullName || undefined,
        inviteCode: inviteCode || undefined,
      });
      setHint('New code sent. Check your inbox.');
      setHintTone('success');
      setResendIn(RESEND_COOLDOWN_S);
      padRef.current?.reset();
    } catch (e: any) {
      const detail = e?.response?.data?.detail || 'Could not resend code.';
      setHint(detail);
      setHintTone('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <TouchableOpacity testID="otp-back" onPress={() => router.back()} style={styles.back}>
        <Text style={styles.backText}>‹ Back</Text>
      </TouchableOpacity>

      <View style={styles.header}>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.subtitle}>
          We sent a 6-digit code to{'\n'}
          <Text style={styles.emailText}>{email}</Text>
        </Text>
      </View>

      <View style={styles.padArea}>
        {busy && (
          <ActivityIndicator color={Colors.primary} style={{ marginBottom: 8 }} />
        )}
        <PinPad
          ref={padRef}
          length={OTP_LENGTH}
          onComplete={onComplete}
          errorState={errorState}
          label="Enter the 6-digit code"
          hint={hint || 'Codes expire after 10 minutes'}
          hintTone={hintTone}
          disabled={busy}
        />
      </View>

      <View style={styles.footer}>
        <TouchableOpacity
          testID="otp-resend"
          onPress={onResend}
          disabled={resendIn > 0 || busy}
          style={[styles.resendBtn, (resendIn > 0 || busy) && styles.resendBtnDisabled]}
          activeOpacity={0.6}
        >
          <Text style={[styles.resendText, (resendIn > 0 || busy) && styles.resendTextDisabled]}>
            {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="otp-change-email"
          onPress={() => router.back()}
          style={styles.changeBtn}
          activeOpacity={0.6}
        >
          <Text style={styles.changeText}>Use a different email</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  back: { paddingHorizontal: 16, paddingTop: 4 },
  backText: { fontSize: 17, color: Colors.primary, fontWeight: '600' },
  header: {
    paddingTop: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 8,
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  emailText: {
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  padArea: {
    flex: 1,
    paddingTop: 12,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  footer: {
    paddingBottom: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  resendBtn: {
    paddingVertical: 14,
    paddingHorizontal: 22,
  },
  resendBtnDisabled: { opacity: 0.5 },
  resendText: {
    fontSize: 15,
    color: Colors.primary,
    fontWeight: '700',
  },
  resendTextDisabled: { color: Colors.textTertiary },
  changeBtn: {
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  changeText: {
    fontSize: 13,
    color: Colors.textTertiary,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});
