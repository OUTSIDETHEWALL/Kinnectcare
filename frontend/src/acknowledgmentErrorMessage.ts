/** Shared by the two interactive acknowledgment paths; never guesses offline. */
export function acknowledgmentErrorMessage(error: unknown): string {
  const failure = error as {
    response?: { status?: number; data?: { detail?: unknown } };
    request?: unknown;
  } | null;
  if (failure?.response) {
    const detail = failure.response.data?.detail;
    return typeof detail === 'string' && detail.trim()
      ? detail
      : 'The server could not complete this acknowledgment. Please refresh and try again.';
  }
  if (failure?.request) {
    return 'Could not reach the server. Please check your connection and try again.';
  }
  return 'Your acknowledgment could not be saved. Please try again.';
}
