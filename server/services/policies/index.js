/**
 * Listing policies: rescheduling and cancellation rules set by the provider (publicData.policies).
 * When a booking is made, they're copied to the transaction's protected data, and the copy applies
 * to that booking even if the provider changes the listing later.
 *
 * Keep in sync with src/util/policies.js, which shows them in the web app.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const MAX_CANCELLATION_RULES = 3;
const COMPARISONS = ['moreThan', 'lessThan'];
const UNITS = ['hours', 'days'];

// Transitions that create a booking: the policies are copied to the transaction with them
const BOOKING_REQUEST_TRANSITIONS = [
  'transition/request-payment',
  'transition/request-payment-after-inquiry',
];

const durationInMs = (amount, unit) => Number(amount) * (unit === 'days' ? DAY_MS : HOUR_MS);

const isValidAmount = amount => Number.isFinite(Number(amount)) && Number(amount) >= 0;

const sanitizeRule = rule => {
  const { heading, comparison, amount, unit, refundPercentage } = rule || {};
  const percentage = Number(refundPercentage);
  const isValid =
    COMPARISONS.includes(comparison) &&
    UNITS.includes(unit) &&
    isValidAmount(amount) &&
    Number.isFinite(percentage) &&
    percentage >= 0 &&
    percentage <= 100;
  return isValid
    ? {
        heading: typeof heading === 'string' ? heading : '',
        comparison,
        amount: Number(amount),
        unit,
        refundPercentage: percentage,
      }
    : null;
};

const sanitizeDuration = duration => {
  const { amount, unit } = duration || {};
  return isValidAmount(amount) && Number(amount) > 0 && UNITS.includes(unit)
    ? { amount: Number(amount), unit }
    : null;
};

/**
 * Policies with only valid values. Without policies, rescheduling is off and there are no
 * cancellation rules and no booking cutoff.
 *
 * @param {Object} [policies]
 * @returns {{reschedule: Object, cancellation: {rules: Array<Object>}}}
 */
const getPolicies = policies => {
  const { reschedule, cancellation, bookingCutoff } = policies || {};
  const allowsReschedule =
    reschedule?.allowed === true &&
    isValidAmount(reschedule?.minNoticeAmount) &&
    UNITS.includes(reschedule?.minNoticeUnit);
  const rules = (cancellation?.rules || [])
    .map(sanitizeRule)
    .filter(Boolean)
    .slice(0, MAX_CANCELLATION_RULES);
  return {
    reschedule: allowsReschedule
      ? {
          allowed: true,
          minNoticeAmount: Number(reschedule.minNoticeAmount),
          minNoticeUnit: reschedule.minNoticeUnit,
        }
      : { allowed: false },
    cancellation: { rules },
    bookingCutoff: sanitizeDuration(bookingCutoff),
  };
};

/**
 * The earliest start of a new booking (or a new time for a booking): bookings can't start
 * within the listing's current booking cutoff (e.g. 24 hours). Null if there's no cutoff.
 *
 * @param {Object} listing Listing entity (attributes.publicData.policies)
 * @param {Date} [now]
 * @returns {Date|null}
 */
const getEarliestBookingStart = (listing, now = new Date()) => {
  const { bookingCutoff } = getPolicies(listing?.attributes?.publicData?.policies);
  return bookingCutoff
    ? new Date(now.getTime() + durationInMs(bookingCutoff.amount, bookingCutoff.unit))
    : null;
};

/**
 * Throws a 400 error (like an SDK error, see handleError) if a booking request starts within
 * the listing's booking cutoff. Other transitions aren't checked.
 *
 * @param {Object} params
 * @param {Object} params.listing
 * @param {string} params.transitionName
 * @param {Date|string} [params.bookingStart]
 * @param {Date} [params.now]
 */
const assertBookingStartAfterCutoff = ({ listing, transitionName, bookingStart, now }) => {
  const earliestStart = getEarliestBookingStart(listing, now);
  const isBookingRequest = BOOKING_REQUEST_TRANSITIONS.includes(transitionName);
  if (
    isBookingRequest &&
    earliestStart &&
    bookingStart &&
    new Date(bookingStart).getTime() < earliestStart.getTime()
  ) {
    const error = new Error('The booking starts within the booking cutoff');
    error.status = 400;
    error.statusText = 'booking-cutoff';
    error.data = { errors: [{ status: 400, code: 'booking-cutoff' }] };
    throw error;
  }
};

/**
 * Protected data to add to a booking request: a copy of the listing's policies. Only for
 * booking listings and the transitions that create a booking.
 *
 * @param {Object} listing Listing entity (attributes.publicData)
 * @param {string} transitionName
 * @returns {Object} { policies } or {}
 */
const getPoliciesProtectedData = (listing, transitionName) => {
  const { transactionProcessAlias, policies } = listing?.attributes?.publicData || {};
  const isBooking = (transactionProcessAlias || '').split('/')[0] === 'default-booking';
  return isBooking && BOOKING_REQUEST_TRANSITIONS.includes(transitionName)
    ? { policies: getPolicies(policies) }
    : {};
};

/**
 * Does the rule apply when the booking starts in timeUntilStartMs?
 *
 * @param {Object} rule
 * @param {number} timeUntilStartMs
 * @returns {boolean}
 */
const isRuleMatching = (rule, timeUntilStartMs) => {
  const threshold = durationInMs(rule.amount, rule.unit);
  return rule.comparison === 'moreThan'
    ? timeUntilStartMs > threshold
    : timeUntilStartMs < threshold;
};

/**
 * The cancellation rule that applies when the booking starts in timeUntilStartMs: the matching
 * rule with the highest refund. Null if no rule matches (the booking can't be cancelled).
 *
 * @param {Array<Object>} rules Sanitized rules
 * @param {number} timeUntilStartMs
 * @returns {Object|null}
 */
const getMatchingCancellationRule = (rules, timeUntilStartMs) =>
  (rules || [])
    .filter(rule => isRuleMatching(rule, timeUntilStartMs))
    .reduce(
      (best, rule) => (!best || rule.refundPercentage > best.refundPercentage ? rule : best),
      null
    );

/**
 * The latest moment a reschedule can be requested, or null if the policy doesn't allow it.
 *
 * @param {Object} reschedulePolicy Sanitized reschedule policy
 * @param {Date} bookingStart
 * @returns {Date|null}
 */
const getRescheduleDeadline = (reschedulePolicy, bookingStart) =>
  reschedulePolicy?.allowed && bookingStart
    ? new Date(
        bookingStart.getTime() -
          durationInMs(reschedulePolicy.minNoticeAmount, reschedulePolicy.minNoticeUnit)
      )
    : null;

module.exports = {
  BOOKING_REQUEST_TRANSITIONS,
  assertBookingStartAfterCutoff,
  getEarliestBookingStart,
  DAY_MS,
  HOUR_MS,
  getMatchingCancellationRule,
  getPolicies,
  getPoliciesProtectedData,
  getRescheduleDeadline,
  isRuleMatching,
};
