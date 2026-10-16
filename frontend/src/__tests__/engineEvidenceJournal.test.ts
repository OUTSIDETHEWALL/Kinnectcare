describe('immutable cross-runtime engine evidence', () => {
  let data: Map<string, string>;
  beforeEach(() => {
    jest.resetModules();
    data = new Map();
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      getItem: async (key: string) => data.get(key) ?? null,
      setItem: async (key: string, value: string) => { data.set(key, value); },
      getAllKeys: async () => [...data.keys()],
      multiGet: async (keys: string[]) => keys.map(k => [k, data.get(k) ?? null]),
      multiRemove: async (keys: string[]) => keys.forEach(k => data.delete(k)),
    }));
  });
  it('a second runtime and foreground polling cannot overwrite or evict motion/heartbeat evidence', async () => {
    const first = require('../engineEvidenceJournal');
    const at = Date.now();
    const record = (name: string, seq: number) => ({ seq, at: at + seq,
      event: name, src: 'engine', detail: {} });
    await first.appendEngineEvidence(record('sdk_onMotionChange', 1));
    jest.resetModules();
    const second = require('../engineEvidenceJournal');
    await second.appendEngineEvidence(record('sdk_onHeartbeat', 2));
    for (let i = 3; i < 80; i++) await second.appendEngineEvidence(record('start_invoked', i));
    const events = await first.readEngineEvidence();
    expect(events.some((e: any) => e.event === 'sdk_onMotionChange')).toBe(true);
    expect(events.some((e: any) => e.event === 'sdk_onHeartbeat')).toBe(true);
    expect(events.filter((e: any) => e.event === 'start_invoked')).toHaveLength(77);
    expect([...data.keys()].filter(k => k.startsWith('kc_engine_evidence_v2:'))).toHaveLength(79);
  });
});
