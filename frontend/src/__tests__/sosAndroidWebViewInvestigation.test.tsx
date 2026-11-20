/**
 * Incremental investigation beyond PR203: run the installed Android WebView JS
 * wrapper, not an invented map exception. Only its native host/module/bridge are
 * inert. These events do NOT reproduce an actual Android renderer/process crash.
 */
import React from 'react';
import { act } from 'react-test-renderer';
import { setupSosInvestigation, profile, flush } from './helpers/sosInvestigation';

describe('SOS: installed Android WebView JS error/lifecycle boundary', () => {
  let h: any;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-20T01:38:40Z'));
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.doMock('react-native/Libraries/BatchedBridge/BatchedBridge', () => ({
      __esModule: true, default: { registerCallableModule: jest.fn() },
    }));
    jest.doMock('react-native/Libraries/vendor/emitter/EventEmitter', () => ({
      __esModule: true,
      default: class {
        addListener() { return { remove() {} }; }
        emit() {}
      },
    }));
    jest.doMock('react-native-webview/lib/NativeRNCWebViewModule', () => ({
      __esModule: true,
      default: { isFileUploadSupported: async () => false },
    }));
    jest.doMock('react-native-webview/lib/RNCWebViewNativeComponent', () => ({
      __esModule: true,
      default: React.forwardRef((props: any, ref) => {
        React.useImperativeHandle(ref, () => ({}));
        return React.createElement('InertAndroidWebView', props);
      }),
      Commands: {
        injectJavaScript: jest.fn(), requestFocus: jest.fn(),
        goBack: jest.fn(), goForward: jest.fn(), reload: jest.fn(),
        stopLoading: jest.fn(), postMessage: jest.fn(),
      },
    }));
    h = setupSosInvestigation({ realMap: true, androidWebView: true });
    h.profiles = [profile()];
  });
  afterEach(async () => {
    try { if (h) await h.dispose(); } finally {
      warn.mockRestore(); error.mockRestore(); jest.clearAllTimers(); jest.useRealTimers();
    }
  });

  function controlsRemain() {
    expect(h.find('sos-banner-active').length).toBeGreaterThan(0);
    expect(h.find('alert-back').length).toBeGreaterThan(0);
    expect(h.find('sos-call-911').length).toBeGreaterThan(0);
    expect(h.find('sos-resolve').length).toBeGreaterThan(0);
  }
  async function event(name: string, detail: Record<string, unknown>) {
    const host = h.tree.root.findByType('InertAndroidWebView');
    await act(async () => {
      host.props[name]({
        nativeEvent: { url: 'https://maps.googleapis.com/', ...detail },
        persist() {},
        isDefaultPrevented: () => false,
      });
      await flush();
    });
  }

  it('mounts the actual installed wrapper inside the incident', async () => {
    await h.mount();
    expect(h.tree.root.findAllByType('InertAndroidWebView')).toHaveLength(1);
    // Real icon and map-observation modules also run in this mode.
    expect(JSON.stringify(h.tree.toJSON())).toContain('📞');
    expect([...h.storage.values()].some(value => value.includes('"map-props"'))).toBe(true);
    controlsRemain();
  });
  it('keeps safety controls when the native host reports a document load error', async () => {
    await h.mount();
    await event('onLoadingError', { code: -2, description: 'Synthetic document load error' });
    controlsRemain();
    expect(JSON.stringify(h.tree.toJSON())).toContain('Error loading page');
  });
  it('keeps safety controls when the native host reports HTTP failure', async () => {
    await h.mount();
    await event('onHttpError', { statusCode: 503, description: 'Synthetic HTTP failure' });
    controlsRemain();
  });
  it.each([false, true])('observes JS handling of render-process-gone didCrash=%s without claiming a native reproduction', async didCrash => {
    await h.mount();
    await event('onRenderProcessGone', { didCrash });
    controlsRemain();
    // This event is a no-op without an application handler. A mounted inert
    // host is NOT evidence that a killed Android renderer recovered.
    const { Commands } = require('react-native-webview/lib/RNCWebViewNativeComponent');
    expect(Commands.reload).not.toHaveBeenCalled();
  });
  it('survives native load start/finish, background removal and authorized remount', async () => {
    await h.mount();
    await event('onLoadingStart', {});
    await event('onLoadingFinish', {});
    controlsRemain();
    await h.appState('background');
    expect(h.tree.root.findAllByType('InertAndroidWebView')).toHaveLength(0);
    await h.appState('active');
    expect(h.tree.root.findAllByType('InertAndroidWebView')).toHaveLength(1);
    controlsRemain();
  });
});
