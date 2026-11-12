const log = require('../../log');
const {
  PAYOUT_PAID,
  PAYOUT_PENDING,
  PAYOUT_STATUS_KEY,
  createPayout,
  findPendingPayouts,
  getDestinationPaymentAvailability,
  updatePaymentIntentMetadata,
} = require('../stripe');

/**
 * Payouts of the provider's share of a cancelled booking (partial refunds).
 *
 * The provider's connected account has manual payouts, and Sharetribe only pays out completed
 * bookings, so the server pays out the provider's share. It's paid only when this booking's own
 * funds are available in the connected account (some days after the payment), never from other
 * funds: until then, the payout waits as "pending" in the PaymentIntent's metadata, and
 * processPendingPayouts pays it later.
 */

const HOUR_MS = 60 * 60 * 1000;

// Metadata keys on the PaymentIntent with the payout details
const AMOUNT_KEY = 'pastime-cancellation-payout-amount';
const ACCOUNT_KEY = 'pastime-cancellation-payout-account';
const PAYMENT_KEY = 'pastime-cancellation-payout-payment';
const AVAILABLE_ON_KEY = 'pastime-cancellation-payout-available-on';
const PAYOUT_ID_KEY = 'pastime-cancellation-payout-id';

const payProviderShare = ({ paymentIntentId, transactionId, accountId, amount, currency }) =>
  createPayout({
    accountId,
    amount,
    currency,
    // One payout per cancelled booking
    idempotencyKey: `cancellation-payout-${transactionId}`,
    metadata: { 'sharetribe-transaction-id': transactionId },
  }).then(payout =>
    updatePaymentIntentMetadata(paymentIntentId, {
      [PAYOUT_STATUS_KEY]: PAYOUT_PAID,
      [PAYOUT_ID_KEY]: payout.id,
    }).then(() => payout)
  );

/**
 * Pay out the provider's share now if this booking's funds are available, or mark it pending.
 *
 * @param {Object} params
 * @param {string} params.paymentIntentId
 * @param {string} params.transactionId
 * @param {Object} params.payment See cancellation.getPaymentDetails
 * @param {number} params.amount Provider's share in minor units
 * @returns {Promise<{status: 'paid'|'pending'|'none', availableOn?: Date}>}
 */
const payOutOrSchedule = ({ paymentIntentId, transactionId, payment, amount }) => {
  if (amount <= 0) {
    return Promise.resolve({ status: 'none' });
  }
  const { accountId, destinationPaymentId, currency } = payment;
  const markPending = availableOn =>
    updatePaymentIntentMetadata(paymentIntentId, {
      [PAYOUT_STATUS_KEY]: PAYOUT_PENDING,
      [AMOUNT_KEY]: `${amount}`,
      [ACCOUNT_KEY]: accountId,
      [PAYMENT_KEY]: destinationPaymentId,
      [AVAILABLE_ON_KEY]: availableOn.toISOString(),
    }).then(() => ({ status: PAYOUT_PENDING, availableOn }));

  return getDestinationPaymentAvailability({ accountId, destinationPaymentId })
    .then(({ isAvailable, availableOn }) =>
      isAvailable
        ? payProviderShare({
            paymentIntentId,
            transactionId,
            accountId,
            amount,
            currency,
          }).then(() => ({ status: PAYOUT_PAID }))
        : markPending(availableOn)
    )
    .catch(e => {
      // Try again with the pending payouts job
      log.error(e, 'cancellation-payout-failed', { transactionId });
      return markPending(new Date());
    });
};

/**
 * Pay out the pending payouts whose funds have become available. Only Stripe is called (no
 * Sharetribe API calls).
 *
 * @param {Date} [now]
 * @returns {Promise<number>} Number of payouts made
 */
const processPendingPayouts = (now = new Date()) =>
  findPendingPayouts().then(paymentIntents => {
    const due = paymentIntents.filter(
      pi => new Date(pi.metadata[AVAILABLE_ON_KEY]).getTime() <= now.getTime()
    );
    return due.reduce(
      (previous, pi) =>
        previous.then(count => {
          const { metadata, currency } = pi;
          const accountId = metadata[ACCOUNT_KEY];
          const transactionId = metadata['sharetribe-transaction-id'];
          return getDestinationPaymentAvailability({
            accountId,
            destinationPaymentId: metadata[PAYMENT_KEY],
          })
            .then(({ isAvailable }) =>
              isAvailable
                ? payProviderShare({
                    paymentIntentId: pi.id,
                    transactionId,
                    accountId,
                    amount: Number(metadata[AMOUNT_KEY]),
                    currency,
                  }).then(() => count + 1)
                : count
            )
            .catch(e => {
              // Try again on the next round
              log.error(e, 'cancellation-payout-failed', { transactionId });
              return count;
            });
        }),
      Promise.resolve(0)
    );
  });

/**
 * Check for due payouts every hour. Requires a long-running server process.
 *
 * @returns {Object} The interval timer
 */
const startPendingPayoutsJob = () => {
  const run = () =>
    processPendingPayouts().catch(e => log.error(e, 'cancellation-payouts-job-failed', {}));
  const timer = setInterval(run, HOUR_MS);
  // Don't keep the process alive just for this job
  timer.unref?.();
  return timer;
};

module.exports = {
  payOutOrSchedule,
  processPendingPayouts,
  startPendingPayoutsJob,
};
