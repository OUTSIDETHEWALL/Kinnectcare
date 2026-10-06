const KEY = '@kinnship/background_location_disclosure_shown_v1';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('Android prominent location disclosure', () => {
  let storage: any;
  let location: any;
  let alert: jest.Mock;
  let platform: { OS: string };
  let ensure: () => Promise<void>;
  let copy: string;

  beforeEach(() => {
    jest.resetModules();
    storage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
    };
    location = {
      getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'undetermined' }),
      requestForegroundPermissionsAsync: jest.fn(),
      requestBackgroundPermissionsAsync: jest.fn(),
    };
    alert = jest.fn();
    platform = { OS: 'android' };
    jest.doMock('@react-native-async-storage/async-storage', () => storage);
    jest.doMock('expo-location', () => location);
    jest.doMock('react-native', () => ({ Platform: platform, Alert: { alert } }));
    const module = require('../backgroundLocationDisclosure');
    ensure = module.ensureBackgroundLocationDisclosure;
    copy = module.BACKGROUND_LOCATION_DISCLOSURE_TEXT;
  });

  function continueDisclosure() {
    alert.mock.calls[alert.mock.calls.length - 1][2][0].onPress();
  }

  it('requires Continue on a clean install and saves only after acknowledgment', async () => {
    let completed = false;
    const pending = ensure().then(() => { completed = true; });
    await settle();
    expect(alert).toHaveBeenCalledWith(
      'Location sharing in the background',
      'Kinnship collects location data to enable family safety location sharing, ' +
        'including current location on your family map and location in SOS alerts, ' +
        'even when the app is closed or not in use. Your location is shared only ' +
        'with members of your Kinnship family group and is never used for advertising.',
      [{ text: 'Continue', onPress: expect.any(Function) }],
      { cancelable: false },
    );
    expect(completed).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    continueDisclosure();
    await pending;
    expect(completed).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(KEY, 'true');
    // This helper only presents disclosure/reads state; it never asks permission.
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(copy).toContain('even when the app is closed or not in use');
  });

  it('does not trust an old acknowledgment when Android has never been asked', async () => {
    storage.getItem.mockResolvedValue('true');
    const pending = ensure();
    await settle();
    expect(location.getForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    continueDisclosure();
    await pending;
  });

  it.each(['granted', 'denied'])(
    'retains an acknowledgment when Android permission is already %s',
    async status => {
      storage.getItem.mockResolvedValue('true');
      location.getForegroundPermissionsAsync.mockResolvedValue({ status });
      await ensure();
      expect(alert).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
    },
  );

  it('shares a single pending operation during slow reads, the dialog, and slow writes', async () => {
    const read = deferred<string | null>();
    const write = deferred<void>();
    storage.getItem.mockReturnValue(read.promise);
    storage.setItem.mockReturnValue(write.promise);
    const first = ensure();
    expect(ensure()).toBe(first);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    read.resolve(null);
    await settle();
    expect(ensure()).toBe(first);
    expect(alert).toHaveBeenCalledTimes(1);
    continueDisclosure();
    await settle();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(ensure()).toBe(first);
    expect(alert).toHaveBeenCalledTimes(1);
    write.resolve(undefined);
    await first;
    storage.getItem.mockResolvedValue('true');
    location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    await ensure();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it.each(['storage', 'permission'])('still discloses if the %s lookup fails', async failure => {
    if (failure === 'storage') storage.getItem.mockRejectedValue(new Error('unavailable'));
    else {
      storage.getItem.mockResolvedValue('true');
      location.getForegroundPermissionsAsync.mockRejectedValue(new Error('unavailable'));
    }
    const pending = ensure();
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    continueDisclosure();
    await pending;
  });

  it('does not trap an acknowledged user on a storage write failure, and retries next time', async () => {
    storage.setItem.mockRejectedValue(new Error('unavailable'));
    const first = ensure();
    await settle();
    continueDisclosure();
    await first;
    const second = ensure();
    await settle();
    expect(alert).toHaveBeenCalledTimes(2);
    continueDisclosure();
    await second;
  });

  it('releases the pending operation after a presentation error so a later call can retry', async () => {
    alert.mockImplementationOnce(() => { throw new Error('alert unavailable'); });
    await expect(ensure()).rejects.toThrow('alert unavailable');
    const retry = ensure();
    await settle();
    expect(alert).toHaveBeenCalledTimes(2);
    continueDisclosure();
    await retry;
  });

  it.each(['ios', 'web'])('does not alter the %s permission flow', async os => {
    platform.OS = os;
    await ensure();
    expect(alert).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(location.getForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});
