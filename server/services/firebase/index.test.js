const {
  FEATURE_UNAVAILABLE,
  getFirestore,
  isFeatureUnavailableError,
  isFirebaseConfigured,
} = require('./index');

describe('firebase', () => {
  const env = { ...process.env };

  beforeEach(() => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  });

  afterAll(() => {
    process.env = env;
  });

  it('is not configured without a service account', () => {
    expect(isFirebaseConfigured()).toBe(false);
    process.env.FIREBASE_SERVICE_ACCOUNT = '{}';
    expect(isFirebaseConfigured()).toBe(true);
  });

  it('throws a 503 feature-unavailable error without a service account', () => {
    let error = null;
    try {
      getFirestore();
    } catch (e) {
      error = e;
    }
    expect(isFeatureUnavailableError(error)).toBe(true);
    // Both error shapes: { status, code } and the SDK's { status, statusText, data }
    expect(error.status).toBe(503);
    expect(error.code).toBe(FEATURE_UNAVAILABLE);
    expect(error.statusText).toBe(FEATURE_UNAVAILABLE);
    expect(error.data.errors[0].code).toBe(FEATURE_UNAVAILABLE);
  });
});
