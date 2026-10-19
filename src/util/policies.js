/**
 * Listing policies: rescheduling and cancellation rules set by the provider in the listing
 * wizard (Policies tab). They're stored in the listing's public data:
 *
 * publicData.policies = {
 *   reschedule: { allowed: true, minNoticeAmount: 48, minNoticeUnit: 'hours' },
 *   bookingCutoff: { amount: 24, unit: 'hours' }, // optional: no bookings this close to the start
 *   cancellation: {
 *     rules: [
 *       { heading: 'Full refund', comparison: 'moreThan', amount: 48, unit: 'hours', refundPercentage: 100 },
 *       ...
 *     ],
 *   },
 * }
 *
 * When a booking is made, the server copies the policies to the transaction's protected data
 * (protectedData.policies), and those apply to the booking even if the listing changes later.
 *
 * The booking cutoff isn't part of the booking's copy: new bookings and reschedules follow the
 * listing's current cutoff (see getEarliestBookingStart).
 *
 * Keep the rules in sync with server/services/policies, which enforces them.
 */

import { getStartOf } from './dates';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const MAX_CANCELLATION_RULES = 3;

export const COMPARISON_MORE_THAN = 'moreThan';
export const COMPARISON_LESS_THAN = 'lessThan';
export const COMPARISONS = [COMPARISON_MORE_THAN, COMPARISON_LESS_THAN];

export const UNIT_HOURS = 'hours';
export const UNIT_DAYS = 'days';
export const UNITS = [UNIT_HOURS, UNIT_DAYS];

/**
 * Duration of an amount of hours or days in milliseconds.
 *
 * @param {number} amount
 * @param {'hours'|'days'} unit
 * @returns {number}
 */
export const durationInMs = (amount, unit) =>
  Number(amount) * (unit === UNIT_DAYS ? DAY_MS : HOUR_MS);

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
 * Policies with only valid values. Listings without policies have rescheduling turned off, no
 * cancellation rules and no booking cutoff.
 *
 * @param {Object} [policies] publicData.policies of a listing or protectedData.policies of a
 * transaction
 * @returns {{reschedule: Object, cancellation: {rules: Array<Object>}}}
 */
export const getPolicies = policies => {
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
 * The earliest start of a new booking: bookings can't start within the listing's booking cutoff
 * (e.g. 24 hours). Null if the listing has no cutoff.
 *
 * @param {Object} [policies] Listing's publicData.policies
 * @param {Date} [now]
 * @returns {Date|null}
 */
export const getEarliestBookingStart = (policies, now = new Date()) => {
  const { bookingCutoff } = getPolicies(policies);
  return bookingCutoff
    ? new Date(now.getTime() + durationInMs(bookingCutoff.amount, bookingCutoff.unit))
    : null;
};

/**
 * Time slot query params that leave out the time within the booking cutoff: the query starts at
 * the earliest booking start. Day intervals (intervalDuration P1D) are aligned to the start of
 * that day, as the API requires the alignment to be within one interval before the start.
 *
 * @param {Object} params
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {string} params.timeZone Listing's time zone
 * @param {Object} params.extraParams Other query params (e.g. intervalAlign)
 * @param {Date|null} params.earliestStart See getEarliestBookingStart
 * @returns {Object|null} { start, extraParams }, or null if nothing can be booked in the range
 */
export const getTimeSlotQueryAfterCutoff = ({
  start,
  end,
  timeZone,
  extraParams,
  earliestStart,
}) => {
  if (!earliestStart || start.getTime() >= earliestStart.getTime()) {
    return { start, extraParams };
  }
  if (earliestStart.getTime() >= end.getTime()) {
    return null;
  }
  const alignMaybe = extraParams?.intervalAlign
    ? { intervalAlign: getStartOf(earliestStart, 'day', timeZone) }
    : {};
  return { start: earliestStart, extraParams: { ...extraParams, ...alignMaybe } };
};

/**
 * Does the rule apply when the booking starts in timeUntilStartMs?
 *
 * @param {Object} rule
 * @param {number} timeUntilStartMs
 * @returns {boolean}
 */
export const isRuleMatching = (rule, timeUntilStartMs) => {
  const threshold = durationInMs(rule.amount, rule.unit);
  return rule.comparison === COMPARISON_MORE_THAN
    ? timeUntilStartMs > threshold
    : timeUntilStartMs < threshold;
};

/**
 * The cancellation rule that applies when the booking starts in timeUntilStartMs. If more than
 * one rule matches, the one with the highest refund applies. Null if no rule matches: then the
 * booking can't be cancelled after it has been accepted.
 *
 * @param {Array<Object>} rules Sanitized rules (see getPolicies)
 * @param {number} timeUntilStartMs
 * @returns {Object|null}
 */
export const getMatchingCancellationRule = (rules, timeUntilStartMs) =>
  (rules || [])
    .filter(rule => isRuleMatching(rule, timeUntilStartMs))
    .reduce(
      (best, rule) => (!best || rule.refundPercentage > best.refundPercentage ? rule : best),
      null
    );

/**
 * The latest moment a reschedule can be requested, or null if rescheduling isn't allowed.
 *
 * @param {Object} reschedulePolicy Sanitized reschedule policy (see getPolicies)
 * @param {Date} bookingStart
 * @returns {Date|null}
 */
export const getRescheduleDeadline = (reschedulePolicy, bookingStart) =>
  reschedulePolicy?.allowed && bookingStart
    ? new Date(
        bookingStart.getTime() -
          durationInMs(reschedulePolicy.minNoticeAmount, reschedulePolicy.minNoticeUnit)
      )
    : null;
