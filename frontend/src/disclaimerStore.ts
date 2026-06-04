/**
 * Tiny pub-sub store for the first-launch health disclaimer
 * acknowledgment flag.
 *
 * Why this exists (v1.1.8 hotfix):
 *   v1.1.7 read AsyncStorage *once* on RootNav mount and kept the
 *   verdict in local React state.  When the user tapped
 *   "I Understand" on the disclaimer screen, AsyncStorage was
 *   updated but the RootNav state stayed `needsDisclaimer=true`,
 *   so navigation back to '/' immediately bounced them to
 *   /disclaimer again → infinite loop.  Even before acking,
 *   the gate's later branches (onboarding redirect) competed
 *   with the disclaimer-redirect branch, causing visible
 *   strobing between the two screens.
 *
 * This module gives us:
 *   • A single async loader to read the flag on cold start.
 *   • A setter that updates AsyncStorage AND notifies every
 *     subscriber synchronously — so RootNav can flip
 *     `needsDisclaimer` to false the same tick the user acks,
 *     and no re-render is wasted bouncing back to /disclaimer.
 *   • A pub/sub interface RootNav uses to react to changes.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const DISCLAIMER_ACK_KEY = 'disclaimer_accepted';

// Mutable, module-scoped cache of the most recent verdict.  Starts
// `null` until the first load completes — RootNav treats null as
// "still loading" and shows the ActivityIndicator.
let _ack: boolean | null = null;
const _subscribers = new Set<() => void>();

export async function loadDisclaimerAck(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(DISCLAIMER_ACK_KEY);
    _ack = !!v;
  } catch (_e) {
    // If AsyncStorage is broken, show the disclaimer (safer default).
    _ack = false;
  }
  return _ack;
}

export function getDisclaimerAckSync(): boolean | null {
  return _ack;
}

export async function setDisclaimerAck(): Promise<void> {
  try {
    await AsyncStorage.setItem(DISCLAIMER_ACK_KEY, '1');
  } catch (_e) {
    // Even if the write fails the user gets to proceed — they'll
    // just be re-prompted on next launch.  Notifying subscribers
    // anyway lets the gate fall through this session.
  }
  _ack = true;
  // Notify synchronously — RootNav's subscriber updates its React
  // state, which triggers exactly one re-render with the new value.
  _subscribers.forEach((cb) => {
    try {
      cb();
    } catch (_e) {
      // A misbehaving subscriber should not break the others.
    }
  });
}

export function subscribeDisclaimerAck(cb: () => void): () => void {
  _subscribers.add(cb);
  return () => {
    _subscribers.delete(cb);
  };
}
