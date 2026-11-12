/* global jest */
// Existing authority/lifecycle fixtures inject fetch as their transport double.
// Transport-specific tests unmock this module and exercise real XHR semantics.
jest.mock('./src/backgroundHttp', () => ({
  backgroundHttp: (...args) => global.fetch(...args),
}));
// Existing suites predate the required Android binary extension. Model the
// native contract explicitly; missing-extension behavior has dedicated tests.
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => require('./src/__mocks__/trackingNative').trackingNative,
}));
