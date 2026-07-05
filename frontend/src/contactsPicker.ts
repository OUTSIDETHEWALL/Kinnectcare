import { Alert, Linking, Platform } from 'react-native';

/**
 * Cross-platform contacts picker for the Emergency Contact selector.
 *
 * On iOS/Android we use `expo-contacts` to request CONTACTS permission and
 * present the system contact picker. On web there's no equivalent — the
 * caller should fall back to the manual entry flow.
 *
 * Returns `{ name, phone }` on success; `null` if the user cancelled or
 * permission was denied; throws only on unexpected failures.
 */
export type PickedContact = { name: string; phone: string };

let Contacts: any = null;
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Contacts = require('expo-contacts');
  } catch (_e) {
    Contacts = null;
  }
}

export function isContactsPickerSupported(): boolean {
  return Platform.OS !== 'web' && !!Contacts;
}

function normaliseE164(raw: string, defaultCountry: string = '+1'): string {
  // Strip everything except digits and a leading +.
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  // 10-digit US/CA: prepend +1 (or whatever defaultCountry is).
  if (cleaned.length === 10) return `${defaultCountry}${cleaned}`;
  // 11-digit starting with 1 -> +1NNN...
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  // Fallback — leave whatever digits we have with a '+' prefix.
  return cleaned ? `+${cleaned}` : '';
}

function showPermissionDeniedExplainer(canAskAgain: boolean) {
  const msg = canAskAgain
    ? 'Kinnship needs access to your phone contacts so you can pick an emergency contact without typing their number. You can enable this in your device settings.'
    : 'Contacts permission was denied. To use this feature, open your device settings and grant Kinnship access to Contacts.';
  Alert.alert(
    'Contacts permission needed',
    msg,
    [
      { text: 'OK', style: 'cancel' },
      { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => {}) },
    ],
  );
}

/** Pick a contact via the system UI. Returns null when cancelled / denied. */
export async function pickContact(): Promise<PickedContact | null> {
  if (!isContactsPickerSupported()) {
    Alert.alert(
      'Not supported',
      'Picking from your phone contacts is only available on iOS and Android. Please enter the emergency contact manually.',
    );
    return null;
  }

  // 1. Permission gating.
  let perm = await Contacts.getPermissionsAsync();
  if (perm.status !== 'granted') {
    if (perm.canAskAgain) {
      perm = await Contacts.requestPermissionsAsync();
    }
    if (perm.status !== 'granted') {
      showPermissionDeniedExplainer(perm.canAskAgain);
      return null;
    }
  }

  // 2. Present picker (iOS native picker). On Android, expo-contacts ships a
  //    JS list picker via presentContactPickerAsync as well (SDK 51+).
  try {
    if (typeof Contacts.presentContactPickerAsync === 'function') {
      const picked = await Contacts.presentContactPickerAsync();
      if (!picked) return null; // cancelled
      const name = picked.name || picked.firstName || 'Emergency Contact';
      const phones = (picked.phoneNumbers || []) as Array<{ number?: string; digits?: string }>;
      const rawPhone = phones[0]?.number || phones[0]?.digits || '';
      const phone = normaliseE164(rawPhone);
      if (!phone) {
        Alert.alert(
          'No phone number',
          `${name} doesn't have a phone number saved in your contacts. Please pick a different contact or enter the number manually.`,
        );
        return null;
      }
      return { name, phone };
    }

    // Fallback path — fetch contacts and let the caller pick. We just take
    // the first one with a phone number as a graceful degradation (no UI).
    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
    });
    const withPhone = (data || []).find((c: any) => (c.phoneNumbers || []).length > 0);
    if (!withPhone) return null;
    const name = withPhone.name || 'Emergency Contact';
    const phone = normaliseE164(withPhone.phoneNumbers[0].number || '');
    return { name, phone };
  } catch (e: any) {
    Alert.alert('Failed to open contacts', e?.message || 'Please try again or enter the contact manually.');
    return null;
  }
}
