const {
  createCookieTokenStore,
  getSdk,
  getTrustedSdk,
  handleError,
  serialize,
} = require('../../api-util/sdk');
const {
  RESCHEDULABLE_UNIT_TYPES,
  TRANSITIONS,
  formatBookingTime,
  getMaxStart,
  getNewBookingTimes,
  getNewTimeError,
  getRequestError,
  getRescheduleStage,
  getStartTimeIntervalMinutes,
  isTimeAvailable,
} = require('../../services/reschedule');

/**
 * Reschedule an accepted booking (see server/services/reschedule/rules.js for the rules).
 *
 * The reschedule transitions are privileged, so they can only be made here, after the request has
 * been validated. The user comes from the session (middleware.auth): they must be the customer or
 * the provider of the transaction.
 *
 * Request body:
 *  - transactionId
 *  - action: 'request' | 'counter' | 'accept' | 'decline'
 *  - bookingStart: the suggested start (request and counter). The end is start + the booking's
 *    duration.
 *
 * Response: the updated transaction with its booking (transit), so that the client doesn't need to
 * fetch it again.
 *
 * Errors: { status, code } with code e.g. 'time-unavailable' (409), 'too-late',
 * 'already-rescheduled', 'not-allowed' (403), 'invalid-time', 'time-in-past', 'time-too-far',
 * 'same-time' (400).
 */

const ACTIONS = ['request', 'counter', 'accept', 'decline'];

const TRANSITION_BY_ACTION_AND_ROLE = {
  request: { customer: TRANSITIONS.REQUEST_BY_CUSTOMER, provider: TRANSITIONS.REQUEST_BY_PROVIDER },
  counter: { customer: TRANSITIONS.COUNTER_BY_CUSTOMER, provider: TRANSITIONS.COUNTER_BY_PROVIDER },
  accept: { customer: TRANSITIONS.ACCEPT_BY_CUSTOMER, provider: TRANSITIONS.ACCEPT_BY_PROVIDER },
  decline: { customer: TRANSITIONS.DECLINE_BY_CUSTOMER, provider: TRANSITIONS.DECLINE_BY_PROVIDER },
};

const fail = (res, status, code) => res.status(status).json({ status, code });

// Send the SDK response of the transition (the updated transaction) to the client
const sendTransaction = (res, apiResponse) => {
  const { status, statusText, data } = apiResponse;
  return res
    .status(status)
    .set('Content-Type', 'application/transit+json')
    .send(serialize({ status, statusText, data }))
    .end();
};

const findIncluded = (txData, included, relationship) => {
  const ref = txData.relationships?.[relationship]?.data;
  return ref ? included.find(i => i.type === ref.type && i.id.uuid === ref.id.uuid) : null;
};

module.exports = async (req, res) => {
  const { transactionId, action, bookingStart } = req.body || {};
  const userId = req.tokenUserId;

  if (!transactionId || !ACTIONS.includes(action)) {
    return fail(res, 400, 'invalid-request');
  }

  try {
    // The signed-in user's SDK: they can only see their own transactions. The trusted SDK is only
    // used for the privileged transitions. Both share one cookie token store, so that a token
    // refresh is reused for the token exchange.
    const tokenStore = createCookieTokenStore(req, res);
    const sdk = getSdk(req, res, tokenStore);
    // The response includes the updated transaction and its booking (moved, if accepted)
    const transitionPrivileged = async params => {
      const trustedSdk = await getTrustedSdk(req, res, tokenStore);
      return trustedSdk.transactions.transition(params, { expand: true, include: ['booking'] });
    };
    const txResponse = await sdk.transactions.show({
      id: transactionId,
      include: ['booking', 'listing', 'customer', 'provider'],
    });
    const { data: tx, included = [] } = txResponse.data;
    const booking = findIncluded(tx, included, 'booking');
    const listing = findIncluded(tx, included, 'listing');
    const customerId = tx.relationships?.customer?.data?.id?.uuid;
    const providerId = tx.relationships?.provider?.data?.id?.uuid;
    const role = userId === customerId ? 'customer' : userId === providerId ? 'provider' : null;

    const publicData = listing?.attributes?.publicData || {};
    if (!role || !booking || !listing || !RESCHEDULABLE_UNIT_TYPES.includes(publicData.unitType)) {
      return fail(res, 403, 'not-allowed');
    }

    const { lastTransition, transitions, protectedData = {} } = tx.attributes;
    const stage = getRescheduleStage(lastTransition);
    const otherRole = role === 'customer' ? 'provider' : 'customer';
    // The other party of a pending request answers it (accept, decline or suggest another time)
    const isResponder = stage === `requested-by-${otherRole}`;
    const now = new Date();
    const timeZone = listing.attributes.availabilityPlan?.timezone || 'Etc/UTC';
    const ownBooking = { start: booking.attributes.start, end: booking.attributes.end };
    const seats = booking.attributes.seats || 1;
    const intervalMinutes = getStartTimeIntervalMinutes(publicData);
    const transition = TRANSITION_BY_ACTION_AND_ROLE[action][role];

    const checkAvailability = async (start, end) => {
      const slotsResponse = await sdk.timeslots.query({ listingId: listing.id, start, end });
      return isTimeAvailable({
        timeSlots: slotsResponse.data.data,
        start,
        end,
        ownBooking,
        seats,
      });
    };

    // Request (or suggest another time): validate the new time and store it in protected data
    if (action === 'request' || action === 'counter') {
      const permissionError =
        action === 'request'
          ? getRequestError({ stage, transitions, bookingStart: ownBooking.start, now })
          : !isResponder || ownBooking.start <= now
          ? 'not-allowed'
          : null;
      if (permissionError) {
        return fail(res, 403, permissionError);
      }

      const { start, end } = getNewBookingTimes({
        start: bookingStart,
        bookingStart: ownBooking.start,
        bookingEnd: ownBooking.end,
      });
      const timeError = getNewTimeError({
        start,
        now,
        bookingStart: ownBooking.start,
        maxStart: getMaxStart(tx.attributes),
        timeZone,
        intervalMinutes,
      });
      if (timeError) {
        return fail(res, 400, timeError);
      }
      if (!(await checkAvailability(start, end))) {
        return fail(res, 409, 'time-unavailable');
      }

      const reschedule = {
        status: 'requested',
        requestedBy: role,
        bookingStart: start.toISOString(),
        bookingEnd: end.toISOString(),
        timeZone,
        displayText: formatBookingTime({ start, end, timeZone }),
        requestedAt: now.toISOString(),
        originalBookingStart: ownBooking.start.toISOString(),
        originalBookingEnd: ownBooking.end.toISOString(),
      };
      const response = await transitionPrivileged({
        id: tx.id,
        transition,
        params: { protectedData: { reschedule } },
      });
      return sendTransaction(res, response);
    }

    // Accept or decline: only the other party of the pending request
    const pending = protectedData.reschedule;
    if (!isResponder || ownBooking.start <= now) {
      return fail(res, 403, 'not-allowed');
    }
    if (pending?.status !== 'requested' || pending?.requestedBy !== otherRole) {
      return fail(res, 409, 'no-request');
    }
    const respondedAt = now.toISOString();

    if (action === 'decline') {
      const reschedule = { ...pending, status: 'declined', respondedBy: role, respondedAt };
      const response = await transitionPrivileged({
        id: tx.id,
        transition,
        params: { protectedData: { reschedule } },
      });
      return sendTransaction(res, response);
    }

    // Accept: the booking is moved to the suggested time, if it's still available
    const start = new Date(pending.bookingStart);
    const end = new Date(pending.bookingEnd);
    const isSameDuration =
      end.getTime() - start.getTime() === ownBooking.end.getTime() - ownBooking.start.getTime();
    if (!isSameDuration || start <= now || !(await checkAvailability(start, end))) {
      return fail(res, 409, 'time-unavailable');
    }

    const reschedule = { ...pending, status: 'accepted', respondedBy: role, respondedAt };
    let response;
    try {
      response = await transitionPrivileged({
        id: tx.id,
        transition,
        params: {
          bookingStart: start,
          bookingEnd: end,
          bookingDisplayStart: start,
          bookingDisplayEnd: end,
          protectedData: { reschedule },
        },
      });
    } catch (e) {
      // The time was booked between our check and the transition
      if (e.status === 409) {
        return fail(res, 409, 'time-unavailable');
      }
      throw e;
    }
    return sendTransaction(res, response);
  } catch (e) {
    handleError(res, e);
  }
};
