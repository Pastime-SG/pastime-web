const Stripe = require('stripe');

/**
 * Stripe API for the server: partial refunds and payouts of cancelled bookings, which Sharetribe's
 * Stripe actions don't support. The secret key must belong to the Stripe account connected in
 * Sharetribe Console (STRIPE_SECRET_KEY).
 *
 * Sharetribe uses destination charges: the payment is transferred to the provider's connected
 * account, the commission comes back to the platform as an application fee, and the platform
 * pays the Stripe fee. Connected accounts have manual payouts: Sharetribe pays them out when a
 * booking is completed.
 *
 * Never expose STRIPE_SECRET_KEY or Stripe API errors to the browser.
 */

let stripe = null;

const getStripe = () => {
  if (!stripe) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY must be set.');
    }
    stripe = new Stripe(secretKey);
  }
  return stripe;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Metadata keys on the PaymentIntent for payouts that wait for the funds to be available
const PAYOUT_STATUS_KEY = 'pastime-cancellation-payout';
const PAYOUT_PENDING = 'pending';
const PAYOUT_PAID = 'paid';

/**
 * PaymentIntents of a Sharetribe transaction (normally one). Sharetribe stores the transaction id
 * in the PaymentIntent's metadata. New PaymentIntents can take about a minute to show up in
 * searches.
 *
 * @param {string} transactionId Transaction UUID
 * @returns {Promise<Array<Object>>}
 */
const findPaymentIntentsForTransaction = transactionId => {
  // The id goes into a search query
  if (!UUID_PATTERN.test(transactionId)) {
    return Promise.reject(new Error('Invalid transaction id'));
  }
  return getStripe()
    .paymentIntents.search({
      query: `metadata['sharetribe-transaction-id']:'${transactionId}'`,
      limit: 10,
    })
    .then(result => result.data);
};

/**
 * PaymentIntent with its charge, the charge's balance transaction (Stripe fee) and the transfer
 * to the provider's connected account.
 *
 * @param {string} paymentIntentId
 * @returns {Promise<Object>}
 */
const retrievePaymentIntent = paymentIntentId =>
  getStripe().paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge.balance_transaction', 'latest_charge.transfer'],
  });

/**
 * Take back part of a transfer from the connected account to the platform.
 *
 * @param {Object} params
 * @param {string} params.transferId
 * @param {number} params.amount In minor units (e.g. cents)
 * @param {string} params.idempotencyKey
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>} Transfer reversal
 */
const createTransferReversal = ({ transferId, amount, idempotencyKey, metadata }) =>
  getStripe().transfers.createReversal(transferId, { amount, metadata }, { idempotencyKey });

/**
 * Refund part of a payment to the customer, from the platform's balance.
 *
 * @param {Object} params
 * @param {string} params.paymentIntentId
 * @param {number} params.amount In minor units
 * @param {string} params.idempotencyKey
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>} Refund
 */
const createRefund = ({ paymentIntentId, amount, idempotencyKey, metadata }) =>
  getStripe().refunds.create(
    { payment_intent: paymentIntentId, amount, metadata },
    { idempotencyKey }
  );

/**
 * When the payment in the provider's connected account becomes available for payouts.
 *
 * @param {Object} params
 * @param {string} params.accountId Connected account id
 * @param {string} params.destinationPaymentId The transfer's destination payment (py_...)
 * @returns {Promise<{isAvailable: boolean, availableOn: Date}>}
 */
const getDestinationPaymentAvailability = ({ accountId, destinationPaymentId }) =>
  getStripe()
    .charges.retrieve(
      destinationPaymentId,
      { expand: ['balance_transaction'] },
      { stripeAccount: accountId }
    )
    .then(payment => {
      const { status, available_on } = payment.balance_transaction || {};
      return { isAvailable: status === 'available', availableOn: new Date(available_on * 1000) };
    });

/**
 * Pay out from the provider's connected account to their bank account.
 *
 * @param {Object} params
 * @param {string} params.accountId Connected account id
 * @param {number} params.amount In minor units
 * @param {string} params.currency
 * @param {string} params.idempotencyKey
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>} Payout
 */
const createPayout = ({ accountId, amount, currency, idempotencyKey, metadata }) =>
  getStripe().payouts.create(
    { amount, currency, metadata },
    { stripeAccount: accountId, idempotencyKey }
  );

/**
 * Send money from the platform's available balance to a connected account (e.g. what Pastime pays
 * of a provider's payout). Fails if the platform's available balance is too low (Stripe error
 * code 'balance_insufficient'); Stripe doesn't retry it.
 *
 * @param {Object} params
 * @param {string} params.accountId Connected account id
 * @param {number} params.amount In minor units
 * @param {string} params.currency
 * @param {string} params.idempotencyKey
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>} Transfer
 */
const createTransfer = ({ accountId, amount, currency, idempotencyKey, metadata }) =>
  getStripe().transfers.create(
    { amount, currency, destination: accountId, metadata },
    { idempotencyKey }
  );

/**
 * Whether a Stripe error is about the platform's balance being too low.
 *
 * @param {Error} e
 * @returns {boolean}
 */
const isInsufficientBalanceError = e =>
  e?.code === 'balance_insufficient' || e?.raw?.code === 'balance_insufficient';

/**
 * Whether Stripe refused a request for sure (nothing was created). Stripe saves such a result for
 * 24 hours and replays it for the same idempotency key, so a retry needs a new key. Network errors,
 * timeouts and conflicts aren't: the request may have succeeded, so a retry keeps its key.
 *
 * @param {Error} e
 * @returns {boolean}
 */
const isRefusedRequestError = e => [400, 402, 403, 404].includes(e?.statusCode);

/**
 * Update the PaymentIntent's metadata (merged with the existing keys).
 *
 * @param {string} paymentIntentId
 * @param {Object} metadata
 * @returns {Promise<Object>}
 */
const updatePaymentIntentMetadata = (paymentIntentId, metadata) =>
  getStripe().paymentIntents.update(paymentIntentId, { metadata });

/**
 * PaymentIntents of cancelled bookings whose payout waits for the funds to be available.
 *
 * @returns {Promise<Array<Object>>}
 */
const findPendingPayouts = () =>
  getStripe()
    .paymentIntents.search({
      query: `metadata['${PAYOUT_STATUS_KEY}']:'${PAYOUT_PENDING}'`,
      limit: 100,
    })
    .then(result => result.data);

module.exports = {
  PAYOUT_PAID,
  PAYOUT_PENDING,
  PAYOUT_STATUS_KEY,
  createPayout,
  createRefund,
  createTransfer,
  createTransferReversal,
  isInsufficientBalanceError,
  isRefusedRequestError,
  findPaymentIntentsForTransaction,
  findPendingPayouts,
  getDestinationPaymentAvailability,
  retrievePaymentIntent,
  updatePaymentIntentMetadata,
};
