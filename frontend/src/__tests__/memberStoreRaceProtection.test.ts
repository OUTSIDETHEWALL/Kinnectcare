/**
 * memberStoreRaceProtection.test.ts  — Task #96
 *
 * Confirms that the canonical memberStore never lets a lower-sequence-number
 * response overwrite a higher-sequence-number one that has already been
 * committed.  This is the core guard that prevents the Member Detail screen
 * from showing a stale address after a fetchOne() races an in-flight PUT.
 *
 * Scenario being tested:
 *   1. The user navigates to the Member Detail screen while an upload PUT is
 *      in flight.
 *   2. Member Detail calls fetchOne() on mount — it allocates seq N and starts
 *      a GET /members/{id} request.
 *   3. Meanwhile requestRefresh() polling commits a newer result with seq M
 *      (M > N) into the store — the dashboard now shows the correct address.
 *   4. The fetchOne() GET /members/{id} response arrives and calls
 *      upsertOne(staleMember, seq=N).  Because N < fetchSeq[id] (which is M),
 *      the write is silently dropped.
 *   5. Both the dashboard (useAllMembers) and the detail screen (useMember)
 *      read from the same store reference, so they always agree.
 *
 * These are pure unit tests — no React Native runtime needed.
 */

// ─── Mock external dependencies ───────────────────────────────────────────────
//
// memberStore imports three things that are unavailable in the Node test env:
//   • react               — useSyncExternalStore (hooks API, not needed here)
//   • ../api              — axios wrapper (no network in tests)
//   • ../refreshPipelineLog — fire-and-forget event log (no-op in tests)

jest.mock('react', () => ({
  useSyncExternalStore: jest.fn(),
}));

jest.mock('../api', () => ({
  api: {},
}));

jest.mock('../refreshPipelineLog', () => ({
  logPipelineEvent: () => {},
}));

// ─── Import the store under test ──────────────────────────────────────────────

import {
  upsertOne,
  upsertMany,
  getMemberById,
  getAllMembers,
  clearAll,
} from '../store/memberStore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type PartialMember = {
  id: string;
  name?: string;
  last_seen?: string | null;
  location_name?: string | null;
  [key: string]: unknown;
};

function member(overrides: PartialMember): any {
  return {
    name: 'Joyce',
    last_seen: '2024-06-01T12:00:00.000Z',
    location_name: 'Bullhead City',
    ...overrides,
    id: overrides.id ?? 'member-1',
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('memberStore — sequence-number race protection', () => {
  beforeEach(() => {
    // Reset the store (and fetchSeq map) before every test.
    clearAll();
  });

  // ── 1. Core guard: lower-seq write is dropped ────────────────────────────
  //
  // Simulates fetchOne() (seq=5) racing requestRefresh() (seq=10).
  // The higher-seq commit arrives first; the lower-seq response must be
  // silently dropped.

  it('drops a lower-seq upsertOne that arrives after a higher-seq commit', () => {
    const id = 'member-1';

    // Step 1 — higher-seq result commits first (e.g. from requestRefresh polling)
    upsertOne(member({ id, name: 'Joyce (fresh)', last_seen: '2024-06-01T12:01:00.000Z', location_name: 'Bullhead City' }), 10);

    const afterHighSeq = getMemberById(id);
    expect(afterHighSeq?.name).toBe('Joyce (fresh)');

    // Step 2 — lower-seq fetchOne() response arrives later — must be dropped
    upsertOne(member({ id, name: 'Joyce (stale)', last_seen: '2024-06-01T11:00:00.000Z', location_name: 'Stale Location' }), 5);

    const stored = getMemberById(id);
    expect(stored?.name).toBe('Joyce (fresh)');
    expect((stored as any)?.location_name).toBe('Bullhead City');
    expect(stored?.last_seen).toBe('2024-06-01T12:01:00.000Z');
  });

  // ── 2. Equal seq — the second write wins (idempotent retry is fine) ───────

  it('accepts a second upsertOne with the same seq number (idempotent retry)', () => {
    const id = 'member-1';

    upsertOne(member({ id, name: 'Joyce (v1)', location_name: 'City A' }), 7);
    upsertOne(member({ id, name: 'Joyce (v2)', location_name: 'City B' }), 7);

    // seq === fetchSeq[id] is NOT < cur, so the second write is accepted.
    const stored = getMemberById(id);
    expect(stored?.name).toBe('Joyce (v2)');
  });

  // ── 3. Higher-seq always wins regardless of wall-clock order ─────────────

  it('accepts a higher-seq write that arrives after a lower-seq commit', () => {
    const id = 'member-1';

    // Lower seq commits first (initial fetchOne)
    upsertOne(member({ id, name: 'Joyce (initial)', location_name: 'Old City' }), 3);

    // Higher seq arrives later (newer refresh wins)
    upsertOne(member({ id, name: 'Joyce (updated)', location_name: 'New City' }), 8);

    const stored = getMemberById(id);
    expect(stored?.name).toBe('Joyce (updated)');
    expect((stored as any)?.location_name).toBe('New City');
  });

  // ── 4. location_name preserved — stale fetchOne with null name is dropped ─
  //
  // Uploads clear location_name on the backend (lazy-geocoding model).  If a
  // PUT response (null name) races a resolved GET /members/{id} (non-null
  // name), the null must never clobber the resolved name.
  //
  // When the seq guard fires FIRST (stale response is dropped entirely), the
  // location_name preservation guard doesn't even run — the higher-seq value
  // persists unchanged.

  it('preserves a committed location_name when a stale fetchOne carries null location_name', () => {
    const id = 'member-1';

    // Higher-seq commit with a resolved address
    upsertOne(member({ id, last_seen: '2024-06-01T12:05:00.000Z', location_name: 'Bullhead City' }), 20);

    // Stale fetchOne response arrives — lower seq AND null location_name
    upsertOne(member({ id, last_seen: '2024-06-01T11:50:00.000Z', location_name: null }), 10);

    const stored = getMemberById(id);
    expect((stored as any)?.location_name).toBe('Bullhead City');
    expect(stored?.last_seen).toBe('2024-06-01T12:05:00.000Z');
  });

  // ── 5. seq=null bypass — push notifications skip the guard ───────────────
  //
  // Realtime push (APNs / FCM) always wins, even if a fetched seq is pending.
  // seq=null disables the race check.

  it('accepts a seq=null upsert (realtime push) regardless of the current seq floor', () => {
    const id = 'member-1';

    // Set a high seq floor
    upsertOne(member({ id, name: 'Joyce (fetched)', location_name: 'City A' }), 50);

    // Push notification bypasses the guard
    upsertOne(member({ id, name: 'Joyce (push)', location_name: 'City B' }), null);

    const stored = getMemberById(id);
    expect(stored?.name).toBe('Joyce (push)');
    expect((stored as any)?.location_name).toBe('City B');
  });

  // ── 6. clearAll() resets the seq floor ────────────────────────────────────
  //
  // Sign-out followed by sign-in must not carry forward old seq state.

  it('accepts a low-seq write after clearAll() resets the seq floor', () => {
    const id = 'member-1';

    // Push a high seq before the sign-out
    upsertOne(member({ id, name: 'Joyce (before)', location_name: 'Old City' }), 100);

    // Sign-out
    clearAll();

    // After clearAll the seq floor is gone — even a seq=1 is accepted
    upsertOne(member({ id, name: 'Joyce (after sign-in)', location_name: 'New City' }), 1);

    const stored = getMemberById(id);
    expect(stored?.name).toBe('Joyce (after sign-in)');
    expect((stored as any)?.location_name).toBe('New City');
  });

  // ── 7. upsertMany bumps seq floors — a subsequent lower-seq fetchOne is ───
  //    dropped for every member touched by the batch.
  //
  // fetchAll() / upsertMany() set each member's seq to nextSeq++ so any
  // concurrently-in-flight fetchOne for a member in that batch is treated
  // as stale.

  it('drops a lower-seq upsertOne for a member whose seq was raised by upsertMany', () => {
    const id = 'member-1';

    // Simulate fetchAll() / upsertMany arriving with seq = high number
    upsertMany([member({ id, name: 'Joyce (batch)', location_name: 'Batch City' })]);

    // Stale fetchOne(id) with a lower explicit seq — must be dropped.
    // NOTE: upsertMany sets fetchSeq[id] = nextSeq++ (a global counter, always ≥ 1).
    // We pass seq=0 which is guaranteed to be less than any real seq counter value.
    upsertOne(member({ id, name: 'Joyce (stale single)', location_name: 'Stale City' }), 0);

    const stored = getMemberById(id);
    expect(stored?.name).toBe('Joyce (batch)');
    expect((stored as any)?.location_name).toBe('Batch City');
  });

  // ── 8. Multiple members — seq is tracked per-id, no cross-contamination ──

  it('tracks seq independently per member id — one stale drop does not affect another id', () => {
    // member-A gets a high seq floor
    upsertOne(member({ id: 'member-a', name: 'Alice (fresh)', location_name: 'City A' }), 20);

    // member-B only has a low seq
    upsertOne(member({ id: 'member-b', name: 'Bob (initial)', location_name: 'City B' }), 2);

    // Stale write for member-A is dropped
    upsertOne(member({ id: 'member-a', name: 'Alice (stale)', location_name: 'City A stale' }), 5);

    // Fresh write for member-B is accepted (5 > 2)
    upsertOne(member({ id: 'member-b', name: 'Bob (updated)', location_name: 'City B updated' }), 5);

    const alice = getMemberById('member-a');
    const bob   = getMemberById('member-b');

    expect(alice?.name).toBe('Alice (fresh)');          // stale drop worked
    expect(bob?.name).toBe('Bob (updated)');             // unrelated id unaffected
  });

  // ── 9. getAllMembers returns consistent view for every subscriber ──────────
  //
  // Both useMember(id) and useAllMembers() read from the same canonical map.
  // After a higher-seq commit, getAllMembers must also reflect the correct
  // value — confirming no split-brain between the list view (dashboard) and
  // the detail view.

  it('getAllMembers reflects the higher-seq committed value after a stale drop', () => {
    const id = 'member-1';

    upsertOne(member({ id, name: 'Joyce (fresh)', location_name: 'Bullhead City' }), 10);
    upsertOne(member({ id, name: 'Joyce (stale)', location_name: 'Stale City'  }), 3);

    const all = getAllMembers();
    const found = all.find((m: any) => m.id === id);

    expect(found).toBeDefined();
    expect(found?.name).toBe('Joyce (fresh)');
    expect((found as any)?.location_name).toBe('Bullhead City');
  });
});
