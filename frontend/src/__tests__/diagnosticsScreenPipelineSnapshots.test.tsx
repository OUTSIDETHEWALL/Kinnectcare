/**
 * Full-screen regression guard for the stale-location Diagnostics section.
 *
 * The persisted snapshot payload is an untrusted runtime boundary. Diagnostics
 * must mount when no snapshots exist and when storage contains a partial record.
 */
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockReadPipelineSnapshots = jest.fn<Promise<unknown[]>, []>();
const mockRouter = { back: jest.fn(), push: jest.fn() };

jest.mock('react-native', () => {
  const React = require('react');
  const wrap = (name: string) => {
    const WrappedComponent = ({ children, ...props }: any) =>
      React.createElement(name, props, children);
    WrappedComponent.displayName = name;
    return WrappedComponent;
  };
  return {
    View: wrap('View'),
    Text: wrap('Text'),
    ScrollView: wrap('ScrollView'),
    TouchableOpacity: wrap('TouchableOpacity'),
    ActivityIndicator: wrap('ActivityIndicator'),
    StyleSheet: { create: (styles: any) => styles },
    Alert: { alert: jest.fn() },
    Platform: { OS: 'ios', Version: 'test', select: (values: any) => values.ios ?? values.default },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: ({ children, ...props }: any) =>
      React.createElement('SafeAreaView', props, children),
  };
});

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: 'test', runtimeVersion: 'test' } },
}));
jest.mock('expo-updates', () => ({
  updateId: null,
  channel: null,
  createdAt: null,
  isEmbeddedLaunch: true,
  runtimeVersion: 'test',
}));
jest.mock('expo-battery', () => ({ getBatteryLevelAsync: async () => 0.5 }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));

jest.mock('../Icon', () => {
  const React = require('react');
  return { Icon: (props: any) => React.createElement('Icon', props) };
});
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: null }) }));
jest.mock('../api', () => ({ api: { get: jest.fn(async () => ({ data: { members: [] } })) } }));
jest.mock('../store/memberStore', () => ({ getMyLastSeenMs: () => null }));
jest.mock('../deviceComparisonRefresh', () => ({
  startDeviceComparisonRefresh: () => () => {},
}));
jest.mock('../backgroundRestrictionDetector', () => ({
  getRestrictionStatus: async () => ({
    isRestricted: false,
    powerSaveActive: false,
    restartBlockedByOs: false,
    leonidasRestartFailed: false,
    lastEvidenceAt: null,
  }),
}));
jest.mock('../components/BackgroundRestrictionWarning', () => ({
  BackgroundRestrictionWarning: () => null,
}));
jest.mock('../leonidas', () => ({
  getSnapshot: () => null,
  getRecoveryLog: async () => [],
}));
jest.mock('../leonidas/types', () => ({ PATROL_INTERVAL_SECONDS: 900 }));

jest.mock('../notificationLog', () => ({
  getNotificationLog: async () => [],
  clearNotificationLog: async () => {},
}));
jest.mock('../routeDiagnostics', () => ({
  readRouteLog: async () => [],
  clearRouteLog: async () => {},
}));
jest.mock('../locationRefresh', () => ({
  readLocationRefreshLog: async () => [],
  clearLocationRefreshLog: async () => {},
}));
jest.mock('../backgroundLocation', () => ({
  readBgTaskLog: async () => [],
  clearBgTaskLog: async () => {},
}));
jest.mock('../batteryTask', () => ({
  readBatteryTaskLog: async () => [],
  clearBatteryTaskLog: async () => {},
}));
jest.mock('../screenRenderLog', () => ({
  readScreenRenderLog: async () => [],
  clearScreenRenderLog: async () => {},
}));
jest.mock('../dashboardLoadLog', () => ({
  getDashboardLoadLog: async () => [],
  clearDashboardLoadLog: async () => {},
}));
jest.mock('../cardRenderLog', () => ({
  getCardRenderLog: async () => [],
  clearCardRenderLog: async () => {},
}));
jest.mock('../refreshPipelineLog', () => ({
  getRefreshPipelineLog: async () => [],
  clearRefreshPipelineLog: async () => {},
}));
jest.mock('../pipelineSnapshot', () => {
  const actual = jest.requireActual('../pipelineSnapshot');
  return {
    readPipelineSnapshots: () => mockReadPipelineSnapshots(),
    clearPipelineSnapshots: async () => {},
    normalizePipelineSnapshots: actual.normalizePipelineSnapshots,
  };
});
jest.mock('../diagnosticsStorageAudit', () => ({
  attachDiagnosticsStorageRecordContext: jest.fn(),
  auditDiagnosticsStorage: async () => ({
    version: 1,
    auditId: 'test-audit',
    createdAt: '2026-08-31T00:00:00.000Z',
    entries: [],
    invalidKeys: [],
  }),
  captureDiagnosticsCrash: jest.fn(),
  getDiagnosticsStorageRecordTraceContext: () => null,
  traceDiagnosticsRecords: (_key: string, records: unknown) => records,
  traceDiagnosticsStorageRead: async (_key: string, reader: () => unknown) => reader(),
}));
jest.mock('../locationEngine', () => ({
  getEngineDiagnostics: async () => ({ log: [], state: null, available: false }),
  clearEngineLog: async () => {},
  getPipelineTimestamps: async () => null,
  getLastHttpSuccessTs: async () => null,
  getPersistentHttpUploadStats: async () => null,
  isListenersAttached: () => false,
  triggerDeviceSnapshotNow: async () => null,
  checkBatteryOptimization: async () => null,
  requestShowIgnoreBatteryOptimizations: async () => null,
  requestShowPowerManager: async () => null,
  showDeviceSettingsScreen: async () => null,
  logEvent: async () => {},
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import DiagnosticsScreen from '../diagnosticsFull';
import DiagnosticsRoute from '../../app/diagnostics';

async function mountDiagnostics() {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<DiagnosticsScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

describe('Diagnostics stale-location snapshot boundary', () => {
  beforeEach(() => {
    jest.spyOn(global, 'setInterval').mockImplementation(() => 0 as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('mounts with zero smoking-gun snapshots', async () => {
    mockReadPipelineSnapshots.mockResolvedValueOnce([]);
    const renderer = await mountDiagnostics();
    expect(renderer.root.findByProps({ testID: 'diagnostics-pipeline-snapshots' })).toBeTruthy();
    await act(async () => renderer.unmount());
  });

  it('loads Full Diagnostics from the user-facing route bootloader', async () => {
    mockReadPipelineSnapshots.mockResolvedValueOnce([]);
    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(<DiagnosticsRoute />);
    });

    const fullDiagnosticsButton = renderer.root.findByProps({
      accessibilityLabel: 'Full Diagnostics',
    });
    await act(async () => {
      fullDiagnosticsButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ testID: 'diagnostics-pipeline-snapshots' })).toBeTruthy();
    await act(async () => renderer.unmount());
  });

  it('does not black-screen when persisted snapshots contain a partial record', async () => {
    mockReadPipelineSnapshots.mockResolvedValueOnce([
      {},
      { failure_stage: null },
      { failure_stage: 'ui', speed_mph: 'fast' },
    ]);
    const renderer = await mountDiagnostics();
    expect(renderer.root.findByProps({ testID: 'diagnostics-pipeline-snapshots' })).toBeTruthy();
    expect(renderer.root.findAllByType('Text').some((node: any) =>
      String(node.props.children).includes('No stale moving-location mismatch has been detected.'),
    )).toBe(true);
    await act(async () => renderer.unmount());
  });

  it('renders a valid smoking-gun snapshot after boundary validation', async () => {
    mockReadPipelineSnapshots.mockResolvedValueOnce([{
      kind: 'STALE_LOCATION_PIPELINE_SNAPSHOT',
      trace_id: 'trace-1',
      member_id: 'member-1',
      created_at: '2026-08-28T20:00:00.000Z',
      trigger: 'speed_over_5_mph',
      failure_stage: 'ui',
      native_gps_timestamp: '2026-08-28T19:59:55.000Z',
      native_gps_coordinates: { latitude: 33.45, longitude: -112.07 },
      upload_timestamp: '2026-08-28T19:59:56.000Z',
      upload_timestamp_source: 'backend_first_observed',
      backend_receive_timestamp: '2026-08-28T19:59:56.000Z',
      mongo_write_timestamp: '2026-08-28T19:59:56.010Z',
      members_response_timestamp: '2026-08-28T19:59:57.000Z',
      dashboard_response_timestamp: '2026-08-28T19:59:57.010Z',
      dashboard_store_timestamp: '2026-08-28T19:59:57.020Z',
      map_props_timestamp: '2026-08-28T19:59:57.030Z',
      map_props_coordinates: { latitude: 33.45, longitude: -112.07 },
      map_render_timestamp: '2026-08-28T19:59:57.040Z',
      map_render_coordinates: { latitude: 33.44, longitude: -112.06 },
      backend_stored_coordinates: { latitude: 33.45, longitude: -112.07 },
      api_response_coordinates: { latitude: 33.45, longitude: -112.07 },
      dashboard_store_coordinates: { latitude: 33.45, longitude: -112.07 },
      previous_dashboard_coordinates: { latitude: 33.44, longitude: -112.06 },
      speed_mps: 3,
      speed_mph: 6.710808,
      accuracy_m: 8,
      provider: 'gps',
      is_moving: true,
      distances_m: {
        native_to_backend: 0,
        backend_to_api: 0,
        api_to_store: 0,
        store_to_map: 120,
        previous_to_native: 120,
      },
    }]);
    const renderer = await mountDiagnostics();
    const text = renderer.root.findAllByType('Text')
      .map((node: any) => String(node.props.children))
      .join(' ');
    expect(text).toContain('UI');
    expect(text).toContain('6.7 mph');
    await act(async () => renderer.unmount());
  });
});