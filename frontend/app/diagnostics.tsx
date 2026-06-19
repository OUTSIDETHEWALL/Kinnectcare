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
import { readLocationRefreshLog, clearLocationRefreshLog, LocationRefreshEntry } from '../src/locationRefresh';
import { readBgTaskLog, clearBgTaskLog, BgTaskLogEntry } from '../src/backgroundLocation';
import { readScreenRenderLog, clearScreenRenderLog, ScreenRenderEntry } from '../src/screenRenderLog';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';

const AUTH_CLEAR_KEY = 'kc_auth_clear_diag';
const PUSH_REFRESH_KEY = 'kc_push_refresh_log';

type AuthClearEntry = {
  t: number;
  source?: string;
  status?: number;
  body?: string | null;
  url?: string | null;
  cachedUserId?: string | null;
};

type PushRefreshEntry = {
  t: number;
  reason?: string;
  rotated?: boolean;
  wrote?: boolean;
  tokenSuffix?: string;
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

async function readPushRefreshLog(): Promise<PushRefreshEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(PUSH_REFRESH_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_e) {
    return [];
  }
}

async function clearPushRefreshLog(): Promise<void> {
  try { await AsyncStorage.removeItem(PUSH_REFRESH_KEY); } catch (_e) {}
}

function fmt(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch (_e) {
    return String(ts);
  }
}

function roundCoordDisp(x: number): number {
  return Math.round(x * 100) / 100;
}

export default function DiagnosticsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [routeLog, setRouteLog] = useState<RouteDiagEntry[]>([]);
  const [authLog, setAuthLog] = useState<AuthClearEntry[]>([]);
  const [pushLog, setPushLog] = useState<PushRefreshEntry[]>([]);
  const [locLog, setLocLog] = useState<LocationRefreshEntry[]>([]);
  const [bgLog, setBgLog] = useState<BgTaskLogEntry[]>([]);
  const [renderLog, setRenderLog] = useState<ScreenRenderEntry[]>([]);
  const [serverState, setServerState] = useState<any>(null);
  const [serverStateLoading, setServerStateLoading] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const [r, a, p, l, b, sr] = await Promise.all([
      readRouteLog(),
      readAuthClearLog(),
      readPushRefreshLog(),
      readLocationRefreshLog(),
      readBgTaskLog(),
      readScreenRenderLog(),
    ]);
    setRouteLog(r);
    setAuthLog(a);
    setPushLog(p);
    setLocLog(l);
    setBgLog(b);
    setRenderLog(sr);
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const fetchServerState = useCallback(async () => {
    setServerStateLoading(true);
    try {
      const r = await api.get('/diagnostics/my-members');
      setServerState({ at: Date.now(), data: r.data, err: null });
    } catch (e: any) {
      setServerState({
        at: Date.now(),
        data: null,
        err: e?.response?.status ? `http_${e.response.status}` : (e?.message || 'unknown'),
      });
    } finally {
      setServerStateLoading(false);
    }
  }, []);

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
      pushRefreshLog: pushLog,
      locationRefreshLog: locLog,
      backgroundLocationTaskLog: bgLog,
      screenRenderLog: renderLog,
      serverState,
      counts: {
        authClear: authLog.length,
        route: routeLog.length,
        pushRefresh: pushLog.length,
        locationRefresh: locLog.length,
        bgTask: bgLog.length,
        screenRender: renderLog.length,
      },
    };
  }, [authLog, routeLog, pushLog, locLog, bgLog, renderLog, serverState, user]);

  const onCopy = async () => {
    try {
      const payload = buildPayload();
      const json = JSON.stringify(payload, null, 2);
      await Clipboard.setStringAsync(json);
      Alert.alert(
        'Copied',
        `Diagnostic log copied (${authLog.length} auth, ${routeLog.length} route, ${pushLog.length} push, ${locLog.length} loc, ${bgLog.length} bg, ${renderLog.length} render entries).`,
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
            await Promise.all([clearAuthClearLog(), clearRouteLog(), clearPushRefreshLog(), clearLocationRefreshLog(), clearBgTaskLog(), clearScreenRenderLog()]);
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
            <Text style={styles.sectionTitle}>Server state (my member rows)</Text>
            <Text style={styles.sectionCount}>
              {serverState?.data ? serverState.data.match_count ?? 0 : '—'}
            </Text>
          </View>
          <Text style={styles.sectionHint}>
            Fetches every member row where user_id = me, across ALL family_groups. Reveals
            duplicate rows or cross-group ghosts that could explain write-vs-read drift.
            More than 1 row in your current family group is a smoking gun.
          </Text>
          <TouchableOpacity
            testID="diagnostics-server-state"
            style={styles.secondaryBtn}
            onPress={fetchServerState}
            disabled={serverStateLoading}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>
              {serverStateLoading ? 'Fetching…' : (serverState ? 'Refetch from server' : 'Fetch from server')}
            </Text>
          </TouchableOpacity>
          {serverState ? (
            <View style={[styles.card, { marginTop: 10 }]}>
              {serverState.err ? (
                <Text style={styles.muted}>err: {serverState.err}</Text>
              ) : serverState.data ? (
                <>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>fetched at: </Text>{fmt(serverState.at)}
                  </Text>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>match_count: </Text>{serverState.data.match_count}
                    {'  '}
                    <Text style={styles.entryK}>dupes_in_group: </Text>
                    <Text style={serverState.data.duplicates_in_current_group > 1 ? styles.divergent : undefined}>
                      {serverState.data.duplicates_in_current_group}
                      {serverState.data.duplicates_in_current_group > 1 ? '  ⚠' : ''}
                    </Text>
                  </Text>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>current fg: </Text>
                    {serverState.data.current_family_group_id?.slice(-6) || '—'}
                  </Text>
                  {(serverState.data.members || []).map((m: any, i: number) => (
                    <View key={`srv-${m.id}-${i}`} style={styles.entry}>
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>id: </Text>{m.id?.slice(-6)}
                        {'  '}
                        <Text style={styles.entryK}>fg: </Text>{m.family_group_id?.slice(-6)}
                        {m.family_group_id !== serverState.data.current_family_group_id
                          ? <Text style={styles.divergent}>  ⚠ ghost</Text>
                          : null}
                      </Text>
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>name: </Text>{m.name || '—'}
                        {'  '}
                        <Text style={styles.entryK}>role: </Text>{m.role || '—'}
                      </Text>
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>coord: </Text>
                        {typeof m.latitude === 'number' ? roundCoordDisp(m.latitude) : '—'},
                        {' '}
                        {typeof m.longitude === 'number' ? roundCoordDisp(m.longitude) : '—'}
                      </Text>
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>last_seen: </Text>
                        {m.last_seen ? new Date(m.last_seen).toLocaleString() : '—'}
                      </Text>
                    </View>
                  ))}
                </>
              ) : (
                <Text style={styles.muted}>No data.</Text>
              )}
            </View>
          ) : null}
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
            <Text style={styles.sectionTitle}>Location refresh</Text>
            <Text style={styles.sectionCount}>{locLog.length}</Text>
          </View>
          <Text style={styles.sectionHint}>
            Each entry = one foreground GPS upload to /members/{'{id}'}/location.
            Auto-fires on app foreground (throttled to once per 60 s). `ok: true` =
            backend accepted the write. Coords are coarse-rounded for privacy.
          </Text>
          <View style={styles.card}>
            {loading ? (
              <Text style={styles.muted}>Loading…</Text>
            ) : locLog.length === 0 ? (
              <Text style={styles.muted}>No location refreshes yet. The next foreground transition will populate.</Text>
            ) : (
              locLog
                .slice()
                .reverse()
                .map((e, i) => (
                  <View key={`l-${e.t}-${i}`} style={styles.entry}>
                    <Text style={styles.entryTime}>{fmt(e.t)}</Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>reason: </Text>{e.reason || '—'}
                      {'  '}
                      <Text style={styles.entryK}>ok: </Text>{String(!!e.ok)}
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>coord ~ </Text>
                      {e.latApprox !== null && e.lonApprox !== null
                        ? `${e.latApprox}, ${e.lonApprox}`
                        : '—'}
                    </Text>
                    {e.memberId || e.bgMemberId || e.userId ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>uid: </Text>{e.userId ? e.userId.slice(-6) : '—'}
                        {'  '}
                        <Text style={styles.entryK}>fg.mid: </Text>{e.memberId ? e.memberId.slice(-6) : '—'}
                        {'  '}
                        <Text style={styles.entryK}>bg.mid: </Text>{e.bgMemberId ? e.bgMemberId.slice(-6) : '—'}
                        {e.divergent ? <Text style={styles.divergent}>  ⚠ DIVERGENT</Text> : null}
                      </Text>
                    ) : null}
                    {e.err ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>err: </Text>{e.err}
                      </Text>
                    ) : null}
                  </View>
                ))
            )}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Read-path render trace</Text>
            <Text style={styles.sectionCount}>{renderLog.length}</Text>
          </View>
          <Text style={styles.sectionHint}>
            Every dashboard/member fetch (`*-fetch`), every MemberMap prop change
            (`map-props`), every WebView marker-painted confirmation (`map-rendered`).
            Compare the lat/lon across the three for the same member to isolate
            (A) map didn't render fresh, (B) fetch returned stale, (C) state never updated.
          </Text>
          <View style={styles.card}>
            {loading ? (
              <Text style={styles.muted}>Loading…</Text>
            ) : renderLog.length === 0 ? (
              <Text style={styles.muted}>No render events yet. Visit Dashboard or a member detail screen.</Text>
            ) : (
              renderLog
                .slice(-25)
                .reverse()
                .map((e, i) => (
                  <View key={`sr-${e.t}-${i}`} style={styles.entry}>
                    <Text style={styles.entryTime}>{fmt(e.t)}</Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>src: </Text>{e.src}
                      {e.memberId ? (
                        <>
                          {'  '}
                          <Text style={styles.entryK}>mid: </Text>{e.memberId.slice(-6)}
                        </>
                      ) : null}
                      {typeof e.memberCount === 'number' ? (
                        <>
                          {'  '}
                          <Text style={styles.entryK}>members: </Text>{e.memberCount}
                        </>
                      ) : null}
                      {typeof e.renderLatencyMs === 'number' ? (
                        <>
                          {'  '}
                          <Text style={styles.entryK}>latency: </Text>{e.renderLatencyMs}ms
                        </>
                      ) : null}
                    </Text>
                    {(typeof e.lat === 'number' || typeof e.lon === 'number') ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>coord: </Text>
                        {typeof e.lat === 'number' ? e.lat : '—'}, {typeof e.lon === 'number' ? e.lon : '—'}
                      </Text>
                    ) : null}
                    {e.locationName ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>name: </Text>{e.locationName}
                      </Text>
                    ) : null}
                    {e.lastSeen ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>last_seen: </Text>{new Date(e.lastSeen).toLocaleString()}
                      </Text>
                    ) : null}
                  </View>
                ))
            )}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Background location task</Text>
            <Text style={styles.sectionCount}>{bgLog.length}</Text>
          </View>
          <Text style={styles.sectionHint}>
            Each entry = one OS wake of the background location task. Empty / sparse =
            Android Doze or iOS deferred-update gating is suppressing wakeups. Frequent
            `upload-fail` = network or auth issue. `lock-held` = previous upload hung.
            `ageS` = how stale the GPS fix was when the OS handed it to us (large value
            = OS batched many points before waking).
          </Text>
          <View style={styles.card}>
            {loading ? (
              <Text style={styles.muted}>Loading…</Text>
            ) : bgLog.length === 0 ? (
              <Text style={styles.muted}>
                No background task wakes recorded yet. Either the task hasn't fired since
                this OTA installed, or the OS is suppressing wakeups. Walk &gt;100 m or
                wait 5+ min to test.
              </Text>
            ) : (
              bgLog
                .slice()
                .reverse()
                .map((e, i) => (
                  <View key={`b-${e.t}-${i}`} style={styles.entry}>
                    <Text style={styles.entryTime}>{fmt(e.t)}</Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>phase: </Text>{e.phase}
                      {typeof e.count === 'number' ? (
                        <>
                          {'  '}
                          <Text style={styles.entryK}>locs: </Text>{e.count}
                        </>
                      ) : null}
                      {typeof e.ageS === 'number' ? (
                        <>
                          {'  '}
                          <Text style={styles.entryK}>ageS: </Text>{e.ageS}
                        </>
                      ) : null}
                    </Text>
                    {typeof e.latApprox === 'number' && typeof e.lonApprox === 'number' ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>coord ~ </Text>
                        {e.latApprox}, {e.lonApprox}
                      </Text>
                    ) : null}
                    {e.memberId || e.fgMemberId || e.userId ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>uid: </Text>{e.userId ? e.userId.slice(-6) : '—'}
                        {'  '}
                        <Text style={styles.entryK}>bg.mid: </Text>{e.memberId ? e.memberId.slice(-6) : '—'}
                        {'  '}
                        <Text style={styles.entryK}>fg.mid: </Text>{e.fgMemberId ? e.fgMemberId.slice(-6) : '—'}
                        {e.divergent ? <Text style={styles.divergent}>  ⚠ DIVERGENT</Text> : null}
                      </Text>
                    ) : null}
                    {e.err ? (
                      <Text style={styles.entryLine}>
                        <Text style={styles.entryK}>err: </Text>{e.err}
                      </Text>
                    ) : null}
                  </View>
                ))
            )}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Push token refresh</Text>
            <Text style={styles.sectionCount}>{pushLog.length}</Text>
          </View>
          <Text style={styles.sectionHint}>
            Each entry = one foreground refresh attempt. Auto-fires on app foreground
            (throttled to once per 30 min). `wrote: false` = token unchanged, no backend
            write needed. `rotated: true` = Expo issued a new token and we synced it.
          </Text>
          <View style={styles.card}>
            {loading ? (
              <Text style={styles.muted}>Loading…</Text>
            ) : pushLog.length === 0 ? (
              <Text style={styles.muted}>No refreshes yet on this session. The next foreground transition will populate.</Text>
            ) : (
              pushLog
                .slice()
                .reverse()
                .map((e, i) => (
                  <View key={`p-${e.t}-${i}`} style={styles.entry}>
                    <Text style={styles.entryTime}>{fmt(e.t)}</Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>reason: </Text>{e.reason || '—'}
                      {'  '}
                      <Text style={styles.entryK}>rotated: </Text>{String(!!e.rotated)}
                      {'  '}
                      <Text style={styles.entryK}>wrote: </Text>{String(!!e.wrote)}
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>token: </Text>…{e.tokenSuffix || '—'}
                    </Text>
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
  divergent: { color: Colors.error, fontWeight: '800' },
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
