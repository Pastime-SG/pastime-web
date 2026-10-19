const log = require('../../log');
const { getIntegrationSdk } = require('../sharetribe/integration');
const {
  cancelPromoCodeUse,
  completePromoCodeUse,
  getPromoCodeSyncPosition,
  setPromoCodeSyncPosition,
} = require('./index');

/**
 * Keeps promo code uses in line with what happens to the bookings later. A use is given back when
 * the booking doesn't go ahead (declined, expired, payment not completed, cancelled), and it's
 * marked completed when the booking is finished.
 *
 * Booking changes are read from the Sharetribe Integration API's transaction events every 30
 * minutes, resuming after the last event read (its sequence id is saved in Firestore after every
 * page), so no event is skipped or read twice. Each check is one events query (100 events), and
 * more only if there are more events.
 */

// States where the booking didn't go ahead: the use is given back
const RELEASE_STATES = [
  'state/declined',
  'state/expired',
  'state/payment-expired',
  'state/cancelled',
  'state/canceled',
  'state/cancelled-without-refund',
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

/**
 * Apply one transaction event to the promo code use of its booking, if it has one.
 *
 * @param {Object} event Integration API event
 * @returns {Promise<string|null>} 'cancelled', 'completed' or null
 */
const applyEvent = async event => {
  const transaction = event?.attributes?.resource;
  const { state, protectedData } = transaction?.attributes || {};
  const { id, redemptionId } = protectedData?.promoCode || {};
  if (!id || !redemptionId) {
    return null;
  }
  if (RELEASE_STATES.includes(state)) {
    return (await cancelPromoCodeUse(id, redemptionId, state)) ? 'cancelled' : null;
  }
  if (FINISHED_STATES.includes(state)) {
    return (await completePromoCodeUse(id, redemptionId)) ? 'completed' : null;
  }
  return null;
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
      if (await applyEvent(event)) {
        changed += 1;
      }
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
  RELEASE_STATES,
  applyEvent,
  processBookingEvents,
  startBookingEventsJob,
};
