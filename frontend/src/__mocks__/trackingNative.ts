/** Deterministic model of the synchronous native contract, not a production fallback. */
let state: any = { generation: 0, owner: '', revoked: true };
const records: any[] = [];
export const trackingNative = {
  trackingRead: () => JSON.stringify(state),
  trackingAuthorize(owner: string, generation: number) {
    if (!state.pendingMutation && !state.shutdownPending && !Object.keys(state.shutdowns ?? {}).length
      && !(state.revoked && state.reason === 'consent')
      && generation === state.generation && (!state.owner || state.owner === owner)) {
      state = { ...state, owner, revoked: false };
    }
    return JSON.stringify(state);
  },
  trackingRevoke(reason: string) {
    state = { generation: state.generation + 1, owner: '', revoked: true, shutdownPending: true,
      reason: state.reason === 'consent' ? 'consent' : reason, revokedOwner: state.owner,
      pendingMutation: state.pendingMutation, shutdowns: state.shutdowns };
    records.push({ event: 'stop_intent', reason });
    return JSON.stringify(state);
  },
  trackingRevokeIfCurrent(owner: string, generation: number, reason: string, operation: string) {
    if (state.owner !== owner || state.generation !== generation) return false;
    trackingNative.trackingRevoke(reason);
    state.shutdowns = { ...state.shutdowns, [operation]: true };
    return true;
  },
  trackingRearmConsent(generation: number) {
    if (state.generation !== generation || !state.revoked) return false;
    if (state.reason === 'consent') state.reason = 'stopped';
    return true;
  },
  trackingClaim(owner: string, generation: number, operation: string, now: number, configurationOnly = false): boolean {
    if (state.revoked || state.owner !== owner || state.generation !== generation) return false;
    if (state.pendingMutation) return false;
    if (state.operation && now - state.claimedAt < 60_000) return false;
    if (state.nextEligibleAt > now && state.nextEligibleAt - now <= 1_800_000) return false;
    const moving = state.moving && state.movementAt <= now && now - state.movementAt < 600_000;
    if (!configurationOnly && state.capturedAt > 0 && state.capturedAt <= now && now - state.capturedAt < (moving ? 600_000 : 3_600_000)) return false;
    state = { ...state, operation, claimedAt: now, pendingMutation: configurationOnly ? operation : undefined };
    return true;
  },
  trackingClaimConfiguration(owner: string, generation: number, operation: string, now: number): boolean {
    return trackingNative.trackingClaim(owner, generation, operation, now, true);
  },
  trackingComplete(operation: string, outcome: string, capturedAt: number, moving: boolean) {
    if (state.pendingMutation === operation) delete state.pendingMutation;
    if (state.operation !== operation || state.revoked) return;
    delete state.operation;
    if (outcome === 'operation_discarded') {
      // Only the operation ends; existing owner health/backoff stays intact.
    } else if (outcome === 'fresh_fix_delivered') {
      state = { ...state, failures: 0, nextEligibleAt: 0, capturedAt, moving, movementAt: capturedAt, outcome };
    } else {
      const failures = (state.failures ?? 0) + 1;
      state = { ...state, failures, outcome,
        nextEligibleAt: Date.now() + (failures === 1 ? 5 : failures === 2 ? 15 : 30) * 60_000 };
    }
  },
  trackingRecord: (event: string, detail: string) => { records.push({ event, ...JSON.parse(detail) }); },
  trackingEvidence: () => JSON.stringify({ state, records }),
  trackingObserve(owner: string, generation: number, capturedAt: number, moving: boolean) {
    if (!state.revoked && state.owner === owner && state.generation === generation && capturedAt > (state.capturedAt ?? 0)) {
      state = { ...state, capturedAt, moving, ordinaryDeliveryAt: capturedAt, outcome: 'recent_location_verified', movementAt: capturedAt, failures: 0, nextEligibleAt: 0 };
    }
  },
  trackingMovement(owner: string, generation: number, moving: boolean) {
    if (!state.revoked && state.owner === owner && state.generation === generation) {
      state = { ...state, moving, movementAt: Date.now() };
    }
  },
  trackingShutdownComplete(generation: number) {
    if (state.revoked && state.generation === generation && !Object.keys(state.shutdowns ?? {}).length) {
      state = { ...state, shutdownPending: false };
    }
  },
  trackingShutdownBegin(generation: number, operation: string) {
    if (!state.revoked || state.generation !== generation) return false;
    state = { ...state, shutdownPending: true, shutdowns: { ...state.shutdowns, [operation]: true } };
    return true;
  },
  trackingShutdownEnd(operation: string, success: boolean) {
    if (!state.shutdowns?.[operation]) return;
    delete state.shutdowns[operation];
    if (state.revoked && (!success || !Object.keys(state.shutdowns).length)) {
      state = { ...state, shutdownPending: !success };
    }
  },
  record: () => true, read: () => '{"records":[]}', clear: () => true,
};
