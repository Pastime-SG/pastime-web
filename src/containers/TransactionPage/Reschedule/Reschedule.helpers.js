import {
  bookingTimeUnits,
  findNextBoundary,
  getStartOf,
  stringifyDateToISO8601,
} from '../../../util/dates';
import { timeSlotsPerDate } from '../../../util/generators';
import {
  getEarliestBookingStart,
  getPolicies,
  getRescheduleDeadline,
} from '../../../util/policies';
import {
  BOOKING_PROCESS_NAME,
  getProcess,
  resolveLatestProcessName,
} from '../../../transactions/transaction';

// Keep these rules in sync with server/services/reschedule/rules.js, which enforces them.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Bookings made before the listing policies existed: the first reschedule request can be made
// until this many days before the booking starts. Newer bookings follow the reschedule policy
// copied to the booking (protectedData.policies).
export const MIN_DAYS_BEFORE_START_TO_REQUEST = 7;
// A booking can't be moved further than this from the payment.
export const MAX_DAYS_FROM_PAYMENT = 90;

// Listing unit types whose bookings can be rescheduled (bookings with a start time)
const RESCHEDULABLE_UNIT_TYPES = ['fixed', 'hour'];

export const STAGE_ACCEPTED = 'accepted';
export const STAGE_REQUESTED_BY_CUSTOMER = 'requested-by-customer';
export const STAGE_REQUESTED_BY_PROVIDER = 'requested-by-provider';

export const OUTCOME_ACCEPTED = 'accepted';
export const OUTCOME_DECLINED = 'declined';
export const OUTCOME_EXPIRED = 'expired';

const getStage = (lastTransition, t) => {
  if (
    [
      t.ACCEPT,
      t.OPERATOR_ACCEPT,
      t.ACCEPT_RESCHEDULE_BY_PROVIDER,
      t.ACCEPT_RESCHEDULE_BY_CUSTOMER,
      t.DECLINE_RESCHEDULE_BY_PROVIDER,
      t.DECLINE_RESCHEDULE_BY_CUSTOMER,
      t.EXPIRE_RESCHEDULE_REQUESTED_BY_CUSTOMER,
      t.EXPIRE_RESCHEDULE_REQUESTED_BY_PROVIDER,
    ].includes(lastTransition)
  ) {
    return STAGE_ACCEPTED;
  }
  if (
    [t.REQUEST_RESCHEDULE_BY_CUSTOMER, t.COUNTER_RESCHEDULE_BY_CUSTOMER].includes(lastTransition)
  ) {
    return STAGE_REQUESTED_BY_CUSTOMER;
  }
  if (
    [t.REQUEST_RESCHEDULE_BY_PROVIDER, t.COUNTER_RESCHEDULE_BY_PROVIDER].includes(lastTransition)
  ) {
    return STAGE_REQUESTED_BY_PROVIDER;
  }
  return null;
};

const getOutcome = (transition, t) => {
  if ([t.ACCEPT_RESCHEDULE_BY_PROVIDER, t.ACCEPT_RESCHEDULE_BY_CUSTOMER].includes(transition)) {
    return OUTCOME_ACCEPTED;
  }
  if ([t.DECLINE_RESCHEDULE_BY_PROVIDER, t.DECLINE_RESCHEDULE_BY_CUSTOMER].includes(transition)) {
    return OUTCOME_DECLINED;
  }
  if (
    [t.EXPIRE_RESCHEDULE_REQUESTED_BY_CUSTOMER, t.EXPIRE_RESCHEDULE_REQUESTED_BY_PROVIDER].includes(
      transition
    )
  ) {
    return OUTCOME_EXPIRED;
  }
  return null;
};

/**
 * Reschedule status of a booking for the transaction page.
 *
 * @param {Object} params
 * @param {Object} params.transaction The transaction, with the booking
 * @param {'customer'|'provider'} params.transactionRole
 * @param {Array<Object>} params.nextTransitions Transitions the current user can make now. The
 * request button is shown only if the transaction's process version supports rescheduling.
 * @param {Date} [params.now]
 * @returns {Object|null} null if rescheduling doesn't apply to the transaction
 */
export const getRescheduleInfo = ({ transaction, transactionRole, nextTransitions, now }) => {
  const processName = resolveLatestProcessName(transaction?.attributes?.processName);
  const booking = transaction?.booking;
  const { unitType, startTimeInterval } = transaction?.listing?.attributes?.publicData || {};
  if (
    processName !== BOOKING_PROCESS_NAME ||
    !booking?.attributes?.start ||
    !RESCHEDULABLE_UNIT_TYPES.includes(unitType)
  ) {
    return null;
  }

  const t = getProcess(processName).transitions;
  const { lastTransition, transitions = [], protectedData = {}, createdAt } =
    transaction.attributes || {};
  const stage = getStage(lastTransition, t);
  if (!stage) {
    return null;
  }

  const currentTime = now || new Date();
  const otherRole = transactionRole === 'customer' ? 'provider' : 'customer';
  const { start, end, seats } = booking.attributes;
  const hasStarted = start.getTime() <= currentTime.getTime();

  // One reschedule loop per booking
  const requestTransitions = [t.REQUEST_RESCHEDULE_BY_CUSTOMER, t.REQUEST_RESCHEDULE_BY_PROVIDER];
  const hasRescheduleHistory = transitions.some(tr => requestTransitions.includes(tr.transition));
  const ownRequestTransition =
    transactionRole === 'customer'
      ? t.REQUEST_RESCHEDULE_BY_CUSTOMER
      : t.REQUEST_RESCHEDULE_BY_PROVIDER;
  const nextTransitionNames = (nextTransitions || []).map(nt => nt?.attributes?.name);
  const requestDeadline = protectedData.policies
    ? getRescheduleDeadline(getPolicies(protectedData.policies).reschedule, start)
    : new Date(start.getTime() - MIN_DAYS_BEFORE_START_TO_REQUEST * DAY_MS);
  const canRequest =
    stage === STAGE_ACCEPTED &&
    !!requestDeadline &&
    !hasRescheduleHistory &&
    nextTransitionNames.includes(ownRequestTransition) &&
    currentTime.getTime() <= requestDeadline.getTime();

  const request = protectedData.reschedule || null;
  const isPending = stage !== STAGE_ACCEPTED;
  const suggestion =
    isPending && request?.bookingStart
      ? { start: new Date(request.bookingStart), end: new Date(request.bookingEnd) }
      : null;

  // How the reschedule loop ended
  const lastLoopTransition = [...transitions].reverse().find(tr => !!getOutcome(tr.transition, t));
  const outcome =
    stage === STAGE_ACCEPTED && lastLoopTransition
      ? getOutcome(lastLoopTransition.transition, t)
      : null;
  const previousBooking =
    outcome === OUTCOME_ACCEPTED && request?.originalBookingStart
      ? { start: new Date(request.originalBookingStart), end: new Date(request.originalBookingEnd) }
      : null;

  // The booking can't be moved further than MAX_DAYS_FROM_PAYMENT days from the payment
  const payment = transitions.find(tr => tr.transition === t.CONFIRM_PAYMENT);
  const paidAt = new Date(payment?.createdAt || createdAt || currentTime);
  const maxStart = new Date(paidAt.getTime() + MAX_DAYS_FROM_PAYMENT * DAY_MS);

  return {
    stage,
    canRequest,
    requestDeadline,
    hasRescheduleHistory,
    isPending,
    // Only before the booking starts: an unanswered request expires when the booking starts
    isRequester: !hasStarted && stage === `requested-by-${transactionRole}`,
    isResponder: !hasStarted && stage === `requested-by-${otherRole}`,
    suggestion,
    outcome,
    outcomeByYou: lastLoopTransition?.by === transactionRole,
    previousBooking,
    booking: { start, end },
    durationMs: end.getTime() - start.getTime(),
    // The booking keeps its seats: the new time needs that many free seats
    seats: seats || 1,
    // New start times follow the listing's start time interval, like in the booking form
    timeUnit: bookingTimeUnits[startTimeInterval]?.timeUnit || 'hour',
    // New times can't be within the listing's booking cutoff (e.g. 24 hours before the start)
    earliestStart: getEarliestBookingStart(
      transaction?.listing?.attributes?.publicData?.policies,
      currentTime
    ),
    maxStart,
  };
};

/**
 * Is the listing available for the whole time between start and end, with enough seats? The
 * booking's own time counts as available, because it's the booking that is being moved.
 *
 * @param {Object} params
 * @param {Array<Object>} params.timeSlots Time slots (attributes.start/end/seats)
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {{start: Date, end: Date}} [params.ownBooking]
 * @param {number} [params.seats] Seats of the booking
 * @returns {boolean}
 */
export const isTimeAvailable = ({ timeSlots, start, end, ownBooking, seats = 1 }) => {
  const free = (timeSlots || [])
    .filter(slot => (slot?.attributes?.seats ?? 1) >= seats)
    .map(slot => ({
      start: new Date(slot.attributes.start).getTime(),
      end: new Date(slot.attributes.end).getTime(),
    }));
  if (ownBooking) {
    free.push({ start: ownBooking.start.getTime(), end: ownBooking.end.getTime() });
  }

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
 * Query range for the time slots of a day: from the next possible start time (today) or the start
 * of the day, to the start of the next day (or the given end, if later).
 *
 * @param {Date} dayStart Start of the day in the listing's time zone
 * @param {string} timeZone
 * @param {Date} [now]
 * @param {Date} [minEnd]
 * @param {string} [timeUnit] Start time interval: 'hour', 'halfHour' or 'quarterHour'
 * @returns {{start: Date, end: Date, dateId: string}}
 */
export const getDayQueryRange = (dayStart, timeZone, now, minEnd, timeUnit = 'hour') => {
  const nextBoundary = findNextBoundary(now || new Date(), 1, timeUnit, timeZone);
  const dayEnd = getStartOf(dayStart, 'day', timeZone, 1, 'days');
  const start = nextBoundary > dayStart ? nextBoundary : dayStart;
  const end = minEnd && minEnd > dayEnd ? minEnd : dayEnd;
  return { start, end, dateId: stringifyDateToISO8601(dayStart, timeZone) };
};

/**
 * Start times on the given day where the whole booking duration fits in the availability.
 *
 * @param {Object} params
 * @param {Date} params.dayStart Start of the day in the listing's time zone
 * @param {string} params.timeZone
 * @param {Array<Object>} params.timeSlots Time slots of the day
 * @param {{start: Date, end: Date}} params.ownBooking The booking's current time
 * @param {number} params.durationMs The booking's duration
 * @param {number} [params.seats] Seats of the booking
 * @param {string} [params.timeUnit] Start time interval: 'hour', 'halfHour' or 'quarterHour'
 * @param {Date} params.maxStart
 * @param {Date|null} [params.earliestStart] Booking cutoff: no start times before this
 * @param {Date} [params.now]
 * @returns {Array<{start: Date, end: Date}>}
 */
export const getStartTimeOptions = ({
  dayStart,
  timeZone,
  timeSlots,
  ownBooking,
  durationMs,
  seats = 1,
  timeUnit = 'hour',
  maxStart,
  earliestStart,
  now,
}) => {
  const dayEnd = getStartOf(dayStart, 'day', timeZone, 1, 'days');
  const nextBoundary = findNextBoundary(now || new Date(), 1, timeUnit, timeZone);
  const options = [];

  let start = nextBoundary > dayStart ? nextBoundary : dayStart;
  while (start < dayEnd && start <= maxStart) {
    const end = new Date(start.getTime() + durationMs);
    const isCurrentTime = start.getTime() === ownBooking.start.getTime();
    const isWithinCutoff = !!earliestStart && start.getTime() < earliestStart.getTime();
    if (
      !isCurrentTime &&
      !isWithinCutoff &&
      isTimeAvailable({ timeSlots, start, end, ownBooking, seats })
    ) {
      options.push({ start, end });
    }
    start = findNextBoundary(start, 1, timeUnit, timeZone);
  }
  return options;
};

/**
 * Days (date ids) that have a free time long enough for the booking, from the monthly time slots.
 *
 * @param {Object} monthlyTimeSlots TransactionPage's monthlyTimeSlots
 * @param {string} timeZone
 * @param {number} durationMinutes
 * @returns {Object<string, boolean>}
 */
export const getAvailableDays = (monthlyTimeSlots, timeZone, durationMinutes) => {
  const timeSlots = Object.values(monthlyTimeSlots || {}).flatMap(month => month?.timeSlots || []);
  if (timeSlots.length === 0) {
    return {};
  }
  const start = new Date(Math.min(...timeSlots.map(ts => new Date(ts.attributes.start).getTime())));
  const end = new Date(Math.max(...timeSlots.map(ts => new Date(ts.attributes.end).getTime())));
  const days = timeSlotsPerDate(start, end, timeSlots, timeZone, {
    minDurationStartingInDay: durationMinutes,
  });
  return Object.fromEntries(
    Object.entries(days).map(([dateId, day]) => [dateId, !!day?.hasAvailability])
  );
};

/**
 * Booking time in the listing's time zone, e.g. "Sat, Oct 17, 2:00 PM – 5:00 PM".
 *
 * @param {Object} intl
 * @param {Date} start
 * @param {Date} end
 * @param {string} timeZone
 * @returns {string}
 */
export const formatBookingTime = (intl, start, end, timeZone) => {
  const dateOptions = { weekday: 'short', month: 'short', day: 'numeric', timeZone };
  const timeOptions = { hour: 'numeric', minute: '2-digit', timeZone };
  const startDay = stringifyDateToISO8601(start, timeZone);
  // A booking that ends at midnight ends on the same day
  const endDay = stringifyDateToISO8601(new Date(end.getTime() - 1), timeZone);
  const startText = `${intl.formatDate(start, dateOptions)}, ${intl.formatTime(
    start,
    timeOptions
  )}`;
  const endText =
    startDay === endDay
      ? intl.formatTime(end, timeOptions)
      : `${intl.formatDate(end, dateOptions)}, ${intl.formatTime(end, timeOptions)}`;
  return `${startText} – ${endText}`;
};
