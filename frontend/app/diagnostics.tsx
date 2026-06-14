/**
 * Diagnostics screen (P1 of the beta stabilization sprint).
 *
 * Read-only viewer + Copy/Clear actions for the two rolling logs we
 * maintain on-device:
 *
 *   1. kc_auth_clear_diag      — every time the session was force-
 *      cleared because /auth/me returned a confirmed 401 (after the
 *      single 2s retry). Used to diagnose "I was kicked back to
 *      Welcome / asked for OTP again" reports.
 *
 *   2. @kinnship/route_diagnostics_v1 — every notification-tap
 *      routing decision (src: routeDiagnostics.ts). Used to diagnose
 *      "tapped SOS alert went to dashboard" reports.
 *
 * The screen is intentionally minimal — beta testers tap "Copy Log"
 * and paste into a support email. There is no parsing, no chart, no
 * search; the goal is to extract the raw payload reliably.
 *
 * Linked from Settings → "Diagnostics" (Beta) row. Safe to keep in
 * production — both logs cap themselves and are rolling buffers.
 */
import { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import { readRouteLog, clearRouteLog, RouteDiagEntry } from '../src/routeDiagnostics';
import { useAuth } from '../src/AuthContext';

const AUTH_CLEAR_KEY = 'kc_auth_clear_diag';

type AuthClearEntry = {
  t: number;
  source?: string;
  status?: number;
  body?: string | null;
  url?: string | null;
  cachedUserId?: string | null;
};

async function readAuthClearLog(): Promise<AuthClearEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(AUTH_CLEAR_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_e) {
    return [];
  }
}

async function clearAuthClearLog(): Promise<void> {
  try { await AsyncStorage.removeItem(AUTH_CLEAR_KEY); } catch (_e) {}
}

function fmt(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch (_e) {
    return String(ts);
  }
}

export default function DiagnosticsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [routeLog, setRouteLog] = useState<RouteDiagEntry[]>([]);
  const [authLog, setAuthLog] = useState<AuthClearEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const [r, a] = await Promise.all([readRouteLog(), readAuthClearLog()]);
    setRouteLog(r);
    setAuthLog(a);
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const buildPayload = useCallback(() => {
    const appVersion =
      (Constants?.expoConfig?.version as string) ||
      (Constants as any)?.manifest?.version ||
      'unknown';
    const runtimeVersion =
      ((Constants?.expoConfig as any)?.runtimeVersion as string) || 'unknown';
    return {
      generatedAt: new Date().toISOString(),
      platform: Platform.OS,
      platformVersion: String(Platform.Version),
      appVersion,
      runtimeVersion,
      user: user ? { id: user.id, email: user.email } : null,
      authClearLog: authLog,
      routeLog,
      counts: {
        authClear: authLog.length,
        route: routeLog.length,
      },
    };
  }, [authLog, routeLog, user]);

  const onCopy = async () => {
    try {
      const payload = buildPayload();
      const json = JSON.stringify(payload, null, 2);
      await Clipboard.setStringAsync(json);
      Alert.alert(
        'Copied',
        `Diagnostic log copied to clipboard (${authLog.length} auth, ${routeLog.length} route entries). Paste it into your support email.`,
      );
    } catch (e: any) {
      Alert.alert('Could not copy', e?.message || 'Try again.');
    }
  };

  const onClear = () => {
    Alert.alert(
      'Clear diagnostic logs?',
      'This removes all auth-clear and route-tap entries from this device. Cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await Promise.all([clearAuthClearLog(), clearRouteLog()]);
            await reload();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="diagnostics-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
          style={styles.backBtn}
          accessibilityLabel="Back"
        >
          <Icon name="arrow-back" size={28} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Diagnostics</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.intro}>
          Beta diagnostics. If support asks, tap <Text style={styles.bold}>Copy Log</Text> and
          paste into your reply. No personal data leaves your phone until you paste.
        </Text>

        <View style={styles.actionRow}>
          <TouchableOpacity
            testID="diagnostics-copy"
            style={styles.primaryBtn}
            onPress={onCopy}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>📋  Copy Log</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="diagnostics-refresh"
            style={styles.secondaryBtn}
            onPress={reload}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>Refresh</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Auth session cleared</Text>
            <Text style={styles.sectionCount}>{authLog.length}</Text>
          </View>
          <Text style={styles.sectionHint}>
            Each entry = one confirmed sign-out after two consecutive 401s from /auth/me. An empty
            list is the healthy state.
          </Text>
          <View style={styles.card}>
            {loading ? (
              <Text style={styles.muted}>Loading…</Text>
            ) : authLog.length === 0 ? (
              <Text style={styles.muted}>No entries. Session has not been force-cleared on this device.</Text>
            ) : (
              authLog
                .slice()
                .reverse()
                .map((e, i) => (
                  <View key={`a-${e.t}-${i}`} style={styles.entry}>
                    <Text style={styles.entryTime}>{fmt(e.t)}</Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>source: </Text>{e.source || '—'}
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>status: </Text>{e.status ?? '—'}
                    </Text>
                    {e.url ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>url: </Text>{e.url}
                      </Text>
                    ) : null}
                    {e.cachedUserId ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>cachedUserId: </Text>{e.cachedUserId}
                      </Text>
                    ) : null}
                    {e.body ? (
                      <Text style={styles.entryBody}>{e.body}</Text>
                    ) : null}
                  </View>
                ))
            )}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Notification routing</Text>
            <Text style={styles.sectionCount}>{routeLog.length}</Text>
          </View>
          <Text style={styles.sectionHint}>
            Each entry = one notification tap or deep link routing decision. Capacity 50,
            oldest rolls off.
          </Text>
          <View style={styles.card}>
            {loading ? (
              <Text style={styles.muted}>Loading…</Text>
            ) : routeLog.length === 0 ? (
              <Text style={styles.muted}>No entries yet. Tap a notification to populate.</Text>
            ) : (
              routeLog
                .slice()
                .reverse()
                .map((e, i) => (
                  <View key={`r-${e.t}-${i}`} style={styles.entry}>
                    <Text style={styles.entryTime}>{fmt(e.t)}</Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>type: </Text>{e.type || '—'}
                      {'  '}
                      <Text style={styles.entryK}>reason: </Text>{e.reason || '—'}
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>loggedIn: </Text>{String(e.loggedIn)}
                      {'  '}
                      <Text style={styles.entryK}>hasPin: </Text>{String(e.hasPin)}
                      {'  '}
                      <Text style={styles.entryK}>pinUnlocked: </Text>{String(e.pinUnlocked)}
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>from: </Text>{e.fromSegment || '—'}
                      {'  '}
                      <Text style={styles.entryK}>→ </Text>{e.toRoute || '—'}
                    </Text>
                    {e.alertId ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>alertId: </Text>{e.alertId}
                      </Text>
                    ) : null}
                  </View>
                ))
            )}
          </View>
        </View>

        <TouchableOpacity
          testID="diagnostics-clear"
          style={styles.dangerBtn}
          onPress={onClear}
          activeOpacity={0.85}
        >
          <Text style={styles.dangerBtnText}>Clear all diagnostic logs</Text>
        </TouchableOpacity>
        <Text style={styles.footer}>
          Logs are stored only on this device and never auto-uploaded.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: Colors.border, backgroundColor: Colors.surface,
  },
  backBtn: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '800', color: Colors.textPrimary, flex: 1, textAlign: 'center' },
  scroll: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 56 },
  intro: {
    fontSize: 13.5, color: Colors.textSecondary, lineHeight: 19, marginBottom: 14,
  },
  bold: { fontWeight: '800', color: Colors.textPrimary },
  actionRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  primaryBtn: {
    flex: 1, height: 48, borderRadius: 12, backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryBtnText: { color: Colors.surface, fontSize: 15, fontWeight: '800' },
  secondaryBtn: {
    paddingHorizontal: 16, height: 48, borderRadius: 12,
    borderWidth: 2, borderColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent',
  },
  secondaryBtnText: { color: Colors.primary, fontSize: 14, fontWeight: '800' },
  section: { marginBottom: 22 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  sectionTitle: {
    fontSize: 13, fontWeight: '800', color: Colors.textTertiary,
    letterSpacing: 0.6, textTransform: 'uppercase',
  },
  sectionCount: {
    fontSize: 12, fontWeight: '800', color: Colors.primary,
    backgroundColor: Colors.tertiary, paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 8, minWidth: 26, textAlign: 'center',
  },
  sectionHint: { fontSize: 12, color: Colors.textTertiary, marginBottom: 8, lineHeight: 17 },
  card: {
    backgroundColor: Colors.surface, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, padding: 12, gap: 12,
  },
  muted: { fontSize: 13, color: Colors.textTertiary, fontStyle: 'italic', textAlign: 'center', paddingVertical: 8 },
  entry: {
    paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  entryTime: { fontSize: 12, fontWeight: '800', color: Colors.textPrimary, marginBottom: 4 },
  entryLine: { fontSize: 12.5, color: Colors.textSecondary, lineHeight: 17 },
  entryK: { color: Colors.textTertiary, fontWeight: '700' },
  entryBody: {
    fontSize: 11.5, color: Colors.textTertiary, marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  dangerBtn: {
    marginTop: 8, height: 46, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.error,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent',
  },
  dangerBtnText: { color: Colors.error, fontSize: 14, fontWeight: '700' },
  footer: {
    fontSize: 11.5, color: Colors.textTertiary, textAlign: 'center',
    marginTop: 14, lineHeight: 16,
  },
});
