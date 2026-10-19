/**
 * Protected data keys that only the app's server sets on a booking: the policies it was made
 * with, a pending reschedule, the applied promo code and the loyalty credits it used. The server
 * trusts them later (refunds, giving back promo code uses and credits), so they must never come
 * from the client.
 *
 * The client can write protected data directly with the Marketplace API in one transition: the
 * inquiry (transition/inquire, not privileged). So when a booking is requested after an inquiry,
 * these keys are always written by the server, as null when not used, to replace anything the
 * inquiry stored.
 */
const SERVER_OWNED_KEYS = ['policies', 'reschedule', 'promoCode', 'loyalty'];

// Promo codes and loyalty credits only apply to bookings (the other processes' refunds aren't
// handled for them)
const BOOKING_PROCESS_NAME = 'default-booking';

/**
 * Whether a process name or alias (e.g. 'default-booking/release-1') is the booking process.
 *
 * @param {string} [processNameOrAlias]
 * @returns {boolean}
 */
const isBookingProcess = processNameOrAlias =>
  typeof processNameOrAlias === 'string' &&
  processNameOrAlias.split('/')[0] === BOOKING_PROCESS_NAME;

/**
 * Protected data for a privileged transition: the client's protected data without the
 * server-owned keys, plus the server's values.
 *
 * @param {Object} params
 * @param {Object} [params.clientProtectedData] From the client's request
 * @param {Object} [params.serverProtectedData] Server-owned values, e.g. { policies, promoCode }
 * @param {boolean} [params.replaceServerOwned] Write every server-owned key (null if not set),
 * e.g. when the transaction exists already (a booking request after an inquiry)
 * @returns {Object} { protectedData } or {} when there's nothing to write
 */
const getProtectedDataParams = ({
  clientProtectedData,
  serverProtectedData = {},
  replaceServerOwned = false,
}) => {
  const fromClient = Object.fromEntries(
    Object.entries(clientProtectedData || {}).filter(([key]) => !SERVER_OWNED_KEYS.includes(key))
  );
  const resetMaybe = replaceServerOwned
    ? Object.fromEntries(SERVER_OWNED_KEYS.map(key => [key, null]))
    : {};
  const protectedData = { ...fromClient, ...resetMaybe, ...serverProtectedData };
  return Object.keys(protectedData).length > 0 ? { protectedData } : {};
};

module.exports = {
  BOOKING_PROCESS_NAME,
  SERVER_OWNED_KEYS,
  getProtectedDataParams,
  isBookingProcess,
};
