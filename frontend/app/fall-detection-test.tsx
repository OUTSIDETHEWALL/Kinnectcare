/**
 * Fall Detection Test page (v1.4.0 — multi-signal state machine).
 *
 * Surfaces the LIVE four-phase fall pipeline from `useFallDetector`
 * so a tester can verify each signal independently before relying on
 * it in production:
 *
 *   PHASE 1 — IMPACT
 *       Lights up the moment the accelerometer reads a magnitude
 *       spike over the threshold.
 *   PHASE 2 — ORIENTATION CHANGE
 *       Shows the live angular delta (degrees) between pre-impact
 *       pose and current pose.  Promotes when the delta crosses the
 *       configured floor.
 *   PHASE 3 — POST-IMPACT STILLNESS
 *       Shows the percent of the stillness window currently
 *       satisfied.  Promotes to "FALL CONFIRMED" when the dwell-time
 *       is met.
 *   PHASE 4 — 30-SECOND COUNTDOWN
 *       Owned by the global FallDetectionOverlay component — this
 *       page only logs the trigger.  Tap "Simulate fall" to manually
 *       jump to phase 4 without dropping a phone.
 */
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import {
  useFallDetector,
  FALL_THRESHOLDS,
  FallPhase,
  PhaseDebug,
} from '../src/fallDetector';

const PHASE_LABELS: Record<FallPhase, string> = {
  'idle': '⚪ Idle — waiting for impact',
  'impact-detected': '🟡 Phase 1 ✅ Impact detected',
  'orientation-confirmed': '🟠 Phase 2 ✅ Orientation change confirmed',
  'stillness-watching': '🟣 Phase 3 — watching for stillness',
  'cooldown': '🔵 Cooldown — try again in a few seconds',
};

export default function FallDetectionTest() {
  const router = useRouter();
  const [latestPhase, setLatestPhase] = useState<FallPhase>('idle');
  const [debug, setDebug] = useState<PhaseDebug>({
    mag: 0, orientationDeltaDeg: null, stillnessFractionPct: null,
  });
  const [eventLog, setEventLog] = useState<string[]>([]);
  const lastPhaseRef = useRef<FallPhase>('idle');
  const [triggeredAt, setTriggeredAt] = useState<number | null>(null);

  const pushLog = (msg: string) => {
    setEventLog((prev) => {
      const line = `${new Date().toLocaleTimeString()} · ${msg}`;
      return [line, ...prev].slice(0, 25);
    });
  };

  // Live phase tap from the production detector.
  const { available, phase, simulateFall } = useFallDetector({
    onFallDetected: () => {
      setTriggeredAt(Date.now());
      pushLog('🚨 FALL CONFIRMED — overlay would show 30 s countdown now');
    },
    onPhase: (p, d) => {
      setLatestPhase(p);
      setDebug(d);
      if (lastPhaseRef.current !== p) {
        lastPhaseRef.current = p;
        pushLog(`→ ${p}`);
      }
    },
  });

  useEffect(() => {
    if (!available && Platform.OS !== 'web') {
      pushLog('Accelerometer NOT AVAILABLE on this device.');
    }
  }, [available]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Icon name="chevron-back" size={28} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Fall Detection · v1.4.0</Text>
        <TouchableOpacity
          testID="fall-test-simulate"
          onPress={simulateFall}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.resetTxt}>Simulate</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.statusCard}>
          <Text style={styles.statusLabel}>Accelerometer</Text>
          <Text style={[
            styles.statusValue,
            available === false ? { color: Colors.error } : null,
            available === true ? { color: Colors.success } : null,
          ]}>
            {available === null ? 'Checking…' : available ? 'Available' : 'NOT AVAILABLE'}
          </Text>
        </View>

        {/* Big phase indicator */}
        <View style={styles.phaseCard}>
          <Text style={styles.phaseLabel}>Current phase</Text>
          <Text style={styles.phaseValue} testID="fall-test-phase">
            {PHASE_LABELS[latestPhase] || latestPhase}
          </Text>
          <Text style={styles.phaseSub}>
            Multi-signal state machine — all phases must pass before the 30 s countdown fires.
          </Text>
        </View>

        {/* Live signal cards */}
        <View style={styles.row}>
          <MetricCard
            label="Magnitude"
            value={`${debug.mag.toFixed(2)} g`}
            hint={`impact ≥ ${FALL_THRESHOLDS.IMPACT_G_THRESHOLD} g`}
          />
          <MetricCard
            label="Orientation Δ"
            value={
              debug.orientationDeltaDeg === null
                ? '—'
                : `${debug.orientationDeltaDeg.toFixed(0)}°`
            }
            hint={`need ≥ ${FALL_THRESHOLDS.ORIENTATION_DELTA_DEG}°`}
          />
        </View>
        <View style={styles.row}>
          <MetricCard
            label="Stillness fill"
            value={
              debug.stillnessFractionPct === null
                ? '—'
                : `${debug.stillnessFractionPct}%`
            }
            hint={`need ${Math.round(
              (FALL_THRESHOLDS.STILLNESS_REQUIRED_MS /
                FALL_THRESHOLDS.STILLNESS_WINDOW_MS) * 100,
            )}% of ${FALL_THRESHOLDS.STILLNESS_WINDOW_MS}ms`}
          />
          <MetricCard
            label="Last triggered"
            value={triggeredAt ? `${Math.round((Date.now() - triggeredAt) / 1000)}s ago` : '—'}
            hint="when phase 4 fired"
          />
        </View>

        <Text style={styles.sectionLabel}>How to use</Text>
        <View style={styles.helpCard}>
          <Text style={styles.helpText}>
            1. Hold the phone in any pose (pocket, hand, table).{'\n'}
            2. Trigger a controlled fall onto a soft surface.{'\n'}
            3. Watch the four phase indicators above progress in real time:{'\n'}
               • Impact (g spike) → Orientation Δ (new resting pose) → Stillness fill (~60% of 1.5 s window){'\n'}
            4. If phase 3 fills past the required threshold, the production
            overlay will fire its 30 s "Are you OK?" countdown.{'\n'}
            5. Tap "Simulate" in the header to bypass the sensors and trigger
            the overlay flow directly.
          </Text>
        </View>

        <Text style={styles.sectionLabel}>Event log</Text>
        <View style={styles.logCard}>
          {eventLog.length === 0 ? (
            <Text style={styles.logEmpty}>No events yet — drop the phone to see live data.</Text>
          ) : (
            eventLog.map((line, i) => (
              <Text key={i} style={styles.logLine}>{line}</Text>
            ))
          )}
        </View>

        <Text style={styles.disclaimer}>
          Multi-signal v1.4.0 — IMPACT ≥ {FALL_THRESHOLDS.IMPACT_G_THRESHOLD} g, orientation Δ ≥ {FALL_THRESHOLDS.ORIENTATION_DELTA_DEG}°, stillness {FALL_THRESHOLDS.STILLNESS_REQUIRED_MS}ms / {FALL_THRESHOLDS.STILLNESS_WINDOW_MS}ms window, severe-impact bypass ≥ {FALL_THRESHOLDS.SEVERE_IMPACT_G} g.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function MetricCard({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, color ? { color } : null]}>{value}</Text>
      {hint ? <Text style={styles.metricHint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: Colors.textPrimary },
  resetTxt: { fontSize: 15, fontWeight: '700', color: Colors.primary },
  scroll: { padding: 16, paddingBottom: 32 },
  statusCard: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: Colors.surface, borderRadius: 12, padding: 14,
    marginBottom: 12, borderWidth: 1, borderColor: Colors.border,
  },
  statusLabel: { fontSize: 14, color: Colors.textSecondary },
  statusValue: { fontSize: 14, fontWeight: '800', color: Colors.textPrimary },
  phaseCard: {
    backgroundColor: Colors.surface, borderRadius: 16, padding: 22,
    marginBottom: 14, borderWidth: 1, borderColor: Colors.tertiary,
    boxShadow: '0px 4px 12px rgba(27,94,53,0.08)' as any,
  },
  phaseLabel: {
    fontSize: 12, fontWeight: '800', color: Colors.textTertiary,
    textTransform: 'uppercase', letterSpacing: 0.6,
  },
  phaseValue: {
    fontSize: 18, fontWeight: '800', color: Colors.textPrimary,
    marginTop: 6, lineHeight: 24,
  },
  phaseSub: {
    fontSize: 12, color: Colors.textSecondary, marginTop: 10, lineHeight: 17,
  },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  metricCard: {
    flex: 1, backgroundColor: Colors.surface, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: Colors.border,
  },
  metricLabel: { fontSize: 12, fontWeight: '700', color: Colors.textSecondary, marginBottom: 4 },
  metricValue: { fontSize: 22, fontWeight: '800', color: Colors.textPrimary },
  metricHint: { fontSize: 11, color: Colors.textTertiary, marginTop: 2 },
  sectionLabel: { fontSize: 13, fontWeight: '800', color: Colors.textSecondary, letterSpacing: 0.6, marginTop: 18, marginBottom: 8 },
  helpCard: {
    backgroundColor: Colors.surface, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: Colors.border,
  },
  helpText: { fontSize: 13, color: Colors.textPrimary, lineHeight: 20 },
  logCard: {
    backgroundColor: '#0F172A', borderRadius: 12, padding: 12, minHeight: 120,
  },
  logEmpty: { color: '#94A3B8', fontSize: 13, fontStyle: 'italic', textAlign: 'center', paddingVertical: 20 },
  logLine: { color: '#A7F3D0', fontFamily: 'Menlo', fontSize: 11, marginBottom: 4 },
  disclaimer: { marginTop: 18, fontSize: 11, color: Colors.textTertiary, textAlign: 'center', lineHeight: 16 },
});
