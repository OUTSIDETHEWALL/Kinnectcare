import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Colors } from '../theme';

/** Opens the device dialer on explicit user action; no API, GPS, or call claim. */
export function EmergencyCallAction({
  initiallyOpened = false, onOpened,
}: { initiallyOpened?: boolean; onOpened?: () => void }) {
  const [status, setStatus] = useState(initiallyOpened ? 'opened' : 'idle');
  const pending = useRef(false);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const guidance = () => Alert.alert(
    'Could not confirm emergency dialer',
    'Use your phone’s emergency call screen or another phone to call 911. '
    + 'Kinnship has not confirmed an emergency call. You can tap Call 911 to try the dialer again.',
  );
  const open = async () => {
    if (pending.current) return;
    pending.current = true;
    const id = ++attempt.current;
    setStatus('opening');
    const timeout = setTimeout(() => {
      if (!mounted.current || attempt.current !== id) return;
      attempt.current += 1; // A late native settlement is no longer this attempt.
      pending.current = false;
      setStatus('unconfirmed');
      guidance();
    }, 3000);
    timer.current = timeout;
    try {
      // Directly try the intent. A separate capability query can reject a valid
      // dialer, and must never become an extra prerequisite for emergency access.
      await Linking.openURL('tel:911');
      if (mounted.current && attempt.current === id) {
        setStatus('opened');
        onOpened?.();
      }
    } catch {
      if (mounted.current && attempt.current === id) {
        setStatus('unconfirmed');
        guidance();
      }
    } finally {
      clearTimeout(timeout);
      if (attempt.current === id) pending.current = false;
    }
  };

  return (
    <View>
      <TouchableOpacity
        testID="sos-call-911"
        accessibilityRole="button"
        accessibilityLabel="Call 911, open emergency dialer"
        onPress={open}
        activeOpacity={0.85}
        style={styles.button}
      >
        <Text style={styles.label}>Call 911</Text>
      </TouchableOpacity>
      <Text testID="sos-dialer-status" style={styles.status}>
        {status === 'opened'
          ? 'Emergency dialer opened. Kinnship cannot confirm a call was placed or answered.'
          : status === 'unconfirmed'
            ? 'Dialer opening not confirmed. Try again or use your phone’s emergency call screen or another phone.'
            : 'Opens your emergency dialer. You must place the call yourself.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56, padding: 12, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surface, borderWidth: 2, borderColor: Colors.sos,
  },
  label: { color: Colors.sos, fontSize: 17, fontWeight: '800' },
  status: { color: Colors.textSecondary, fontSize: 12, textAlign: 'center', marginTop: 6 },
});
