const { getRescheduleStage } = require('../reschedule');
const { getMatchingCancellationRule, getPolicies } = require('../policies');

/**
 * Customer cancellations of an accepted booking (default-booking process). Providers can't cancel
 * bookings for now.
 *
 *  - Before the booking is accepted, the customer can always cancel for free: the process cancels
 *    the card authorization (transition/customer-cancel-request), without the server.
 *  - After the booking is accepted, the cancellation rules of the policies copied to the booking
 *    (protectedData.policies) apply: the matching rule with the highest refund. Without a
 *    matching rule, the booking can't be cancelled.
 *  - The Stripe fee isn't refunded once the booking is accepted: it's deducted from the refund.
 *  - The part of the booking price that isn't refunded is treated as the new price: the
 *    commissions of the booking apply to it, and the provider is paid the rest.
 */

const TRANSITIONS = {
  CUSTOMER_CANCEL_REQUEST: 'transition/customer-cancel-request',
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
};

// Privileged cancel transitions: they can only be made through server/api/cancel
const CANCEL_PRIVILEGED_TRANSITIONS = [
  TRANSITIONS.CUSTOMER_CANCEL,
  TRANSITIONS.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER,
  TRANSITIONS.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER,
  TRANSITIONS.CUSTOMER_CANCEL_NO_REFUND,
  TRANSITIONS.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_CUSTOMER,
  TRANSITIONS.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_PROVIDER,
];

const CANCEL_TRANSITIONS_BY_STAGE = {
  accepted: {
    refund: TRANSITIONS.CUSTOMER_CANCEL,
    noRefund: TRANSITIONS.CUSTOMER_CANCEL_NO_REFUND,
  },
  'requested-by-customer': {
    refund: TRANSITIONS.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_CUSTOMER,
    noRefund: TRANSITIONS.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_CUSTOMER,
  },
  'requested-by-provider': {
    refund: TRANSITIONS.CUSTOMER_CANCEL_RESCHEDULE_REQUESTED_BY_PROVIDER,
    noRefund: TRANSITIONS.CUSTOMER_CANCEL_NO_REFUND_RESCHEDULE_REQUESTED_BY_PROVIDER,
  },
};

/**
 * The cancel transition of an accepted booking (also while a reschedule request is pending).
 *
 * @param {string} lastTransition
 * @param {boolean} hasRefund
 * @returns {string|null}
 */
const getCancelTransition = (lastTransition, hasRefund) => {
  const transitions = CANCEL_TRANSITIONS_BY_STAGE[getRescheduleStage(lastTransition)];
  return transitions ? transitions[hasRefund ? 'refund' : 'noRefund'] : null;
};

/**
 * The cancellation rule that applies now, from the policies copied to the booking.
 *
 * @param {Object} params
 * @param {Object} params.protectedData Transaction's protected data
 * @param {Date} params.bookingStart
 * @param {Date} params.now
 * @returns {Object|null} The rule, or null if the booking can't be cancelled now
 */
const getApplicableRule = ({ protectedData, bookingStart, now }) => {
  if (!bookingStart || bookingStart.getTime() <= now.getTime()) {
    return null;
  }
  const { rules } = getPolicies(protectedData?.policies).cancellation;
  return getMatchingCancellationRule(rules, bookingStart.getTime() - now.getTime());
};

const isCommission = item =>
  ['line-item/provider-commission', 'line-item/customer-commission'].includes(item.code);

const sumLineTotals = items => items.reduce((sum, item) => sum + item.lineTotal.amount, 0);

/**
 * Booking price and commissions from the transaction's line items (the ones the booking was paid
 * with).
 *
 * @param {Array<Object>} lineItems
 * @returns {{price: number, providerCommission: number, customerCommission: number,
 * customerReductions: number}} Minor units, commissions and reductions as positive amounts.
 * Customer reductions are what the marketplace paid for the customer: an admin's promo code
 * discount and loyalty credits.
 */
const getBookingAmounts = lineItems => {
  const active = (lineItems || []).filter(item => !item.reversal);
  const price = sumLineTotals(
    active.filter(
      item =>
        !isCommission(item) &&
        item.includeFor.includes('customer') &&
        item.includeFor.includes('provider')
    )
  );
  const providerCommission = Math.abs(
    sumLineTotals(active.filter(item => item.code === 'line-item/provider-commission'))
  );
  const customerCommission = sumLineTotals(
    active.filter(item => item.code === 'line-item/customer-commission')
  );
  const customerReductions = Math.abs(
    sumLineTotals(
      active.filter(
        item =>
          !isCommission(item) &&
          item.includeFor.includes('customer') &&
          !item.includeFor.includes('provider') &&
          (item.lineTotal?.amount ?? 0) < 0
      )
    )
  );
  return { price, providerCommission, customerCommission, customerReductions };
};

/**
 * Who gets what when the booking is cancelled with the given refund percentage.
 *
 * The part of the price that isn't refunded is treated as the new price: the commissions apply to
 * it in the same proportion as to the full price (e.g. 15% of it), and so do the reductions the
 * marketplace paid for the customer (admin discount, credits; the credits' refunded share is
 * given back as credits). The customer is refunded the rest of the payment, minus the Stripe
 * fee, which is non-refundable.
 *
 * @param {Object} params
 * @param {number} params.refundPercentage 0-100
 * @param {Object} params.bookingAmounts See getBookingAmounts
 * @param {number} params.paid Amount the customer paid (minor units)
 * @param {number} params.stripeFee Stripe fee of the payment (minor units)
 * @returns {{retainedPrice: number, providerPayout: number, platformCommission: number, refund: number}}
 */
const getCancellationAmounts = ({ refundPercentage, bookingAmounts, paid, stripeFee }) => {
  const { price, providerCommission, customerCommission, customerReductions = 0 } = bookingAmounts;
  const retainedPrice = Math.round((price * (100 - refundPercentage)) / 100);
  const share = price > 0 ? retainedPrice / price : 0;
  const retainedProviderCommission = Math.round(providerCommission * share);
  const retainedCustomerCommission = Math.round(customerCommission * share);
  const retainedReductions = Math.round(customerReductions * share);
  // What the customer pays for the part that isn't refunded
  const retainedCharge = retainedPrice + retainedCustomerCommission - retainedReductions;
  return {
    retainedPrice,
    providerPayout: retainedPrice - retainedProviderCommission,
    platformCommission:
      retainedProviderCommission + retainedCustomerCommission - retainedReductions,
    refund: Math.max(paid - retainedCharge - stripeFee, 0),
  };
};

/**
 * Payment details from the Stripe PaymentIntent (see stripe.retrievePaymentIntent).
 *
 * @param {Object} paymentIntent
 * @returns {Object} paid, stripeFee, providerShare (what the transfer left in the provider's
 * account), alreadyRefunded, alreadyReversed, currency, transferId, accountId,
 * destinationPaymentId
 */
const getPaymentDetails = paymentIntent => {
  const charge = paymentIntent?.latest_charge;
  const balanceTransaction = charge?.balance_transaction;
  const transfer = charge?.transfer;
  if (!charge?.captured || !balanceTransaction || !transfer?.id) {
    const error = new Error('Payment is not captured or has no transfer');
    error.code = 'payment-not-captured';
    throw error;
  }
  if (balanceTransaction.currency !== charge.currency) {
    // The Stripe fee is in another currency than the payment: needs manual handling
    const error = new Error('Stripe fee is in another currency than the payment');
    error.code = 'currency-mismatch';
    throw error;
  }
  return {
    currency: charge.currency,
    paid: charge.amount,
    stripeFee: balanceTransaction.fee,
    providerShare: transfer.amount - (charge.application_fee_amount || 0),
    alreadyRefunded: charge.amount_refunded || 0,
    alreadyReversed: transfer.amount_reversed || 0,
    transferId: transfer.id,
    accountId: transfer.destination,
    destinationPaymentId: transfer.destination_payment,
  };
};

/**
 * Money as text for emails, e.g. "S$49.15". Amounts are in minor units.
 *
 * @param {number} amount
 * @param {string} currency
 * @returns {string}
 */
const formatMoney = (amount, currency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(
    amount / 100
  );

module.exports = {
  CANCEL_PRIVILEGED_TRANSITIONS,
  TRANSITIONS,
  formatMoney,
  getApplicableRule,
  getBookingAmounts,
  getCancelTransition,
  getCancellationAmounts,
  getPaymentDetails,
};
