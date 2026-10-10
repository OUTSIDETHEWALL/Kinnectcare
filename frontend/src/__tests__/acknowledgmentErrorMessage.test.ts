import { acknowledgmentErrorMessage } from '../acknowledgmentErrorMessage';

describe('interactive acknowledgment error messages', () => {
  it.each([409, 400, 401, 403, 404, 503])('shows the server detail for HTTP %s, never offline', status => {
    expect(acknowledgmentErrorMessage({
      response: { status, data: { detail: 'Server explanation' } }, request: {},
    })).toBe('Server explanation');
  });

  it.each([undefined, '', ['validation error']])('uses a server fallback when detail is unusable', detail => {
    expect(acknowledgmentErrorMessage({ response: { status: 409, data: { detail } } }))
      .toBe('The server could not complete this acknowledgment. Please refresh and try again.');
  });

  it('only suggests checking connectivity when a request got no response', () => {
    expect(acknowledgmentErrorMessage({ request: {} })).toContain('Could not reach the server');
  });

  it.each([new Error('local failure'), null, undefined])('does not diagnose local/unknown failures as offline', error => {
    expect(acknowledgmentErrorMessage(error)).toBe('Your acknowledgment could not be saved. Please try again.');
  });
});
