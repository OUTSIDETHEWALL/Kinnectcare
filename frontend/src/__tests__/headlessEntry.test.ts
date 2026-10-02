import fs from 'fs';
import path from 'path';

describe('cold headless entry registration', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  function loadEntry(platform = 'android') {
    const order: string[] = [];
    const sdk = {
      registerHeadlessTask: jest.fn((handler: unknown) => {
        expect(typeof handler).toBe('function');
        order.push('location-registration');
      }),
      ready: jest.fn(),
      start: jest.fn(),
      setConfig: jest.fn(),
      getCurrentPosition: jest.fn(),
      getState: jest.fn(),
    };
    const backgroundFetch = {
      registerHeadlessTask: jest.fn((handler: unknown) => {
        expect(typeof handler).toBe('function');
        order.push('battery-registration');
      }),
      configure: jest.fn(),
    };
    const permissionDisclosure = jest.fn();
    const storage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
      removeItem: jest.fn().mockResolvedValue(undefined),
    };

    // Mock platform dependencies, not the two registration modules. No layout
    // or React component is mounted: this is a fresh headless-only bundle load.
    jest.doMock('react-native', () => ({
      Platform: { OS: platform },
      AppState: { currentState: 'background' },
    }));
    jest.doMock('@react-native-async-storage/async-storage', () => storage);
    jest.doMock('../backgroundLocationDisclosure', () => ({
      ensureBackgroundLocationDisclosure: permissionDisclosure,
    }));
    jest.doMock('react-native-background-geolocation', () => ({ default: sdk }));
    jest.doMock('react-native-background-fetch', () => ({ default: backgroundFetch }));
    jest.doMock('@expo/metro-runtime', () => {
      order.push('metro-runtime');
      return {};
    });
    jest.doMock('expo-router/entry', () => {
      if (platform !== 'web') {
        expect(sdk.registerHeadlessTask).toHaveBeenCalledTimes(1);
        expect(backgroundFetch.registerHeadlessTask).toHaveBeenCalledTimes(1);
      }
      order.push('router-entry');
      return {};
    });

    // Re-evaluate real module-level side effects in a fresh module registry.
    jest.resetModules();
    require('../../index.js');
    return { order, sdk, backgroundFetch, permissionDisclosure };
  }

  it('makes the custom entry the package bootstrap', () => {
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../package.json'), 'utf8',
    ));
    expect(packageJson.main).toBe('index.js');
  });

  it.each(['android', 'ios'])(
    'registers both existing handlers before Router on %s without starting tracking',
    platform => {
      const { order, sdk, backgroundFetch, permissionDisclosure } = loadEntry(platform);
      expect(order).toEqual([
        'metro-runtime', 'location-registration', 'battery-registration', 'router-entry',
      ]);
      expect(sdk.ready).not.toHaveBeenCalled();
      expect(sdk.start).not.toHaveBeenCalled();
      expect(sdk.setConfig).not.toHaveBeenCalled();
      expect(sdk.getCurrentPosition).not.toHaveBeenCalled();
      expect(sdk.getState).not.toHaveBeenCalled();
      expect(backgroundFetch.configure).not.toHaveBeenCalled();
      expect(permissionDisclosure).not.toHaveBeenCalled();
    },
  );

  it('does not register either handler twice when the entry is imported again', () => {
    const { sdk, backgroundFetch } = loadEntry();
    require('../../index.js');
    expect(sdk.registerHeadlessTask).toHaveBeenCalledTimes(1);
    expect(backgroundFetch.registerHeadlessTask).toHaveBeenCalledTimes(1);
  });

  it('preserves web guards and still loads Router after Metro', () => {
    const { order, sdk, backgroundFetch } = loadEntry('web');
    expect(order).toEqual(['metro-runtime', 'router-entry']);
    expect(sdk.registerHeadlessTask).not.toHaveBeenCalled();
    expect(backgroundFetch.registerHeadlessTask).not.toHaveBeenCalled();
  });
});