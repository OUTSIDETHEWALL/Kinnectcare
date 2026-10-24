import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';

const hooks = require('../../plugins/deepAsyncHooks');
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const compile = (source: string) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const id = (n: number) => n.toString(16).padStart(32, '0');

describe('deep async passive observation', () => {
  let rows: any[];
  let native: any;
  let trace: typeof import('../deepAsyncTrace');
  beforeEach(() => {
    jest.resetModules();
    rows = [];
    native = { deepRecord: jest.fn((kind, request, stage, detail) => {
      rows.push({ kind, id: request, stage, ...JSON.parse(detail) });
    }) };
    jest.doMock('expo', () => ({ requireOptionalNativeModule: () => native }));
    trace = require('../deepAsyncTrace');
  });

  it('fails open when the native observer throws', () => {
    native.deepRecord.mockImplementation(() => { throw Error('observer failed'); });
    expect(() => trace.deepStage({ operation: id(1), origin: 'workmanager' }, 'helper_entered')).not.toThrow();
    expect(() => (globalThis as any).__kinnshipAsyncStage(id(1), 'body_read_entered')).not.toThrow();
  });
  it('never exposes a shared-flight key and preserves underlying Promise identity', async () => {
    const flights = require('../initialOwnershipReads');
    let resolve!: (v: unknown[]) => void;
    const raw = new Promise(r => { resolve = r; });
    const load = jest.fn(() => raw);
    const key = 'private-token-and-sharing-key-DO-NOT-RECORD';
    const a = flights.initialOwnershipReads(key, load, { operation: id(1), origin: 'sdk-headless' });
    const b = flights.initialOwnershipReads(key, load, { operation: id(2), origin: 'sdk-headless' });
    expect(a).toBe(raw); expect(b).toBe(raw); expect(load).toHaveBeenCalledTimes(1);
    expect(rows.filter(r => r.stage === 'flight_created')).toHaveLength(1);
    expect(rows.filter(r => r.stage === 'flight_joined')).toHaveLength(1);
    expect(rows.filter(r => r.stage === 'consumer_attached').map(r => r.flight)).toEqual([rows[0].id, rows[0].id]);
    resolve([{}, [], {}]); await raw; await flush();
    expect(rows.some(r => r.stage === 'aggregate_fulfilled')).toBe(true);
    expect(rows.some(r => r.stage === 'map_removed')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(key);
  });
  it('retains rejection identity and does not let cleanup erase a replacement flight', async () => {
    const flights = require('../initialOwnershipReads');
    let reject!: (v: Error) => void;
    const first = new Promise((_, r) => { reject = r; });
    const err = Error('private error contents');
    flights.initialOwnershipReads('key', () => first, { operation: id(1), origin: 'sdk-headless' });
    first.catch(() => {});
    const finish = flights.beginOwnershipSessionChange(); finish();
    const replacement = new Promise(() => {});
    flights.initialOwnershipReads('key', () => replacement, { operation: id(2), origin: 'sdk-headless' });
    reject(err); await flush();
    expect(flights.initialOwnershipReads('key', () => { throw Error('must not load'); })).toBe(replacement);
    expect(JSON.stringify(rows)).not.toContain(err.message);
  });

  function fixture() {
    const jobs: any[] = [];
    let xhr: any, reader: any, active: any;
    let finished = false, result: unknown, rejected: unknown;
    class BlobModel { type = ''; constructor(..._args: any[]) {} }
    class ReaderModel {
      result = ''; onload: any; onerror: any; __kcAsyncRequest: any;
      readAsText(blob: any) { reader = this; this.__kcAsyncRequest = blob.__kcAsyncRequest;
        (globalThis as any).__kinnshipAsyncStage(this.__kcAsyncRequest, 'js_body_read_entered'); }
    }
    class XhrModel {
      readyState = 0; status = 200; statusText = 'OK'; responseURL = 'https://example.test/api/auth/me';
      response = new BlobModel(); onreadystatechange: any; onload: any; onabort: any;
      constructor() { xhr = this; }
      open() { this.readyState = 1; }
      setRequestHeader() {} send() {}
      getAllResponseHeaders() { return 'content-type: application/json'; }
      abort() { this.onabort?.(); }
      done() { this.readyState = 4; this.onreadystatechange?.(); this.onload?.(); }
    }
    const box: any = { exports: {}, Promise, AbortController, Blob: BlobModel, FileReader: ReaderModel,
      XMLHttpRequest: XhrModel, ArrayBuffer, Uint8Array, DataView, TextDecoder, Symbol, DOMException,
      __kinnshipAsyncCurrent: () => active?.asyncRequest,
      __kinnshipAsyncStage: (globalThis as any).__kinnshipAsyncStage,
      diagnosticId: () => id(20),
      deepStage: trace.deepStage,
      withRequestOrigin: (context: any, dispatch: () => unknown) => { active = context; try { return dispatch(); } finally { active = null; } },
      setTimeout: (f: () => void, delay: number) => { const job = { f, delay, active: true }; jobs.push(job); return job; },
      clearTimeout: (job: any) => { job.active = false; },
    };
    box.self = box;
    const fetchSource = fs.readFileSync(require.resolve('whatwg-fetch').replace('/dist/fetch.umd.js', '/fetch.js'), 'utf8');
    vm.runInNewContext(compile(hooks.fetch(fetchSource)), box);
    box.fetch = box.exports.fetch;
    const source = fs.readFileSync(path.join(__dirname, '../androidTrackingRecovery.ts'), 'utf8');
    const at = source.indexOf('async function authenticatedGet(');
    const helper = source.slice(at, source.indexOf('\n}', at) + 2);
    vm.runInNewContext(compile(helper + '\nexport { authenticatedGet };'), box);
    const promise = box.exports.authenticatedGet('https://example.test/api/auth/me', 'secret-not-recorded',
      { operation: id(1), origin: 'workmanager', phase: 'device-contact' });
    promise.then((v: any) => { finished = true; result = v; }, (e: any) => { finished = true; rejected = e; });
    return {
      promise, jobs, xhr: () => xhr, reader: () => reader,
      state: () => ({ finished, result, rejected }),
      run: async (delay: number) => { for (const job of jobs.filter(j => j.active && j.delay === delay)) { job.active = false; job.f(); } await flush(); },
    };
  }
  it('identifies native completion without inventing a JS receipt', async () => {
    const f = fixture();
    (globalThis as any).__kinnshipAsyncStage(id(20), 'native_ended');
    await flush();
    expect(f.state().finished).toBe(false);
    expect(rows.at(-1).stage).toBe('native_ended');
    expect(rows.some(r => r.stage === 'fetch_fulfilled')).toBe(false);
  });
  it('distinguishes fetch fulfillment, pending body and a post-transport abort', async () => {
    const f = fixture(); f.xhr().done(); await f.run(0);
    expect(rows.some(r => r.stage === 'fetch_fulfilled')).toBe(true);
    expect(rows.some(r => r.stage === 'body_read_entered')).toBe(true);
    expect(rows.some(r => r.stage === 'body_read_fulfilled')).toBe(false);
    await f.run(8000);
    expect(rows.some(r => r.stage === 'abort_timer_fired')).toBe(true);
    expect(f.state().finished).toBe(false);
    expect(rows.some(r => r.flight)).toBe(false);
  });
  it('normal request records parse completion and preserves the returned value', async () => {
    const f = fixture(); f.xhr().done(); await f.run(0);
    f.reader().result = '{"id":"private-body-not-recorded"}'; f.reader().onload(); await flush();
    expect(f.state().result).toEqual({ id: 'private-body-not-recorded' });
    for (const stage of ['fetch_fulfilled', 'body_read_fulfilled', 'json_parse_entered', 'json_parse_completed',
      'helper_fulfilled', 'helper_exited']) expect(rows.some(r => r.stage === stage)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/secret-not-recorded|private-body-not-recorded/);
  });
  it('JSON parse rejection is observed and propagated without changing the error', async () => {
    const f = fixture(); f.xhr().done(); await f.run(0);
    f.reader().result = '{'; f.reader().onload(); await flush();
    expect(f.state().rejected).toBeDefined();
    expect(rows.some(r => r.stage === 'json_parse_failed')).toBe(true);
    expect(rows.some(r => r.stage === 'helper_rejected')).toBe(true);
  });
  it('native recorder failure does not prevent fetch/body completion', async () => {
    native.deepRecord.mockImplementation(() => { throw Error('storage offline'); });
    const f = fixture(); f.xhr().done(); await f.run(0);
    f.reader().result = '{}'; f.reader().onload(); await flush();
    expect(f.state().finished).toBe(true); expect(f.state().result).toEqual({});
  });
  it.each([
    ['react-native/Libraries/Network/XMLHttpRequest.js', 'xhr'],
    ['react-native/Libraries/Blob/FileReader.js', 'reader'],
    ['whatwg-fetch/fetch.js', 'fetch'],
    ['whatwg-fetch/dist/fetch.umd.js', 'fetch'],
  ])('hooks %s exactly once and parses the transformed source', (file, kind) => {
    const source = fs.readFileSync(path.join(__dirname, '../../node_modules', file), 'utf8');
    const transformed = hooks[kind](source);
    expect(hooks[kind](transformed)).toBe(transformed);
    expect(transformed).toContain(hooks.MARK);
    require('@babel/parser').parse(transformed, { sourceType: 'unambiguous', plugins: ['flow', 'jsx'] });
  });
});
