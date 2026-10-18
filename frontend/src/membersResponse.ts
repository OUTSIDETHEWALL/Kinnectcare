import type { AxiosResponse } from 'axios';
import { api, subscribeToTokenChanges, type Member } from './api';

// Coalesce only overlapping requests, never reuse a completed response. Keep
// the raw status/headers/payload for Dashboard's diagnostic trace.
let pending: Promise<AxiosResponse<Member[]>> | null = null;
let observingSession = false;

export function invalidateMembersResponse(): void {
  pending = null;
}

export function getMembersResponse(): Promise<AxiosResponse<Member[]>> {
  if (!observingSession) {
    subscribeToTokenChanges(invalidateMembersResponse);
    observingSession = true;
  }
  if (pending) return pending;
  const request = api.get<Member[]>('/members');
  pending = request;
  const settled = () => {
    // An old account/request must not clear its replacement's flight.
    if (pending === request) pending = null;
  };
  void request.then(settled, settled);
  return request;
}
