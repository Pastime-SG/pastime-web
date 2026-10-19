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
 * The Firestore instance. The Firebase app is initialized on the first call.
 *
 * @returns {Object} Firestore
 */
const getFirestore = () => {
  if (firestore) {
    return firestore;
  }
  const serviceAccount = parseServiceAccount();
  if (!serviceAccount) {
    throw new Error(
      'Firebase service account is missing. Set FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH.'
    );
  }
  const app = getApps().some(a => a.name === APP_NAME)
    ? getApp(APP_NAME)
    : initializeApp({ credential: cert(serviceAccount) }, APP_NAME);
  firestore = getAdminFirestore(app);
  return firestore;
};

module.exports = {
  FieldValue,
  getFirestore,
};
