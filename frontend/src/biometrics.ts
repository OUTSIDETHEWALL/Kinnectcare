/**
 * biometrics.ts — Build #55.
 *
 * Optional biometric (Face ID / Touch ID / Fingerprint) unlock on top
 * of the mandatory 4-digit PIN.  Product spec (per Charles):
 *   • Biometrics are a CONVENIENCE alternative to the PIN, never a
 *     replacement.  A PIN must exist before biometrics can be
 *     enabled.
 *   • If a biometric attempt fails/cancels, the caller must fall
 *     back to the PIN pad — biometrics never dead-end the user.
 *   • The per-user opt-in flag lives in AsyncStorage (it's a UX
 *     preference, not a secret).
 *
 * Web (Expo Go preview) is unsupported by expo-local-authentication;
 * every helper below returns a safe default when we're not on native.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Lazy-require so the web preview doesn't blow up on the native-only
// module import.  expo-local-authentication ships a web shim for some
// methods, but calling authenticateAsync there just throws.
let _LA: typeof import('expo-local-authentication') | null = null;
function getLA(): typeof import('expo-local-authentication') | null {
  if (Platform.OS === 'web') return null;
  if (_LA) return _LA;
  try {
    _LA = require('expo-local-authentication');
    return _LA;
  } catch (_e) {
    return null;
  }
}

function prefKey(userId: string): string {
  const safe = String(userId || '').replace(/[^A-Za-z0-9_.-]/g, '');
  return `@kinnship/biometric_enabled_v1_${safe}`;
}

export type BiometricCapability = {
  supported: boolean;      // Hardware capable at all
  enrolled: boolean;       // User has at least one face/fingerprint registered
  typeLabel: string;       // Human-readable — "Face ID", "Fingerprint", "Biometrics"
  // Build #56 — enumerate ALL enrolled biometric types so Me → Security
  // can show one row per method (many Android phones ship both a
  // face-unlock sensor AND a fingerprint reader — showing only one
  // hides half the value).  Empty array on web / unsupported devices.
  availableTypes: Array<'face' | 'fingerprint' | 'iris'>;
};

function _labelFor(kind: 'face' | 'fingerprint' | 'iris'): string {
  if (kind === 'face') return Platform.OS === 'ios' ? 'Face ID' : 'Face Unlock';
  if (kind === 'fingerprint') return Platform.OS === 'ios' ? 'Touch ID' : 'Fingerprint';
  return 'Iris';
}

export function labelForBiometricType(kind: 'face' | 'fingerprint' | 'iris'): string {
  return _labelFor(kind);
}

/** Detect whether the device supports biometric auth AND the user has enrolled at least one. */
export async function getBiometricCapability(): Promise<BiometricCapability> {
  const LA = getLA();
  if (!LA) return { supported: false, enrolled: false, typeLabel: 'Biometrics', availableTypes: [] };
  try {
    const hardware = await LA.hasHardwareAsync();
    const enrolled = await LA.isEnrolledAsync();
    let typeLabel = 'Biometrics';
    const availableTypes: Array<'face' | 'fingerprint' | 'iris'> = [];
    try {
      const types = await LA.supportedAuthenticationTypesAsync();
      // Preserve enumeration order — most Android devices report
      // fingerprint first when both are enrolled, which happens to be
      // the label caregivers expect to see (fingerprint is more
      // commonly used on Android than face unlock).
      if (types.includes(LA.AuthenticationType.FINGERPRINT)) availableTypes.push('fingerprint');
      if (types.includes(LA.AuthenticationType.FACIAL_RECOGNITION)) availableTypes.push('face');
      if (types.includes(LA.AuthenticationType.IRIS)) availableTypes.push('iris');
      if (availableTypes[0]) typeLabel = _labelFor(availableTypes[0]);
    } catch (_e) {}
    return { supported: !!hardware, enrolled: !!enrolled, typeLabel, availableTypes };
  } catch (_e) {
    return { supported: false, enrolled: false, typeLabel: 'Biometrics', availableTypes: [] };
  }
}

/** Whether the current user has opted-in to biometric unlock. */
export async function isBiometricEnabledForUser(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const raw = await AsyncStorage.getItem(prefKey(userId));
    return raw === '1';
  } catch (_e) {
    return false;
  }
}

/** Turn the per-user preference on. */
export async function enableBiometricForUser(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.setItem(prefKey(userId), '1');
  } catch (_e) {}
}

/** Turn the per-user preference off (idempotent). */
export async function disableBiometricForUser(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.removeItem(prefKey(userId));
  } catch (_e) {}
}

export type BiometricPromptResult =
  | { ok: true }
  | { ok: false; reason: 'cancel' | 'fallback' | 'unavailable' | 'lockout' | 'error'; message?: string };

/**
 * Show the OS biometric prompt.  Callers MUST handle `ok: false` by
 * routing back to the PIN pad — biometrics can never dead-end the
 * user.
 */
export async function promptBiometric(
  reason: string = 'Unlock Kinnship',
): Promise<BiometricPromptResult> {
  const LA = getLA();
  if (!LA) return { ok: false, reason: 'unavailable' };
  try {
    const cap = await getBiometricCapability();
    if (!cap.supported || !cap.enrolled) return { ok: false, reason: 'unavailable' };
    const res = await LA.authenticateAsync({
      promptMessage: reason,
      // Force our own fallback UI — we always want to route back to
      // the PIN pad, not the OS passcode.
      disableDeviceFallback: true,
      cancelLabel: 'Use PIN',
    });
    if (res.success) return { ok: true };
    // res.error might be "user_cancel", "user_fallback", "lockout",
    // "lockout_permanent", "not_enrolled", etc.
    const err = (res as any).error as string | undefined;
    if (err === 'user_cancel') return { ok: false, reason: 'cancel' };
    if (err === 'user_fallback' || err === 'system_cancel')
      return { ok: false, reason: 'fallback' };
    if (err === 'lockout' || err === 'lockout_permanent')
      return { ok: false, reason: 'lockout', message: 'Too many attempts — use your PIN.' };
    return { ok: false, reason: 'error', message: err };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: e?.message };
  }
}
