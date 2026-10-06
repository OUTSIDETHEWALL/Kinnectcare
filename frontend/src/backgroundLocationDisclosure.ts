import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Platform } from 'react-native';
import * as Location from 'expo-location';

/**
 * Google Play requires an in-app, prominent disclosure immediately before an
 * Android background-location permission request. Keep the mandated concepts
 * ("location" and "when the app is closed") in this exact copy.
 */
export const BACKGROUND_LOCATION_DISCLOSURE_TEXT =
  'Kinnship collects location data to enable family safety location sharing, ' +
  'including current location on your family map and location in SOS alerts, ' +
  'even when the app is closed or not in use. Your location is shared only ' +
  'with members of your Kinnship family group and is never used for advertising.';

const DISCLOSURE_SHOWN_KEY = '@kinnship/background_location_disclosure_shown_v1';
let pendingDisclosure: Promise<void> | null = null;

function showDisclosureAlert(): Promise<void> {
  return new Promise((resolve) => {
    Alert.alert(
      'Location sharing in the background',
      BACKGROUND_LOCATION_DISCLOSURE_TEXT,
      [{ text: 'Continue', onPress: () => resolve() }],
      { cancelable: false },
    );
  });
}

/**
 * Await acknowledgment before an Android location permission request.
 * An acknowledgment restored from old app data is not sufficient if location
 * permission has never been requested. Concurrent callers share the entire
 * check/dialog/save operation, not just the visible alert.
 */
export function ensureBackgroundLocationDisclosure(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  if (pendingDisclosure) return pendingDisclosure;

  pendingDisclosure = checkAndShowDisclosure().finally(() => {
    pendingDisclosure = null;
  });
  return pendingDisclosure;
}

async function checkAndShowDisclosure(): Promise<void> {
  try {
    if (await AsyncStorage.getItem(DISCLOSURE_SHOWN_KEY) === 'true') {
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.status !== 'undetermined') return;
    }
  } catch (_e) {
    // If storage or permission-state lookup fails, disclose rather than
    // trusting a possibly stale acknowledgment.
  }

  await showDisclosureAlert();

  try {
    await AsyncStorage.setItem(DISCLOSURE_SHOWN_KEY, 'true');
  } catch (_e) {
    // A storage failure only means the disclosure may appear again next time.
  }
}