/* global jest */
// Existing suites predate the required Android binary extension. Model the
// native contract explicitly; missing-extension behavior has dedicated tests.
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => require('./src/__mocks__/trackingNative').trackingNative,
}));
