const { FieldValue, getFirestore } = require('../firebase');

/**
 * The loyalty program's on/off switch, set by admins (see server/api/loyalty):
 *
 *   settings/loyalty { enabled: boolean, changedAt, changedBy }
 *
 * Off by default. While it's off, nothing new happens with credits: checkout doesn't offer them,
 * they can't be used, and finished bookings don't earn them. Credits that a booking already used
 * are still given back if the booking doesn't go ahead (see promoCodes/bookingEvents.js).
 */

const SETTINGS_DOC = ['settings', 'loyalty'];
// Read at most once a minute per server process
const CACHE_MS = 60 * 1000;

let cache = null;

const settingsRef = () =>
  getFirestore()
    .collection(SETTINGS_DOC[0])
    .doc(SETTINGS_DOC[1]);

const toMillis = value => (value?.toMillis ? value.toMillis() : value || null);

/**
 * The loyalty switch.
 *
 * @param {Object} [params]
 * @param {Date} [params.now]
 * @returns {Promise<{enabled: boolean, changedAt: number|null}>}
 */
const getLoyaltySettings = async ({ now = new Date() } = {}) => {
  if (cache && now.getTime() - cache.readAt < CACHE_MS) {
    return cache.settings;
  }
  const doc = await settingsRef().get();
  const data = doc.exists ? doc.data() : {};
  const settings = { enabled: data.enabled === true, changedAt: toMillis(data.changedAt) };
  cache = { settings, readAt: now.getTime() };
  return settings;
};

/**
 * Whether the loyalty program was on at the given time: a booking finished while it was on
 * still earns credits if the switch is turned off before the booking's event is read.
 *
 * @param {Object} settings See getLoyaltySettings
 * @param {Date|string} [at] When something happened (default: now)
 * @returns {boolean}
 */
const wasLoyaltyEnabledAt = (settings, at) => {
  const time = at ? new Date(at).getTime() : Date.now();
  const changedBefore = !settings.changedAt || Number.isNaN(time) || settings.changedAt <= time;
  return changedBefore ? settings.enabled : !settings.enabled;
};

/**
 * Turn the loyalty program on or off. The caller must have checked that the user is an admin.
 *
 * @param {boolean} enabled
 * @param {string} adminId
 * @returns {Promise<{enabled: boolean, changedAt: number|null}>}
 */
const setLoyaltyEnabled = async (enabled, adminId) => {
  if (typeof enabled !== 'boolean') {
    const error = new Error('invalid-enabled');
    error.status = 400;
    error.code = 'invalid-enabled';
    throw error;
  }
  await settingsRef().set(
    { enabled, changedAt: FieldValue.serverTimestamp(), changedBy: adminId },
    { merge: true }
  );
  cache = null;
  return getLoyaltySettings();
};

// For tests
const clearLoyaltySettingsCache = () => {
  cache = null;
};

module.exports = {
  clearLoyaltySettingsCache,
  getLoyaltySettings,
  setLoyaltyEnabled,
  wasLoyaltyEnabledAt,
};
