import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'kc.onboarding.done';

export async function isOnboardingDone(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v === '1';
  } catch {
    return false;
  }
}

export async function markOnboardingDone(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, '1');
  } catch {
    // ignore
  }
}

export async function resetOnboarding(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
