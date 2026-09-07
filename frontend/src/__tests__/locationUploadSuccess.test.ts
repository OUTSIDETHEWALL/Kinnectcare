const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
const mockGetAllKeys = jest.fn();
const mockMultiRemove = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: unknown[]) => mockGetItem(...args),
    setItem: (...args: unknown[]) => mockSetItem(...args),
    getAllKeys: (...args: unknown[]) => mockGetAllKeys(...args),
    multiRemove: (...args: unknown[]) => mockMultiRemove(...args),
  },
}));

import {
  LOCATION_UPLOAD_SUCCESS_KEY,
  getLocationUploadSuccessTs,
  recordLocationUploadSuccess,
} from '../locationUploadSuccess';

describe('recordLocationUploadSuccess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
    mockGetAllKeys.mockResolvedValue([]);
    mockMultiRemove.mockResolvedValue(undefined);
  });

  it('writes the shared Diagnostics timestamp for a successful upload', async () => {
    await recordLocationUploadSuccess(1_788_806_400_000);

    expect(mockSetItem).toHaveBeenCalledWith(
      `${LOCATION_UPLOAD_SUCCESS_KEY}:1788806400000`,
      '1',
    );
    expect(mockSetItem).toHaveBeenCalledWith(
      LOCATION_UPLOAD_SUCCESS_KEY,
      '1788806400000',
    );
  });

  it('reads the newest marker even if an older runtime regressed the legacy cache', async () => {
    mockGetItem.mockResolvedValue('1788806400000');
    mockGetAllKeys.mockResolvedValue([
      `${LOCATION_UPLOAD_SUCCESS_KEY}:1788806400000`,
      `${LOCATION_UPLOAD_SUCCESS_KEY}:1788806500000`,
    ]);

    await expect(getLocationUploadSuccessTs()).resolves.toBe(1_788_806_500_000);
  });

  it('cleanup removes only older markers and retains the newest evidence', async () => {
    mockGetAllKeys.mockResolvedValue([
      `${LOCATION_UPLOAD_SUCCESS_KEY}:100`,
      `${LOCATION_UPLOAD_SUCCESS_KEY}:200`,
      `${LOCATION_UPLOAD_SUCCESS_KEY}:300`,
      `${LOCATION_UPLOAD_SUCCESS_KEY}:400`,
      `${LOCATION_UPLOAD_SUCCESS_KEY}:500`,
      `${LOCATION_UPLOAD_SUCCESS_KEY}:600`,
    ]);

    await recordLocationUploadSuccess(600);

    expect(mockMultiRemove).toHaveBeenCalledWith([
      `${LOCATION_UPLOAD_SUCCESS_KEY}:200`,
      `${LOCATION_UPLOAD_SUCCESS_KEY}:100`,
    ]);
  });

  it('swallows storage failures so Diagnostics cannot break uploading', async () => {
    mockSetItem.mockRejectedValue(new Error('storage unavailable'));

    await expect(recordLocationUploadSuccess(1_788_806_400_000)).resolves.toBeUndefined();
  });
});