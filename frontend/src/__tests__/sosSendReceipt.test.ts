import {
  clearSosSendReceipt, noteSosDialerOpened, readSosSendReceipt, recordSosSendReceipt,
} from '../sosSendReceipt';

const response = {
  ok: true, alert_id: 'synthetic-sos', timestamp: '2026-11-19T12:00:00Z',
  coordinates: { latitude: 12, longitude: 34 }, fanout_mode: 'background',
};

const scope = 'synthetic-account-family';
afterEach(() => clearSosSendReceipt());

it('retains outcome metadata, not coordinates or a fabricated delivery/call outcome', () => {
  const receipt = recordSosSendReceipt(response, { capturedAt: 100, accuracy: 5, acquiredDuringAttempt: true }, false, scope);
  expect(receipt).toEqual({
    scope,
    alertId: 'synthetic-sos', recordedAt: response.timestamp, notificationRequested: true,
    location: 'gps', capturedAt: 100, accuracy: 5, dialerOpened: false,
  });
  expect(readSosSendReceipt('different', scope)).toBeNull();
  expect(readSosSendReceipt(['synthetic-sos'], scope)).toBeNull();
  expect(readSosSendReceipt('synthetic-sos', 'other-account-family')).toBeNull();
  noteSosDialerOpened('different');
  expect(receipt.dialerOpened).toBe(false);
  noteSosDialerOpened('synthetic-sos');
  expect(readSosSendReceipt('synthetic-sos', scope)?.dialerOpened).toBe(true);
});

it('does not invent timestamp, freshness, or notification requests for an older/partial response', () => {
  const receipt = recordSosSendReceipt({ ...response, timestamp: 'bad', fanout_mode: undefined }, {}, false, scope);
  expect(receipt.recordedAt).toBeNull();
  expect(receipt.location).toBe('included');
  expect(receipt.notificationRequested).toBe(false);
});

it.each([null, {}, { latitude: 12 }, { latitude: NaN, longitude: 34 }, { latitude: 91, longitude: 34 }])(
  'does not treat invalid or missing coordinates as included: %j', coordinates => {
    expect(recordSosSendReceipt({ ...response, coordinates }, {}, false, scope).location).toBe('unavailable');
  },
);

it('distinguishes known older capture from a GPS fix acquired during this attempt', () => {
  expect(recordSosSendReceipt(response, { capturedAt: 100, acquiredDuringAttempt: false }, false, scope).location)
    .toBe('last-known');
});
