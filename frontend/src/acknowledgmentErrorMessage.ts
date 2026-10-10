/** Shared by the two interactive acknowledgment paths; never guesses offline. */
export function acknowledgmentErrorMessage(error: unknown): string {
  const failure = error as {
    response?: { status?: number; data?: { detail?: unknown } };
    request?: unknown;
  } | null;
  if (failure?.response) {
    const detail = failure.response.data?.detail;
    if (failure.response.status === 409) {
      // Only use a known domain message, never arbitrary server diagnostics.
      if (typeof detail === 'string' && detail.startsWith('Medication occurrence was already marked missed')) {
        return 'This dose was already marked missed and cannot be marked Taken.';
      }
      return 'This dose cannot be confirmed yet. Please refresh and try again.';
    }
    if (failure.response.status === 401 || failure.response.status === 403) {
      return 'Please sign in with an account allowed to confirm this dose.';
    }
    if (failure.response.status === 404) {
      return 'This reminder or alert is no longer available. Please refresh.';
    }
    return 'The server could not complete this acknowledgment. Please refresh and try again.';
  }
  if (failure?.request) {
    return 'Could not reach the server. Please check your connection and try again.';
  }
  return 'Your acknowledgment could not be saved. Please try again.';
}
