import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Platform } from 'react-native';

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
 * Show the prominent disclosure once per Android installation, directly before
 * the app requests background location. It is intentionally not a substitute
 * for Android's runtime permission prompt, which follows immediately after.
 */
export async function ensureBackgroundLocationDisclosure(): Promise<void> {
  if (Platform.OS !== 'android') return;

  try {
    if (await AsyncStorage.getItem(DISCLOSURE_SHOWN_KEY) === 'true') return;
  } catch (_e) {
    // If local storage is temporarily unavailable, still disclose rather than
    // silently proceeding to Android's sensitive-permission prompt.
  }

  await showDisclosureAlert();

  try {
    await AsyncStorage.setItem(DISCLOSURE_SHOWN_KEY, 'true');
  } catch (_e) {
    // A storage failure only means the disclosure may appear again next time.
  }
}