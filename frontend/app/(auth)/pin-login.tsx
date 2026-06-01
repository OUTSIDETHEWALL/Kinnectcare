/**
 * pin-login.tsx — the daily-driver login screen.
 *
 * Shown when:
 *   - The user has a saved token (authenticated already) AND
 *   - They have set up a PIN AND
 *   - They have NOT yet unlocked in this session.
 *
 * Behaviour:
 *   - Big 4-digit PIN pad (88pt touch targets, designed for seniors).
 *   - 5 wrong attempts → 15-minute lockout. During lockout the pad is
 *     disabled and the user is told to tap "Use email & password
 *     instead" to unlock immediately.
 *   - "Forgot PIN?" link → sends to email/password login. After
 *     successful re-login they can re-set a PIN.
 *   - "Use email & password instead" link → same as forgot, just
 *     phrased as a normal alternative.
 */
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';
import PinPad, { PinPadHandle } from '../../src/PinPad';
import {
  verifyPin, getAttemptState, MAX_PIN_ATTEMPTS, PIN_LENGTH,
} from '../../src/pinAuth';
import { performFullAppReset } from '../../src/appReset';

function formatLockMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

export default function PinLogin() {
  const router = useRouter();
  const { user, loading, logout, requestOtp } = useAuth();
  const padRef = useRef<PinPadHandle>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string>('');
  const [hintTone, setHintTone] = useState<'normal' | 'error' | 'success'>('normal');
  const [errorState, setErrorState] = useState(false);
  const [lockUntilMs, setLockUntilMs] = useState(0);
  const [remaining, setRemaining] = useState(MAX_PIN_ATTEMPTS);

  // HARD GUARD: unauthenticated users must NEVER see this screen.
  // PIN unlock is a per-account secret; without an account there's
  // nothing to unlock. If we somehow land here with user==null
  // (e.g. logout race, stale Keychain token wipe), bounce to the
  // welcome screen so the user can sign in normally.
  useEffect(() => {
    if (!loading && !user?.id) {
      router.replace('/');
    }
  }, [loading, user?.id]);

  // Load initial state (in case user is mid-lockout).
  useEffect(() => {
    (async () => {
      if (!user?.id) return;
      const st = await getAttemptState(user.id);
      if (!st.hasPin) {
        // No PIN saved on this device — fall through to email login.
        router.replace('/(auth)/login');
        return;
      }
      setRemaining(MAX_PIN_ATTEMPTS - st.attempts);
      if (st.lockUntilMs && st.lockUntilMs > Date.now()) {
        setLockUntilMs(st.lockUntilMs);
      }
    })();
  }, [user?.id]);

  // Live countdown during lockout — updates the hint every second.
  useEffect(() => {
    if (!lockUntilMs) return;
    const tick = () => {
      const remainingMs = lockUntilMs - Date.now();
      if (remainingMs <= 0) {
        setLockUntilMs(0);
        setHint('You can try again now.');
        setHintTone('normal');
        return;
      }
      setHint(`Too many wrong PINs. Try again in ${formatLockMs(remainingMs)} — or tap "Email me a code" below.`);
      setHintTone('error');
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [lockUntilMs]);

  const onComplete = async (pin: string) => {
    if (!user?.id || busy) return;
    setBusy(true);
    try {
      const result = await verifyPin(user.id, pin);
      if (result.ok) {
        setHint('Unlocked!');
        setHintTone('success');
        // Tiny delay so the user sees the green confirmation.
        setTimeout(() => router.replace('/(tabs)/dashboard'), 250);
        return;
      }
      // result.ok === false here — but TS struct-narrowing on
      // discriminated unions across multiple `reason` literals can be
      // brittle in some tsconfigs, so we widen once via `any` and
      // dispatch on the reason ourselves.
      const r: any = result;
      if (r.reason === 'no_pin') {
        router.replace('/(auth)/login');
        return;
      }
      if (r.reason === 'locked') {
        setLockUntilMs(Number(r.lockUntilMs) || 0);
        setErrorState(true);
        setTimeout(() => setErrorState(false), 600);
        padRef.current?.reset();
        return;
      }
      // Wrong PIN — show remaining count and shake.
      const rem = Number(r.remaining) || 0;
      setRemaining(rem);
      setErrorState(true);
      setTimeout(() => setErrorState(false), 600);
      padRef.current?.reset();
      if (rem === 0) {
        setLockUntilMs(Number(r.lockUntilMs) || 0);
      } else {
        setHint(`Wrong PIN — ${rem} ${rem === 1 ? 'try' : 'tries'} left.`);
        setHintTone('error');
      }
    } finally {
      setBusy(false);
    }
  };

  const goToEmailLogin = async () => {
    // Master-key fallback: send a 6-digit code to the user's email
    // so they can sign in even if they forgot their PIN. We log out
    // the existing token first so AuthContext starts from a clean
    // slate after verification. After they verify, RootNav will
    // route them through pin-setup so they can pick a new PIN.
    const email = user?.email;
    if (!email) {
      await logout();
      router.replace('/(auth)/login');
      return;
    }
    try {
      await requestOtp({ email, purpose: 'login' });
    } catch (_e) {
      // Even if the request silently fails (network, etc.), still
      // route to the verify screen — the user can press Resend.
    }
    await logout();
    router.push({
      pathname: '/(auth)/otp-verify',
      params: { email, purpose: 'login' },
    } as any);
  };

  // LAST-RESORT RECOVERY: wipe ALL local app state. Used when the
  // user is stuck (e.g. forgot PIN, can't recall email password
  // either, app got into a bad state). Server-side account is
  // untouched — they can sign back in.
  const onResetApp = () => {
    Alert.alert(
      'Reset Kinnship?',
      "This will sign you out of this device and clear all locally-saved settings (including your PIN). Your account, family group, and medications on the server are NOT affected — you can sign back in immediately.\n\nUse this if you're stuck and can't get past this screen.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              await performFullAppReset();
            } catch (_e) {}
            try { await logout(); } catch (_e) {}
            router.replace('/');
          },
        },
      ],
    );
  };

  const locked = lockUntilMs > Date.now();

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>
            {user?.full_name ? `${user.full_name.split(' ')[0]}, enter your PIN` : 'Enter your PIN'}
          </Text>
        </View>

        <View style={styles.padArea}>
          {busy && (
            <ActivityIndicator color={Colors.primary} style={{ marginBottom: 8 }} />
          )}
          <PinPad
            ref={padRef}
            length={PIN_LENGTH}
            onComplete={onComplete}
            errorState={errorState}
            hint={hint || (locked ? '' : `${MAX_PIN_ATTEMPTS} attempts allowed`)}
            hintTone={hintTone}
            disabled={locked || busy}
          />
        </View>

        <View style={styles.footer}>
          <TouchableOpacity
            testID="pin-login-fallback"
            onPress={goToEmailLogin}
            style={styles.fallbackBtn}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.fallbackText}>Email me a code instead</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="pin-login-forgot"
            onPress={goToEmailLogin}
            style={styles.forgotBtn}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.forgotText}>Forgot PIN?</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="pin-login-reset-app"
            onPress={onResetApp}
            style={styles.resetLink}
            activeOpacity={0.6}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={styles.resetLinkText}>Having trouble? Reset app</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  scroll: {
    paddingBottom: 24,
    alignItems: 'center',
  },
  header: {
    paddingTop: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
    width: '100%',
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    fontSize: 16,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  padArea: {
    marginTop: 18,
    paddingHorizontal: 12,
    alignItems: 'center',
    width: '100%',
  },
  footer: {
    marginTop: 24,
    paddingHorizontal: 24,
    alignItems: 'center',
    width: '100%',
  },
  fallbackBtn: {
    paddingVertical: 12,
    paddingHorizontal: 22,
  },
  fallbackText: {
    fontSize: 15,
    color: Colors.primary,
    fontWeight: '700',
  },
  forgotBtn: {
    paddingVertical: 8,
    paddingHorizontal: 22,
  },
  forgotText: {
    fontSize: 13,
    color: Colors.textTertiary,
    fontWeight: '600',
  },
  resetLink: {
    paddingVertical: 8,
    paddingHorizontal: 22,
    marginTop: 2,
  },
  resetLinkText: {
    fontSize: 12,
    color: Colors.textTertiary,
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
});
