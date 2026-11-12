const { FieldValue, getFirestore } = require('../firebase');

/**
 * The switch for studio (merchant) promo codes, set by admins (see server/api/promo-codes):
 *
 *   settings/promoCodes { merchantCodesEnabled: boolean, changedAt, changedBy }
 *
 * On by default. While it's off, studios can't create or turn on codes, and studio codes don't
 * work at checkout. Marketplace (admin) codes aren't affected, and uses of studio codes are still
 * given back when bookings don't go ahead.
 */

const SETTINGS_DOC = ['settings', 'promoCodes'];
// Read at most once a minute per server process
const CACHE_MS = 60 * 1000;

let cache = null;

const settingsRef = () =>
  getFirestore()
    .collection(SETTINGS_DOC[0])
    .doc(SETTINGS_DOC[1]);

/**
 * @param {Object} [params]
 * @param {Date} [params.now]
 * @returns {Promise<{merchantCodesEnabled: boolean}>}
 */
const getPromoCodeSettings = async ({ now = new Date() } = {}) => {
  if (cache && now.getTime() - cache.readAt < CACHE_MS) {
    return cache.settings;
  }
  const doc = await settingsRef().get();
  const data = doc.exists ? doc.data() : {};
  const settings = { merchantCodesEnabled: data.merchantCodesEnabled !== false };
  cache = { settings, readAt: now.getTime() };
  return settings;
};

/**
 * Turn studio promo codes on or off. The caller must have checked that the user is an admin.
 *
 * @param {boolean} merchantCodesEnabled
 * @param {string} adminId
 * @returns {Promise<{merchantCodesEnabled: boolean}>}
 */
const setMerchantCodesEnabled = async (merchantCodesEnabled, adminId) => {
  if (typeof merchantCodesEnabled !== 'boolean') {
    const error = new Error('invalid-enabled');
    error.status = 400;
    error.code = 'invalid-enabled';
    throw error;
  }
  await settingsRef().set(
    { merchantCodesEnabled, changedAt: FieldValue.serverTimestamp(), changedBy: adminId },
    { merge: true }
  );
  cache = null;
  return getPromoCodeSettings();
};

/**
 * Throws 403 'merchant-codes-disabled' while studio promo codes are turned off.
 */
const assertMerchantCodesEnabled = async () => {
  if (!(await getPromoCodeSettings()).merchantCodesEnabled) {
    const error = new Error('merchant-codes-disabled');
    error.status = 403;
    error.code = 'merchant-codes-disabled';
    throw error;
  }
};

// For tests
const clearPromoCodeSettingsCache = () => {
  cache = null;
};

module.exports = {
  assertMerchantCodesEnabled,
  clearPromoCodeSettingsCache,
  getPromoCodeSettings,
  setMerchantCodesEnabled,
};
