/**
 * Transaction process graph for bookings:
 *   - default-booking
 */

/**
 * Transitions
 *
 * These strings must sync with values defined in Marketplace API,
 * since transaction objects given by API contain info about last transitions.
 * All the actions in API side happen in transitions,
 * so we need to understand what those strings mean.
 */

export const transitions = {
  // When a customer makes a booking to a listing, a transaction is
  // created with the initial request-payment transition.
  // At this transition a PaymentIntent is created by Marketplace API.
  // After this transition, the actual payment must be made on client-side directly to Stripe.
  REQUEST_PAYMENT: 'transition/request-payment',

  // A customer can also initiate a transaction with an inquiry, and
  // then transition that with a request.
  INQUIRE: 'transition/inquire',
  REQUEST_PAYMENT_AFTER_INQUIRY: 'transition/request-payment-after-inquiry',

  // Stripe SDK might need to ask 3D security from customer, in a separate front-end step.
  // Therefore we need to make another transition to Marketplace API,
  // to tell that the payment is confirmed.
  CONFIRM_PAYMENT: 'transition/confirm-payment',

  // If the payment is not confirmed in the time limit set in transaction process (by default 15min)
  // the transaction will expire automatically.
  EXPIRE_PAYMENT: 'transition/expire-payment',

  // When the provider accepts or declines a transaction from the
  // SalePage, it is transitioned with the accept or decline transition.
  ACCEPT: 'transition/accept',
  DECLINE: 'transition/decline',

  // The operator can accept or decline the offer on behalf of the provider
  OPERATOR_ACCEPT: 'transition/operator-accept',
  OPERATOR_DECLINE: 'transition/operator-decline',

  // The backend automatically expire the transaction.
  EXPIRE: 'transition/expire',

  // Admin can also cancel the transition.
  CANCEL: 'transition/cancel',

  // Rescheduling an accepted booking (one reschedule loop per booking). These are privileged
  // transitions that go through the server: see server/api/reschedule/reschedule.js
  REQUEST_RESCHEDULE_BY_CUSTOMER: 'transition/request-reschedule-by-customer',
  REQUEST_RESCHEDULE_BY_PROVIDER: 'transition/request-reschedule-by-provider',
  ACCEPT_RESCHEDULE_BY_PROVIDER: 'transition/accept-reschedule-by-provider',
  ACCEPT_RESCHEDULE_BY_CUSTOMER: 'transition/accept-reschedule-by-customer',
  COUNTER_RESCHEDULE_BY_PROVIDER: 'transition/counter-reschedule-by-provider',
  COUNTER_RESCHEDULE_BY_CUSTOMER: 'transition/counter-reschedule-by-customer',
  DECLINE_RESCHEDULE_BY_PROVIDER: 'transition/decline-reschedule-by-provider',
  DECLINE_RESCHEDULE_BY_CUSTOMER: 'transition/decline-reschedule-by-customer',
  // The backend expires an unanswered reschedule request when the booking starts.
  EXPIRE_RESCHEDULE_REQUESTED_BY_CUSTOMER: 'transition/expire-reschedule-requested-by-customer',
  EXPIRE_RESCHEDULE_REQUESTED_BY_PROVIDER: 'transition/expire-reschedule-requested-by-provider',
  // Admin can cancel the booking while a reschedule request is pending.
  CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER: 'transition/cancel-reschedule-requested-by-customer',
  CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER: 'transition/cancel-reschedule-requested-by-provider',

  // Customer cancellations. Before the booking is accepted: free.
  CUSTOMER_CANCEL_REQUEST: 'transition/customer-cancel-request',
  // After it's accepted, by the cancellation rules copied to the booking. These are privileged
  // transitions that go through the server: see server/api/cancel
  CUSTOMER_CANCEL: 'transition/customer-cancel',
  CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER:
    'transition/customer-cancel-reschedule-requested-by-customer',
  CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER:
    'transition/customer-cancel-reschedule-requested-by-provider',
  CUSTOMER_CANCEL_NO_REFUND: 'transition/customer-cancel-no-refund',
  CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_CUSTOMER:
    'transition/customer-cancel-no-refund-reschedule-requested-by-customer',
  CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_PROVIDER:
    'transition/customer-cancel-no-refund-reschedule-requested-by-provider',
  // The backend pays out the provider of a booking cancelled without a refund at the booking end
  PAYOUT_CANCELLED_WITHOUT_REFUND: 'transition/payout-cancelled-without-refund',

  // The backend will mark the transaction completed.
  COMPLETE: 'transition/complete',
  OPERATOR_COMPLETE: 'transition/operator-complete',

  // Reviews are given through transaction transitions. Only the customer reviews the provider:
  // the review is published right away.
  REVIEW_BY_CUSTOMER: 'transition/review-by-customer',

  // Older process versions: review 1 can be by provider or customer, and review 2 will be the
  // other party of the transaction. Kept for transactions made with those versions.
  REVIEW_1_BY_PROVIDER: 'transition/review-1-by-provider',
  REVIEW_2_BY_PROVIDER: 'transition/review-2-by-provider',
  REVIEW_1_BY_CUSTOMER: 'transition/review-1-by-customer',
  REVIEW_2_BY_CUSTOMER: 'transition/review-2-by-customer',
  EXPIRE_CUSTOMER_REVIEW_PERIOD: 'transition/expire-customer-review-period',
  EXPIRE_PROVIDER_REVIEW_PERIOD: 'transition/expire-provider-review-period',
  EXPIRE_REVIEW_PERIOD: 'transition/expire-review-period',
};

/**
 * States
 *
 * These constants are only for making it clear how transitions work together.
 * You should not use these constants outside of this file.
 *
 * Note: these states are not in sync with states used transaction process definitions
 *       in Marketplace API. Only last transitions are passed along transaction object.
 */
export const states = {
  INITIAL: 'initial',
  INQUIRY: 'inquiry',
  PENDING_PAYMENT: 'pending-payment',
  PAYMENT_EXPIRED: 'payment-expired',
  PREAUTHORIZED: 'preauthorized',
  DECLINED: 'declined',
  ACCEPTED: 'accepted',
  RESCHEDULE_REQUESTED_BY_CUSTOMER: 'reschedule-requested-by-customer',
  RESCHEDULE_REQUESTED_BY_PROVIDER: 'reschedule-requested-by-provider',
  EXPIRED: 'expired',
  CANCELED: 'canceled',
  CANCELLED_WITHOUT_REFUND: 'cancelled-without-refund',
  DELIVERED: 'delivered',
  REVIEWED: 'reviewed',
  REVIEWED_BY_CUSTOMER: 'reviewed-by-customer',
  REVIEWED_BY_PROVIDER: 'reviewed-by-provider',
};

/**
 * Description of transaction process graph
 *
 * You should keep this in sync with transaction process defined in Marketplace API
 *
 * Note: we don't use yet any state machine library,
 *       but this description format is following Xstate (FSM library)
 *       https://xstate.js.org/docs/
 */
export const graph = {
  // id is defined only to support Xstate format.
  // However if you have multiple transaction processes defined,
  // it is best to keep them in sync with transaction process aliases.
  id: 'default-booking/release-1',

  // This 'initial' state is a starting point for new transaction
  initial: states.INITIAL,

  // States
  states: {
    [states.INITIAL]: {
      on: {
        [transitions.INQUIRE]: states.INQUIRY,
        [transitions.REQUEST_PAYMENT]: states.PENDING_PAYMENT,
      },
    },
    [states.INQUIRY]: {
      on: {
        [transitions.REQUEST_PAYMENT_AFTER_INQUIRY]: states.PENDING_PAYMENT,
      },
    },

    [states.PENDING_PAYMENT]: {
      on: {
        [transitions.EXPIRE_PAYMENT]: states.PAYMENT_EXPIRED,
        [transitions.CONFIRM_PAYMENT]: states.PREAUTHORIZED,
      },
    },

    [states.PAYMENT_EXPIRED]: {},
    [states.PREAUTHORIZED]: {
      on: {
        [transitions.DECLINE]: states.DECLINED,
        [transitions.OPERATOR_DECLINE]: states.DECLINED,
        [transitions.EXPIRE]: states.EXPIRED,
        [transitions.ACCEPT]: states.ACCEPTED,
        [transitions.OPERATOR_ACCEPT]: states.ACCEPTED,
        [transitions.CUSTOMER_CANCEL_REQUEST]: states.CANCELED,
      },
    },

    [states.DECLINED]: {},
    [states.EXPIRED]: {},
    [states.ACCEPTED]: {
      on: {
        [transitions.CANCEL]: states.CANCELED,
        [transitions.COMPLETE]: states.DELIVERED,
        [transitions.OPERATOR_COMPLETE]: states.DELIVERED,
        [transitions.REQUEST_RESCHEDULE_BY_CUSTOMER]: states.RESCHEDULE_REQUESTED_BY_CUSTOMER,
        [transitions.REQUEST_RESCHEDULE_BY_PROVIDER]: states.RESCHEDULE_REQUESTED_BY_PROVIDER,
        [transitions.CUSTOMER_CANCEL]: states.CANCELED,
        [transitions.CUSTOMER_CANCEL_NO_REFUND]: states.CANCELLED_WITHOUT_REFUND,
      },
    },
    [states.RESCHEDULE_REQUESTED_BY_CUSTOMER]: {
      on: {
        [transitions.ACCEPT_RESCHEDULE_BY_PROVIDER]: states.ACCEPTED,
        [transitions.DECLINE_RESCHEDULE_BY_PROVIDER]: states.ACCEPTED,
        [transitions.COUNTER_RESCHEDULE_BY_PROVIDER]: states.RESCHEDULE_REQUESTED_BY_PROVIDER,
        [transitions.EXPIRE_RESCHEDULE_REQUESTED_BY_CUSTOMER]: states.ACCEPTED,
        [transitions.CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER]: states.CANCELED,
        [transitions.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER]: states.CANCELED,
        [transitions.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_CUSTOMER]:
          states.CANCELLED_WITHOUT_REFUND,
      },
    },
    [states.RESCHEDULE_REQUESTED_BY_PROVIDER]: {
      on: {
        [transitions.ACCEPT_RESCHEDULE_BY_CUSTOMER]: states.ACCEPTED,
        [transitions.DECLINE_RESCHEDULE_BY_CUSTOMER]: states.ACCEPTED,
        [transitions.COUNTER_RESCHEDULE_BY_CUSTOMER]: states.RESCHEDULE_REQUESTED_BY_CUSTOMER,
        [transitions.EXPIRE_RESCHEDULE_REQUESTED_BY_PROVIDER]: states.ACCEPTED,
        [transitions.CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER]: states.CANCELED,
        [transitions.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER]: states.CANCELED,
        [transitions.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_PROVIDER]:
          states.CANCELLED_WITHOUT_REFUND,
      },
    },

    [states.CANCELLED_WITHOUT_REFUND]: {
      on: {
        [transitions.PAYOUT_CANCELLED_WITHOUT_REFUND]: states.CANCELED,
      },
    },
    [states.CANCELED]: {},
    [states.DELIVERED]: {
      on: {
        [transitions.EXPIRE_REVIEW_PERIOD]: states.REVIEWED,
        [transitions.REVIEW_BY_CUSTOMER]: states.REVIEWED,
        [transitions.REVIEW_1_BY_CUSTOMER]: states.REVIEWED_BY_CUSTOMER,
        [transitions.REVIEW_1_BY_PROVIDER]: states.REVIEWED_BY_PROVIDER,
      },
    },

    [states.REVIEWED_BY_CUSTOMER]: {
      on: {
        [transitions.REVIEW_2_BY_PROVIDER]: states.REVIEWED,
        [transitions.EXPIRE_PROVIDER_REVIEW_PERIOD]: states.REVIEWED,
      },
    },
    [states.REVIEWED_BY_PROVIDER]: {
      on: {
        [transitions.REVIEW_2_BY_CUSTOMER]: states.REVIEWED,
        [transitions.EXPIRE_CUSTOMER_REVIEW_PERIOD]: states.REVIEWED,
      },
    },
    [states.REVIEWED]: { type: 'final' },
  },
};

// Transitions of the reschedule loop. They're shown in the activity feed with their own
// messages, because most of them lead back to the accepted state.
export const rescheduleTransitions = [
  transitions.REQUEST_RESCHEDULE_BY_CUSTOMER,
  transitions.REQUEST_RESCHEDULE_BY_PROVIDER,
  transitions.ACCEPT_RESCHEDULE_BY_PROVIDER,
  transitions.ACCEPT_RESCHEDULE_BY_CUSTOMER,
  transitions.COUNTER_RESCHEDULE_BY_PROVIDER,
  transitions.COUNTER_RESCHEDULE_BY_CUSTOMER,
  transitions.DECLINE_RESCHEDULE_BY_PROVIDER,
  transitions.DECLINE_RESCHEDULE_BY_CUSTOMER,
  transitions.EXPIRE_RESCHEDULE_REQUESTED_BY_CUSTOMER,
  transitions.EXPIRE_RESCHEDULE_REQUESTED_BY_PROVIDER,
];

// Customer cancellations. They're shown in the activity feed with their own messages.
export const customerCancelTransitions = [
  transitions.CUSTOMER_CANCEL_REQUEST,
  transitions.CUSTOMER_CANCEL,
  transitions.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER,
  transitions.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER,
  transitions.CUSTOMER_CANCEL_NO_REFUND,
  transitions.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_CUSTOMER,
  transitions.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_PROVIDER,
];

// Check if a transition is the kind that should be rendered
// when showing transition history (e.g. ActivityFeed)
// The first transition and most of the expiration transitions made by system are not relevant
export const isRelevantPastTransition = transition => {
  return [
    transitions.ACCEPT,
    transitions.OPERATOR_ACCEPT,
    transitions.CANCEL,
    transitions.COMPLETE,
    transitions.OPERATOR_COMPLETE,
    transitions.CONFIRM_PAYMENT,
    transitions.DECLINE,
    transitions.OPERATOR_DECLINE,
    transitions.EXPIRE,
    transitions.REVIEW_BY_CUSTOMER,
    transitions.REVIEW_1_BY_CUSTOMER,
    transitions.REVIEW_1_BY_PROVIDER,
    transitions.REVIEW_2_BY_CUSTOMER,
    transitions.REVIEW_2_BY_PROVIDER,
    transitions.CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER,
    transitions.CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER,
    ...rescheduleTransitions,
    ...customerCancelTransitions,
  ].includes(transition);
};

// Processes might be different on how reviews are handled.
// Default processes use two-sided diamond shape, where either party can make the review first
export const isCustomerReview = transition => {
  return [
    transitions.REVIEW_BY_CUSTOMER,
    transitions.REVIEW_1_BY_CUSTOMER,
    transitions.REVIEW_2_BY_CUSTOMER,
  ].includes(transition);
};

// Processes might be different on how reviews are handled.
// Default processes use two-sided diamond shape, where either party can make the review first
export const isProviderReview = transition => {
  return [transitions.REVIEW_1_BY_PROVIDER, transitions.REVIEW_2_BY_PROVIDER].includes(transition);
};

// Check if the given transition is privileged.
//
// Privileged transitions need to be handled from a secure context,
// i.e. the backend. This helper is used to check if the transition
// should go through the local API endpoints, or if using JS SDK is
// enough.
export const isPrivileged = transition => {
  return [
    transitions.REQUEST_PAYMENT,
    transitions.REQUEST_PAYMENT_AFTER_INQUIRY,
    transitions.REQUEST_RESCHEDULE_BY_CUSTOMER,
    transitions.REQUEST_RESCHEDULE_BY_PROVIDER,
    transitions.ACCEPT_RESCHEDULE_BY_PROVIDER,
    transitions.ACCEPT_RESCHEDULE_BY_CUSTOMER,
    transitions.COUNTER_RESCHEDULE_BY_PROVIDER,
    transitions.COUNTER_RESCHEDULE_BY_CUSTOMER,
    transitions.DECLINE_RESCHEDULE_BY_PROVIDER,
    transitions.DECLINE_RESCHEDULE_BY_CUSTOMER,
    transitions.CUSTOMER_CANCEL,
    transitions.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER,
    transitions.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER,
    transitions.CUSTOMER_CANCEL_NO_REFUND,
    transitions.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_CUSTOMER,
    transitions.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_PROVIDER,
  ].includes(transition);
};

// Check when transaction is completed (booking over)
export const isCompleted = transition => {
  const txCompletedTransitions = [
    transitions.COMPLETE,
    transitions.OPERATOR_COMPLETE,
    transitions.REVIEW_BY_CUSTOMER,
    transitions.REVIEW_1_BY_CUSTOMER,
    transitions.REVIEW_1_BY_PROVIDER,
    transitions.REVIEW_2_BY_CUSTOMER,
    transitions.REVIEW_2_BY_PROVIDER,
    transitions.EXPIRE_REVIEW_PERIOD,
    transitions.EXPIRE_CUSTOMER_REVIEW_PERIOD,
    transitions.EXPIRE_PROVIDER_REVIEW_PERIOD,
  ];
  return txCompletedTransitions.includes(transition);
};

// Check when transaction is refunded (booking did not happen)
// In these transitions action/stripe-refund-payment is called
export const isRefunded = transition => {
  const txRefundedTransitions = [
    transitions.EXPIRE_PAYMENT,
    transitions.EXPIRE,
    transitions.CANCEL,
    transitions.CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER,
    transitions.CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER,
    transitions.CUSTOMER_CANCEL_REQUEST,
    transitions.DECLINE,
  ];
  return txRefundedTransitions.includes(transition);
};

export const statesNeedingProviderAttention = [
  states.PREAUTHORIZED,
  states.RESCHEDULE_REQUESTED_BY_CUSTOMER,
];

// The customer needs to answer the provider's reschedule request
export const statesNeedingCustomerAttention = [states.RESCHEDULE_REQUESTED_BY_PROVIDER];
