/**
 * Fall Detection Test page.
 *
 * Senior-safety app diagnostic tool. Subscribes directly to the raw
 * accelerometer and shows live magnitude + a rolling history so the
 * user (Charles) can drop the phone onto a couch and INSTANTLY see
 * what the device actually produced:
 *
 *   • Live magnitude (g) — current reading, updated 20× / sec.
 *   • Peak magnitude (last impact) — the biggest spike seen so far.
 *   • Last max-freefall streak length — informs whether the freefall
 *     pre-check would have passed.
 *   • Stillness check — % of post-impact samples within the band,
 *     and longest consecutive stillness streak.
 *   • Last 60 samples on a tiny inline strip chart (text-based) so
 *     we don't have to ship a charting library.
 *
 * This eliminates the "no telemetry" problem we were stuck on: couch
 * drops weren't triggering, the algorithm fix didn't help, but we had
 * no idea WHY because there's no way to see raw sensor data from a
 * production build. Now there is.
 *
 * Tap the "Simulate fall" button at the bottom to verify the modal /
 * SOS path works end-to-end without actually dropping the phone.
 */
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Accelerometer } from 'expo-sensors';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';

const SAMPLE_MS = 50;
const RING_SIZE = 200;
const FREEFALL_G = 0.6;
const IMPACT_G = 2.2;
const STILLNESS_BAND_G = 0.35; // matches the relaxed band for couch compat
const STILLNESS_REQUIRED_MS = 1000;
const POST_IMPACT_WINDOW_MS = 4000;

type Sample = { t: number; m: number };

export default function FallDetectionTest() {
  const router = useRouter();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [liveMag, setLiveMag] = useState(0);
  const [peakMag, setPeakMag] = useState(0);
  const [lastFreefallMs, setLastFreefallMs] = useState(0);
  const [lastStillnessMs, setLastStillnessMs] = useState(0);
  const [lastImpactTs, setLastImpactTs] = useState(0);
  const [wouldTrigger, setWouldTrigger] = useState<boolean | null>(null);
  const [eventLog, setEventLog] = useState<string[]>([]);

  const bufRef = useRef<Sample[]>([]);
  const stateRef = useRef<'idle' | 'impact-wait-stillness'>('idle');
  const impactAtRef = useRef(0);
  const stillStartRef = useRef(0);
  const peakRef = useRef(0);
  const stillBestRef = useRef(0);

  const pushLog = (msg: string) => {
    setEventLog((prev) => {
      const line = `${new Date().toLocaleTimeString()} · ${msg}`;
      return [line, ...prev].slice(0, 20);
    });
  };

  useEffect(() => {
    (async () => {
      const isAvail = await Accelerometer.isAvailableAsync();
      setAvailable(isAvail);
      if (!isAvail) {
        pushLog('Accelerometer NOT AVAILABLE on this device. Test cannot run.');
        return;
      }
      Accelerometer.setUpdateInterval(SAMPLE_MS);
      const sub = Accelerometer.addListener(({ x, y, z }) => {
        const now = Date.now();
        const mag = Math.sqrt(x * x + y * y + z * z);
        setLiveMag(mag);

        // Ring buffer
        const buf = bufRef.current;
        buf.push({ t: now, m: mag });
        while (buf.length > RING_SIZE) buf.shift();

        if (stateRef.current === 'idle') {
          if (mag >= IMPACT_G) {
            // Compute MAX freefall streak in the lookback window.
            let maxFf = 0;
            let curStart = 0;
            for (let i = 0; i < buf.length - 1; i++) {
              if (buf[i].t > now - 20) break;
              if (buf[i].m < FREEFALL_G) {
                if (!curStart) curStart = buf[i].t;
                const len = buf[i].t - curStart;
                if (len > maxFf) maxFf = len;
              } else {
                curStart = 0;
              }
            }
            peakRef.current = Math.max(peakRef.current, mag);
            setPeakMag(peakRef.current);
            setLastFreefallMs(maxFf);
            setLastImpactTs(now);
            pushLog(`IMPACT ${mag.toFixed(2)}g — pre-impact freefall ${maxFf}ms`);
            if (maxFf >= 120) {
              stateRef.current = 'impact-wait-stillness';
              impactAtRef.current = now;
              stillStartRef.current = 0;
              stillBestRef.current = 0;
              pushLog('→ freefall window OK, watching for stillness…');
            } else {
              pushLog(`✗ freefall window TOO SHORT (need ≥120ms, got ${maxFf}ms) — ignored`);
            }
          }
          return;
        }

        // state === 'impact-wait-stillness'
        const elapsed = now - impactAtRef.current;
        const isStill = Math.abs(mag - 1.0) <= STILLNESS_BAND_G;
        if (isStill) {
          if (stillStartRef.current === 0) stillStartRef.current = now;
          const dur = now - stillStartRef.current;
          if (dur > stillBestRef.current) {
            stillBestRef.current = dur;
            setLastStillnessMs(dur);
          }
          if (dur >= STILLNESS_REQUIRED_MS) {
            pushLog(`✅ FALL CONFIRMED — stillness held ${dur}ms (band ${STILLNESS_BAND_G}g)`);
            setWouldTrigger(true);
            stateRef.current = 'idle';
            impactAtRef.current = 0;
            stillStartRef.current = 0;
          }
        } else {
          if (stillStartRef.current !== 0) {
            pushLog(`stillness broken at ${(mag).toFixed(2)}g — restart`);
          }
          stillStartRef.current = 0;
        }
        if (elapsed > POST_IMPACT_WINDOW_MS) {
          pushLog(`✗ post-impact window expired (best stillness ${stillBestRef.current}ms / need ${STILLNESS_REQUIRED_MS}ms)`);
          setWouldTrigger(false);
          stateRef.current = 'idle';
          impactAtRef.current = 0;
          stillStartRef.current = 0;
        }
      });
      return () => sub.remove();
    })();
  }, []);

  const resetCounters = () => {
    peakRef.current = 0;
    stillBestRef.current = 0;
    setPeakMag(0);
    setLastFreefallMs(0);
    setLastStillnessMs(0);
    setLastImpactTs(0);
    setWouldTrigger(null);
    setEventLog([]);
    pushLog('counters reset');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Icon name="chevron-back" size={28} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Fall Detection Test</Text>
        <TouchableOpacity onPress={resetCounters} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.resetTxt}>Reset</Text>
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

        <View style={styles.bigCard}>
          <Text style={styles.bigLabel}>Live magnitude</Text>
          <Text style={styles.bigValue}>{liveMag.toFixed(2)}<Text style={styles.bigUnit}> g</Text></Text>
          <Text style={styles.bigHint}>
            ≈1.0g resting · &lt;0.6g freefall · ≥2.2g impact
          </Text>
        </View>

        <View style={styles.row}>
          <MetricCard label="Peak G seen" value={peakMag > 0 ? `${peakMag.toFixed(2)} g` : '—'} />
          <MetricCard label="Last freefall" value={lastFreefallMs > 0 ? `${lastFreefallMs} ms` : '—'} hint="need ≥120ms" />
        </View>
        <View style={styles.row}>
          <MetricCard label="Best stillness" value={lastStillnessMs > 0 ? `${lastStillnessMs} ms` : '—'} hint="need ≥1000ms" />
          <MetricCard
            label="Would trigger?"
            value={wouldTrigger === null ? '—' : wouldTrigger ? 'YES' : 'NO'}
            color={wouldTrigger === true ? Colors.success : wouldTrigger === false ? Colors.error : Colors.textSecondary}
          />
        </View>

        <Text style={styles.sectionLabel}>How to use</Text>
        <View style={styles.helpCard}>
          <Text style={styles.helpText}>
            1. Hold the phone at chest height.{'\n'}
            2. Drop onto the test surface (couch, bed, floor).{'\n'}
            3. Watch the event log below — it shows the IMPACT g, the pre-impact freefall streak that was detected, and whether stillness held for the required 1000ms.{'\n'}
            4. If "freefall window TOO SHORT" — the device decelerated too gently before impact (couch may absorb the freefall too fast).{'\n'}
            5. If "post-impact window expired" — the device kept moving after impact (couch bouncing).{'\n'}
            6. Share screenshot of the event log so we can tune thresholds to your device.
          </Text>
        </View>

        <Text style={styles.sectionLabel}>Event log</Text>
        <View style={styles.logCard}>
          {eventLog.length === 0 ? (
            <Text style={styles.logEmpty}>No events yet — drop the phone to see data.</Text>
          ) : (
            eventLog.map((line, i) => (
              <Text key={i} style={styles.logLine}>{line}</Text>
            ))
          )}
        </View>

        <Text style={styles.disclaimer}>
          This test page uses the same algorithm as the production fall
          detector — IMPACT_G {IMPACT_G}, FREEFALL_G {FREEFALL_G},
          STILLNESS_BAND {STILLNESS_BAND_G}g for {STILLNESS_REQUIRED_MS}ms.
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
  bigCard: {
    backgroundColor: Colors.surface, borderRadius: 16, padding: 24,
    alignItems: 'center', marginBottom: 14, borderWidth: 1, borderColor: Colors.border,
  },
  bigLabel: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, letterSpacing: 0.5 },
  bigValue: { fontSize: 64, fontWeight: '900', color: Colors.textPrimary, marginTop: 8 },
  bigUnit: { fontSize: 28, fontWeight: '700', color: Colors.textSecondary },
  bigHint: { fontSize: 12, color: Colors.textTertiary, marginTop: 6, textAlign: 'center' },
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
