/**
 * Firebase Admin SDK (Firestore), used on the server only.
 *
 * The service account credentials are read from the environment, so that the service account
 * JSON file never ends up in the repository:
 *   - FIREBASE_SERVICE_ACCOUNT: the service account JSON, as-is or base64 encoded
 *   - FIREBASE_SERVICE_ACCOUNT_PATH: a path to the service account JSON file (local development)
 */
const path = require('path');
const { initializeApp, getApps, getApp, cert } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore, FieldValue } = require('firebase-admin/firestore');

// A named app, so that it can't clash with another Firebase app in the same process
const APP_NAME = 'pastime';

let firestore = null;

// Error code when Firebase isn't set up on this server (e.g. the dev site has no service account):
// the features stored in Firestore aren't available there
const FEATURE_UNAVAILABLE = 'feature-unavailable';

const parseServiceAccount = () => {
  const { FIREBASE_SERVICE_ACCOUNT, FIREBASE_SERVICE_ACCOUNT_PATH } = process.env;
  if (FIREBASE_SERVICE_ACCOUNT) {
    const trimmed = FIREBASE_SERVICE_ACCOUNT.trim();
    const json = trimmed.startsWith('{')
      ? trimmed
      : Buffer.from(trimmed, 'base64').toString('utf8');
    return JSON.parse(json);
  }
  if (FIREBASE_SERVICE_ACCOUNT_PATH) {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(path.resolve(FIREBASE_SERVICE_ACCOUNT_PATH));
  }
  return null;
};

/**
 * Whether Firebase is set up on this server (a service account is given).
 *
 * @returns {boolean}
 */
const isFirebaseConfigured = () =>
  !!process.env.FIREBASE_SERVICE_ACCOUNT || !!process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

/**
 * The error for a feature that needs Firestore when Firebase isn't set up: 503 with the code
 * 'feature-unavailable'. It has both shapes the app's server sends errors in: { status, code }
 * (see the controllers' sendError) and the SDK's { status, statusText, data } (see handleError,
 * e.g. a promo code at checkout).
 *
 * @returns {Error}
 */
const featureUnavailableError = () => {
  const error = new Error(
    'This feature is not available on this environment: Firebase is not set up (FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH).'
  );
  error.status = 503;
  error.code = FEATURE_UNAVAILABLE;
  error.statusText = FEATURE_UNAVAILABLE;
  error.data = { errors: [{ status: 503, code: FEATURE_UNAVAILABLE }] };
  return error;
};

/**
 * Whether an error is the one for Firebase not being set up.
 *
 * @param {Error} e
 * @returns {boolean}
 */
const isFeatureUnavailableError = e => e?.code === FEATURE_UNAVAILABLE;

/**
 * The Firestore instance. The Firebase app is initialized on the first call. Throws
 * featureUnavailableError() when Firebase isn't set up.
 *
 * @returns {Object} Firestore
 */
const getFirestore = () => {
  if (firestore) {
    return firestore;
  }
  const serviceAccount = parseServiceAccount();
  if (!serviceAccount) {
    throw featureUnavailableError();
  }
  const app = getApps().some(a => a.name === APP_NAME)
    ? getApp(APP_NAME)
    : initializeApp({ credential: cert(serviceAccount) }, APP_NAME);
  firestore = getAdminFirestore(app);
  return firestore;
};

module.exports = {
  FEATURE_UNAVAILABLE,
  FieldValue,
  featureUnavailableError,
  getFirestore,
  isFeatureUnavailableError,
  isFirebaseConfigured,
};
