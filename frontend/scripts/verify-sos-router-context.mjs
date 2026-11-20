/**
 * Offline regression for the installed duplicate-navigation context boundary.
 * Runs outside Jest's navigation mocks. Real React, both installed navigation
 * contexts/hooks, Expo Router's useNavigation implementation and the production
 * SOS hook execute. Native AppState and HTTP are controlled, NOT Android/Stack.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(frontend, 'package.json'));
const React = require('react');
const { act, create } = require('react-test-renderer');
const { transformSync } = require('@babel/core');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = () => { throw new Error('Live network prohibited'); };

const directCore = path.dirname(require.resolve('@react-navigation/core/package.json'));
const routerRequire = createRequire(require.resolve('expo-router/package.json'));
const routerCore = path.dirname(routerRequire.resolve('@react-navigation/core/package.json'));
const coreModule = (base, name) => import(pathToFileURL(
  path.join(base, 'lib/module', `${name}.js`),
).href);
const { NavigationContext } = await coreModule(routerCore, 'NavigationContext');
const { NavigationContainerRefContext } = await coreModule(routerCore, 'NavigationContainerRefContext');
const { useNavigation } = await coreModule(routerCore, 'useNavigation');
const { useStateForPath } = await coreModule(routerCore, 'useStateForPath');
const { useIsFocused: directFocus } = await coreModule(directCore, 'useIsFocused');

// Explicit imports only: no unexpected native/bootstrap/network dependency may
// silently execute. Parent-route helpers are unused by useNavigation() with no
// parent; the native facade exposes the actual core functions it re-exports.
function loadCommonJs(code, imports) {
  const module = { exports: {} };
  const limitedRequire = id => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected dependency: ${id}`);
    return imports[id];
  };
  new Function('require', 'module', 'exports', code)(limitedRequire, module, module.exports);
  return module.exports;
}
const routerNavigation = loadCommonJs(
  readFileSync(require.resolve('expo-router/build/useNavigation'), 'utf8'),
  {
    '@react-navigation/native': { useNavigation, useStateForPath },
    './global-state/utils': {},
    './link/href': {},
  },
);

function providers(navigation, child) {
  return React.createElement(NavigationContainerRefContext.Provider, { value: navigation },
    React.createElement(NavigationContext.Provider, { value: navigation }, child));
}

test('the old direct focus hook throws under the router-owned contexts', async () => {
  assert.notEqual(directCore, routerCore, 'This fixture must exercise distinct installed copies');
  function LegacyScreen() {
    return React.createElement('span', null, String(directFocus()));
  }
  let tree;
  try {
    await assert.rejects(async () => {
      await act(async () => {
        tree = create(providers({ isFocused: () => true }, React.createElement(LegacyScreen)));
      });
    }, /Couldn't find a navigation object/);
  } finally {
    if (tree) await act(async () => tree.unmount());
  }
});

test('the production SOS hook uses router context and preserves focus/background cancellation', async () => {
  const listeners = { focus: new Set(), blur: new Set(), app: new Set() };
  let focused = true;
  const navigation = {
    isFocused: () => focused,
    addListener: (event, listener) => {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
  };
  const signals = [];
  let pendingMember;
  let holdMember = false;
  let refreshes = 0;
  const incident = {
    id: 'synthetic-sos', owner_id: 'synthetic-owner', member_id: 'synthetic-owner',
    family_group_id: 'synthetic-family', type: 'sos', resolved: false,
    created_at: new Date(Date.now() - 5_000).toISOString(),
  };
  const profile = {
    id: 'synthetic-profile', user_id: incident.owner_id, family_group_id: incident.family_group_id,
    location_sharing_enabled: true, location_consent_generation: 1,
    latitude: 20, longitude: 30, coordinate_captured_at: new Date().toISOString(),
  };
  const api = {
    get: async (url, options) => {
      signals.push(options.signal);
      if (url === '/alerts') return { data: [incident] };
      assert.equal(url, '/members');
      if (holdMember) return new Promise(resolve => { pendingMember = resolve; });
      return { data: [profile] };
    },
    post: async url => {
      assert.equal(url, '/members/synthetic-profile/request-location-refresh');
      refreshes++;
      return { data: { sent_to: 0 } };
    },
  };
  // An optional saved source file lets a reviewer verify RED against the exact
  // pre-fix revision without replacing any application file on disk.
  const source = readFileSync(process.argv[2]
    ? path.resolve(process.argv[2]) : path.join(frontend, 'src/sosDetailLocation.ts'), 'utf8');
  const { code } = transformSync(source, {
    filename: 'sosDetailLocation.ts', configFile: false, babelrc: false,
    presets: [
      [require.resolve('@babel/preset-env'), { targets: { node: 'current' } }],
      require.resolve('@babel/preset-typescript'),
    ],
  });
  const { useSosDetailLocation } = loadCommonJs(code, {
    react: React,
    'expo-router': routerNavigation,
    // Keeping this real legacy hook available makes reverting the production
    // import fail with the actual context exception, not an unstubbed-import error.
    '@react-navigation/native': { useIsFocused: directFocus },
    'react-native': { AppState: {
      currentState: 'active',
      addEventListener: (_, listener) => {
        listeners.app.add(listener);
        return { remove: () => listeners.app.delete(listener) };
      },
    } },
    './api': { api },
  });
  let currentIncident = null;
  let result;
  const ended = () => { throw new Error('Unexpected incident termination'); };
  function Screen() {
    result = useSosDetailLocation(currentIncident, ended);
    return React.createElement('span', null, 'incident controls can render');
  }
  const view = () => providers(navigation, React.createElement(Screen));
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const emit = async (event, value) => act(async () => {
    for (const listener of [...listeners[event]]) listener(value);
    await flush();
  });
  let tree;
  try {
    // The real screen calls the hook even while the initial incident is null.
    await act(async () => { tree = create(view()); await flush(); });
    assert.equal(tree.toJSON().children[0], 'incident controls can render');
    assert.equal(signals.length, 0);
    currentIncident = incident;
    await act(async () => { tree.update(view()); await flush(); });
    assert.equal(result.fix.latitude, 20);
    assert.equal(refreshes, 1);
    assert.equal(listeners.focus.size, 1);
    assert.equal(listeners.blur.size, 1);
    focused = false;
    await emit('blur');
    assert.equal(result.fix, null);
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(listeners.app.size, 0);
    // A late response cannot restore a pin after backgrounding.
    holdMember = true;
    focused = true;
    await emit('focus');
    assert.equal(typeof pendingMember, 'function');
    await emit('app', 'background');
    assert.ok(signals.every(signal => signal.aborted));
    await act(async () => { pendingMember({ data: [profile] }); await flush(); });
    assert.equal(result.fix, null);
    holdMember = false;
    await emit('app', 'active');
    assert.equal(result.fix.latitude, 20);
    assert.equal(refreshes, 1, 'Refocusing must not duplicate the refresh request');
  } finally {
    if (tree) await act(async () => tree.unmount());
  }
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(listeners.focus.size + listeners.blur.size + listeners.app.size, 0);
});
