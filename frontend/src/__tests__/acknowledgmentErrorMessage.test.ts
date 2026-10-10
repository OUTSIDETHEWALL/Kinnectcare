import { acknowledgmentErrorMessage } from '../acknowledgmentErrorMessage';

describe('interactive acknowledgment error messages', () => {
  it.each([409, 400, 401, 403, 404, 503, 500])('does not expose arbitrary server detail for HTTP %s', status => {
    expect(acknowledgmentErrorMessage({
      response: { status, data: { detail: 'Server explanation' } }, request: {},
    })).not.toMatch(/Server explanation|offline|connection/);
  });

  it.each([undefined, '', ['validation error']])('uses a server fallback when detail is unusable', detail => {
    expect(acknowledgmentErrorMessage({ response: { status: 409, data: { detail } } }))
      .toBe('This dose cannot be confirmed yet. Please refresh and try again.');
  });

  it('only suggests checking connectivity when a request got no response', () => {
    expect(acknowledgmentErrorMessage({ request: {} })).toContain('Could not reach the server');
  });

  it.each([new Error('local failure'), null, undefined])('does not diagnose local/unknown failures as offline', error => {
    expect(acknowledgmentErrorMessage(error)).toBe('Your acknowledgment could not be saved. Please try again.');
  });
});
