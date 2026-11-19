import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { api } from '../src/api';
import { Colors } from '../src/theme';
import { EmergencyCallAction } from '../src/components/EmergencyCallAction';
import {
  clearSosSendReceipt, getSosReceiptEpoch, noteSosDialerOpened,
  recordSosSendReceipt, sosAccountScope, SosLocationEvidence,
} from '../src/sosSendReceipt';
import { useAuth } from '../src/AuthContext';

/**
 * SOS sending screen — shown immediately after the 3-2-1 countdown fires.
 *
 * This screen owns all the async work that was previously a fire-and-forget
 * IIFE in the dashboard: GPS acquisition, POST /sos, location boost, alerts
 * bump. It shows live progress rows so the user can see what is happening.
 *
 * Navigation: router.replace('/sos-confirmation') on success only — we never
 * claim delivery or emergency dispatch. Calling is an independent user action.
 */

type SendStep = 'preparing' | 'locating' | 'sending' | 'done' | 'error';

// Total permission + GPS budget, not a separate wait for each native callback.
const SOS_LOCATION_BUDGET_MS = 1500;
type SosCoordinates = SosLocationEvidence & { latitude?: number; longitude?: number };

async function bestEffortSosLocation(isCurrent: () => boolean): Promise<SosCoordinates> {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const location = (async (): Promise<SosCoordinates> => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (finished || !isCurrent() || status !== 'granted') return {};
      const requestedAt = Date.now();
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (finished || !isCurrent()) return {};
      const { latitude, longitude } = pos.coords;
      const capturedAt = Number.isFinite(pos.timestamp) && pos.timestamp > 0 && pos.timestamp <= Date.now()
        ? pos.timestamp : undefined;
      return Number.isFinite(latitude) && Math.abs(latitude) <= 90
        && Number.isFinite(longitude) && Math.abs(longitude) <= 180
        ? {
          latitude, longitude, capturedAt,
          acquiredDuringAttempt: capturedAt !== undefined && capturedAt >= requestedAt,
          accuracy: Number.isFinite(pos.coords.accuracy) && (pos.coords.accuracy ?? -1) >= 0
            ? pos.coords.accuracy! : undefined,
        } : {};
    } catch {
      return {}; // Includes rejection after the fallback has already sent SOS.
    }
  })();
  try {
    return await Promise.race([
      location,
      new Promise<SosCoordinates>(resolve => {
        timer = setTimeout(() => resolve({}), SOS_LOCATION_BUDGET_MS);
      }),
    ]);
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
  }
}

export default function SOSSending() {
  const router = useRouter();
  const { user } = useAuth();
  const scope = sosAccountScope(user);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [step, setStep] = useState<SendStep>('preparing');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const hasFired = useRef(false);
  const mounted = useRef(true);
  const operation = useRef(0);
  const inFlight = useRef(false);
  const dialerOpened = useRef(false);
  const dialerScope = useRef(scope);
  if (dialerScope.current !== scope) {
    dialerOpened.current = false;
    dialerScope.current = scope;
  }
  const recordedId = useRef<string | null>(null);
  const handedOff = useRef(false);
  const [locationLabel, setLocationLabel] = useState('Checking GPS location');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
      inFlight.current = false;
      hasFired.current = false;
      if (!handedOff.current && recordedId.current) clearSosSendReceipt(recordedId.current);
    };
  }, []);

  const run = useCallback(async () => {
    if (inFlight.current || !mounted.current) return;
    inFlight.current = true;
    const id = ++operation.current;
    setStep('preparing');
    setErrorMsg(null);
    setLocationLabel('Checking GPS location');
    clearSosSendReceipt();
    recordedId.current = null;
    handedOff.current = false;
    const receiptEpoch = getSosReceiptEpoch();
    const isCurrent = () => mounted.current && operation.current === id
      && currentScope.current === scope && getSosReceiptEpoch() === receiptEpoch;
    if (!scope) {
      setStep('error');
      setErrorMsg('Your signed-in family could not be confirmed. You can still call 911.');
      inFlight.current = false;
      return;
    }
    // Brief settling pause so the screen renders before GPS starts.
    await new Promise<void>(resolve => setTimeout(resolve, 350));
    try {
      if (!isCurrent()) return;
      // Step 1 — GPS (best-effort; SOS fires with or without coordinates)
      setStep('locating');
      const coordinates = await bestEffortSosLocation(isCurrent);
      if (!isCurrent()) return;
      setLocationLabel(coordinates.latitude === undefined ? 'Location unavailable — sending without GPS'
        : coordinates.acquiredDuringAttempt ? 'GPS location available'
          : 'Location available — freshness not confirmed');

      // Step 2 — POST /sos (the network call that must succeed)
      setStep('sending');
      const response = await api.post('/sos', {
        latitude: coordinates.latitude, longitude: coordinates.longitude,
      });
      if (!isCurrent()) return;
      const receipt = recordSosSendReceipt(response.data, coordinates, dialerOpened.current, scope);
      recordedId.current = receipt.alertId;

      // Step 3 — post-send housekeeping (best-effort; never blocks success)
      void import('../src/backgroundLocation').then(bg => {
        if (isCurrent()) return bg.beginSosBoost();
      }).catch(() => {}); // Retain location boost without gating the dialer/UI.
      try { (globalThis as any).__kinnshipAlertsBump = Date.now(); } catch (_e) {}

      // Step 4 — success
      setStep('done');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      // Brief pause — success rows stay visible before navigating.
      await new Promise<void>(resolve => setTimeout(resolve, 900));
      if (isCurrent()) {
        handedOff.current = true;
        router.replace({ pathname: '/sos-confirmation', params: { receiptId: receipt.alertId } });
      }
    } catch {
      if (!isCurrent()) return;
      setErrorMsg(
        'Could not confirm that your family alert was recorded. It may have reached the server. '
        + 'You can retry or call 911 independently.',
      );
      setStep('error');
    } finally {
      if (operation.current === id) inFlight.current = false;
    }
  }, [router, scope]);

  useEffect(() => {
    if (hasFired.current) return;
    hasFired.current = true;
    run();
  }, [run]);

  const retry = useCallback(() => {
    run();
  }, [run]);

  const preparingDone = ['locating', 'sending', 'done'].includes(step);
  const locationDone  = ['sending', 'done'].includes(step);
  const sendingDone   = step === 'done';

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>🆘</Text>
        </View>

        <Text style={styles.title}>Sending Emergency Alert</Text>
        <Text style={styles.sub}>
          Family alerts and emergency calling are separate. You can call 911 now.
        </Text>

        <View style={styles.rows}>
          <StatusRow
            label="Preparing"
            ok={preparingDone}
            active={step === 'preparing'}
          />
          <StatusRow
            label={locationLabel}
            ok={locationDone}
            active={step === 'locating'}
          />
          <StatusRow
            label={sendingDone ? 'SOS alert recorded' : 'Recording SOS alert'}
            ok={sendingDone}
            active={step === 'sending'}
          />
        </View>

        {step === 'error' && (
          <View style={styles.errorBox}>
            <Text style={styles.errorEmoji}>⚠️</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.errorTitle}>Family alert not confirmed</Text>
              <Text style={styles.errorBody}>{errorMsg}</Text>
            </View>
          </View>
        )}
      </ScrollView>

      <View style={styles.bottom}>
        <EmergencyCallAction key={scope} onOpened={() => {
          dialerOpened.current = true;
          noteSosDialerOpened(recordedId.current);
        }} />
        {step === 'error' && (
          <TouchableOpacity
            testID="sos-retry"
            onPress={retry}
            activeOpacity={0.85}
            style={styles.retryBtn}
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        )}
      </View>
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
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
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
  bottom: { paddingHorizontal: 24, paddingBottom: 20, gap: 12 },
  retryBtn: {
    height: 56, backgroundColor: Colors.sos, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  retryText: { color: Colors.surface, fontSize: 16, fontWeight: '800' },
});
