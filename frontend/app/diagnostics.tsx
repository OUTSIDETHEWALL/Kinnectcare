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
import { useEffect, useState, useCallback, useRef, useMemo, ReactNode } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
import { getNotificationLog, clearNotificationLog } from '../src/notificationLog';
import { Icon } from '../src/Icon';
import { Colors } from '../src/theme';
import { readRouteLog, clearRouteLog, RouteDiagEntry } from '../src/routeDiagnostics';
import { readLocationRefreshLog, clearLocationRefreshLog, LocationRefreshEntry } from '../src/locationRefresh';
import { readBgTaskLog, clearBgTaskLog, BgTaskLogEntry } from '../src/backgroundLocation';
import {
  readBatteryTaskLog,
  clearBatteryTaskLog,
  BatteryTaskLogEntry,
} from '../src/batteryTask';
import { readScreenRenderLog, clearScreenRenderLog, ScreenRenderEntry } from '../src/screenRenderLog';
import {
  getDashboardLoadLog,
  clearDashboardLoadLog,
  DashboardLoadEntry,
} from '../src/dashboardLoadLog';
import {
  getCardRenderLog,
  clearCardRenderLog,
  CardRenderEntry,
} from '../src/cardRenderLog';
import {
  getRefreshPipelineLog,
  clearRefreshPipelineLog,
  PipelineEntry,
} from '../src/refreshPipelineLog';
import {
  getEngineDiagnostics,
  clearEngineLog,
  EngineLogEvent,
  LocationEngineState,
  getPipelineTimestamps,
  getLastHttpSuccessTs,
  isListenersAttached,
  PipelineTimestamps,
  triggerDeviceSnapshotNow,
  checkBatteryOptimization,
  requestShowIgnoreBatteryOptimizations,
  requestShowPowerManager,
  showDeviceSettingsScreen,
  DeviceSettingsRequest,
  logEvent,
} from '../src/locationEngine';
import * as memberStore from '../src/store/memberStore';
import * as leonidas from '../src/leonidas';
import * as Battery from 'expo-battery';
import { PATROL_INTERVAL_SECONDS } from '../src/leonidas/types';
import { DIAG_BUFFER_SIZES, pruneBuffer } from '../src/diagBufferConfig';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';
import { getRestrictionStatus, RestrictionStatus } from '../src/backgroundRestrictionDetector';
import { BackgroundRestrictionWarning } from '../src/components/BackgroundRestrictionWarning';
import {
  HealthStatus,
  HealthItem,
  healthIcon,
  formatAgeMs,
  computeHealthItems,
  computeOverallHealth,
  heroTheme,
  OverallHealthResult,
  OverallHealthLevel,
} from '../src/healthCheck';
import { startDeviceComparisonRefresh } from '../src/deviceComparisonRefresh';
import {
  ageCellColor,
  computeSnapshotElapsedMs,
  effectiveSnapshotAgeMs as computeEffectiveSnapshotAgeMs,
  httpOkCellColor,
} from '../src/deviceComparisonUtils';

const AUTH_CLEAR_KEY = 'kc_auth_clear_diag';
const PUSH_REFRESH_KEY = 'kc_push_refresh_log';
const EXPANSION_STATE_KEY = '@kinnship/diagnostics_expanded_v1';

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
    const arr: AuthClearEntry[] = raw ? JSON.parse(raw) : [];
    // Build 46: prune-on-read (size + age) so the auth-clear log
    // honors the same diagnostics budget as the in-process buffers.
    return pruneBuffer(arr, (e) => e.t, DIAG_BUFFER_SIZES.authClear);
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

// ===========================================================
//  Leonidas — pretty-formatters for the Last Decision summary
// ===========================================================
/**
 * Translate the Leonidas event + state + reason triple into a single
 * caregiver-grade sentence for the Last Decision field.  Build 46
 * intentionally keeps this human-friendly: "No Action — Stationary
 * within expected upload window" is more useful at a glance than
 * "standing-guard + null".
 */
function formatLeonidasDecision(
  event: string | null,
  state: string | null,
  reason: string | null,
  action: string | null,
): string {
  if (!event) return '— no patrol yet';
  if (event === 'patrol-tick') {
    if (state === 'standing-guard') return 'No Action — Healthy';
    if (state === 'watching') return 'No Action — Stationary within expected upload window';
    if (state === 'unknown') return 'No Action — Awaiting first upload';
    return `No Action — ${state}`;
  }
  if (event === 'state-change') return `State changed → ${state}`;
  if (event === 'recovery-invoked') {
    if (action === 'request-fresh-location') return `Requested Fresh Location — ${reason ?? state}`;
    if (action === 'restart-engine') return `Restart Engine — ${reason ?? state}`;
    if (action === 'restart-engine+request-fresh-location')
      return `Restart + Fresh Fix — ${reason ?? state}`;
    return `Invoked ${action ?? 'recovery'} — ${reason ?? state}`;
  }
  if (event === 'recovery-succeeded') return `Recovery Successful (${action ?? 'recovery'})`;
  if (event === 'recovery-failed') return `Recovery Failed (${action ?? 'recovery'})`;
  if (event === 'engine-restart-attempted') return 'Engine restart attempted';
  if (event === 'engine-restart-succeeded') return 'Restart Deferred — Waiting for next patrol';
  if (event === 'engine-restart-failed') return 'Engine restart failed';
  if (event === 'patrol-started') return 'Patrol started';
  if (event === 'patrol-stopped') return 'Patrol stopped';
  return event;
}

// ===========================================================
//  Motion Timeline helpers — Build 64.
//
//  Filters the engine ring buffer to show only motion-relevant
//  events in strict chronological order so Charles and Joyce's
//  phone behaviour can be compared side-by-side during the same
//  trip.  Oldest-first so the sequence reads top → bottom.
// ===========================================================

const MOTION_EVENT_SET = new Set([
  'sdk_onActivityChange',
  'sdk_onMotionChange',
  'sdk_onHeartbeat',
  'heartbeat_getCurrentPosition_ok',
  'heartbeat_getCurrentPosition_error',
  'sdk_onLocation',
  'sdk_onHttp',
  'sdk_onPowerSaveChange',
  'sdk_onEnabledChange',
  'headless_task_invoked',
  'headless_heartbeat_ok',
  'headless_heartbeat_error',
  'started_ok',
  'requestFreshLocation_ok',
  'requestFreshLocation_error',
  'sdk_config_snapshot',
]);

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch (_e) { return String(ts); }
}

type MotionFmt = { badge: string; badgeColor: string; label: string; detail: string | null };

function formatMotionEvent(entry: EngineLogEvent): MotionFmt {
  const d = entry.detail ?? {};
  switch (entry.event) {
    case 'sdk_onActivityChange': {
      const act = String(d.activity ?? '—').toUpperCase().replace(/_/g, ' ');
      const conf = d.confidence != null ? `${d.confidence}%` : '—';
      return {
        badge: 'ACTIVITY', badgeColor: '#3B82F6',
        label: `${act}  conf=${conf}`,
        detail: `moving=${d.isMoving ? 'YES' : 'NO'}`,
      };
    }
    case 'sdk_onMotionChange':
      return {
        badge: d.isMoving ? '→ MOVING' : '→ STILL',
        badgeColor: d.isMoving ? '#10B981' : '#6B7280',
        label: d.isMoving
          ? 'STATIONARY → MOVING  (SDK transition)'
          : 'MOVING → STATIONARY  (SDK transition)',
        detail: null,
      };
    case 'sdk_onHeartbeat':
      return { badge: 'HEARTBEAT', badgeColor: '#9CA3AF', label: 'SDK heartbeat', detail: null };
    case 'headless_task_invoked':
      return {
        badge: 'HEADLESS', badgeColor: '#9CA3AF',
        label: 'Headless task invoked',
        detail: d.eventName ? `event=${d.eventName}` : null,
      };
    case 'headless_heartbeat_ok':
      return { badge: 'HB ✓', badgeColor: '#9CA3AF', label: 'Headless heartbeat — fix ok', detail: null };
    case 'headless_heartbeat_error':
      return {
        badge: 'HB ✗', badgeColor: '#EF4444',
        label: 'Headless heartbeat — fix FAILED',
        detail: String(d.error ?? ''),
      };
    case 'heartbeat_getCurrentPosition_ok':
      return { badge: 'FIX ✓', badgeColor: '#10B981', label: 'JS heartbeat — GPS fix acquired', detail: null };
    case 'heartbeat_getCurrentPosition_error':
      return {
        badge: 'FIX ✗', badgeColor: '#EF4444',
        label: 'JS heartbeat — GPS fix FAILED',
        detail: String(d.error ?? ''),
      };
    case 'sdk_onLocation':
      return {
        badge: 'LOCATION', badgeColor: '#14B8A6',
        label: `acc=${d.acc ?? '—'}m  speed=${d.speed != null ? `${d.speed}` : '—'}`,
        detail: `event=${d.event ?? '—'}  isMoving=${d.isMoving}`,
      };
    case 'sdk_onHttp':
      return {
        badge: d.success ? 'HTTP ✓' : 'HTTP ✗',
        badgeColor: d.success ? '#10B981' : '#EF4444',
        label: `status=${d.status ?? '—'}`,
        detail: null,
      };
    case 'sdk_onPowerSaveChange':
      return {
        badge: 'POWER', badgeColor: '#F59E0B',
        label: `Battery saver: ${d.isPowerSaveMode ? 'ON ⚠' : 'OFF'}`,
        detail: null,
      };
    case 'sdk_onEnabledChange':
      return {
        badge: 'ENGINE', badgeColor: '#8B5CF6',
        label: `SDK ${d.enabled ? 'enabled' : 'DISABLED'}`,
        detail: null,
      };
    case 'started_ok':
      return {
        badge: 'STARTED', badgeColor: '#8B5CF6',
        label: `Engine started  isMoving=${d.isMoving ?? '—'}`,
        detail: null,
      };
    case 'requestFreshLocation_ok':
      return { badge: 'FRESH ✓', badgeColor: '#14B8A6', label: 'Fresh location request OK', detail: null };
    case 'requestFreshLocation_error':
      return {
        badge: 'FRESH ✗', badgeColor: '#EF4444',
        label: 'Fresh location request FAILED',
        detail: String(d.error ?? ''),
      };
    case 'sdk_config_snapshot':
      return {
        badge: 'CONFIG', badgeColor: '#8B5CF6',
        label: [
          `distFilter=${d.distanceFilter ?? '—'}m`,
          `stationaryR=${d.stationaryRadius ?? '—'}m`,
          `stopTimeout=${d.stopTimeout ?? '—'}min`,
          `heartbeat=${d.heartbeatInterval ?? '—'}s`,
        ].join('  '),
        detail: [
          `activityInterval=${d.activityRecognitionInterval ?? '—'}ms`,
          `minConf=${d.minimumActivityRecognitionConfidence ?? '—'}%`,
          `disableStopDet=${d.disableStopDetection ?? '—'}`,
          `motionTriggerDelay=${d.motionTriggerDelay ?? '—'}`,
          `preventSuspend=${d.preventSuspend ?? '—'}`,
          `autoSync=${d.autoSync ?? '—'}`,
        ].join('  '),
      };
    default:
      return { badge: entry.event.slice(0, 10), badgeColor: '#9CA3AF', label: entry.event, detail: null };
  }
}

// ===========================================================
//  SummaryRow + ageColor — Task 8 summary card helpers.
// ===========================================================

/**
 * Returns a color based on how old the age is.
 *  • null / undefined → gray (no data yet)
 *  • < warnMs         → green (healthy)
 *  • < critMs         → amber (degraded)
 *  • ≥ critMs         → red (stale)
 */
function ageColor(
  ageMs: number | null,
  warnMs: number,
  critMs: number,
): string {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) return '#9CA3AF';
  if (ageMs < warnMs) return '#10B981';
  if (ageMs < critMs) return '#F59E0B';
  return '#EF4444';
}

type SummaryRowProps = {
  label: string;
  value: string;
  valueColor?: string;
  isLast?: boolean;
};

function SummaryRow({ label, value, valueColor = '#111827', isLast = false }: SummaryRowProps) {
  return (
    <View style={[summaryRowStyles.row, isLast && summaryRowStyles.rowLast]}>
      <Text style={summaryRowStyles.label}>{label}</Text>
      <Text style={[summaryRowStyles.value, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

// Defined outside StyleSheet.create because it's only used by SummaryRow.
const summaryRowStyles = {
  row: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  rowLast: { borderBottomWidth: 0 },
  label: { fontSize: 13, color: '#6B7280', fontWeight: '500' as const },
  value: { fontSize: 13, fontWeight: '700' as const },
};

// ===========================================================
//  HealthRow — Task 9 health check panel row renderer.
//  computeHealthItems is imported from src/healthCheck.ts.
// ===========================================================

function HealthRow({ item, isLast = false }: { item: HealthItem; isLast?: boolean }) {
  // 'unknown' items are informational — no data yet, not a failure.
  // Render them muted so they don't compete visually with genuine statuses.
  const labelColor = item.status === 'unknown' ? '#9CA3AF' : '#111827';
  const iconOpacity = item.status === 'unknown' ? 0.55 : 1;
  return (
    <View style={[healthRowStyles.row, isLast && healthRowStyles.rowLast]}>
      <Text style={[healthRowStyles.icon, { opacity: iconOpacity }]}>{item.icon}</Text>
      <Text style={[healthRowStyles.label, { color: labelColor }]}>{item.label}</Text>
    </View>
  );
}

const healthRowStyles = {
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  rowLast: { borderBottomWidth: 0 },
  icon: {
    fontSize: 17,
    marginRight: 10,
    width: 26,
    textAlign: 'center' as const,
  },
  label: { fontSize: 14, color: '#111827', flex: 1 },
};

// Background Reliability section — Android only.
// Card-based layout with two states:
//   enabled  (battOptIgnoring === false): amber ⚠ + description + "Open Battery Settings" button
//   disabled (battOptIgnoring === true):  green ✅ + confirmation text, no button
const battOptStyles = {
  card: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  cardRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    marginBottom: 2,
  },
  warningIcon: { fontSize: 17, marginRight: 8 },
  warningTitle: { fontSize: 15, fontWeight: '700' as const, color: Colors.warning, flex: 1 },
  okIcon: { fontSize: 17, marginRight: 8 },
  okTitle: { fontSize: 15, fontWeight: '700' as const, color: Colors.success, flex: 1 },
  description: {
    fontSize: 13.5,
    color: Colors.textSecondary,
    lineHeight: 19,
    marginTop: 8,
    marginBottom: 14,
  },
  btn: {
    alignSelf: 'flex-start' as const,
    borderWidth: 1,
    borderColor: Colors.warning,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: Colors.warningBg,
  },
  btnText: { fontSize: 14, color: Colors.warning, fontWeight: '700' as const },
  // Info table — key/value rows shown below the state card.
  infoTable: { paddingHorizontal: 16, paddingBottom: 14 },
};

// ===========================================================
//  CollapsibleSection — Build 46 wrapper.
//
//  Every Diagnostics section uses this so users can hide the noise
//  they don't currently care about.  Contents are NOT rendered when
//  collapsed — this is the key perf win for a 12-section screen.
//
//  Expansion state is persisted to AsyncStorage under a single
//  JSON object, keyed by `id`, so the screen remembers what you
//  had open across navigations within the same session.
// ===========================================================
type CollapsibleSectionProps = {
  id: string;
  title: string;
  count?: number | string | null;
  /** Optional one-line hint shown under the header when expanded. */
  hint?: string;
  /** Whether the section starts open if the user has no saved state. */
  defaultExpanded?: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
  testID?: string;
  /** Optional small status badge rendered in the header (e.g. auto-refresh indicator). */
  autoRefreshLabel?: string;
};

function CollapsibleSection({
  id,
  title,
  count,
  hint,
  expanded,
  onToggle,
  children,
  testID,
  autoRefreshLabel,
}: CollapsibleSectionProps) {
  return (
    <View style={styles.section} testID={testID}>
      <TouchableOpacity
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
        accessibilityRole="button"
        onPress={() => onToggle(id)}
        activeOpacity={0.7}
        style={styles.collapsibleHeader}
        testID={`${testID || `diagnostics-section-${id}`}-header`}
      >
        <Text style={styles.collapsibleChevron}>{expanded ? '▼' : '▶'}</Text>
        <Text style={styles.collapsibleTitle} numberOfLines={1}>
          {title}
        </Text>
        {count !== null && count !== undefined ? (
          <Text style={styles.collapsibleCount}>{count}</Text>
        ) : null}
        {autoRefreshLabel ? (
          <View style={styles.autoRefreshBadge}>
            <Text style={styles.autoRefreshBadgeText}>{autoRefreshLabel}</Text>
          </View>
        ) : null}
      </TouchableOpacity>
      {expanded ? (
        <>
          {hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}
          {children}
        </>
      ) : null}
    </View>
  );
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
  const [engineLog, setEngineLog] = useState<EngineLogEvent[]>([]);
  const [engineState, setEngineState] = useState<LocationEngineState | null>(null);
  const [engineAvailable, setEngineAvailable] = useState<boolean>(false);
  const [dashLoadLog, setDashLoadLog] = useState<DashboardLoadEntry[]>([]);
  const [cardLog, setCardLog] = useState<CardRenderEntry[]>([]);
  const [pipelineLog, setPipelineLog] = useState<PipelineEntry[]>([]);
  const [serverState, setServerState] = useState<any>(null);
  const [serverStateLoading, setServerStateLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  // Task #21 Deliverable 2 — side-by-side device comparison.
  // Fetched from /api/diagnostics/family-snapshot on demand.
  const [familySnapshot, setFamilySnapshot] = useState<any>(null);
  const [familySnapshotLoading, setFamilySnapshotLoading] = useState(false);
  // Build XX — GPS quality history fetched from backend location_history collection.
  const [gpsHistory, setGpsHistory] = useState<any[]>([]);
  const [gpsHistoryErr, setGpsHistoryErr] = useState<string | null>(null);
  // TEMP DIAG — battery pipeline investigation.
  const [deviceBatteryLevel, setDeviceBatteryLevel] = useState<number | null>(null);
  // Battery subsystem — periodic WorkManager/BGTaskScheduler task log.
  const [batteryTaskLog, setBatteryTaskLog] = useState<BatteryTaskLogEntry[]>([]);

  // Task #21 — Pipeline timestamps (per-stage AsyncStorage timestamps).
  const [pipelineTs, setPipelineTs] = useState<PipelineTimestamps | null>(null);
  const [listenersAttachedFlag, setListenersAttachedFlag] = useState<boolean>(false);
  // Task #53 — "Push snapshot now" test button state.
  const [snapshotPushing, setSnapshotPushing] = useState<boolean>(false);
  const [snapshotPushResult, setSnapshotPushResult] = useState<string | null>(null);
  // Battery optimization — Android only.
  // null  = check not yet run, unavailable, or iOS.
  // true  = OS is ignoring battery optimizations (unrestricted).
  // false = OS is applying battery optimizations — show actionable state.
  const [battOptIgnoring, setBattOptIgnoring] = useState<boolean | null>(null);
  // Device info gathered alongside the battery check — used for the static
  // info card so a screenshot tells us the full device state immediately.
  const [battOptInfo, setBattOptInfo] = useState<{
    manufacturer: string | null;
    model: string | null;
    powerManagerAvailable: boolean | null;
    checkedAt: number | null;
  }>({ manufacturer: null, model: null, powerManagerAvailable: null, checkedAt: null });
  // Task #92 — auto-clear timer so a stale result never misleads the next tap.
  const snapshotPushResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Leonidas (Build 46) — snapshot + recovery log
  const [leoSnapshot, setLeoSnapshot] = useState<leonidas.LeonidasSnapshotForUI | null>(null);
  const [leoLog, setLeoLog] = useState<leonidas.RecoveryLogEntry[]>([]);
  const [restrictionStatus, setRestrictionStatus] = useState<RestrictionStatus>({
    isRestricted: false,
    powerSaveActive: false,
    restartBlockedByOs: false,
    leonidasRestartFailed: false,
    lastEvidenceAt: null,
  });
  // 1-second ticking clock used ONLY for the live "Next Patrol" countdown
  // in the Leonidas snapshot card.  Only ticks while the Leonidas panel
  // is expanded — see the gated effect below.
  const [nowTick, setNowTick] = useState<number>(Date.now());

  // ── Diagnostics summary card (Task 8) ───────────────────────────────────
  // Five at-a-glance values computed from the existing engine log ring buffer.
  // Placed above the ScrollView so they are always visible without scrolling.
  const diagSummary = useMemo(() => {
    const now = nowTick;
    const rev = [...engineLog].reverse();

    const lastHeartbeatEvtRaw = rev.find(
      (e) => e.event === 'sdk_onHeartbeat' || e.event === 'headless_task_invoked',
    ) ?? null;
    const lastHeadlessEvt = rev.find(
      (e) => e.event === 'headless_task_invoked',
    ) ?? null;
    const lastUploadEvt = rev.find(
      (e) => e.event === 'sdk_onHttp' && e.detail?.success === true,
    ) ?? null;
    const lastEnabledEvt = rev.find(
      (e) => e.event === 'sdk_onEnabledChange',
    ) ?? null;
    const lastPowerSaveEvt = rev.find(
      (e) => e.event === 'sdk_onPowerSaveChange',
    ) ?? null;

    return {
      lastHeartbeatAge: lastHeartbeatEvtRaw ? now - lastHeartbeatEvtRaw.at : null,
      lastHeadlessAge: lastHeadlessEvt ? now - lastHeadlessEvt.at : null,
      lastUploadAge: lastUploadEvt ? now - lastUploadEvt.at : null,
      bgServiceRunning: lastEnabledEvt ? (!!lastEnabledEvt.detail?.enabled) : null,
      powerSaveOn: lastPowerSaveEvt ? (!!lastPowerSaveEvt.detail?.isPowerSaveMode) : null,
    };
  }, [engineLog, nowTick]);

  // Task 9 / Task 11 — Health check items derived from the engine log.
  // Uses nowTick (updated every second by the unconditional interval below)
  // so "Last heartbeat: X min ago" and "Last location upload: X min ago"
  // tick in real time and status icons flip without a manual reload.
  // Pass the persistent last-successful-upload timestamp so the upload row
  // stays green even when the ring buffer has been flooded with failure
  // entries and the last successful sdk_onHttp event was evicted.
  // pipelineTs is already loaded by reload() via getPipelineTimestamps().
  const healthItems = useMemo(
    () => computeHealthItems(engineLog, nowTick, pipelineTs?.http_success ?? null),
    [engineLog, nowTick, pipelineTs],
  );

  // Hero card — single overall verdict driven primarily by upload recency.
  // This is the first thing a caregiver sees and answers "is Kinnship
  // protecting my loved one right now?" before any detail panel.
  //
  // lastSeenMs bridges the gap between the dashboard's member.last_seen
  // (updated by every native background upload via /members API) and the
  // engine log's sdk_onHttp events (only fired when the JS layer is awake).
  // Without it, the hero card says "starting up" while the dashboard shows
  // "Updated just now" — two screens disagreeing about the same upload.
  //
  // pipelineTs?.http_success (kc_pts_http_ok) is the third evidence stream:
  // a persistent AsyncStorage key immune to ring-buffer eviction.  It keeps
  // the hero card green even when a failure burst has evicted the last success
  // from the ring buffer and lastSeenMs is not yet populated (fresh device /
  // first /members poll pending).
  const overallHealth = useMemo(() => {
    const myLastSeenMs = memberStore.getMyLastSeenMs(user?.id ?? null);
    return computeOverallHealth(
      engineLog,
      nowTick,
      myLastSeenMs,
      pipelineTs?.http_success ?? null,
    );
  }, [engineLog, nowTick, user?.id, pipelineTs]);

  // Task 68 — Upload ratio summary.
  // Counts headless + foreground HTTP upload successes vs failures from
  // the ring buffer so Charles can confirm the upload pipeline is healthy
  // at a glance without scanning individual log entries.
  //
  // Both paths emit sdk_onHttp (success boolean) and a named event
  // (headless_http_ok / headless_http_error or http_upload_success /
  // http_upload_failure).  We count only sdk_onHttp to avoid double-
  // counting (each upload emits exactly one sdk_onHttp regardless of path).
  const uploadRatio = useMemo(() => {
    const httpEvents = engineLog.filter((e) => e.event === 'sdk_onHttp');
    const ok = httpEvents.filter((e) => e.detail?.success === true).length;
    const fail = httpEvents.filter((e) => e.detail?.success === false).length;
    const total = httpEvents.length;
    const lastFailEvt = [...httpEvents].reverse().find((e) => e.detail?.success === false) ?? null;
    return { total, ok, fail, lastFailStatus: lastFailEvt?.detail?.status ?? null };
  }, [engineLog]);

  // Build 64 — Motion Timeline derived data.
  // Computed from engineLog so they stay in sync with the reload() cycle.
  const motionEvents = useMemo(
    () => engineLog.filter((e) => MOTION_EVENT_SET.has(e.event)),
    [engineLog],
  );
  const lastActivityEvt = useMemo(
    () => [...motionEvents].reverse().find((e) => e.event === 'sdk_onActivityChange') ?? null,
    [motionEvents],
  );
  const lastHeartbeatEvt = useMemo(
    () => [...motionEvents].reverse().find(
      (e) => e.event === 'sdk_onHeartbeat' || e.event === 'headless_heartbeat_ok',
    ) ?? null,
    [motionEvents],
  );

  // Build 46 — collapsible-section state.  Persisted to AsyncStorage
  // (best-effort) so the screen remembers which panels were open
  // during the current session.  Default-closed for everything
  // except Leonidas + Engine + Build/OTA, which are the most useful
  // panels for ongoing field testing.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    health: true,    // Task 9 — Health Check panel, default open
    'build-ota': true,
    leonidas: true,
    engine: true,
    pipeline: true,  // Build XX — Refresh Pipeline investigation, default open
    'pipeline-ts': true, // Task #21 — Pipeline Timestamps, default open
    'device-comparison': true, // Task #30 — open by default so stale events are visible immediately
    'background-reliability': false, // Closed by default — tester opens when investigating
  });
  const expansionLoadedRef = useRef(false);

  // Restore persisted expansion state once on mount.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(EXPANSION_STATE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            setExpanded((prev) => ({ ...prev, ...parsed }));
          }
        }
      } catch (_e) { /* best-effort */ }
      expansionLoadedRef.current = true;
    })();
  }, []);

  // Task #92 — cancel the auto-clear timer if the screen unmounts while it's running.
  useEffect(() => {
    return () => {
      if (snapshotPushResultTimerRef.current !== null) {
        clearTimeout(snapshotPushResultTimerRef.current);
      }
    };
  }, []);

  const toggleSection = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      // Persist async, fire-and-forget.
      AsyncStorage.setItem(EXPANSION_STATE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const [r, a, p, l, b, sr, eng, dl, cr, pl, lsnap, llog, rs] = await Promise.all([
      readRouteLog(),
      readAuthClearLog(),
      readPushRefreshLog(),
      readLocationRefreshLog(),
      readBgTaskLog(),
      readScreenRenderLog(),
      getEngineDiagnostics(),
      getDashboardLoadLog(),
      getCardRenderLog(),
      getRefreshPipelineLog(),
      Promise.resolve(leonidas.getSnapshot()),
      leonidas.getRecoveryLog(),
      getRestrictionStatus(),
    ]);
    setRouteLog(r);
    setAuthLog(a);
    setPushLog(p);
    setLocLog(l);
    setBgLog(b);
    setRenderLog(sr);
    setEngineLog(eng.log);
    setEngineState(eng.state);
    setEngineAvailable(eng.available);
    setDashLoadLog(dl);
    setCardLog(cr);
    setPipelineLog(pl);
    setLeoSnapshot(lsnap);
    setLeoLog(llog);
    setRestrictionStatus(rs);

    // Build XX — GPS quality history from the backend location_history collection.
    // Read the device's own member_id from AsyncStorage (same key as locationRefresh.ts)
    // then call GET /members/{id}/location-history.
    try {
      const memberId = await AsyncStorage.getItem('kc_my_member_id_v1');
      if (memberId) {
        const resp = await api.get(`/members/${memberId}/location-history`);
        setGpsHistory(resp.data || []);
        setGpsHistoryErr(null);
      }
    } catch (e: any) {
      const msg = e?.response?.status
        ? `http_${e.response.status}`
        : (e?.message || 'unknown').slice(0, 80);
      setGpsHistoryErr(msg);
    }

    // Battery subsystem — live device level + periodic task log.
    try {
      const level = await Battery.getBatteryLevelAsync();
      setDeviceBatteryLevel(typeof level === 'number' ? level : null);
    } catch (_e) {
      setDeviceBatteryLevel(null);
    }
    try {
      setBatteryTaskLog(await readBatteryTaskLog());
    } catch (_e) {
      setBatteryTaskLog([]);
    }

    // Battery optimization status + device info — Android only.
    // All three calls are read-only metadata fetches — no Settings screen is opened.
    // Every failure path is now logged explicitly so the engine ring buffer shows
    // exactly which SDK call failed and why, instead of silently returning null.
    if (Platform.OS === 'android') {
      void logEvent('battery_opt_reload_start');
      try {
        const [ignoring, bOptReq, pmReq] = await Promise.all([
          checkBatteryOptimization(),
          requestShowIgnoreBatteryOptimizations(),
          requestShowPowerManager(),
        ]);
        // Log all resolved values before setting state — each wrapper already logs
        // its own failure reason (SDK_NOT_READY / METHOD_THROW), so this entry
        // shows the final picture: which calls succeeded and which returned null.
        void logEvent('battery_opt_reload_result', {
          ignoring,
          hasOptRequest: bOptReq !== null,
          manufacturer: bOptReq?.manufacturer ?? null,
          model: bOptReq?.model ?? null,
          hasPowerManager: pmReq !== null,
        });
        setBattOptIgnoring(ignoring);
        setBattOptInfo({
          manufacturer: bOptReq?.manufacturer ?? null,
          model: bOptReq?.model ?? null,
          powerManagerAvailable: pmReq !== null,
          checkedAt: ignoring !== null ? Date.now() : null,
        });
        if (ignoring !== null) {
          void logEvent('battery_opt_status_check', {
            ignoring,
            manufacturer: bOptReq?.manufacturer ?? null,
            model: bOptReq?.model ?? null,
            powerManagerAvailable: pmReq !== null,
          });
        }
      } catch (e: any) {
        // The individual wrappers each catch their own errors, so this outer catch
        // should only fire if something unexpected throws inside the try block itself.
        void logEvent('battery_opt_reload_failed', {
          reason: 'PROMISE_ALL_THROW',
          error: String((e as any)?.message || e),
        });
        setBattOptIgnoring(null);
      }
    }

    // Task #21 — pipeline timestamps.
    try {
      const pts = await getPipelineTimestamps();
      setPipelineTs(pts);
      setListenersAttachedFlag(isListenersAttached());
    } catch (_e) {
      setPipelineTs(null);
    }

    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Build 46 — Leonidas-only fast-refresh tick.  Only ticks while the
  // Leonidas panel is expanded, so we don't burn cycles when the user
  // is looking at other sections.  Refreshes every 4s, which is fast
  // enough to watch state transitions live without spamming
  // AsyncStorage reads.
  useEffect(() => {
    if (!expanded.leonidas) return;
    const tick = setInterval(async () => {
      try {
        const [snap, log] = await Promise.all([
          Promise.resolve(leonidas.getSnapshot()),
          leonidas.getRecoveryLog(),
        ]);
        setLeoSnapshot(snap);
        setLeoLog(log);
      } catch (_e) { /* swallow */ }
    }, 4000);
    return () => clearInterval(tick);
  }, [expanded.leonidas]);

  // 1-second tick for live age displays.  Runs unconditionally while the
  // Diagnostics screen is mounted so the summary card "X min ago" values
  // and the Leonidas "Next Patrol" countdown both stay accurate without a
  // manual reload.  A 1-second setInterval is effectively free — no
  // AsyncStorage reads, no network calls, just a Date.now() assignment.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 30-second pipelineTs refresh — fresh-install recovery path.
  //
  // reload() is only called at mount-time, so if the first upload fires after
  // that initial read, kc_pts_http_ok is written to AsyncStorage but pipelineTs
  // state never receives the new value.  The hero card would stay 'starting'
  // indefinitely.
  //
  // This effect polls getLastHttpSuccessTs() every 30 seconds — a single
  // AsyncStorage key read, minimal overhead — and applies a functional update
  // to pipelineTs state when the value changes.  The overallHealth useMemo
  // then re-runs on the next nowTick, flipping the hero card from 'starting'
  // to 'ok' within at most 30 seconds of the first upload, well within the
  // 5-minute window the task requires.
  //
  // The update is a no-op when:
  //   • pipelineTs is null (reload hasn't completed yet — avoid creating a
  //     partial object with only http_success set)
  //   • the value hasn't changed (avoids unnecessary re-renders)
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const httpSuccessMs = await getLastHttpSuccessTs();
        setPipelineTs((prev) => {
          if (!prev || prev.http_success === httpSuccessMs) return prev;
          return { ...prev, http_success: httpSuccessMs };
        });
      } catch (_e) { /* swallow — hero card remains at last known state */ }
    }, 30_000);
    return () => clearInterval(t);
  }, []);

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

  // Task #21 Deliverable 2 — Fetch family-snapshot for cross-device comparison.
  const fetchFamilySnapshot = useCallback(async () => {
    setFamilySnapshotLoading(true);
    try {
      const r = await api.get('/diagnostics/family-snapshot');
      setFamilySnapshot({ at: Date.now(), data: r.data, err: null });
    } catch (e: any) {
      setFamilySnapshot({
        at: Date.now(),
        data: null,
        err: e?.response?.status ? `http_${e.response.status}` : (e?.message || 'unknown'),
      });
    } finally {
      setFamilySnapshotLoading(false);
    }
  }, []);

  // Device Comparison auto-refresh — must sit AFTER fetchFamilySnapshot is
  // declared; placing it before caused a ReferenceError at component init
  // (const is not hoisted) which blanked the entire Diagnostics screen.
  useEffect(
    () => startDeviceComparisonRefresh(!!expanded['device-comparison'], fetchFamilySnapshot),
    [expanded['device-comparison'], fetchFamilySnapshot],
  );

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
      locationEngine: {
        available: engineAvailable,
        state: engineState,
        log: engineLog,
      },
      dashboardLoadLog: dashLoadLog,
      serverState,
      counts: {
        authClear: authLog.length,
        route: routeLog.length,
        pushRefresh: pushLog.length,
        locationRefresh: locLog.length,
        bgTask: bgLog.length,
        screenRender: renderLog.length,
        engineLog: engineLog.length,
        dashboardLoad: dashLoadLog.length,
      },
    };
  }, [authLog, routeLog, pushLog, locLog, bgLog, renderLog, engineLog, engineState, engineAvailable, dashLoadLog, serverState, user]);

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

  // v1.3.3 — Refresh trace (server-side), Notification log.
  const [refreshTraces, setRefreshTraces] = useState<any[]>([]);
  const [notifLog, setNotifLog] = useState<any[]>([]);

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
    refreshNotifLog();
    refreshTraceData();
  }, [refreshNotifLog, refreshTraceData]);

  const onClearNotifLog = useCallback(async () => {
    await clearNotificationLog();
    refreshNotifLog();
  }, [refreshNotifLog]);

  const onClear = () => {
    Alert.alert(
      'Clear ALL Diagnostics?',
      'This removes EVERY developer ring buffer from this device — engine log, dashboard log, card render log, Leonidas log, auth log, route log, push log, notification log, and more. Cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear ALL',
          style: 'destructive',
          onPress: async () => {
            await Promise.all([
              clearAuthClearLog(),
              clearRouteLog(),
              clearPushRefreshLog(),
              clearLocationRefreshLog(),
              clearBgTaskLog(),
              clearScreenRenderLog(),
              clearEngineLog(),
              clearDashboardLoadLog(),
              clearCardRenderLog(),
              leonidas.clearRecoveryLog(),
              clearNotificationLog(),
              clearBatteryTaskLog(),
            ]);
            await reload();
            try { await refreshNotifLog(); } catch (_e) {}
          },
        },
      ],
    );
  };

  // Build 46 — Leonidas-specific actions.
  const onCopyMotionTimeline = useCallback(async () => {
    try {
      const lines = motionEvents.map((e) => {
        const { badge, label, detail } = formatMotionEvent(e);
        return `${new Date(e.at).toISOString()}  [${badge}]  ${label}${detail ? '  · ' + detail : ''}`;
      }).join('\n');
      await Clipboard.setStringAsync(lines);
      Alert.alert('Copied', `Motion timeline copied (${motionEvents.length} events).`);
    } catch (e: any) {
      Alert.alert('Could not copy', e?.message || 'Try again.');
    }
  }, [motionEvents]);

  // Build XX — Refresh Pipeline copy action.
  const onCopyPipelineLog = useCallback(async () => {
    try {
      const payload = {
        generatedAt: new Date().toISOString(),
        refresh_pipeline: pipelineLog,
      };
      await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
      Alert.alert('Copied', `Refresh pipeline copied (${pipelineLog.length} entries).`);
    } catch (e: any) {
      Alert.alert('Could not copy', e?.message || 'Try again.');
    }
  }, [pipelineLog]);

  const onCopyLeonidasLog = useCallback(async () => {
    try {
      const payload = {
        generatedAt: new Date().toISOString(),
        leonidas: {
          snapshot: leoSnapshot,
          recovery_log: leoLog,
        },
      };
      await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
      Alert.alert('Copied', `Leonidas log copied (${leoLog.length} entries).`);
    } catch (e: any) {
      Alert.alert('Could not copy', e?.message || 'Try again.');
    }
  }, [leoSnapshot, leoLog]);

  const onClearLeonidasLog = useCallback(() => {
    Alert.alert(
      'Clear Leonidas log?',
      'Removes the recovery log on this device. The patrol loop keeps running.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await leonidas.clearRecoveryLog();
            const [snap, log] = await Promise.all([
              Promise.resolve(leonidas.getSnapshot()),
              leonidas.getRecoveryLog(),
            ]);
            setLeoSnapshot(snap);
            setLeoLog(log);
          },
        },
      ],
    );
  }, []);

  // Build 53 — Export bg_task_log dedicated action.  Copies ONLY the
  // Transistor background-task ring buffer to clipboard so bug reports
  // can paste a focused execution trace of what the headless engine
  // actually did (rather than a big multi-log dump).
  // Battery optimization — Android only.
  // Implements the documented SDK flow:
  //   1. Show an explanation Alert (user must opt in).
  //   2. Call requestShowIgnoreBatteryOptimizations() to get a DeviceSettingsRequest.
  //   3. Call showDeviceSettingsScreen(request) to open the Android settings screen.
  //   4. On Samsung: also offer showPowerManager() if the device has that screen.
  //
  // The SDK docs note showPowerManager() throws on non-OEM devices — catch it silently.
  // All steps are logged so the Diagnostics ring buffer captures the full trace.
  const onOpenBatterySettings = useCallback(async () => {
    Alert.alert(
      'Improve Background Reliability',
      'Some Android phones reduce background activity to save battery.\n\n' +
      'Allowing Kinnship to run without battery optimization may improve:\n\n' +
      '• faster location updates\n' +
      '• more reliable battery monitoring\n' +
      '• better emergency tracking\n\n' +
      'Your phone may use slightly more battery.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => { void logEvent('battery_opt_user_cancelled'); },
        },
        {
          text: 'Continue',
          onPress: async () => {
            try {
              const request = await requestShowIgnoreBatteryOptimizations();
              if (!request) {
                void logEvent('battery_opt_settings_unavailable');
                return;
              }
              void logEvent('battery_opt_prompt_shown', {
                seen: request.seen,
                lastSeenAt: request.lastSeenAt ? new Date(request.lastSeenAt).toISOString() : null,
                manufacturer: request.manufacturer,
                model: request.model,
              });
              await showDeviceSettingsScreen(request);
              void logEvent('battery_opt_settings_opened', {
                manufacturer: request.manufacturer,
                model: request.model,
              });
              // show(request) resolves when the user returns from Android Settings.
              // Re-run isIgnoringBatteryOptimizations() immediately so the card
              // updates to ✅ without requiring a manual reload.
              try {
                const updatedIgnoring = await checkBatteryOptimization();
                setBattOptIgnoring(updatedIgnoring);
                setBattOptInfo(prev => ({ ...prev, checkedAt: Date.now() }));
                void logEvent('battery_opt_recheck_after_settings', { ignoring: updatedIgnoring });
              } catch (_e) { /* swallow — UI stays at last known state */ }
              // Samsung devices have a vendor-specific power-manager screen in
              // addition to the standard Android battery settings.  Offer it only
              // if requestShowPowerManager() confirms this device has one (it returns
              // null on stock-Android / Pixel devices — expected, not an error).
              const isSamsung = request.manufacturer?.toLowerCase().includes('samsung');
              if (isSamsung) {
                const pmReq = await requestShowPowerManager();
                if (pmReq) {
                  void logEvent('battery_opt_power_manager_available', {
                    seen: pmReq.seen,
                    lastSeenAt: pmReq.lastSeenAt ? new Date(pmReq.lastSeenAt).toISOString() : null,
                    manufacturer: pmReq.manufacturer,
                    model: pmReq.model,
                  });
                  Alert.alert(
                    'Samsung Battery Settings',
                    'Samsung devices have an additional power-manager setting. ' +
                    "Tap \"Open\" to check Kinnship's setting there too.",
                    [
                      {
                        text: 'Skip',
                        style: 'cancel',
                        onPress: () => { void logEvent('battery_opt_power_manager_skipped'); },
                      },
                      {
                        text: 'Open',
                        onPress: async () => {
                          await showDeviceSettingsScreen(pmReq);
                          void logEvent('battery_opt_power_manager_opened');
                        },
                      },
                    ],
                  );
                } else {
                  void logEvent('battery_opt_power_manager_unavailable');
                }
              }
            } catch (e: any) {
              void logEvent('battery_opt_error', { error: String(e?.message || e) });
            }
          },
        },
      ],
    );
  }, []);

  const onCopyBgTaskLog = useCallback(async () => {
    try {
      const raw = await readBgTaskLog();
      const payload = {
        exportedAt: new Date().toISOString(),
        bg_task_log_entries: raw.length,
        bg_task_log: raw,
      };
      await Clipboard.setStringAsync(JSON.stringify(payload, null, 2));
      Alert.alert('Copied', `bg_task_log copied (${raw.length} entries).`);
    } catch (e: any) {
      Alert.alert('Could not copy', e?.message || 'Try again.');
    }
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="diagnostics-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/me'))}
          style={styles.backBtn}
          accessibilityLabel="Back"
        >
          <Icon name="arrow-back" size={28} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Diagnostics</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* =====================================================
          Hero health card — replaces the raw 5-row summary.
          Non-scrolling: always visible between the nav header
          and the ScrollView.  Answers the one question that
          matters: "Can I trust Kinnship is protecting my loved
          one right now?"  Derived from upload recency — the
          most direct evidence the full pipeline is working.
          ===================================================== */}
      {(() => {
        const { level, headline, subline } = overallHealth;
        const t = heroTheme[level];
        return (
          <View style={[styles.heroCard, { backgroundColor: t.bg, borderColor: t.border }]}>
            <Text style={styles.heroIcon}>{t.icon}</Text>
            <View style={styles.heroTextBlock}>
              <Text style={[styles.heroHeadline, { color: t.headline }]}>{headline}</Text>
              <Text style={[styles.heroSubline, { color: t.sub }]}>{subline}</Text>
            </View>
          </View>
        );
      })()}

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.intro}>
          Beta diagnostics. If support asks, tap <Text style={styles.bold}>Copy Log</Text> and
          paste into your reply. No personal data leaves your phone until you paste.
        </Text>

        {/* =====================================================
            Task 9 — Plain-English Health Check panel.
            Product-owner-facing.  Answers "is the app working?"
            without requiring interpretation of log lines.
            Derived from the engine log ring buffer — no extra
            data sources needed.  Expanded by default so it's
            the first thing visible on scroll.
            ===================================================== */}
        <CollapsibleSection
          id="health"
          title="Health Check"
          expanded={!!expanded.health}
          onToggle={toggleSection}
          hint="Is Kinnship working? Green = good · Amber = check soon · Red = needs attention."
          testID="diagnostics-health"
        >
          {healthItems.map((item, i) => (
            <HealthRow key={item.label} item={item} isLast={i === healthItems.length - 1} />
          ))}
        </CollapsibleSection>

        {/* =====================================================
            Background Reliability — Android only.
            Uses the documented Transistorsoft deviceSettings API.
            Two states:
              enabled  (battOptIgnoring === false): ⚠ + description + button
              disabled (battOptIgnoring === true):  ✅ + confirmation, no button
            Hidden entirely on iOS and before the first check runs.
            ===================================================== */}
        {Platform.OS === 'android' && battOptIgnoring !== null && (
          <CollapsibleSection
            id="background-reliability"
            title="Background Reliability"
            expanded={!!expanded['background-reliability']}
            onToggle={toggleSection}
            hint="Android battery optimization controls how often Kinnship can run in the background."
            testID="diagnostics-background-reliability"
          >
            {battOptIgnoring === false ? (
              // Battery optimization is ACTIVE — show actionable warning.
              <View style={battOptStyles.card} testID="diagnostics-battery-opt-enabled">
                <View style={battOptStyles.cardRow}>
                  <Text style={battOptStyles.warningIcon}>⚠</Text>
                  <Text style={battOptStyles.warningTitle}>
                    Android Battery Optimization Enabled
                  </Text>
                </View>
                <Text style={battOptStyles.description}>
                  This phone may delay background location updates after long periods of inactivity.
                </Text>
                <TouchableOpacity
                  style={battOptStyles.btn}
                  onPress={onOpenBatterySettings}
                  activeOpacity={0.8}
                  testID="diagnostics-battery-opt-btn"
                >
                  <Text style={battOptStyles.btnText}>Open Battery Settings</Text>
                </TouchableOpacity>
              </View>
            ) : (
              // Battery optimization is DISABLED — unrestricted, no action needed.
              <View style={battOptStyles.card} testID="diagnostics-battery-opt-disabled">
                <View style={battOptStyles.cardRow}>
                  <Text style={battOptStyles.okIcon}>✅</Text>
                  <Text style={battOptStyles.okTitle}>
                    Android Battery Optimization Disabled
                  </Text>
                </View>
              </View>
            )}
            {/* Static device info card — visible as soon as the check has run.
                A tester screenshot shows the full device state without digging
                through the engine ring buffer. */}
            {battOptInfo.checkedAt !== null && (
              <View style={battOptStyles.infoTable}>
                <SummaryRow
                  label="Battery optimization"
                  value={battOptIgnoring === false ? 'Enabled' : 'Disabled'}
                  valueColor={battOptIgnoring === false ? Colors.warning : Colors.success}
                />
                {battOptInfo.model ? (
                  <SummaryRow label="Device" value={battOptInfo.model} />
                ) : null}
                {battOptInfo.manufacturer ? (
                  <SummaryRow label="Manufacturer" value={battOptInfo.manufacturer} />
                ) : null}
                {battOptInfo.powerManagerAvailable !== null && (
                  <SummaryRow
                    label="Power Manager"
                    value={battOptInfo.powerManagerAvailable ? 'Available' : 'Not available'}
                    valueColor={battOptInfo.powerManagerAvailable ? Colors.success : Colors.textSecondary}
                  />
                )}
                <SummaryRow
                  label="Ignoring battery optimizations"
                  value={battOptIgnoring === true ? 'YES' : battOptIgnoring === false ? 'NO' : '—'}
                  valueColor={battOptIgnoring === true ? Colors.success : battOptIgnoring === false ? Colors.warning : undefined}
                  isLast={!battOptInfo.checkedAt}
                />
                <SummaryRow
                  label="Last checked"
                  value={fmt(battOptInfo.checkedAt)}
                  isLast
                />
              </View>
            )}
          </CollapsibleSection>
        )}

        {/* =====================================================
            Build 46 — Clear ALL Diagnostics.
            One button at the top wipes every developer ring
            buffer so testers don't have to scroll to each panel
            to clear individually between test windows.
            ===================================================== */}
        <TouchableOpacity
          testID="diagnostics-clear-all-top"
          style={styles.clearAllBtn}
          onPress={onClear}
          activeOpacity={0.85}
        >
          <Text style={styles.clearAllBtnText}>🗑  Clear ALL Diagnostics</Text>
        </TouchableOpacity>
        <Text style={styles.clearAllHint}>
          Clears engine, dashboard, card-render, Leonidas, auth, route, push,
          notifications, and every other developer ring buffer in one tap.
        </Text>

        {/* =====================================================
            Leonidas v1.1 — Background Restriction Warning.
            Reads positively confirmed evidence from the engine
            and Leonidas ring buffers.  Invisible in the happy
            path (isRestricted === false → renders null).
            ===================================================== */}
        <BackgroundRestrictionWarning status={restrictionStatus} />

        {/* =====================================================
            Build 46 — Leonidas v1.0 Health Monitor.
            Live snapshot + recovery log.  Auto-refreshes only
            while expanded.  This is the primary observation
            surface for the Build 45 health-monitor subsystem.
            ===================================================== */}
        <CollapsibleSection
          id="leonidas"
          title="Leonidas Health Monitor"
          count={leoLog.length}
          expanded={!!expanded.leonidas}
          onToggle={toggleSection}
          hint="Passive patrol of engine state + one-shot conservative recovery.  Auto-refreshes every 4 s while this panel is expanded."
          testID="diagnostics-leonidas"
        >
          {/* Snapshot card — at-a-glance health */}
          <View style={styles.card} testID="diagnostics-leonidas-snapshot">
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Patrol active: </Text>
              <Text style={leoSnapshot?.patrol_active ? styles.bold : undefined}>
                {leoSnapshot?.patrol_active ? 'Yes' : 'No'}
              </Text>
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Health state: </Text>
              <Text style={styles.bold}>{leoSnapshot?.state ?? 'unknown'}</Text>
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Motion state: </Text>
              {leoSnapshot?.last_patrol
                ? (leoSnapshot.last_patrol.engine_is_moving === null
                    ? 'unknown'
                    : leoSnapshot.last_patrol.engine_is_moving
                    ? 'moving'
                    : 'stationary')
                : '—'}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Last patrol: </Text>
              {leoSnapshot?.last_patrol ? fmt(leoSnapshot.last_patrol.at) : '—'}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Patrol count: </Text>
              {leoSnapshot?.patrol_count ?? 0}
              {'   '}
              <Text style={styles.entryK}>Recoveries today: </Text>
              {leoSnapshot?.recoveries_today ?? 0}
            </Text>
            {/* Build 46 — live "Next Patrol" countdown.  Computed from
                last_patrol.at + PATROL_INTERVAL_SECONDS.  Ticks every
                second via nowTick (gated on Leonidas-panel expansion).
                Says "due now" if overdue, "—" if no patrol yet. */}
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Next patrol: </Text>
              {(() => {
                if (!leoSnapshot?.patrol_active) return 'patrol stopped';
                const lastAt = leoSnapshot?.last_patrol?.at;
                if (typeof lastAt !== 'number') return '— awaiting first patrol';
                const nextAt = lastAt + PATROL_INTERVAL_SECONDS * 1000;
                const remainingMs = nextAt - nowTick;
                if (remainingMs <= 0) {
                  const overdue = Math.round(-remainingMs / 1000);
                  return overdue < 5 ? 'due now' : `overdue ${overdue}s`;
                }
                const s = Math.ceil(remainingMs / 1000);
                return s === 1 ? '1 second' : `${s} seconds`;
              })()}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Last upload age: </Text>
              {formatAgeMs(leoSnapshot?.last_patrol?.last_upload_age_ms ?? null)}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Last decision: </Text>
              <Text style={styles.bold}>
                {formatLeonidasDecision(
                  leoLog.length > 0 ? leoLog[leoLog.length - 1].event : null,
                  leoLog.length > 0 ? leoLog[leoLog.length - 1].health_state : (leoSnapshot?.state ?? null),
                  leoLog.length > 0 ? (leoLog[leoLog.length - 1].detail?.reason ?? null) : null,
                  leoLog.length > 0 ? (leoLog[leoLog.length - 1].detail?.action ?? null) : null,
                )}
              </Text>
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Current recovery state: </Text>
              {leoSnapshot?.last_recovery
                ? `${leoSnapshot.last_recovery.recovery_action} → ${leoSnapshot.last_recovery.recovery_result ?? '—'}${
                    leoSnapshot.last_recovery.recovery_duration_ms != null
                      ? ` (${leoSnapshot.last_recovery.recovery_duration_ms} ms)`
                      : ''
                  }`
                : 'idle — no recovery this session'}
            </Text>
          </View>

          {/* Recovery log */}
          <Text style={styles.subSectionLabel}>Recovery log (newest first, last {DIAG_BUFFER_SIZES.leonidas})</Text>
          {leoLog.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.muted}>
                — no Leonidas events recorded yet.  The first patrol fires
                ~60 s after engine start; if this stays empty, Leonidas is
                not booting (check auth / engine state above).
              </Text>
            </View>
          ) : (
            leoLog.slice().sort((a, b) => b.seq - a.seq).map((e) => (
              <View key={`leo-${e.seq}`} style={styles.card}>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>#{e.seq} {fmt(e.at)} </Text>
                  <Text style={styles.bold}>{e.event}</Text>
                  <Text style={styles.entry}>  state={e.health_state}</Text>
                </Text>
                {e.detail?.reason ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  reason: </Text>
                    <Text style={styles.entry}>{String(e.detail.reason)}</Text>
                  </Text>
                ) : null}
                {e.detail?.action ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  action: </Text>
                    <Text style={styles.entry}>{String(e.detail.action)}</Text>
                  </Text>
                ) : null}
                {e.detail?.duration_ms != null ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  duration: </Text>
                    <Text style={styles.entry}>{String(e.detail.duration_ms)} ms</Text>
                  </Text>
                ) : null}
                {e.detail?.last_upload_age_ms != null ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  last_upload_age: </Text>
                    <Text style={styles.entry}>{formatAgeMs(e.detail.last_upload_age_ms)}</Text>
                  </Text>
                ) : null}
                {e.detail?.engine_is_moving != null ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  engine_is_moving: </Text>
                    <Text style={styles.entry}>{String(e.detail.engine_is_moving)}</Text>
                  </Text>
                ) : null}
                {e.detail?.note ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  note: </Text>
                    <Text style={styles.entry}>{String(e.detail.note)}</Text>
                  </Text>
                ) : null}
                {e.detail?.error ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  error: </Text>
                    <Text style={styles.divergent}>{String(e.detail.error)}</Text>
                  </Text>
                ) : null}
                {e.detail?.from && e.detail?.to ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  transition: </Text>
                    <Text style={styles.entry}>{String(e.detail.from)} → {String(e.detail.to)}</Text>
                  </Text>
                ) : null}
              </View>
            ))
          )}

          <View style={styles.actionRow}>
            <TouchableOpacity
              testID="diagnostics-leonidas-copy"
              style={styles.primaryBtn}
              onPress={onCopyLeonidasLog}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>📋  Copy Leonidas Log</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="diagnostics-leonidas-clear"
              style={styles.secondaryBtn}
              onPress={onClearLeonidasLog}
              activeOpacity={0.85}
            >
              <Text style={styles.secondaryBtnText}>Clear Leonidas Log</Text>
            </TouchableOpacity>
          </View>
        </CollapsibleSection>

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
              {(() => {
                const u = (Updates as any)?.runtimeVersion;
                if (typeof u === 'string' && u.length > 0) return u;
                const c = (Constants?.expoConfig as any)?.runtimeVersion;
                if (typeof c === 'string' && c.length > 0) return c;
                if (c && typeof c === 'object' && c.policy) return `policy:${c.policy}`;
                return 'unknown';
              })()}
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
            Build 64 — Motion Timeline.
            Filters the engine log to show only motion-relevant
            events (Activity Recognition, motion state changes,
            GPS fixes, HTTP uploads) in strict chronological order
            so Charles's and Joyce's phone behaviour can be
            compared side-by-side during the same trip.
            ===================================================== */}
        <CollapsibleSection
          id="motion-timeline"
          title="Motion Timeline"
          count={motionEvents.length}
          hint={
            'Activity Recognition → Motion Change → GPS Fix → HTTP Upload, oldest first. ' +
            'Compare Charles and Joyce side-by-side. Missing sdk_onActivityChange entries ' +
            'mean Android never delivered a motion event to the SDK.'
          }
          expanded={!!expanded['motion-timeline']}
          onToggle={toggleSection}
          testID="diagnostics-motion-timeline"
          defaultExpanded
        >
          {/* Live status bar */}
          <View style={styles.card}>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>isMoving: </Text>
              <Text style={engineState?.isMoving
                ? { color: '#10B981', fontWeight: '800' } as any
                : styles.entry}>
                {engineState?.isMoving === null ? '—' : engineState?.isMoving ? 'YES ▶' : 'NO ■'}
              </Text>
            </Text>
            {lastActivityEvt ? (
              <Text style={styles.entryLine}>
                <Text style={styles.entryK}>last activity: </Text>
                <Text style={styles.entry}>
                  {String(lastActivityEvt.detail?.activity ?? '—').toUpperCase().replace(/_/g, ' ')}
                  {' '}conf={lastActivityEvt.detail?.confidence ?? '—'}%
                  {'  '}({fmtTime(lastActivityEvt.at)})
                </Text>
              </Text>
            ) : (
              <Text style={styles.entryLine}>
                <Text style={styles.entryK}>last activity: </Text>
                <Text style={[styles.entry, { color: '#EF4444' }]}>
                  none recorded — onActivityChange has not fired yet
                </Text>
              </Text>
            )}
            {lastHeartbeatEvt ? (
              <Text style={styles.entryLine}>
                <Text style={styles.entryK}>last heartbeat: </Text>
                <Text style={styles.entry}>
                  {fmtTime(lastHeartbeatEvt.at)}
                  {'  '}({formatAgeMs(Date.now() - lastHeartbeatEvt.at)})
                </Text>
              </Text>
            ) : null}
          </View>

          {/* Chronological timeline */}
          {motionEvents.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.muted}>
                No motion events yet. Clear the engine log, then drive or walk for 30 seconds.
              </Text>
            </View>
          ) : (
            motionEvents.map((entry, i) => {
              const { badge, badgeColor, label, detail } = formatMotionEvent(entry);
              const isTransition = entry.event === 'sdk_onMotionChange';
              return (
                <View
                  key={`mt-${entry.seq ?? i}-${entry.at}`}
                  style={[
                    styles.mtRow,
                    isTransition && styles.mtRowHighlight,
                  ]}
                >
                  <Text style={styles.mtTime}>{fmtTime(entry.at)}</Text>
                  <View style={[styles.mtBadge, { backgroundColor: badgeColor }]}>
                    <Text style={styles.mtBadgeText}>{badge}</Text>
                  </View>
                  <View style={styles.mtContent}>
                    <Text style={[styles.mtLabel, isTransition && styles.mtLabelBold]}>
                      {label}
                    </Text>
                    {detail ? (
                      <Text style={styles.mtDetail}>{detail}</Text>
                    ) : null}
                  </View>
                </View>
              );
            })
          )}

          <TouchableOpacity
            style={[styles.secondaryBtn, { marginTop: 8 }]}
            onPress={onCopyMotionTimeline}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>Copy motion timeline</Text>
          </TouchableOpacity>
        </CollapsibleSection>

        {/* =====================================================
            Task #21 — Pipeline Timestamps
            Side-by-side table of per-stage last-seen timestamps.
            The first stage whose timestamp diverges from Charles's
            is the first failing stage in the pipeline.
        ===================================================== */}
        <CollapsibleSection
          id="pipeline-ts"
          title="Pipeline Timestamps"
          expanded={!!expanded['pipeline-ts']}
          onToggle={toggleSection}
          testID="diagnostics-pipeline-ts"
          defaultExpanded
        >
          {(() => {
            const now = nowTick;
            const pts = pipelineTs;

            const stages: { label: string; key: keyof PipelineTimestamps; note?: string }[] = [
              { label: 'Activity callback',   key: 'activity',           note: 'Android Activity Recognition' },
              { label: 'Motion callback',      key: 'motion',             note: 'onMotionChange (moving↔stationary)' },
              { label: 'Location callback',    key: 'location',           note: 'onLocation (GPS fix received)' },
              { label: 'Heartbeat (JS)',        key: 'heartbeat_js',       note: 'onHeartbeat — JS runtime alive' },
              { label: 'Headless invoked',     key: 'headless_invoked',   note: 'HeadlessTask — any event' },
              { label: 'Headless heartbeat',   key: 'headless_heartbeat', note: 'HeadlessTask — getCurrentPosition ok' },
              { label: 'HTTP attempt',         key: 'http_attempt',       note: 'onHttp — any upload' },
              { label: 'HTTP success',         key: 'http_success',       note: 'onHttp — 200/201 confirmed' },
            ];

            // Find the first stage older than 5 min while a later stage is fresh.
            // That divergence is the leading indicator of the failing stage.
            const STALE_MS = 5 * 60 * 1000;

            return (
              <View style={styles.card}>
                {/* Listeners guard row */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#374151' }}>
                  <Text style={[styles.entryK, { flex: 1 }]}>listeners_attached</Text>
                  <Text style={[styles.entry, { fontWeight: '700', color: listenersAttachedFlag ? '#10B981' : '#EF4444' }]}>
                    {listenersAttachedFlag ? 'YES' : 'NO — callbacks are deaf'}
                  </Text>
                </View>

                {stages.map(({ label, key, note }) => {
                  const ts = pts?.[key] ?? null;
                  const ageMs = ts !== null ? now - ts : null;
                  const isStale = ageMs !== null && ageMs > STALE_MS;
                  const isMissing = ts === null;

                  return (
                    <View key={key} style={{ paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#374151' }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                        <Text style={[styles.entryK, { flex: 1 }]}>{label}</Text>
                        <Text style={[styles.entry, { fontWeight: '600', color: isMissing ? '#6B7280' : isStale ? '#EF4444' : '#10B981' }]}>
                          {isMissing
                            ? 'never'
                            : ageMs !== null && ageMs < 60_000
                              ? `${Math.round(ageMs / 1000)}s ago`
                              : formatAgeMs(ageMs ?? 0)}
                        </Text>
                      </View>
                      {note ? <Text style={[styles.muted, { fontSize: 10, marginTop: 1 }]}>{note}</Text> : null}
                    </View>
                  );
                })}

                <Text style={[styles.muted, { marginTop: 8, fontSize: 11 }]}>
                  Red = last seen &gt;5 min ago. First red row in this sequence is the first failing pipeline stage.
                </Text>
              </View>
            );
          })()}

          <TouchableOpacity
            style={[styles.secondaryBtn, { marginTop: 8 }]}
            onPress={async () => {
              if (!pipelineTs) return;
              const now = Date.now();
              const lines = [
                `Pipeline Timestamps — ${new Date(now).toISOString()}`,
                `listeners_attached: ${listenersAttachedFlag}`,
                ...Object.entries(pipelineTs).map(([k, v]) =>
                  `${k}: ${v === null ? 'never' : `${formatAgeMs(now - v)} ago (${new Date(v).toISOString()})`}`
                ),
              ];
              await Clipboard.setStringAsync(lines.join('\n'));
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>Copy pipeline timestamps</Text>
          </TouchableOpacity>

          {/* Task #53 — Force-push snapshot for plumbing validation */}
          <TouchableOpacity
            style={[
              styles.secondaryBtn,
              { marginTop: 8, opacity: snapshotPushing ? 0.6 : 1 },
            ]}
            onPress={async () => {
              if (snapshotPushing) return;
              // Clear any pending auto-clear and any stale result immediately
              // so the button never shows a previous outcome while the new push
              // is in-flight (Task #92).
              if (snapshotPushResultTimerRef.current !== null) {
                clearTimeout(snapshotPushResultTimerRef.current);
                snapshotPushResultTimerRef.current = null;
              }
              setSnapshotPushing(true);
              setSnapshotPushResult(null);
              const result = await triggerDeviceSnapshotNow();
              setSnapshotPushing(false);
              const msg = result.ok
                ? '✓ Snapshot pushed — tap "Fetch Device Comparison" to verify'
                : `✗ ${result.error}`;
              setSnapshotPushResult(msg);
              // Auto-clear after 8 s so the result never misleads the next tap.
              snapshotPushResultTimerRef.current = setTimeout(() => {
                setSnapshotPushResult(null);
                snapshotPushResultTimerRef.current = null;
              }, 8000);
            }}
            disabled={snapshotPushing}
            activeOpacity={0.85}
            testID="diagnostics-push-snapshot-btn"
          >
            <Text style={styles.secondaryBtnText}>
              {snapshotPushing ? '⏳  Pushing…' : '📤  Push my snapshot now (test)'}
            </Text>
          </TouchableOpacity>
          {snapshotPushResult !== null ? (
            <Text style={[
              styles.muted,
              {
                marginTop: 6,
                fontSize: 12,
                color: snapshotPushResult.startsWith('✓') ? '#10B981' : '#EF4444',
              },
            ]}>
              {snapshotPushResult}
            </Text>
          ) : null}
        </CollapsibleSection>

        {/* =====================================================
            Task #21 Deliverable 2 — Device Comparison
            Side-by-side table of Charles vs Joyce (or any two
            family members) so Charles can see exactly which
            pipeline stage diverges while Joyce is stale.

            Data sources:
              • last_seen / captured_at / is_moving / battery —
                from the backend members collection (updated on
                every native SDK upload, visible even when the JS
                heartbeat is silent).
              • device_snapshot — pipeline timestamps pushed by
                the device heartbeat stale-detection path
                (locationEngine.pushDeviceSnapshotToBackend).

            The column that goes stale while others stay fresh
            is the first failing stage.
        ===================================================== */}
        <CollapsibleSection
          id="device-comparison"
          title="Device Comparison (Side-by-Side)"
          expanded={!!expanded['device-comparison']}
          onToggle={toggleSection}
          hint="Compare all family members' upload freshness and pipeline state at the same instant. Fetch from server to refresh."
          testID="diagnostics-device-comparison"
          autoRefreshLabel={!!expanded['device-comparison'] ? '⟳ 60s' : undefined}
        >
          <TouchableOpacity
            style={[styles.secondaryBtn, { marginBottom: 8 }]}
            onPress={fetchFamilySnapshot}
            disabled={familySnapshotLoading}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>
              {familySnapshotLoading ? '⏳  Fetching…' : '🔄  Fetch Device Comparison'}
            </Text>
          </TouchableOpacity>

          {familySnapshot?.err ? (
            <View style={styles.card}>
              <Text style={[styles.entry, { color: '#EF4444' }]}>
                Error: {familySnapshot.err}
              </Text>
            </View>
          ) : familySnapshot?.data ? (() => {
            const members: any[] = familySnapshot.data.members ?? [];
            const fetchedAt: number = familySnapshot.at ?? Date.now();
            const fetchedAgo = Math.round((nowTick - fetchedAt) / 1000);

            // Helper: format an age in ms with colour coding.
            const ageCell = (ageMs: number | null | undefined, warn = 5 * 60_000, crit = 15 * 60_000): ReactNode => {
              if (ageMs === null || ageMs === undefined) {
                return <Text style={{ color: '#6B7280', fontSize: 12 }}>—</Text>;
              }
              const color = ageCellColor(ageMs, warn, crit);
              const s = Math.round(ageMs / 1000);
              const label = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
              return <Text style={{ color, fontWeight: '700', fontSize: 12 }}>{label} ago</Text>;
            };

            const boolCell = (val: boolean | null | undefined, trueLabel = 'YES', falseLabel = 'NO'): ReactNode => {
              if (val === null || val === undefined) return <Text style={{ color: '#6B7280', fontSize: 12 }}>—</Text>;
              return <Text style={{ color: val ? '#10B981' : '#EF4444', fontWeight: '700', fontSize: 12 }}>{val ? trueLabel : falseLabel}</Text>;
            };

            const strCell = (val: string | null | undefined): ReactNode => (
              <Text style={{ color: '#374151', fontSize: 12 }} numberOfLines={1}>
                {val ?? '—'}
              </Text>
            );

            // ── First-failing-stage auto-detection ─────────────────────────────
            // Pipeline stage order matches the data flow from SDK activity
            // recognition through to the confirmed HTTP upload.  The first
            // stage whose age exceeds the crit threshold (15 min) is the
            // root-cause stage — the point where the pipeline stopped.
            //
            // Note: all *_age_ms values in device_snapshot are ages AT THE
            // TIME the snapshot was pushed (not "now"), so a stage showing
            // 8 min at snapshot time when the snapshot itself is 12 min old
            // means the actual current age is ~20 min.  The "Snapshot age"
            // row below provides the offset context.
            const SNAPSHOT_STAGE_ORDER: { label: string; snapshotKey: string }[] = [
              { label: 'Activity cb',      snapshotKey: 'activity_age_ms' },
              { label: 'Motion cb',        snapshotKey: 'motion_age_ms' },
              { label: 'Location cb',      snapshotKey: 'location_age_ms' },
              { label: 'Heartbeat JS',     snapshotKey: 'hb_js_age_ms' },
              { label: 'Headless invoked', snapshotKey: 'hl_inv_age_ms' },
              { label: 'HTTP success',     snapshotKey: 'http_ok_age_ms' },
            ];
            const SNAP_CRIT_MS = 15 * 60_000;

            /** Returns the label of the first pipeline stage whose age
             *  exceeded SNAP_CRIT_MS at snapshot time, or null if all
             *  stages were healthy (or the snapshot is absent). */
            const getFirstFailingStage = (ds: any): string | null => {
              if (!ds) return null;
              for (const { label, snapshotKey } of SNAPSHOT_STAGE_ORDER) {
                const ageMs: number | null | undefined = ds[snapshotKey];
                if (ageMs !== null && ageMs !== undefined && ageMs >= SNAP_CRIT_MS) {
                  return label;
                }
              }
              return null;
            };

            /**
             * Returns how many ms have elapsed since the device_snapshot was
             * pushed, measured from `nowTick` (the live 1-second clock).
             * Returns null if the snapshot has no timestamp.
             */
            const getSnapshotElapsedMs = (m: any): number | null => {
              const ds = m.device_snapshot;
              return computeSnapshotElapsedMs(ds?.at, ds?.stored_at, nowTick);
            };

            /**
             * Effective age = stage_age_at_snapshot_push + elapsed_since_push.
             * Returns null if either component is missing.
             */
            const effectiveSnapshotAgeMs = (m: any, stageAgeMs: number | null | undefined): number | null => {
              const ds = m.device_snapshot;
              return computeEffectiveSnapshotAgeMs(ds?.at, ds?.stored_at, nowTick, stageAgeMs);
            };

            // Comparison rows: label + accessor function.
            type RowDef = { label: string; render: (m: any) => ReactNode };
            const rows: RowDef[] = [
              {
                label: 'Last backend upload',
                render: (m) => ageCell(m.last_seen_age_ms, 5 * 60_000, 15 * 60_000),
              },
              {
                label: 'GPS captured',
                render: (m) => {
                  if (!m.captured_at) return <Text style={{ color: '#6B7280', fontSize: 12 }}>—</Text>;
                  try {
                    const ageMs = fetchedAt - new Date(m.captured_at).getTime();
                    return ageCell(ageMs, 5 * 60_000, 15 * 60_000);
                  } catch { return <Text style={{ color: '#6B7280', fontSize: 12 }}>—</Text>; }
                },
              },
              {
                label: 'Moving (SDK)',
                render: (m) => boolCell(m.is_moving, 'MOVING', 'STILL'),
              },
              {
                label: 'Battery',
                render: (m) => {
                  if (m.battery_level === null || m.battery_level === undefined) return <Text style={{ color: '#6B7280', fontSize: 12 }}>—</Text>;
                  const pct = Math.round((m.battery_level ?? 0) * 100);
                  const color = pct >= 30 ? '#10B981' : pct >= 15 ? '#F59E0B' : '#EF4444';
                  return <Text style={{ color, fontWeight: '700', fontSize: 12 }}>{pct}%{m.is_charging ? ' ⚡' : ''}</Text>;
                },
              },
              {
                label: 'GPS accuracy',
                render: (m) => m.gps_accuracy != null
                  ? <Text style={{ color: '#374151', fontSize: 12 }}>{Math.round(m.gps_accuracy)}m</Text>
                  : <Text style={{ color: '#6B7280', fontSize: 12 }}>—</Text>,
              },
              // device_snapshot fields (pushed by JS heartbeat stale-detection).
              // Ages are shown as effective current age = stage_age_at_snapshot + elapsed_since_snapshot.
              {
                label: 'Activity cb (device)',
                render: (m) => ageCell(effectiveSnapshotAgeMs(m, m.device_snapshot?.activity_age_ms), 5 * 60_000, 15 * 60_000),
              },
              {
                label: 'Motion cb (device)',
                render: (m) => ageCell(effectiveSnapshotAgeMs(m, m.device_snapshot?.motion_age_ms), 5 * 60_000, 15 * 60_000),
              },
              {
                label: 'Location cb (device)',
                render: (m) => ageCell(effectiveSnapshotAgeMs(m, m.device_snapshot?.location_age_ms), 5 * 60_000, 15 * 60_000),
              },
              {
                label: 'Heartbeat JS (device)',
                render: (m) => ageCell(effectiveSnapshotAgeMs(m, m.device_snapshot?.hb_js_age_ms), 5 * 60_000, 15 * 60_000),
              },
              {
                label: 'Headless invoked (device)',
                render: (m) => ageCell(effectiveSnapshotAgeMs(m, m.device_snapshot?.hl_inv_age_ms), 5 * 60_000, 15 * 60_000),
              },
              {
                label: 'HTTP success (device)',
                // httpOkCellColor is the exported presentation model for this row
                // (deviceComparisonUtils.ts).  Calling it with `nowTick` is the
                // explicit linkage that turns the cell amber as the live clock
                // advances — without requiring a new server fetch.  Tests verify
                // this by calling httpOkCellColor(member, nowMs) with advancing nowMs.
                render: (m) => {
                  const ageMs = effectiveSnapshotAgeMs(m, m.device_snapshot?.http_ok_age_ms);
                  if (ageMs === null) return <Text style={{ color: '#6B7280', fontSize: 12 }}>—</Text>;
                  const s = Math.round(ageMs / 1000);
                  const label = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
                  return <Text style={{ color: httpOkCellColor(m, nowTick), fontWeight: '700', fontSize: 12 }}>{label} ago</Text>;
                },
              },
              {
                label: 'Listeners attached (device)',
                render: (m) => boolCell(m.device_snapshot?.listeners_attached),
              },
              {
                label: 'SDK enabled (device)',
                render: (m) => boolCell(m.device_snapshot?.sdk_enabled),
              },
              {
                label: 'AppState (device)',
                render: (m) => strCell(m.device_snapshot?.app_state),
              },
              {
                label: 'Snapshot age',
                render: (m) => {
                  const ds = m.device_snapshot;
                  if (!ds?.at && !ds?.stored_at) return <Text style={{ color: '#6B7280', fontSize: 12 }}>never pushed</Text>;
                  try {
                    const tsStr = ds.at || ds.stored_at;
                    const ageMs = fetchedAt - new Date(tsStr).getTime();
                    return ageCell(ageMs, 10 * 60_000, 60 * 60_000);
                  } catch { return <Text style={{ color: '#6B7280', fontSize: 12 }}>—</Text>; }
                },
              },
            ];

            return (
              <View>
                <Text style={[styles.muted, { marginBottom: 6, fontSize: 11 }]}>
                  Fetched {fetchedAgo}s ago · {members.length} member{members.length !== 1 ? 's' : ''} · family group {(familySnapshot.data.family_group_id ?? '').slice(0, 8)}
                </Text>

                {/* ── First-failing-stage summary card ─────────────────────────────
                    Automatically answers "which pipeline stage stopped first?"
                    Visible only once at least one member has pushed a snapshot.
                    When this card shows a red entry, that IS the root-cause stage.
                    ─────────────────────────────────────────────────────────────── */}
                {members.some((m) => m.device_snapshot) && (
                  <View style={{ backgroundColor: '#1F2937', borderRadius: 6, padding: 10, marginBottom: 8 }}>
                    <Text style={{ color: '#9CA3AF', fontSize: 11, fontWeight: '700', marginBottom: 4 }}>
                      🔍 FIRST FAILING STAGE (auto-detected from snapshot)
                    </Text>
                    {members.map((m) => {
                      const firstFailing = getFirstFailingStage(m.device_snapshot);
                      return (
                        <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3 }}>
                          <Text style={{ color: '#D1D5DB', fontSize: 12, fontWeight: '700', width: 72 }} numberOfLines={1}>
                            {m.name?.split(' ')[0] ?? '?'}:
                          </Text>
                          {!m.device_snapshot ? (
                            <Text style={{ color: '#6B7280', fontSize: 12, fontStyle: 'italic' }}>no snapshot yet</Text>
                          ) : firstFailing ? (
                            <Text style={{ color: '#EF4444', fontWeight: '700', fontSize: 12 }}>
                              ❌ {firstFailing}
                            </Text>
                          ) : (
                            <Text style={{ color: '#10B981', fontWeight: '700', fontSize: 12 }}>
                              ✓ all stages healthy at snapshot time
                            </Text>
                          )}
                        </View>
                      );
                    })}
                    <Text style={{ color: '#6B7280', fontSize: 10, marginTop: 6 }}>
                       Ages are at snapshot time — add &quot;Snapshot age&quot; for current effective age
                    </Text>
                  </View>
                )}

                {/* Column header row */}
                <View style={{ flexDirection: 'row', backgroundColor: '#1F2937', paddingVertical: 6, paddingHorizontal: 4, borderRadius: 4, marginBottom: 2 }}>
                  <Text style={{ flex: 1.4, color: '#9CA3AF', fontSize: 11, fontWeight: '700' }}>Stage</Text>
                  {members.map((m) => (
                    <Text key={m.id} style={{ flex: 1, color: '#F9FAFB', fontSize: 11, fontWeight: '700', textAlign: 'center' }} numberOfLines={1}>
                      {m.name?.split(' ')[0] ?? '?'}
                    </Text>
                  ))}
                </View>

                {/* Data rows */}
                {rows.map((row, ri) => (
                  <View key={`cr-${ri}`} style={{
                    flexDirection: 'row',
                    paddingVertical: 6,
                    paddingHorizontal: 4,
                    backgroundColor: ri % 2 === 0 ? '#F9FAFB' : '#FFFFFF',
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: '#E5E7EB',
                  }}>
                    <Text style={{ flex: 1.4, fontSize: 11, color: '#374151' }} numberOfLines={2}>
                      {row.label}
                    </Text>
                    {members.map((m) => (
                      <View key={`${m.id}-${ri}`} style={{ flex: 1, alignItems: 'center' }}>
                        {row.render(m)}
                      </View>
                    ))}
                  </View>
                ))}

                {/* Footnote — effective-age approximation */}
                {members.some((m) => m.device_snapshot) && (
                  <Text style={{ color: '#6B7280', fontSize: 10, fontStyle: 'italic', marginTop: 8, lineHeight: 14 }}>
                    * Device pipeline ages shown as effective current age (stage age at snapshot + time elapsed since snapshot). Approximate — snapshot was captured at a single point in time, not continuously.
                  </Text>
                )}

                {/* Copy action */}
                <TouchableOpacity
                  style={[styles.secondaryBtn, { marginTop: 10 }]}
                  onPress={async () => {
                    try {
                      await Clipboard.setStringAsync(JSON.stringify(familySnapshot.data, null, 2));
                      Alert.alert('Copied', 'Device comparison JSON copied to clipboard.');
                    } catch (_e) {}
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.secondaryBtnText}>Copy comparison JSON</Text>
                </TouchableOpacity>
              </View>
            );
          })() : (
            <View style={styles.card}>
              <Text style={styles.muted}>
                 Tap &quot;Fetch Device Comparison&quot; to load both devices&apos; upload freshness and
                pipeline state from the server. Green = &lt;5 min · Amber = 5-15 min · Red = &gt;15 min.{'\n\n'}
                 The &quot;device_snapshot&quot; rows only appear once each device has been stale for &gt;5 min
                and has pushed its pipeline timestamps to the backend.
              </Text>
            </View>
          )}
        </CollapsibleSection>

        {/* =====================================================
            Build XX — Refresh Pipeline
            Instruments the complete path from dashboard refresh
            trigger → API response → store write, so we can
            pinpoint exactly where stale data stops propagating.

            Key signals:
              [DASH LOAD]     which event triggered a /members fetch
              [UPSERT]        single-member write, prev → new location
              [BATCH]         batch write from dashboard, advanced/regressed count
              [FETCH-ALL]     store's own fetchAll(), same stats
              ⚠ REGRESSION   incoming last_seen is OLDER than stored —
                              a slower response overwrote a fresher one
              [DROPPED]       fetchSeq race-protection suppressed the write
            ===================================================== */}
        <CollapsibleSection
          id="pipeline"
          title="Refresh Pipeline"
          count={pipelineLog.length}
          hint="Logs every dashboard refresh trigger and store write — newest first. Look for ⚠ REGRESSION entries to spot race conditions."
          defaultExpanded
          expanded={!!expanded['pipeline']}
          onToggle={toggleSection}
          testID="diagnostics-pipeline"
        >
          {pipelineLog.length === 0 ? (
            <Text style={styles.muted}>No pipeline events yet. Trigger a refresh or navigate to the dashboard.</Text>
          ) : (
            pipelineLog.slice(0, 40).map((entry, i) => {
              const isDashLoad = entry.stage === 'dashboard-load';
              const isBatch = entry.stage === 'store-upsert-many' || entry.stage === 'store-fetch-all';
              const isRegression = (entry.lastSeenDeltaMs !== undefined && entry.lastSeenDeltaMs !== null && entry.lastSeenDeltaMs < 0)
                || (entry.batchRegressed !== undefined && entry.batchRegressed > 0);
              const isDropped = entry.droppedBySeq === true;

              let badgeLabel = '?';
              let badgeColor = '#9CA3AF';
              if (isDashLoad) { badgeLabel = 'DASH LOAD'; badgeColor = '#3B82F6'; }
              else if (entry.stage === 'store-upsert-one') {
                badgeLabel = isDropped ? 'DROPPED' : isRegression ? '⚠ REGRESS' : 'UPSERT';
                badgeColor = isDropped ? '#9CA3AF' : isRegression ? '#EF4444' : '#10B981';
              } else if (entry.stage === 'store-upsert-many') {
                badgeLabel = isRegression ? '⚠ BATCH' : 'BATCH';
                badgeColor = isRegression ? '#EF4444' : '#8B5CF6';
              } else if (entry.stage === 'store-fetch-all') {
                badgeLabel = isRegression ? '⚠ FETCH-ALL' : 'FETCH-ALL';
                badgeColor = isRegression ? '#EF4444' : '#14B8A6';
              }

              // Build the main label line
              let label = '';
              let detail = '';
              if (isDashLoad) {
                label = `trigger=${entry.trigger ?? '—'}`;
              } else if (isBatch) {
                label = `${entry.batchTotal ?? 0} members`;
                const parts: string[] = [];
                if (entry.batchAdvanced)   parts.push(`↑${entry.batchAdvanced} fresh`);
                if (entry.batchUnchanged)  parts.push(`=${entry.batchUnchanged} same`);
                if (entry.batchRegressed)  parts.push(`↓${entry.batchRegressed} older ⚠`);
                if (entry.batchFirstWrite) parts.push(`+${entry.batchFirstWrite} new`);
                detail = parts.join('  ');
              } else {
                // upsert-one
                const name = entry.memberName ?? entry.memberId?.slice(0, 8) ?? '—';
                const prevLoc = entry.prevLocationName ?? '(none)';
                const newLoc = entry.newLocationName ?? '(none)';
                if (isDropped) {
                  label = `${name}  [dropped by seq]`;
                  detail = `${prevLoc} unchanged`;
                } else if (entry.prevLastSeen == null) {
                  label = `${name}  first write`;
                  detail = newLoc;
                } else {
                  const deltaMs = entry.lastSeenDeltaMs ?? 0;
                  const deltaSign = deltaMs >= 0 ? '+' : '';
                  const deltaSec = Math.round(Math.abs(deltaMs) / 1000);
                  const arrow = deltaMs >= 0 ? '↑' : '↓⚠';
                  label = `${name}  ${arrow} ${deltaSign}${deltaSec}s`;
                  if (prevLoc !== newLoc) {
                    detail = `"${prevLoc}" → "${newLoc}"`;
                  } else {
                    detail = `"${newLoc}" (same place)`;
                  }
                }
              }

              return (
                <View key={`pl-${entry.seq}-${i}`} style={[styles.plRow, isRegression && styles.plRowWarn]}>
                  <Text style={styles.plTime}>{fmtTime(entry.t)}</Text>
                  <View style={[styles.plBadge, { backgroundColor: badgeColor }]}>
                    <Text style={styles.plBadgeText}>{badgeLabel}</Text>
                  </View>
                  <View style={styles.plContent}>
                    <Text style={styles.plLabel}>{label}</Text>
                    {!!detail && <Text style={styles.plDetail}>{detail}</Text>}
                  </View>
                </View>
              );
            })
          )}
          <TouchableOpacity
            style={[styles.secondaryBtn, { marginTop: 8 }]}
            onPress={onCopyPipelineLog}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>Copy pipeline log</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.dangerBtn, { marginTop: 6 }]}
            onPress={() => {
              clearRefreshPipelineLog().then(reload);
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.dangerBtnText}>Clear pipeline log</Text>
          </TouchableOpacity>
        </CollapsibleSection>

        {/* =====================================================
            v1.2.1 (build 41) — Transistor Location Engine.
            Shows whether the background-geolocation native module
            is loaded, the SDK's current tracking state, and a
            ring-buffer of every lifecycle event captured since
            the app started.  This is the primary diagnostic for
            verifying that the engine is actually running after
            authentication (the open question from the v1.2.0 (40)
            field test).
            ===================================================== */}
        <View style={styles.section} testID="diagnostics-engine">
          <TouchableOpacity
            style={styles.collapsibleHeader}
            onPress={() => toggleSection('engine')}
            activeOpacity={0.7}
            accessibilityLabel={`${expanded.engine ? 'Collapse' : 'Expand'} Engine`}
          >
            <Text style={styles.collapsibleChevron}>{expanded.engine ? '▼' : '▶'}</Text>
            <Text style={styles.collapsibleTitle}>Transistor Location Engine</Text>
            <Text style={styles.collapsibleCount}>{engineLog.length}</Text>
          </TouchableOpacity>
          {!!expanded.engine && (<>
          <Text style={styles.sectionHint}>
            Live state of the background-location SDK.  If &quot;available&quot; is true
            but &quot;enabled&quot; is false, the engine never started — check the log
            for the failure reason.  If both are true, look for `sdk_onHeartbeat`
            entries while the app is backgrounded to confirm tracking continues.
          </Text>
          <View style={styles.card}>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>available: </Text>
              {String(engineAvailable)}
              {!engineAvailable && (
                <Text style={styles.entry}> (native module not loaded — web or non-Transistor build)</Text>
              )}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>enabled: </Text>
              {String(engineState?.enabled ?? false)}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>trackingMode: </Text>
              {engineState?.trackingMode ?? 'unknown'}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>isMoving: </Text>
              {engineState?.isMoving === null ? '—' : String(engineState?.isMoving)}
            </Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>odometer (m): </Text>
              {engineState?.odometerMeters === null
                ? '—'
                : String(Math.round((engineState?.odometerMeters ?? 0) * 10) / 10)}
            </Text>
          </View>

          {/* Task 68 — Upload ratio summary card.
              Shows ok vs fail counts from the ring buffer so Charles can
              confirm at a glance whether uploads are landing or bouncing
              without reading individual log entries.  Both the foreground
              (http_upload_success/failure) and headless (headless_http_ok/
              headless_http_error) paths feed into sdk_onHttp, which is what
              we count here to avoid double-counting. */}
          <Text style={[styles.subSectionLabel, { marginTop: 12 }]}>Upload ratio (this buffer)</Text>
          <View style={styles.card} testID="diagnostics-upload-ratio">
            {uploadRatio.total === 0 ? (
              <Text style={styles.entryLine}>
                <Text style={styles.entry}>No uploads recorded yet in this buffer.</Text>
              </Text>
            ) : (
              <>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>✅ ok: </Text>
                  <Text style={[styles.bold, uploadRatio.ok > 0 ? { color: '#22c55e' } : {}]}>
                    {uploadRatio.ok}
                  </Text>
                  <Text style={styles.entry}>  /  total: {uploadRatio.total}</Text>
                </Text>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>❌ failed: </Text>
                  <Text style={[styles.bold, uploadRatio.fail > 0 ? { color: '#ef4444' } : {}]}>
                    {uploadRatio.fail}
                  </Text>
                  {uploadRatio.lastFailStatus !== null && (
                    <Text style={styles.entry}>  (last status: {uploadRatio.lastFailStatus})</Text>
                  )}
                </Text>
              </>
            )}
          </View>

          <Text style={[styles.subSectionLabel, { marginTop: 12 }]}>Lifecycle log (last 30)</Text>
          {engineLog.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.entryLine}>
                <Text style={styles.entry}>
                  No events recorded yet.  If you reached this screen after login but
                  see nothing here, the layout effect never fired — likely an auth-state
                  or member-row issue.
                </Text>
              </Text>
            </View>
          ) : (
            engineLog.slice().reverse().map((entry, i) => (
              <View key={`eng-${i}-${entry.at}`} style={styles.card}>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>{fmt(entry.at)}: </Text>
                  <Text style={styles.bold}>{entry.event}</Text>
                </Text>
                {entry.detail && Object.keys(entry.detail).length > 0 ? (
                  <Text style={styles.entryLine}>
                    <Text style={styles.entry}>
                      {Object.entries(entry.detail)
                        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                        .join('  ·  ')}
                    </Text>
                  </Text>
                ) : null}
              </View>
            ))
          )}

          <TouchableOpacity
            testID="diagnostics-clear-engine-log"
            style={[styles.secondaryBtn, { marginTop: 8 }]}
            onPress={async () => {
              await clearEngineLog();
              await reload();
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>Clear engine log</Text>
          </TouchableOpacity>
          </>)}
        </View>

        {/* =====================================================
            v1.2.0 (43) — Dashboard Refresh Log.  Pure-additive
            observation of every load() call that the Dashboard
            tab fires.  Captures: who triggered (interval / focus /
            AppState / notif / pull / quick-checkin), four
            timestamps (start, get-sent, get-received, setState),
            full raw /members response body, member ids that fired
            the silent-push pull-on-stale cascade, plus any error.
            This panel is the single source of truth for "what
            did the API return vs what the UI rendered" during a
            stale-render incident.
            ===================================================== */}
        <View style={styles.section} testID="diagnostics-dash-load">
          <TouchableOpacity
            style={styles.collapsibleHeader}
            onPress={() => toggleSection('dashboard')}
            activeOpacity={0.7}
            accessibilityLabel={`${expanded.dashboard ? 'Collapse' : 'Expand'} Dashboard`}
          >
            <Text style={styles.collapsibleChevron}>{expanded.dashboard ? '▼' : '▶'}</Text>
            <Text style={styles.collapsibleTitle}>Dashboard Refresh Log</Text>
            <Text style={styles.collapsibleCount}>{dashLoadLog.length}</Text>
          </TouchableOpacity>
          {!!expanded.dashboard && (<>
          <Text style={styles.sectionHint}>
            Every dashboard `load()` invocation, newest first.  Each entry shows:
            trigger source, the four end-to-end timestamps, the HTTP status,
            the raw `/members` response (full unaltered JSON), and which member
            ids fired the silent-push pull-on-stale cascade.  This is the
            authoritative record of what the API returned at each refresh.
          </Text>
          {dashLoadLog.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.entryLine}>
                <Text style={styles.entry}>
                  No dashboard refreshes recorded yet.  Open the Dashboard tab
                  and wait for a refresh cycle.
                </Text>
              </Text>
            </View>
          ) : (
            dashLoadLog.slice().reverse().map((entry, i) => {
              const dur = (entry.t_get_received && entry.t_get_sent)
                ? `${entry.t_get_received - entry.t_get_sent}ms`
                : '—';
              const total = (entry.t_setstate && entry.t_load_started)
                ? `${entry.t_setstate - entry.t_load_started}ms`
                : '—';
              return (
                <View key={`dl-${i}-${entry.id}`} style={styles.card}>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>{fmt(entry.t_load_started)} </Text>
                    <Text style={styles.bold}>[{entry.trigger}]</Text>
                    <Text style={styles.entry}>  status={entry.http_status ?? '—'}  http={dur}  total={total}  count={entry.member_count ?? '—'}</Text>
                  </Text>
                  {entry.server_date_header ? (
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>server Date: </Text>
                      <Text style={styles.entry}>{entry.server_date_header}</Text>
                    </Text>
                  ) : null}
                  {entry.error ? (
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>error: </Text>
                      <Text style={styles.entry}>{entry.error}</Text>
                    </Text>
                  ) : null}
                  {entry.staleness_triggered_for.length > 0 ? (
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>silent-push fired for: </Text>
                      <Text style={styles.entry}>
                        {entry.staleness_triggered_for.map((m) => m.slice(-6)).join(', ')}
                      </Text>
                    </Text>
                  ) : null}
                  {entry.raw_members && entry.raw_members.length > 0 ? (
                    entry.raw_members.map((mb: any, j: number) => (
                      <Text key={`dl-${entry.id}-mb-${j}`} style={styles.entryLine}>
                        <Text style={styles.entryK}>id={(mb?.id || '').slice(-6)} </Text>
                        <Text style={styles.entry}>
                          user_id={(mb?.user_id || '').slice(-6)} · fg={(mb?.family_group_id || '').slice(-6)} · last_seen={mb?.last_seen ?? 'null'} · lat={mb?.latitude ?? '—'} · lon={mb?.longitude ?? '—'} · name={mb?.location_name ?? '—'}
                        </Text>
                      </Text>
                    ))
                  ) : null}
                </View>
              );
            })
          )}
          <TouchableOpacity
            testID="diagnostics-clear-dash-load"
            style={[styles.secondaryBtn, { marginTop: 8 }]}
            onPress={async () => {
              await clearDashboardLoadLog();
              await reload();
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>Clear dashboard refresh log</Text>
          </TouchableOpacity>
          </>)}
        </View>

        {/* =====================================================
            v1.2.0 (44) — Card Render & Broadcast Timeline.
            Interleaves two event streams (card-render and
            broadcast) into a single seq-ordered list.  Use this
            to pin down whether the visible card text matches
            what was just broadcast vs. what was stored earlier.
            ===================================================== */}
        <View style={styles.section} testID="diagnostics-card-render">
          <TouchableOpacity
            style={styles.collapsibleHeader}
            onPress={() => toggleSection('card-render')}
            activeOpacity={0.7}
            accessibilityLabel={`${expanded['card-render'] ? 'Collapse' : 'Expand'} Card Render`}
          >
            <Text style={styles.collapsibleChevron}>{expanded['card-render'] ? '▼' : '▶'}</Text>
            <Text style={styles.collapsibleTitle}>Card Render & Broadcast Timeline</Text>
            <Text style={styles.collapsibleCount}>{cardLog.length}</Text>
          </TouchableOpacity>
          {!!expanded['card-render'] && (<>
          <Text style={styles.sectionHint}>
            Every card render (`card-render`) and every member broadcast
            (`broadcast`) in strict seq order.  Compare the `last_seen` value
            in a `broadcast` entry with the `last_seen` painted by the very
            next `card-render` entry for the same `member_id` — divergence
            here proves where stale data enters the UI.
          </Text>
          {cardLog.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.entryLine}>
                <Text style={styles.entry}>
                  No card renders or broadcasts recorded yet.  Open the
                  Dashboard tab to populate this log.
                </Text>
              </Text>
            </View>
          ) : (
            // Sort by seq descending (newest first) to keep the most
            // diagnostically-interesting entries at the top.
            cardLog.slice().sort((a, b) => b.seq - a.seq).map((entry) => {
              const seqStr = `#${entry.seq}`;
              const mid = entry.member_id.slice(-6);
              if (entry.src === 'card-render') {
                return (
                  <View key={`cr-${entry.seq}`} style={styles.card}>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>{seqStr} {fmt(entry.at)} </Text>
                      <Text style={styles.bold}>[card-render]</Text>
                      <Text style={styles.entry}>  member={mid}  refreshing={String(entry.refreshing)}</Text>
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>  prop last_seen: </Text>
                      <Text style={styles.entry}>{entry.last_seen ?? 'null'}</Text>
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>  rendered ageLabel: </Text>
                      <Text style={styles.entry}>&quot;{entry.age_label}&quot;</Text>
                    </Text>
                  </View>
                );
              }
              // broadcast entry
              return (
                <View key={`bc-${entry.seq}`} style={styles.card}>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>{seqStr} {fmt(entry.at)} </Text>
                    <Text style={styles.bold}>[broadcast]</Text>
                    <Text style={styles.entry}>  member={mid}  is_newer={String(entry.is_newer)}</Text>
                  </Text>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  broadcast last_seen: </Text>
                    <Text style={styles.entry}>{entry.broadcast_last_seen ?? 'null'}</Text>
                  </Text>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>  prior state last_seen: </Text>
                    <Text style={styles.entry}>{entry.prior_state_last_seen ?? 'null'}</Text>
                  </Text>
                </View>
              );
            })
          )}
          <TouchableOpacity
            testID="diagnostics-clear-card-log"
            style={[styles.secondaryBtn, { marginTop: 8 }]}
            onPress={async () => {
              await clearCardRenderLog();
              await reload();
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>Clear card render & broadcast log</Text>
          </TouchableOpacity>
          </>)}
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
            shows `sound: &quot;default&quot;`, that&apos;s the leak source.
          </Text>
          <View style={styles.card} testID="diagnostics-notif-log">
            {notifLog.length === 0 ? (
              <Text style={styles.muted}>— no notifications observed yet.</Text>
            ) : notifLog.slice(0, 20).map((n, i) => (
              <View key={i} style={{ marginBottom: 8 }}>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>{fmt(n.at)} </Text>
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
            is the server, FCM, or the device&apos;s GPS warmup.
          </Text>
          <View style={styles.card} testID="diagnostics-refresh-traces">
            {refreshTraces.length === 0 ? (
              <Text style={styles.muted}>— no traces yet. Tap Refresh on the dashboard, then come back.</Text>
            ) : refreshTraces.slice(0, 20).map((t, i) => (
              <View key={i} style={{ marginBottom: 8 }}>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>{fmt(t.requested_at)} </Text>
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

        {/* Build 53 — dedicated bg_task_log export.  Focused view of
            the Transistor headless execution trace for remote debug. */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            testID="diagnostics-copy-bg-task-log"
            style={styles.secondaryBtn}
            onPress={onCopyBgTaskLog}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>📤  Export bg_task_log</Text>
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

        {/* Battery System — permanent section (replaces temp Battery Pipeline diag). */}
        <CollapsibleSection
          id="battery-system"
          title="Battery System"
          count={batteryTaskLog.length || null}
          hint={
            'Two independent paths update battery: (A) Transistor SDK headless heartbeat — fires when the ' +
            'location engine is active; (B) WorkManager periodic task — fires every ~4 h regardless of movement. ' +
            'Both PATCH the same /battery endpoint; the backend write-guard keeps the most recent reading.'
          }
          expanded={!!expanded['battery-system']}
          onToggle={toggleSection}
        >
          {/* ── Last update summary (Charles's "Source" field) ───── */}
          {(() => {
            // Find most recent successful update from EITHER path so we
            // can show a single "last refresh" summary with the source label.
            const pathAOk = [...engineLog].reverse()
              .find((e) => e.event === 'headless_battery_patch_ok');
            const pathBOk = [...batteryTaskLog].reverse()
              .find((e) => e.event === 'background_battery_ok');

            const winner =
              pathAOk && pathBOk
                ? (pathAOk.at >= pathBOk.at ? { src: 'Transistor heartbeat', e: pathAOk, isB: false } : { src: 'WorkManager', e: pathBOk, isB: true })
                : pathAOk ? { src: 'Transistor heartbeat', e: pathAOk, isB: false }
                : pathBOk ? { src: 'WorkManager', e: pathBOk, isB: true }
                : null;

            if (!winner) {
              return (
                <View style={styles.card}>
                  <Text style={styles.subSectionLabel}>Last battery update</Text>
                  <Text style={styles.muted}>No battery update recorded yet in this session.</Text>
                </View>
              );
            }

            const ageMs = Date.now() - winner.e.at;
            const min = Math.round(ageMs / 60_000);
            const ageStr = min < 60 ? `${min} min ago` : `${Math.round(ageMs / 3_600_000)} h ago`;
            const ts = new Date(winner.e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const level = winner.isB
              ? winner.e.detail?.levelPct
              : (winner.e.detail?.battLevel != null ? Math.round(Number(winner.e.detail.battLevel) * 100) : null);
            const charging = winner.isB
              ? winner.e.detail?.isCharging
              : winner.e.detail?.battCharging;

            return (
              <View style={styles.card}>
                <Text style={styles.subSectionLabel}>Last battery update</Text>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>Last background refresh  </Text>
                  {`${ts}  (${ageStr})`}
                </Text>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>Source  </Text>
                  {winner.src}
                </Text>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>Battery sent  </Text>
                  {level != null ? `${level} %` : '—'}
                </Text>
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>Charging  </Text>
                  {charging != null ? (charging ? 'Yes' : 'No') : '—'}
                </Text>
              </View>
            );
          })()}

          {/* ── Live device state ─────────────────────────────────── */}
          <View style={[styles.card, { marginTop: 8 }]}>
            <Text style={styles.subSectionLabel}>Live device state</Text>
            <Text style={styles.entryLine}>
              <Text style={styles.entryK}>Device battery (expo-battery): </Text>
              {deviceBatteryLevel != null
                ? `${Math.round(deviceBatteryLevel * 100)} %`
                : '— (unavailable on this device/platform)'}
            </Text>
            {gpsHistory.length > 0 && (() => {
              const latest = gpsHistory[0];
              const rb = latest.raw_battery;
              const sdkPct = rb?.level != null ? Math.round(Number(rb.level) * 100) : null;
              return (
                <Text style={styles.entryLine}>
                  <Text style={styles.entryK}>Last SDK upload battery: </Text>
                  {rb != null
                    ? `${sdkPct != null ? sdkPct + ' %' : '—'}  charging=${rb.is_charging != null ? String(rb.is_charging) : '—'}`
                    : '— (SDK did not send battery in last upload)'}
                </Text>
              );
            })()}
          </View>

          {/* ── Path A: Headless SDK battery events ──────────────── */}
          <View style={[styles.card, { marginTop: 8 }]}>
            <Text style={styles.subSectionLabel}>Path A — Transistor headless</Text>
            {(() => {
              const rev = [...engineLog].reverse();
              const lastOk = rev.find((e) => e.event === 'headless_battery_patch_ok');
              const lastSkip = rev.find((e) => e.event === 'headless_battery_patch_skipped');
              const lastErr = rev.find((e) => e.event === 'headless_battery_patch_error');
              const fmt = (ts: number) => {
                const ageMs = Date.now() - ts;
                const min = Math.round(ageMs / 60_000);
                return min < 60 ? `${min} min ago` : `${Math.round(ageMs / 3_600_000)} h ago`;
              };
              return (
                <>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>Last patch_ok: </Text>
                    {lastOk
                      ? `${fmt(lastOk.at)}  level=${lastOk.detail?.battLevel != null ? Math.round(Number(lastOk.detail.battLevel) * 100) + ' %' : '?'}  charging=${lastOk.detail?.battCharging}`
                      : '— not seen in ring buffer'}
                  </Text>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>Last skipped: </Text>
                    {lastSkip
                      ? `${fmt(lastSkip.at)}  reason=${lastSkip.detail?.reason ?? '?'}`
                      : '—'}
                  </Text>
                  <Text style={styles.entryLine}>
                    <Text style={styles.entryK}>Last error: </Text>
                    {lastErr
                      ? `${fmt(lastErr.at)}  ${String(lastErr.detail?.error ?? '').slice(0, 80)}`
                      : '—'}
                  </Text>
                </>
              );
            })()}
          </View>

          {/* ── Path B: WorkManager periodic task log ────────────── */}
          <View style={[styles.card, { marginTop: 8 }]}>
            <Text style={styles.subSectionLabel}>
              {'Path B — WorkManager (~4 h)  '}
              <Text style={styles.muted}>{`${batteryTaskLog.length} entries`}</Text>
            </Text>
            {batteryTaskLog.length === 0 ? (
              <Text style={styles.muted}>
                No background task executions recorded yet. The first fire will appear here after ~4 hours (or sooner if the OS scheduler runs a maintenance window).
              </Text>
            ) : (
              [...batteryTaskLog].reverse().slice(0, 10).map((entry, i) => {
                const ageMs = Date.now() - entry.at;
                const min = Math.round(ageMs / 60_000);
                const ageStr = min < 60 ? `${min} min ago` : `${Math.round(ageMs / 3_600_000)} h ago`;
                const isOk = entry.event === 'background_battery_ok';
                const isErr = entry.event === 'background_battery_error' || entry.event === 'background_battery_timeout';
                const dotColor = isOk ? Colors.success : isErr ? Colors.error : Colors.textTertiary;
                const detail = entry.detail
                  ? Object.entries(entry.detail)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join('  ')
                  : '';
                return (
                  <View key={i} style={{ flexDirection: 'row', marginTop: 3, flexWrap: 'wrap' }}>
                    <Text style={{ color: dotColor, marginRight: 4 }}>●</Text>
                    <Text style={[styles.entryLine, { flex: 1, marginTop: 0 }]}>
                      <Text style={styles.entryK}>{ageStr}  </Text>
                      {entry.event.replace('background_battery_', '')}{detail ? '  ' + detail : ''}
                    </Text>
                  </View>
                );
              })
            )}
          </View>

          <TouchableOpacity
            style={[styles.secondaryBtn, { marginTop: 8 }]}
            onPress={reload}
            activeOpacity={0.85}
          >
            <Text style={styles.secondaryBtnText}>Reload</Text>
          </TouchableOpacity>
        </CollapsibleSection>

        {/* Build XX — GPS Quality History */}
        <CollapsibleSection
          id="gps-history"
          title="GPS Quality History"
          count={gpsHistoryErr ? '!' : gpsHistory.length || null}
          hint={
            'Last 50 accepted fixes from the backend — full-precision coordinates, accuracy, speed, and heading. ' +
            'Use this to reconstruct GPS behaviour around anomalies: was the accuracy poor? Was the device stationary? ' +
            'Did the next fix immediately correct the position? ' +
            'Not populated until the next accepted upload from this device.'
          }
          expanded={!!expanded['gps-history']}
          onToggle={toggleSection}
        >
          <View style={styles.card}>
            {loading ? (
              <Text style={styles.muted}>Loading…</Text>
            ) : gpsHistoryErr ? (
              <Text style={styles.muted}>Failed to load: {gpsHistoryErr}</Text>
            ) : gpsHistory.length === 0 ? (
              <Text style={styles.muted}>
                No history yet. Will populate after the next accepted location upload from this device.
              </Text>
            ) : (
              gpsHistory.map((e: any, i: number) => {
                const acceptedDate = e.accepted_at ? new Date(e.accepted_at) : null;
                const capturedDate = e.captured_at ? new Date(e.captured_at) : null;
                const latencyS = acceptedDate && capturedDate
                  ? ((acceptedDate.getTime() - capturedDate.getTime()) / 1000).toFixed(1)
                  : null;
                const speedMph = e.speed != null ? (Number(e.speed) * 2.23694).toFixed(1) : null;
                return (
                  <View key={`gh-${i}`} style={styles.entry}>
                    <Text style={styles.entryTime}>
                      {acceptedDate ? acceptedDate.toLocaleTimeString() : '—'}
                      {latencyS !== null ? ` · ${latencyS}s upload lag` : ''}
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>lat/lon: </Text>
                      {typeof e.latitude === 'number' ? e.latitude.toFixed(6) : '—'},{' '}
                      {typeof e.longitude === 'number' ? e.longitude.toFixed(6) : '—'}
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>accuracy: </Text>
                      {e.accuracy != null ? `${Number(e.accuracy).toFixed(1)} m` : '—'}
                      {'   '}
                      <Text style={styles.entryK}>speed: </Text>
                      {speedMph != null ? `${speedMph} mph` : '—'}
                      {'   '}
                      <Text style={styles.entryK}>hdg: </Text>
                      {e.heading != null ? `${Number(e.heading).toFixed(0)}°` : '—'}
                    </Text>
                    <Text style={styles.entryLine}>
                      <Text style={styles.entryK}>moving: </Text>
                      {e.is_moving != null ? String(e.is_moving) : '—'}
                      {'   '}
                      <Text style={styles.entryK}>provider: </Text>
                      {e.provider || '—'}
                      {'   '}
                      <Text style={styles.entryK}>event: </Text>
                      {e.event || '—'}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
        </CollapsibleSection>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Read-path render trace</Text>
            <Text style={styles.sectionCount}>{renderLog.length}</Text>
          </View>
          <Text style={styles.sectionHint}>
            Every dashboard/member fetch (`*-fetch`), every MemberMap prop change
            (`map-props`), every WebView marker-painted confirmation (`map-rendered`).
            Compare the lat/lon across the three for the same member to isolate
            (A) map didn&apos;t render fresh, (B) fetch returned stale, (C) state never updated.
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
                No background task wakes recorded yet. Either the task hasn&apos;t fired since
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
  collapsibleHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 12, marginBottom: 6,
    backgroundColor: Colors.surface,
    borderRadius: 10, borderWidth: 1, borderColor: Colors.border,
    gap: 8,
  },
  collapsibleChevron: {
    fontSize: 13, fontWeight: '800', color: Colors.textTertiary, width: 14,
  },
  collapsibleTitle: {
    flex: 1,
    fontSize: 13, fontWeight: '800', color: Colors.textPrimary,
    letterSpacing: 0.4, textTransform: 'uppercase',
  },
  collapsibleCount: {
    fontSize: 12, fontWeight: '800', color: Colors.primary,
    backgroundColor: Colors.tertiary, paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 8, minWidth: 26, textAlign: 'center', overflow: 'hidden',
  },
  autoRefreshBadge: {
    backgroundColor: '#D1FAE5',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  autoRefreshBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#065F46',
  },
  clearAllBtn: {
    marginBottom: 6, paddingVertical: 14, borderRadius: 12,
    backgroundColor: Colors.error,
    alignItems: 'center', justifyContent: 'center',
  },
  clearAllBtnText: { color: Colors.surface, fontSize: 15, fontWeight: '800' },
  clearAllHint: {
    fontSize: 11.5, color: Colors.textTertiary,
    textAlign: 'center', marginBottom: 18, lineHeight: 16, paddingHorizontal: 6,
  },
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

  // Hero health card — replaces Task 8 summary card.
  // Always visible between the nav header and the ScrollView.
  heroCard: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
    borderRadius: 14,
    borderWidth: 1.5,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
  },
  heroIcon: {
    fontSize: 30,
    lineHeight: 36,
  },
  heroTextBlock: {
    flex: 1,
  },
  heroHeadline: {
    fontSize: 16,
    fontWeight: '800' as const,
    marginBottom: 3,
  },
  heroSubline: {
    fontSize: 13,
    fontWeight: '500' as const,
    lineHeight: 18,
  },

  // summaryCard kept for reference (no longer rendered)
  summaryCard: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },

  // Refresh Pipeline row styles — Build XX
  plRow: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    paddingVertical: 6,
    paddingHorizontal: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
    marginBottom: 2,
    borderRadius: 8,
  },
  plRowWarn: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FCA5A5',
    borderWidth: 1,
  },
  plTime: {
    fontSize: 10,
    fontWeight: '700' as const,
    color: Colors.textTertiary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 3,
    minWidth: 58,
  },
  plBadge: {
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    alignSelf: 'flex-start' as const,
    marginTop: 1,
    minWidth: 58,
    alignItems: 'center' as const,
  },
  plBadgeText: {
    fontSize: 8,
    fontWeight: '800' as const,
    color: '#fff',
    letterSpacing: 0.2,
    textTransform: 'uppercase' as const,
  },
  plContent: { flex: 1 },
  plLabel: {
    fontSize: 12,
    color: Colors.textPrimary,
    lineHeight: 16,
    fontWeight: '600' as const,
  },
  plDetail: {
    fontSize: 11,
    color: Colors.textTertiary,
    lineHeight: 15,
    marginTop: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Motion Timeline row styles — Build 64
  mtRow: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    paddingVertical: 7,
    paddingHorizontal: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
    marginBottom: 2,
    borderRadius: 8,
  },
  mtRowHighlight: {
    backgroundColor: '#F0FDF4',
    borderColor: '#10B981',
    borderWidth: 1,
  },
  mtTime: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: Colors.textTertiary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
    minWidth: 60,
  },
  mtBadge: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'flex-start' as const,
    marginTop: 1,
    minWidth: 70,
    alignItems: 'center' as const,
  },
  mtBadgeText: {
    fontSize: 9,
    fontWeight: '800' as const,
    color: '#fff',
    letterSpacing: 0.3,
    textTransform: 'uppercase' as const,
  },
  mtContent: {
    flex: 1,
  },
  mtLabel: {
    fontSize: 12,
    color: Colors.textPrimary,
    lineHeight: 16,
  },
  mtLabelBold: {
    fontWeight: '800' as const,
  },
  mtDetail: {
    fontSize: 11,
    color: Colors.textTertiary,
    lineHeight: 15,
    marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
