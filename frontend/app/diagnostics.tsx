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
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
import {
  subscribeLiveState,
  readLiveStateSync,
  getPhases,
  getSamples,
  getEvents,
  clearAllFallLogs,
  armSampleCapture,
} from '../src/fallTelemetry';
import { getNotificationLog, clearNotificationLog } from '../src/notificationLog';
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
    // expo-updates exposes the running update's identity, channel
    // subscription, and an `isEmbeddedLaunch` flag — together these
    // let a tester confirm a freshly-published OTA actually replaced
    // the previously-running bundle on their device.  All fields are
    // safe-defaults to '—' if expo-updates hasn't initialized yet
    // (e.g. on Expo Go or web preview).
    const otaInfo = {
      updateId: (Updates as any)?.updateId || null,
      channel: (Updates as any)?.channel || null,
      createdAt:
        (Updates as any)?.createdAt
          ? new Date((Updates as any).createdAt).toISOString()
          : null,
      isEmbeddedLaunch: (Updates as any)?.isEmbeddedLaunch ?? null,
      runtimeVersion: (Updates as any)?.runtimeVersion || runtimeVersion,
    };
    return {
      generatedAt: new Date().toISOString(),
      platform: Platform.OS,
      platformVersion: String(Platform.Version),
      appVersion,
      runtimeVersion,
      ota: otaInfo,
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

  const onCheckForUpdate = useCallback(async () => {
    // Force the device to query Expo for a newer bundle on the
    // currently-subscribed channel.  If found, downloads it and
    // applies it on the NEXT app launch (or immediately if the user
    // taps "Reload").  Web preview / dev builds always return
    // isAvailable=false, so we silently no-op in that case.
    if (Platform.OS === 'web') {
      Alert.alert('Not available', 'OTA updates can only be checked on a native build.');
      return;
    }
    try {
      const r = await Updates.checkForUpdateAsync();
      if (r?.isAvailable) {
        const fetchRes = await Updates.fetchUpdateAsync();
        Alert.alert(
          'Update downloaded',
          fetchRes?.isNew
            ? 'A new bundle was downloaded. Tap Reload to apply it now, or it will activate on the next app launch.'
            : 'Up to date — no newer bundle found.',
          [
            { text: 'Later', style: 'cancel' },
            ...(fetchRes?.isNew
              ? [{ text: 'Reload now', onPress: () => Updates.reloadAsync().catch(() => {}) }]
              : []),
          ],
        );
      } else {
        Alert.alert('Up to date', 'No newer bundle is available on this channel.');
      }
    } catch (e: any) {
      Alert.alert('Update check failed', e?.message || 'Try again in a minute.');
    }
  }, []);

  // v1.3.3 — Refresh trace (server-side), Notification log,
  // Fall live state + persisted ring buffers.
  const [refreshTraces, setRefreshTraces] = useState<any[]>([]);
  const [notifLog, setNotifLog] = useState<any[]>([]);
  const [fallLive, setFallLive] = useState<any>(readLiveStateSync());
  const [fallPhases, setFallPhases] = useState<any[]>([]);
  const [fallSamples, setFallSamples] = useState<any[]>([]);
  const [fallEvents, setFallEvents] = useState<any[]>([]);
  const [captureArmed, setCaptureArmed] = useState(false);
  const [captureUntil, setCaptureUntil] = useState<number | null>(null);

  useEffect(() => subscribeLiveState(setFallLive), []);

  const refreshFallTelemetry = useCallback(async () => {
    const [p, s, e] = await Promise.all([getPhases(), getSamples(), getEvents()]);
    setFallPhases(p);
    setFallSamples(s);
    setFallEvents(e);
  }, []);

  const refreshNotifLog = useCallback(async () => {
    const arr = await getNotificationLog();
    setNotifLog(arr);
  }, []);

  const refreshTraceData = useCallback(async () => {
    try {
      const r = await api.get('/diagnostics/refresh-traces?limit=20');
      setRefreshTraces(r?.data?.traces || []);
    } catch (_e) {
      setRefreshTraces([]);
    }
  }, []);

  useEffect(() => {
    refreshFallTelemetry();
    refreshNotifLog();
    refreshTraceData();
    // Live tick — live phase/sample-count update every 500 ms.
    const tick = setInterval(() => {
      setFallLive(readLiveStateSync());
    }, 500);
    return () => clearInterval(tick);
  }, [refreshFallTelemetry, refreshNotifLog, refreshTraceData]);

  const onArmCapture = useCallback(() => {
    armSampleCapture(30_000);
    setCaptureArmed(true);
    setCaptureUntil(Date.now() + 30_000);
    setTimeout(() => {
      setCaptureArmed(false);
      setCaptureUntil(null);
      refreshFallTelemetry();
    }, 30_500);
  }, [refreshFallTelemetry]);

  const onClearFallLogs = useCallback(async () => {
    await clearAllFallLogs();
    refreshFallTelemetry();
  }, [refreshFallTelemetry]);

  const onClearNotifLog = useCallback(async () => {
    await clearNotificationLog();
    refreshNotifLog();
  }, [refreshNotifLog]);

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

        {/*
          v1.3.2 — Build / OTA info section.
          Shows the EXACT bundle the device is running so we can
          confirm whether a freshly-published OTA actually replaced
          the previous bundle.  Without this, a "still on v1.3.1"
          report is impossible to disambiguate between
          (A) OTA not delivered (channel/runtime mismatch),
          (B) device cached old bundle (needs hard relaunch), or
          (C) bundle delivered but the source code was never bumped.
        */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Build / OTA info</Text>
          </View>
          <View style={styles.card} testID="diagnostics-build-info">
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>app version: </Text>
              {(Constants?.expoConfig?.version as string) || 'unknown'}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>runtime: </Text>
              {(Updates as any)?.runtimeVersion ||
                ((Constants?.expoConfig as any)?.runtimeVersion as string) ||
                'unknown'}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>channel: </Text>
              {(Updates as any)?.channel || '— (Expo Go / dev)'}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>update id: </Text>
              <Text testID="diagnostics-update-id" selectable>
                {(Updates as any)?.updateId || '— (embedded bundle)'}
              </Text>
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>published at: </Text>
              {(Updates as any)?.createdAt
                ? new Date((Updates as any).createdAt).toLocaleString()
                : '—'}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>source: </Text>
              {(Updates as any)?.isEmbeddedLaunch === true
                ? 'EMBEDDED (app store build — no OTA applied yet)'
                : (Updates as any)?.isEmbeddedLaunch === false
                ? 'OTA UPDATE (over-the-air bundle is active)'
                : '— (unavailable)'}
            </Text>
            <TouchableOpacity
              testID="diagnostics-check-update"
              style={[styles.secondaryBtn, { marginTop: 12 }]}
              onPress={onCheckForUpdate}
              activeOpacity={0.85}
            >
              <Text style={styles.secondaryBtnText}>Check for OTA update now</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* =====================================================
            v1.3.3 — Fall Detection live + persistent telemetry.
            ===================================================== */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Fall Detection · live</Text>
          </View>
          <Text style={styles.sectionHint}>
            Proves the multi-signal state machine is alive and receiving sensor events.
            If "subscribed" is blank or "accelerometer" is unavailable, the detector
            is NOT running and no real fall will ever fire — see Settings → Fall
            Detection.
          </Text>
          <View style={styles.card} testID="diagnostics-fall-live">
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>enabled: </Text>{String(fallLive.enabled)}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>accelerometer: </Text>{String(fallLive.available)}
              {'   '}
              <Text style={styles.entryK}>gyroscope: </Text>{String(fallLive.gyroAvailable)}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>current phase: </Text>{fallLive.phase}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>AppState: </Text>{fallLive.appState}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>samples observed: </Text>{fallLive.sampleCount}
              {'   '}
              <Text style={styles.entryK}>last mag: </Text>{(fallLive.lastMag || 0).toFixed(2)} g
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>peak (last 5 s): </Text>{(fallLive.peakMag5s || 0).toFixed(2)} g
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>subscribed at: </Text>
              {fallLive.subscribedAt ? fmt(new Date(fallLive.subscribedAt).toISOString()) : '— never'}
            </Text>
          </View>
          <View style={styles.actionRow}>
            <TouchableOpacity
              testID="diagnostics-fall-arm"
              style={styles.primaryBtn}
              onPress={onArmCapture}
              disabled={captureArmed}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>
                {captureArmed
                  ? `⏱ Capturing… (${Math.max(0, Math.round(((captureUntil || 0) - Date.now()) / 1000))} s)`
                  : '⏱ Arm 30 s sample capture'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="diagnostics-fall-clear"
              style={styles.secondaryBtn}
              onPress={onClearFallLogs}
              activeOpacity={0.85}
            >
              <Text style={styles.secondaryBtnText}>Clear fall logs</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.sectionHint}>
            Tap "Arm" then throw the phone within 30 s — every accelerometer sample
            during the window is logged below.  Without arming, only phase
            transitions are persisted (to save battery).
          </Text>

          {/* Phase transitions */}
          <Text style={styles.subSectionLabel}>Phase transitions (last 20)</Text>
          <View style={styles.card}>
            {fallPhases.length === 0 ? (
              <Text style={styles.muted}>— no transitions recorded.</Text>
            ) : fallPhases.slice(0, 20).map((p, i) => (
              <Text key={i} style={styles.entryLine}>
                <Text style={styles.entryK}>{fmt(new Date(p.at).toISOString())}: </Text>
                {p.phase}
              </Text>
            ))}
          </View>

          {/* Lifecycle events */}
          <Text style={styles.subSectionLabel}>Events (last 20)</Text>
          <View style={styles.card}>
            {fallEvents.length === 0 ? (
              <Text style={styles.muted}>— no events recorded.</Text>
            ) : fallEvents.slice(0, 20).map((e, i) => (
              <Text key={i} style={styles.entryLine}>
                <Text style={styles.entryK}>{fmt(new Date(e.at).toISOString())}: </Text>
                {e.kind}{e.detail ? ` (${e.detail})` : ''}
              </Text>
            ))}
          </View>

          {/* Captured sensor samples (only populated during armed capture) */}
          <Text style={styles.subSectionLabel}>Captured samples (last 30)</Text>
          <View style={styles.card}>
            {fallSamples.length === 0 ? (
              <Text style={styles.muted}>— no samples captured. Tap Arm and throw the phone.</Text>
            ) : fallSamples.slice(0, 30).map((s, i) => (
              <Text key={i} style={styles.entryLine}>
                <Text style={styles.entryK}>{fmt(new Date(s.at).toISOString())}: </Text>
                {s.mag.toFixed(2)} g  ({s.x.toFixed(2)}, {s.y.toFixed(2)}, {s.z.toFixed(2)})
              </Text>
            ))}
          </View>
        </View>

        {/* =====================================================
            v1.3.3 — Notifications received (sound-leak diagnostic).
            ===================================================== */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Notifications received</Text>
            <TouchableOpacity onPress={onClearNotifLog} style={styles.secondaryBtnSmall}>
              <Text style={styles.secondaryBtnText}>Clear</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.sectionHint}>
            Every push observed by this device — for diagnosing intermittent silent-
            push sound leaks.  If a notification with `channelId: silent_v2` ever
            shows `sound: "default"`, that's the leak source.
          </Text>
          <View style={styles.card} testID="diagnostics-notif-log">
            {notifLog.length === 0 ? (
              <Text style={styles.muted}>— no notifications observed yet.</Text>
            ) : notifLog.slice(0, 20).map((n, i) => (
              <View key={i} style={{ marginBottom: 8 }}>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>{fmt(new Date(n.at).toISOString())} </Text>
                  ({n.source})
                </Text>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>channel: </Text>{n.channelId ?? '—'}
                  {'   '}
                  <Text style={styles.entryK}>sound: </Text>
                  <Text style={n.sound && n.sound !== '' ? styles.divergent : undefined}>
                    {String(n.sound)}
                  </Text>
                </Text>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>priority: </Text>{n.priority ?? '—'}
                  {'   '}
                  <Text style={styles.entryK}>vibrate: </Text>{String(n.vibrate)}
                </Text>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>type: </Text>{n.type ?? '—'}
                  {'   '}
                  <Text style={styles.entryK}>requestId: </Text>{n.requestId ?? '—'}
                </Text>
                {n.title || n.body ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>title: </Text>{n.title || '(empty)'}
                    {n.body ? `  · body: ${n.body}` : ''}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        </View>

        {/* =====================================================
            v1.3.3 — Refresh trace (server-side).
            ===================================================== */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Refresh traces (server)</Text>
            <TouchableOpacity onPress={refreshTraceData} style={styles.secondaryBtnSmall}>
              <Text style={styles.secondaryBtnText}>Refresh</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.sectionHint}>
            End-to-end latency for each refresh.  Columns: when requested, time to
            push send, time to GPS upload received.  Reveals whether a slow refresh
            is the server, FCM, or the device's GPS warmup.
          </Text>
          <View style={styles.card} testID="diagnostics-refresh-traces">
            {refreshTraces.length === 0 ? (
              <Text style={styles.muted}>— no traces yet. Tap Refresh on the dashboard, then come back.</Text>
            ) : refreshTraces.slice(0, 20).map((t, i) => (
              <View key={i} style={{ marginBottom: 8 }}>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>{fmt(new Date(t.requested_at).toISOString())} </Text>
                  member <Text style={styles.entryK}>{t.member_id?.slice(0, 8)}</Text>
                </Text>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>push sent +</Text>
                  {t.push_sent_after_ms != null ? `${t.push_sent_after_ms} ms` : '— (skipped)'}
                  {'   '}
                  <Text style={styles.entryK}>gps received +</Text>
                  {t.gps_received_after_ms != null ? `${t.gps_received_after_ms} ms` : '—'}
                </Text>
                {t.push_skipped_reason ? (
                  <Text style={[styles.entryLine, styles.divergent]}>
                    skipped: {t.push_skipped_reason}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        </View>

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
  secondaryBtnSmall: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: Colors.primary, backgroundColor: 'transparent',
  },
  subSectionLabel: {
    fontSize: 11, fontWeight: '800', color: Colors.textSecondary,
    letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 12, marginBottom: 4,
  },
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
