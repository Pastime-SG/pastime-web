/**
 * Rescheduling an accepted booking (default-booking process).
 *
 * Rules:
 *  - One reschedule loop per booking. The first request can be made while the booking is
 *    accepted and starts in 7 days or more. The loop ends when the new time is accepted or
 *    declined (or when the request expires at the booking start).
 *  - The suggested time is stored in the transaction's protected data (`reschedule`). The
 *    booking itself is updated only when the other party accepts it.
 *  - The duration can't change (so the price doesn't change either): only the start time is
 *    chosen, the end time is start + the booking's duration (e.g. the session length of a
 *    fixed-duration listing).
 *  - Start times follow the listing's start time interval (every hour, half hour or quarter
 *    hour), like in the booking form.
 *  - The booking keeps its seats: the new time needs that many free seats.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The first reschedule request can be made until this many days before the booking starts.
const MIN_DAYS_BEFORE_START_TO_REQUEST = 7;

// A booking can't be moved further than this from the payment. This keeps the same limit as
// the booking form (config.stripe.dayCountAvailableForBooking): Stripe holds the funds until
// the payout, which happens when the booking is completed.
const MAX_DAYS_FROM_PAYMENT = 90;

// Listing unit types whose bookings can be rescheduled (bookings with a start time)
const RESCHEDULABLE_UNIT_TYPES = ['fixed', 'hour'];

// Minutes between possible start times (listing's publicData.startTimeInterval)
const START_TIME_INTERVAL_MINUTES = {
  hour: 60,
  halfHour: 30,
  quarterHour: 15,
};

/**
 * Minutes between possible start times of the listing. Defaults to an hour.
 *
 * @param {Object} publicData Listing's public data
 * @returns {number}
 */
const getStartTimeIntervalMinutes = publicData =>
  START_TIME_INTERVAL_MINUTES[(publicData?.startTimeInterval)] || START_TIME_INTERVAL_MINUTES.hour;

const TRANSITIONS = {
  ACCEPT: 'transition/accept',
  OPERATOR_ACCEPT: 'transition/operator-accept',
  CONFIRM_PAYMENT: 'transition/confirm-payment',
  REQUEST_BY_CUSTOMER: 'transition/request-reschedule-by-customer',
  REQUEST_BY_PROVIDER: 'transition/request-reschedule-by-provider',
  ACCEPT_BY_PROVIDER: 'transition/accept-reschedule-by-provider',
  ACCEPT_BY_CUSTOMER: 'transition/accept-reschedule-by-customer',
  COUNTER_BY_PROVIDER: 'transition/counter-reschedule-by-provider',
  COUNTER_BY_CUSTOMER: 'transition/counter-reschedule-by-customer',
  DECLINE_BY_PROVIDER: 'transition/decline-reschedule-by-provider',
  DECLINE_BY_CUSTOMER: 'transition/decline-reschedule-by-customer',
  EXPIRE_REQUESTED_BY_CUSTOMER: 'transition/expire-reschedule-requested-by-customer',
  EXPIRE_REQUESTED_BY_PROVIDER: 'transition/expire-reschedule-requested-by-provider',
};

// User transitions of the reschedule loop. They can only be made through
// server/api/reschedule/reschedule.js, which validates them.
const RESCHEDULE_USER_TRANSITIONS = [
  TRANSITIONS.REQUEST_BY_CUSTOMER,
  TRANSITIONS.REQUEST_BY_PROVIDER,
  TRANSITIONS.ACCEPT_BY_PROVIDER,
  TRANSITIONS.ACCEPT_BY_CUSTOMER,
  TRANSITIONS.COUNTER_BY_PROVIDER,
  TRANSITIONS.COUNTER_BY_CUSTOMER,
  TRANSITIONS.DECLINE_BY_PROVIDER,
  TRANSITIONS.DECLINE_BY_CUSTOMER,
];

// Stages of an accepted booking, derived from the last transition
const STAGE_ACCEPTED = 'accepted';
const STAGE_REQUESTED_BY_CUSTOMER = 'requested-by-customer';
const STAGE_REQUESTED_BY_PROVIDER = 'requested-by-provider';

const LAST_TRANSITIONS_BY_STAGE = {
  [STAGE_ACCEPTED]: [
    TRANSITIONS.ACCEPT,
    TRANSITIONS.OPERATOR_ACCEPT,
    TRANSITIONS.ACCEPT_BY_PROVIDER,
    TRANSITIONS.ACCEPT_BY_CUSTOMER,
    TRANSITIONS.DECLINE_BY_PROVIDER,
    TRANSITIONS.DECLINE_BY_CUSTOMER,
    TRANSITIONS.EXPIRE_REQUESTED_BY_CUSTOMER,
    TRANSITIONS.EXPIRE_REQUESTED_BY_PROVIDER,
  ],
  [STAGE_REQUESTED_BY_CUSTOMER]: [TRANSITIONS.REQUEST_BY_CUSTOMER, TRANSITIONS.COUNTER_BY_CUSTOMER],
  [STAGE_REQUESTED_BY_PROVIDER]: [TRANSITIONS.REQUEST_BY_PROVIDER, TRANSITIONS.COUNTER_BY_PROVIDER],
};

/**
 * @param {string} lastTransition The transaction's last transition
 * @returns {string|null} 'accepted', 'requested-by-customer', 'requested-by-provider' or null
 */
const getRescheduleStage = lastTransition =>
  Object.keys(LAST_TRANSITIONS_BY_STAGE).find(stage =>
    LAST_TRANSITIONS_BY_STAGE[stage].includes(lastTransition)
  ) || null;

/**
 * Has a reschedule loop been started already? Only one loop is allowed per booking.
 *
 * @param {Array<{transition: string}>} transitions The transaction's transitions
 * @returns {boolean}
 */
const hasRescheduleHistory = transitions =>
  (transitions || []).some(t =>
    [TRANSITIONS.REQUEST_BY_CUSTOMER, TRANSITIONS.REQUEST_BY_PROVIDER].includes(t.transition)
  );

/**
 * Why a reschedule can't be requested, or null if it can.
 *
 * @param {Object} params
 * @param {string|null} params.stage
 * @param {Array<Object>} params.transitions
 * @param {Date} params.bookingStart Current start of the booking
 * @param {Date} params.now
 * @returns {string|null} 'not-allowed', 'already-rescheduled', 'too-late' or null
 */
const getRequestError = ({ stage, transitions, bookingStart, now }) => {
  if (stage !== STAGE_ACCEPTED) {
    return 'not-allowed';
  }
  if (hasRescheduleHistory(transitions)) {
    return 'already-rescheduled';
  }
  if (bookingStart.getTime() - now.getTime() < MIN_DAYS_BEFORE_START_TO_REQUEST * DAY_MS) {
    return 'too-late';
  }
  return null;
};

/**
 * The latest moment a booking can be moved to: MAX_DAYS_FROM_PAYMENT days from the payment.
 *
 * @param {Object} transactionAttributes
 * @returns {Date}
 */
const getMaxStart = transactionAttributes => {
  const { transitions = [], createdAt } = transactionAttributes || {};
  const payment = transitions.find(t => t.transition === TRANSITIONS.CONFIRM_PAYMENT);
  const paidAt = new Date(payment?.createdAt || createdAt);
  return new Date(paidAt.getTime() + MAX_DAYS_FROM_PAYMENT * DAY_MS);
};

/**
 * New booking times for a suggested start: the duration stays the same.
 *
 * @param {Object} params
 * @param {Date|string|number} params.start Suggested start
 * @param {Date} params.bookingStart Current start of the booking
 * @param {Date} params.bookingEnd Current end of the booking
 * @returns {{start: Date, end: Date}}
 */
const getNewBookingTimes = ({ start, bookingStart, bookingEnd }) => {
  const newStart = new Date(start);
  const duration = bookingEnd.getTime() - bookingStart.getTime();
  return { start: newStart, end: new Date(newStart.getTime() + duration) };
};

// Minutes of the given moment in the given time zone (some time zones aren't full hours from UTC)
const getMinutesInTimeZone = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, minute: 'numeric' }).formatToParts(
    date
  );
  return Number(parts.find(p => p.type === 'minute')?.value);
};

/**
 * Why a suggested time can't be used, or null if it can.
 *
 * @param {Object} params
 * @param {Date} params.start Suggested start
 * @param {Date} params.now
 * @param {Date} params.bookingStart Current start of the booking
 * @param {Date} params.maxStart See getMaxStart
 * @param {string} params.timeZone Listing's time zone
 * @param {number} [params.intervalMinutes] Minutes between possible start times (see
 * getStartTimeIntervalMinutes)
 * @returns {string|null} 'invalid-time', 'time-in-past', 'time-too-far', 'same-time' or null
 */
const getNewTimeError = ({
  start,
  now,
  bookingStart,
  maxStart,
  timeZone,
  intervalMinutes = 60,
}) => {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    return 'invalid-time';
  }
  // Bookings start on the listing's start time interval (e.g. 10:00, 10:15, 10:30)
  const isOnInterval =
    getMinutesInTimeZone(start, timeZone) % intervalMinutes === 0 &&
    start.getUTCSeconds() === 0 &&
    start.getUTCMilliseconds() === 0;
  if (!isOnInterval) {
    return 'invalid-time';
  }
  if (start.getTime() <= now.getTime()) {
    return 'time-in-past';
  }
  if (start.getTime() > maxStart.getTime()) {
    return 'time-too-far';
  }
  if (start.getTime() === bookingStart.getTime()) {
    return 'same-time';
  }
  return null;
};

/**
 * Is the listing available for the whole time between start and end, with enough seats?
 *
 * The booking's own current time counts as available: it's reserved by this booking, which is
 * being moved (e.g. 2-5 PM can be moved to 3-6 PM), so its seats are freed there.
 *
 * @param {Object} params
 * @param {Array<Object>} params.timeSlots Time slots from the timeslots API (attributes.start/end/seats)
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {{start: Date, end: Date}} [params.ownBooking] The booking's current time
 * @param {number} [params.seats] Seats of the booking
 * @returns {boolean}
 */
const isTimeAvailable = ({ timeSlots, start, end, ownBooking, seats = 1 }) => {
  const free = (timeSlots || [])
    .filter(slot => (slot?.attributes?.seats ?? 1) >= seats)
    .map(slot => ({
      start: new Date(slot.attributes.start).getTime(),
      end: new Date(slot.attributes.end).getTime(),
    }));
  if (ownBooking) {
    free.push({
      start: new Date(ownBooking.start).getTime(),
      end: new Date(ownBooking.end).getTime(),
    });
  }

  // Merge overlapping and back-to-back intervals, then look for one that covers the new time
  const merged = free
    .sort((a, b) => a.start - b.start)
    .reduce((acc, interval) => {
      const last = acc[acc.length - 1];
      if (last && interval.start <= last.end) {
        last.end = Math.max(last.end, interval.end);
      } else {
        acc.push({ ...interval });
      }
      return acc;
    }, []);

  const s = start.getTime();
  const e = end.getTime();
  return merged.some(interval => interval.start <= s && e <= interval.end);
};

/**
 * Human-readable booking time in the listing's time zone, e.g.
 * "Sat, Oct 17, 2026, 2:00 – 5:00 PM". Stored with the request, for emails.
 *
 * @param {Object} params
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {string} params.timeZone
 * @returns {string}
 */
const formatBookingTime = ({ start, end, timeZone }) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return typeof formatter.formatRange === 'function'
    ? formatter.formatRange(start, end)
    : `${formatter.format(start)} – ${formatter.format(end)}`;
};

module.exports = {
  DAY_MS,
  MAX_DAYS_FROM_PAYMENT,
  MIN_DAYS_BEFORE_START_TO_REQUEST,
  RESCHEDULABLE_UNIT_TYPES,
  RESCHEDULE_USER_TRANSITIONS,
  STAGE_ACCEPTED,
  STAGE_REQUESTED_BY_CUSTOMER,
  STAGE_REQUESTED_BY_PROVIDER,
  TRANSITIONS,
  formatBookingTime,
  getMaxStart,
  getNewBookingTimes,
  getNewTimeError,
  getRequestError,
  getRescheduleStage,
  getStartTimeIntervalMinutes,
  hasRescheduleHistory,
  isTimeAvailable,
};
