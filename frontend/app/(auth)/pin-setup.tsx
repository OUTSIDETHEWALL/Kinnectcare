/**
 * pin-setup.tsx — first-time PIN setup screen.
 *
 * Flow:
 *   1. User signs in with email/password (or just signed up). The login
 *      screen routes here if no PIN is set yet for this user.
 *   2. Step 1: enter a new 4-digit PIN.
 *   3. Step 2: re-enter to confirm. If the two PINs don't match, we
 *      bounce them back to step 1 with a friendly error.
 *   4. On match: store via pinAuth.setPin, mark unlocked, route to
 *      dashboard.
 *
 * The user can also tap "Not now" — that skips PIN setup; they'll keep
 * logging in with email/password until they decide to set one later.
 */
import { useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';
import PinPad, { PinPadHandle } from '../../src/PinPad';
import { setPin, markUnlocked, PIN_LENGTH } from '../../src/pinAuth';
import { markPinSetupDismissed } from '../../src/pinSetupPrompt';
import { performFullAppReset } from '../../src/appReset';

export default function PinSetup() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const params = useLocalSearchParams<{ required?: string }>();
  // When `required=1` we hide the "Not now" button — used after a forced
  // PIN reset where the user MUST set a new one before continuing.
  const isRequired = params?.required === '1';

  // ============================================================
  // HARD GUARD: unauthenticated users must NEVER see this screen.
  // ============================================================
  // A PIN is a per-account secret — there's nothing to "set up"
  // without an account. The v6.9 bug was: a stale Keychain token
  // from a previous install was being honoured, RootNav saw the
  // ghost user, and shoved the user into pin-setup with no exit
  // ramp. Even if RootNav misbehaves, this screen-level guard
  // ensures the worst-case is "blink → welcome screen" rather
  // than "infinite PIN-setup loop with no way out".
  useEffect(() => {
    if (!loading && !user?.id) {
      router.replace('/');
    }
  }, [loading, user?.id]);

  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [firstPin, setFirstPin] = useState('');
  const [errorState, setErrorState] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [hintTone, setHintTone] = useState<'normal' | 'error' | 'success'>('normal');
  const padRef = useRef<PinPadHandle>(null);

  const reset = (toStep: 'enter' | 'confirm', msg: string, tone: 'normal' | 'error' | 'success') => {
    setStep(toStep);
    setHint(msg);
    setHintTone(tone);
    padRef.current?.reset();
  };

  const onPinComplete = async (pin: string) => {
    if (!user?.id) {
      Alert.alert('Not signed in', 'Please sign in with your email & password first.');
      router.replace('/(auth)/login');
      return;
    }
    if (step === 'enter') {
      setFirstPin(pin);
      reset('confirm', 'Re-enter the same PIN to confirm', 'normal');
      return;
    }
    // Confirm step
    if (pin !== firstPin) {
      setErrorState(true);
      setTimeout(() => setErrorState(false), 600);
      setFirstPin('');
      reset('enter', "PINs didn't match. Please choose a new PIN.", 'error');
      return;
    }
    try {
      await setPin(user.id, pin);
      markUnlocked(user.id);
      reset('enter', 'PIN saved!', 'success');
      setTimeout(() => router.replace('/(tabs)/dashboard'), 400);
    } catch (e: any) {
      Alert.alert('Could not save PIN', e?.message || 'Please try again.');
      setFirstPin('');
      reset('enter', 'Try again.', 'error');
    }
  };

  const onSkip = () => {
    if (isRequired) return;
    Alert.alert(
      'Skip PIN setup?',
      "You can always add a PIN later from Settings → Account. You'll keep signing in with your email and password until then.",
      [
        {
          text: 'Keep email login',
          style: 'default',
          onPress: async () => {
            // Persist the dismissal so RootNav doesn't keep
            // re-routing the user back here on every app open /
            // re-sign-in.
            if (user?.id) {
              try { await markPinSetupDismissed(user.id); } catch (_e) {}
            }
            router.replace('/(tabs)/dashboard');
          },
        },
        { text: 'Set up PIN', style: 'cancel' },
      ],
    );
  };

  // ============================================================
  // LAST-RESORT RECOVERY: Reset App
  // ============================================================
  // Wipes all local state — auth token, install sentinel, all
  // AsyncStorage. After confirmation the user is logged out and
  // bounced to welcome with a perfectly clean slate.
  //
  // Surfaced as a tiny "Having trouble? Reset app" link at the
  // bottom of the PIN screens so any future stuck-state bug has
  // a one-tap escape hatch. Also useful for support: "tap Reset
  // app at the bottom of the PIN screen" is a 1-step fix.
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

  // The screen title doubles as the per-step instruction so we don't
  // need a separate PinPad `label` prop colliding with it. Same fix
  // pattern as otp-verify.tsx — one clear instruction line, never
  // two stacked on top of each other.
  const stepTitle = step === 'enter'
    ? (isRequired ? 'Set up a new PIN' : 'Choose a 4-digit PIN')
    : 'Confirm your PIN';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>{stepTitle}</Text>
          <Text style={styles.subtitle}>
            {step === 'enter'
              ? "We'll use this for daily sign-in — no email code needed."
              : 'Type the same 4 digits again to confirm.'}
          </Text>
        </View>

        <View style={styles.padArea}>
          <PinPad
            ref={padRef}
            length={PIN_LENGTH}
            onComplete={onPinComplete}
            errorState={errorState}
            hint={hint || (step === 'enter' ? 'Pick something easy to remember' : '')}
            hintTone={hintTone}
          />
        </View>

        {!isRequired && (
          <TouchableOpacity testID="pin-setup-skip" onPress={onSkip} style={styles.skip}>
            <Text style={styles.skipText}>Not now</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          testID="pin-setup-reset-app"
          onPress={onResetApp}
          style={styles.resetLink}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.resetLinkText}>Having trouble? Reset app</Text>
        </TouchableOpacity>
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
    lineHeight: 21,
    paddingHorizontal: 16,
  },
  padArea: {
    marginTop: 18,
    paddingHorizontal: 12,
    alignItems: 'center',
    width: '100%',
  },
  skip: {
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 8,
  },
  skipText: {
    fontSize: 15,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  resetLink: {
    alignItems: 'center',
    paddingVertical: 10,
    marginTop: 2,
  },
  resetLinkText: {
    fontSize: 12,
    color: Colors.textTertiary,
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
});
