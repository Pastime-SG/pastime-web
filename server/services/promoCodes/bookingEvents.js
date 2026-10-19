const log = require('../../log');
const { getIntegrationSdk } = require('../sharetribe/integration');
const { confirmSpentCredits, earnCredits, returnCredits } = require('../loyalty');
const { CANCEL_PRIVILEGED_TRANSITIONS } = require('../cancellation');
const { isBookingProcess } = require('../bookingData');
const { BOOKING_REQUEST_TRANSITIONS } = require('../policies');
const {
  cancelPromoCodeUse,
  completePromoCodeUse,
  confirmPromoCodeUse,
  getPromoCodeSyncPosition,
  setPromoCodeSyncPosition,
} = require('./index');

/**
 * Keeps promo code uses and loyalty credits in line with what happens to the bookings later.
 *
 * - A booking that doesn't go ahead with a full refund (declined, expired, payment not
 *   completed, cancelled by the operator or before acceptance): its promo code use is given
 *   back, and so are the credits it used.
 * - A booking the customer cancels after acceptance (see server/api/cancel): the credits are
 *   given back in proportion to the refund (none without a refund). The promo code use stays.
 * - A finished booking: the promo code use is marked completed, and the customer earns credits
 *   for what they paid.
 *
 * Only data the server set is trusted: the cancellation's refund percentage is in the
 * transaction's metadata (privileged), the customer comes from the transaction itself, and a
 * promo code use or credits are only given back for the booking that used them (the
 * transaction id they were linked to when the booking was made).
 *
 * Booking changes are read from the Sharetribe Integration API's transaction events every 30
 * minutes, resuming after the last event read (its sequence id is saved in Firestore after every
 * page), so no event is skipped or read twice. Each check is one events query (100 events), and
 * more only if there are more events.
 */

// Transitions that refund the whole payment: the booking didn't go ahead
const FULL_REFUND_TRANSITIONS = [
  'transition/decline',
  'transition/operator-decline',
  'transition/expire',
  'transition/expire-payment',
  'transition/cancel',
  'transition/cancel-reschedule-requested-by-customer',
  'transition/cancel-reschedule-requested-by-provider',
  'transition/customer-cancel-request',
];
// States where the booking is finished: the use is counted for good
const FINISHED_STATES = [
  'state/delivered',
  'state/reviewed',
  'state/reviewed-by-customer',
  'state/reviewed-by-provider',
  'state/received',
  'state/completed',
];

const EVENTS_PER_PAGE = 100;
// At most this many pages per check (a busy period is caught up on the next checks)
const MAX_PAGES_PER_CHECK = 5;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
// The very first read (no saved position yet) starts this long ago
const FIRST_READ_LOOKBACK_MS = 60 * 60 * 1000;
// First check shortly after the server starts (e.g. after a deploy)
const FIRST_CHECK_DELAY_MS = 60 * 1000;

const getUuid = value => value?.uuid || (typeof value === 'string' ? value : null);

/**
 * The share of the payment refunded by the event's transition (1: all, 0.5: half, 0: none), or
 * null if the transition isn't a refund or cancellation.
 *
 * @param {Object} attributes Transaction attributes after the event
 * @returns {number|null}
 */
const getRefundShare = attributes => {
  const { lastTransition, metadata } = attributes || {};
  if (FULL_REFUND_TRANSITIONS.includes(lastTransition)) {
    return 1;
  }
  if (CANCEL_PRIVILEGED_TRANSITIONS.includes(lastTransition)) {
    // Set by the app's server with the cancellation (privileged metadata)
    const percentage = Number(metadata?.cancellation?.refundPercentage);
    return Number.isFinite(percentage) ? Math.min(Math.max(percentage, 0), 100) / 100 : 0;
  }
  return null;
};

// The booking's customer, from the transaction: the event's resource includes 1-to-1
// relationships as ids. If it doesn't, the transaction is fetched (one Integration API call).
const getCustomerId = async (transaction, transactionId) => {
  const fromEvent =
    getUuid(transaction?.relationships?.customer?.data?.id) || getUuid(transaction?.customer?.id);
  if (fromEvent || !transactionId) {
    return fromEvent || null;
  }
  const response = await getIntegrationSdk().transactions.show({
    id: transactionId,
    include: ['customer'],
    'fields.user': [],
  });
  return getUuid(response.data.data.relationships?.customer?.data?.id);
};

// The booking request: links the promo code use and spent credits to the transaction, in case
// that failed when the booking was made (both only link what isn't linked yet)
const linkBookingRequest = async ({ transactionId, lastTransition, protectedData }) => {
  if (!transactionId || !BOOKING_REQUEST_TRANSITIONS.includes(lastTransition)) {
    return;
  }
  const { promoCode, loyalty } = protectedData || {};
  await Promise.all([
    promoCode?.id && promoCode?.redemptionId
      ? confirmPromoCodeUse(promoCode.id, promoCode.redemptionId, transactionId)
      : null,
    loyalty?.customerId && loyalty?.redemptionId
      ? confirmSpentCredits(loyalty.customerId, loyalty.redemptionId, transactionId)
      : null,
  ]);
};

// The promo code use of the booking, if it has one
const applyPromoCodeEvent = async ({ transactionId, state, refundShare, protectedData }) => {
  const { id, redemptionId } = protectedData?.promoCode || {};
  if (!id || !redemptionId || !transactionId) {
    return null;
  }
  if (refundShare === 1) {
    return (await cancelPromoCodeUse(id, redemptionId, transactionId, state)) ? 'cancelled' : null;
  }
  if (FINISHED_STATES.includes(state)) {
    return (await completePromoCodeUse(id, redemptionId, transactionId)) ? 'completed' : null;
  }
  return null;
};

// Loyalty credits: the credits a booking used are given back (in proportion to the refund), and
// a finished booking earns credits for what the customer paid
const applyLoyaltyEvent = async ({ event, transaction, transactionId, state, refundShare }) => {
  if (!transactionId) {
    return null;
  }
  const { protectedData, payinTotal } = transaction?.attributes || {};
  if (refundShare != null) {
    const { customerId, redemptionId } = protectedData?.loyalty || {};
    return refundShare > 0 &&
      customerId &&
      redemptionId &&
      (await returnCredits({ customerId, redemptionId, transactionId, share: refundShare }))
      ? 'credits-returned'
      : null;
  }
  // Credits are earned once, when the booking first becomes finished (not e.g. when reviewed)
  const previousState = event.attributes.previousValues?.attributes?.state;
  if (!FINISHED_STATES.includes(state) || FINISHED_STATES.includes(previousState) || !payinTotal) {
    return null;
  }
  const customerId = await getCustomerId(transaction, transactionId);
  if (!customerId) {
    return null;
  }
  const earned = await earnCredits({
    customerId,
    transactionId,
    paidAmount: payinTotal.amount,
    currency: payinTotal.currency,
  });
  return earned != null ? 'credits-earned' : null;
};

/**
 * Apply one transaction event to the booking's promo code use and loyalty credits.
 *
 * @param {Object} event Integration API event
 * @returns {Promise<Array<string>>} What changed, e.g. ['cancelled', 'credits-returned']
 */
const applyEvent = async event => {
  const transaction = event?.attributes?.resource;
  const attributes = transaction?.attributes || {};
  // Promo codes and credits only apply to bookings: other processes' data is never read
  if (!isBookingProcess(attributes.processName)) {
    return [];
  }
  const params = {
    lastTransition: attributes.lastTransition,
    event,
    transaction,
    transactionId: getUuid(event?.attributes?.resourceId) || getUuid(transaction?.id),
    state: attributes.state,
    refundShare: getRefundShare(attributes),
    protectedData: attributes.protectedData,
  };
  await linkBookingRequest(params);
  const results = await Promise.all([applyPromoCodeEvent(params), applyLoyaltyEvent(params)]);
  return results.filter(Boolean);
};

/**
 * Read the new booking events and update the promo code uses.
 *
 * @param {Date} [now]
 * @returns {Promise<{events: number, changed: number}>}
 */
const processBookingEvents = async (now = new Date()) => {
  let position = await getPromoCodeSyncPosition();
  let eventCount = 0;
  let changed = 0;
  for (let page = 0; page < MAX_PAGES_PER_CHECK; page += 1) {
    const startMaybe =
      position != null
        ? { startAfterSequenceId: position }
        : { createdAtStart: new Date(now.getTime() - FIRST_READ_LOOKBACK_MS) };
    // eslint-disable-next-line no-await-in-loop
    const response = await getIntegrationSdk().events.query({
      ...startMaybe,
      eventTypes: 'transaction/transitioned',
      perPage: EVENTS_PER_PAGE,
    });
    const events = response.data.data;
    for (const event of events) {
      // eslint-disable-next-line no-await-in-loop
      changed += (await applyEvent(event)).length;
      position = event.attributes.sequenceId;
    }
    eventCount += events.length;
    if (events.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await setPromoCodeSyncPosition(position);
    }
    if (events.length < EVENTS_PER_PAGE) {
      break;
    }
  }
  return { events: eventCount, changed };
};

/**
 * Check booking events every 30 minutes, and once a minute after the server starts. Requires a
 * long-running server process.
 *
 * @returns {Object} The interval timer
 */
const startBookingEventsJob = () => {
  let running = false;
  const run = () => {
    // Skip a round if the previous one is still running
    if (running) {
      return;
    }
    running = true;
    processBookingEvents()
      .catch(e => log.error(e, 'promo-code-booking-events-failed', {}))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(run, FIRST_CHECK_DELAY_MS).unref?.();
  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref?.();
  return timer;
};

module.exports = {
  FINISHED_STATES,
  FULL_REFUND_TRANSITIONS,
  getRefundShare,
  applyEvent,
  processBookingEvents,
  startBookingEventsJob,
};
