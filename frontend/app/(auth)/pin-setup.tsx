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
import { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../../src/theme';
import { useAuth } from '../../src/AuthContext';
import PinPad, { PinPadHandle } from '../../src/PinPad';
import { setPin, markUnlocked, PIN_LENGTH } from '../../src/pinAuth';
import { markPinSetupDismissed } from '../../src/pinSetupPrompt';

export default function PinSetup() {
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ required?: string }>();
  // When `required=1` we hide the "Not now" button — used after a forced
  // PIN reset where the user MUST set a new one before continuing.
  const isRequired = params?.required === '1';

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

  const label = step === 'enter'
    ? 'Choose a 4-digit PIN'
    : 'Confirm your PIN';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>
          {isRequired ? 'Set up a new PIN' : 'Set up a 4-digit PIN'}
        </Text>
        <Text style={styles.subtitle}>
          Faster sign-in next time — no typing your password.
        </Text>
      </View>

      <View style={styles.padArea}>
        <PinPad
          ref={padRef}
          length={PIN_LENGTH}
          onComplete={onPinComplete}
          errorState={errorState}
          label={label}
          hint={hint || (step === 'enter' ? 'Pick something easy to remember' : '')}
          hintTone={hintTone}
        />
      </View>

      {!isRequired && (
        <TouchableOpacity testID="pin-setup-skip" onPress={onSkip} style={styles.skip}>
          <Text style={styles.skipText}>Not now</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    paddingTop: 16,
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
    marginTop: 6,
    fontSize: 15,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
    paddingHorizontal: 16,
  },
  padArea: {
    flex: 1,
    paddingTop: 12,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  skip: {
    alignItems: 'center',
    paddingVertical: 16,
    marginBottom: 8,
  },
  skipText: {
    fontSize: 15,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
});
