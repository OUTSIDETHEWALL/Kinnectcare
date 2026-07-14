import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { api } from '../src/api';
import { Colors } from '../src/theme';

/**
 * SOS sending screen — shown immediately after the 3-2-1 countdown fires.
 *
 * This screen owns all the async work that was previously a fire-and-forget
 * IIFE in the dashboard: GPS acquisition, POST /sos, location boost, alerts
 * bump. It shows live progress rows so the user can see what is happening.
 *
 * Navigation: router.replace('/sos-confirmation') on success only — we never
 * tell the user "help is on the way" until the server has confirmed receipt.
 */

type SendStep = 'preparing' | 'locating' | 'sending' | 'done' | 'error';

export default function SOSSending() {
  const router = useRouter();
  const [step, setStep] = useState<SendStep>('preparing');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const hasFired = useRef(false);

  const run = useCallback(async () => {
    setStep('preparing');
    setErrorMsg(null);
    // Brief settling pause so the screen renders before GPS starts.
    await new Promise<void>(resolve => setTimeout(resolve, 350));
    try {
      // Step 1 — GPS (best-effort; SOS fires with or without coordinates)
      setStep('locating');
      let lat: number | undefined, lon: number | undefined;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          lat = pos.coords.latitude;
          lon = pos.coords.longitude;
        }
      } catch (_e) {}

      // Step 2 — POST /sos (the network call that must succeed)
      setStep('sending');
      await api.post('/sos', { latitude: lat, longitude: lon });

      // Step 3 — post-send housekeeping (best-effort; never blocks success)
      try {
        const bg = await import('../src/backgroundLocation');
        await bg.beginSosBoost(); // 10 s cadence for 30 min so family sees a moving dot
      } catch (_e) {}
      try { (globalThis as any).__kinnshipAlertsBump = Date.now(); } catch (_e) {}

      // Step 4 — success
      setStep('done');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Hold the ✓ state briefly so all three rows are visible before navigating.
      await new Promise<void>(resolve => setTimeout(resolve, 900));
      router.replace('/sos-confirmation');
    } catch (e: any) {
      setErrorMsg(
        e?.response?.data?.detail || 'Network error. Tap Retry to try again.',
      );
      setStep('error');
    }
  }, [router]);

  useEffect(() => {
    if (hasFired.current) return;
    hasFired.current = true;
    run();
  }, [run]);

  const retry = useCallback(() => {
    hasFired.current = false;
    run();
  }, [run]);

  const preparingDone = ['locating', 'sending', 'done'].includes(step);
  const locationDone  = ['sending', 'done'].includes(step);
  const sendingDone   = step === 'done';

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>🆘</Text>
        </View>

        <Text style={styles.title}>Sending Emergency Alert</Text>
        <Text style={styles.sub}>
          Keep this screen open while we alert your family.
        </Text>

        <View style={styles.rows}>
          <StatusRow
            label="Preparing"
            ok={preparingDone}
            active={step === 'preparing'}
          />
          <StatusRow
            label="Attaching location"
            ok={locationDone}
            active={step === 'locating'}
          />
          <StatusRow
            label="Sending to family"
            ok={sendingDone}
            active={step === 'sending'}
          />
        </View>

        {step === 'error' && (
          <View style={styles.errorBox}>
            <Text style={styles.errorEmoji}>⚠️</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.errorTitle}>Alert failed to send</Text>
              <Text style={styles.errorBody}>{errorMsg}</Text>
            </View>
          </View>
        )}
      </View>

      {step === 'error' && (
        <View style={styles.bottom}>
          <TouchableOpacity
            testID="sos-retry"
            onPress={retry}
            activeOpacity={0.85}
            style={styles.retryBtn}
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

function StatusRow({
  label, ok, active,
}: { label: string; ok: boolean; active: boolean }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIconWrap}>
        {ok ? (
          <Text style={styles.rowCheck}>✓</Text>
        ) : active ? (
          <ActivityIndicator size="small" color={Colors.primary} />
        ) : (
          <View style={styles.rowPending} />
        )}
      </View>
      <Text style={[styles.rowLabel, ok && styles.rowLabelDone]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background, justifyContent: 'space-between' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  iconWrap: {
    width: 120, height: 120, borderRadius: 60, backgroundColor: Colors.sos,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0px 10px 24px rgba(220,38,38,0.35)' as any,
    ...Platform.select({ android: { elevation: 8 } }),
  },
  icon: { fontSize: 56 },
  title: {
    fontSize: 24, fontWeight: '800', color: Colors.textPrimary,
    marginTop: 24, textAlign: 'center',
  },
  sub: {
    fontSize: 14, color: Colors.textSecondary, marginTop: 8,
    textAlign: 'center', lineHeight: 20,
  },
  rows: {
    alignSelf: 'stretch', backgroundColor: Colors.surface,
    borderRadius: 16, borderWidth: 1, borderColor: Colors.border,
    padding: 8, marginTop: 28,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 12, gap: 14,
  },
  rowIconWrap: { width: 24, alignItems: 'center', justifyContent: 'center' },
  rowCheck: { fontSize: 18, color: Colors.primary, fontWeight: '800' },
  rowPending: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.border },
  rowLabel: { fontSize: 15, fontWeight: '600', color: Colors.textSecondary },
  rowLabelDone: { color: Colors.textPrimary, fontWeight: '700' },
  errorBox: {
    flexDirection: 'row', gap: 10, alignSelf: 'stretch',
    backgroundColor: '#FFF4E5', borderColor: '#F2C46A', borderWidth: 1,
    borderRadius: 14, padding: 14, marginTop: 20,
  },
  errorEmoji: { fontSize: 22 },
  errorTitle: { fontSize: 14, fontWeight: '800', color: '#7A4A00' },
  errorBody: { fontSize: 13, color: '#7A4A00', marginTop: 4, lineHeight: 18 },
  bottom: { paddingHorizontal: 24, paddingBottom: 28 },
  retryBtn: {
    height: 56, backgroundColor: Colors.sos, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  retryText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
});
