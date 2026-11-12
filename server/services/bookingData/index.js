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
 *
 * providerPayout: the provider's whole payout of a booking paid out by Pastime, for the provider's
 * emails (Sharetribe's payout total doesn't include Pastime's part). Only the total: what the
 * customer used (credits, an admin's code) isn't shown to providers.
 */
const SERVER_OWNED_KEYS = ['policies', 'reschedule', 'promoCode', 'loyalty', 'providerPayout'];

// Promo codes and loyalty credits only apply to bookings (the other processes' refunds aren't
// handled for them)
const BOOKING_PROCESS_NAME = 'default-booking';
// Bookings where Pastime pays part of the provider's payout, and free bookings (see
// server/services/commission getPaymentPlan). Same states and transitions as default-booking.
const PLATFORM_PAID_BOOKING_PROCESS_NAME = 'booking-platform-paid';
const FREE_BOOKING_PROCESS_NAME = 'booking-free';
const BOOKING_PROCESS_NAMES = [
  BOOKING_PROCESS_NAME,
  PLATFORM_PAID_BOOKING_PROCESS_NAME,
  FREE_BOOKING_PROCESS_NAME,
];

const processNameOf = processNameOrAlias =>
  typeof processNameOrAlias === 'string' ? processNameOrAlias.split('/')[0] : null;

/**
 * Whether a process name or alias (e.g. 'default-booking/release-1') is one of the booking
 * processes.
 *
 * @param {string} [processNameOrAlias]
 * @returns {boolean}
 */
const isBookingProcess = processNameOrAlias =>
  BOOKING_PROCESS_NAMES.includes(processNameOf(processNameOrAlias));

/**
 * Whether Pastime's server pays the provider of this booking (instead of Sharetribe).
 *
 * @param {string} [processNameOrAlias]
 * @returns {boolean}
 */
const isPaidOutByPlatform = processNameOrAlias =>
  [PLATFORM_PAID_BOOKING_PROCESS_NAME, FREE_BOOKING_PROCESS_NAME].includes(
    processNameOf(processNameOrAlias)
  );

/**
 * Whether the booking has a Stripe payment (free bookings don't).
 *
 * @param {string} [processNameOrAlias]
 * @returns {boolean}
 */
const hasStripePayment = processNameOrAlias =>
  processNameOf(processNameOrAlias) !== FREE_BOOKING_PROCESS_NAME;

/**
 * The process and request transition a booking request must use, by how it's paid.
 *
 * @param {'standard'|'platform-paid'|'free'} paymentType From getPaymentPlan
 * @returns {{processAlias: string, transition: string}}
 */
const getBookingRequest = paymentType =>
  paymentType === 'free'
    ? { processAlias: `${FREE_BOOKING_PROCESS_NAME}/release-1`, transition: 'transition/request' }
    : paymentType === 'platform-paid'
    ? {
        processAlias: `${PLATFORM_PAID_BOOKING_PROCESS_NAME}/release-1`,
        transition: 'transition/request-payment',
      }
    : {
        processAlias: `${BOOKING_PROCESS_NAME}/release-1`,
        transition: 'transition/request-payment',
      };

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
  BOOKING_PROCESS_NAMES,
  FREE_BOOKING_PROCESS_NAME,
  PLATFORM_PAID_BOOKING_PROCESS_NAME,
  getBookingRequest,
  hasStripePayment,
  isPaidOutByPlatform,
  SERVER_OWNED_KEYS,
  getProtectedDataParams,
  isBookingProcess,
};
