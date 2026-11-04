const log = require('../../log');
const {
  createCookieTokenStore,
  getSdk,
  getTrustedSdk,
  handleError,
  serialize,
} = require('../../api-util/sdk');
const {
  formatMoney,
  getApplicableRule,
  getBookingAmounts,
  getCancelTransition,
  getCancellationAmounts,
  getPaymentDetails,
} = require('../../services/cancellation');
const { payOutOrSchedule } = require('../../services/cancellation/payouts');
const {
  createRefund,
  createTransferReversal,
  findPaymentIntentsForTransaction,
  retrievePaymentIntent,
} = require('../../services/stripe');

/**
 * Customer cancellation of an accepted booking (see server/services/cancellation for the rules).
 * Cancelling a booking request before it's accepted doesn't need the server.
 *
 * The cancel transitions are privileged, so they can only be made here, after the cancellation
 * rule has been checked. The user comes from the session (middleware.auth): they must be the
 * customer of the transaction.
 *
 * Request body:
 *  - transactionId
 *  - action: 'preview' (the refund the customer would get now) or 'cancel'
 *
 * Responses:
 *  - preview: { ruleHeading, refundPercentage, currency, paid, stripeFee, refund }
 *  - cancel: the updated transaction with its booking (transit)
 *
 * Errors: { status, code } with code 'not-allowed' (403), 'not-cancellable' (403: no cancellation
 * rule applies now), 'payment-not-found' (409) or 'refund-failed' (502).
 */

const ACTIONS = ['preview', 'cancel'];

const fail = (res, status, code) => res.status(status).json({ status, code });

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

const paymentNotFound = () => {
  const error = new Error('Payment not found');
  error.code = 'payment-not-found';
  return error;
};

// The PaymentIntent stored with the transaction by Sharetribe (stripe-create-payment-intent), if
// it belongs to this transaction, or else one found by searching Stripe. Searching only finds
// PaymentIntents after about a minute, so it's the fallback.
const findPaymentIntent = async (transactionId, protectedData) => {
  const storedId = protectedData?.stripePaymentIntents?.default?.stripePaymentIntentId;
  if (typeof storedId === 'string' && /^pi_[A-Za-z0-9]+$/.test(storedId)) {
    const pi = await retrievePaymentIntent(storedId).catch(() => null);
    if (pi?.metadata?.['sharetribe-transaction-id'] === transactionId) {
      return pi;
    }
  }
  const found = await findPaymentIntentsForTransaction(transactionId);
  const match = found.find(pi => pi.status === 'succeeded');
  return match ? retrievePaymentIntent(match.id) : null;
};

// The captured PaymentIntent of the transaction
const getPayment = async (transactionId, protectedData) => {
  const pi = await findPaymentIntent(transactionId, protectedData);
  if (pi?.status !== 'succeeded') {
    throw paymentNotFound();
  }
  return { paymentIntentId: pi.id, payment: getPaymentDetails(pi) };
};

// Take back the provider's share minus what they keep, and refund the customer. Stripe calls are
// idempotent and skipped when already done, so a failed cancellation can be retried.
const refundPayment = ({ transactionId, paymentIntentId, payment, amounts }) => {
  const reversal = payment.providerShare - amounts.providerPayout - payment.alreadyReversed;
  const refund = amounts.refund - payment.alreadyRefunded;
  const metadata = { 'sharetribe-transaction-id': transactionId };
  const reverseMaybe =
    reversal > 0
      ? createTransferReversal({
          transferId: payment.transferId,
          amount: reversal,
          idempotencyKey: `cancellation-reversal-${transactionId}`,
          metadata,
        })
      : Promise.resolve();
  return reverseMaybe.then(() =>
    refund > 0
      ? createRefund({
          paymentIntentId,
          amount: refund,
          idempotencyKey: `cancellation-refund-${transactionId}`,
          metadata,
        })
      : null
  );
};

module.exports = async (req, res) => {
  const { transactionId, action } = req.body || {};
  const userId = req.tokenUserId;

  if (!transactionId || !ACTIONS.includes(action)) {
    return fail(res, 400, 'invalid-request');
  }

  try {
    // The signed-in user's SDK: they can only see their own transactions. The trusted SDK is only
    // used for the privileged transition, with the same cookie token store.
    const tokenStore = createCookieTokenStore(req, res);
    const sdk = getSdk(req, res, tokenStore);
    // The customer has to be included: Sharetribe only returns the relationships that are asked for,
    // and the customer is checked below
    const txResponse = await sdk.transactions.show({
      id: transactionId,
      include: ['booking', 'customer'],
      'fields.user': ['profile.displayName'],
    });
    const { data: tx, included = [] } = txResponse.data;
    const booking = findIncluded(tx, included, 'booking');
    const customerId = tx.relationships?.customer?.data?.id?.uuid;
    const { lastTransition, protectedData, lineItems, payinTotal, payoutTotal } = tx.attributes;
    const now = new Date();

    if (userId !== customerId || !booking || !getCancelTransition(lastTransition, true)) {
      return fail(res, 403, 'not-allowed');
    }
    const rule = getApplicableRule({ protectedData, bookingStart: booking.attributes.start, now });
    if (!rule) {
      return fail(res, 403, 'not-cancellable');
    }

    const currency = payinTotal.currency;
    const hasRefund = rule.refundPercentage > 0;
    const ruleDetails = { ruleHeading: rule.heading, refundPercentage: rule.refundPercentage };

    // Without a refund, Stripe isn't needed: the provider is paid out as usual by the process
    let cancellation;
    if (!hasRefund) {
      if (action === 'preview') {
        return res
          .status(200)
          .json({ ...ruleDetails, currency, paid: payinTotal.amount, refund: 0 });
      }
      cancellation = {
        ...ruleDetails,
        cancelledAt: now.toISOString(),
        currency,
        paid: payinTotal.amount,
        refund: 0,
        providerPayout: payoutTotal.amount,
        providerPayoutText: formatMoney(payoutTotal.amount, currency),
        payoutStatus: 'with-booking-end',
      };
    } else {
      const { paymentIntentId, payment } = await getPayment(tx.id.uuid, protectedData);
      const amounts = getCancellationAmounts({
        refundPercentage: rule.refundPercentage,
        bookingAmounts: getBookingAmounts(lineItems),
        paid: payment.paid,
        stripeFee: payment.stripeFee,
      });
      const { paid, stripeFee } = payment;
      if (action === 'preview') {
        return res
          .status(200)
          .json({ ...ruleDetails, currency, paid, stripeFee, refund: amounts.refund });
      }

      try {
        await refundPayment({ transactionId: tx.id.uuid, paymentIntentId, payment, amounts });
      } catch (e) {
        log.error(e, 'cancellation-refund-failed', { transactionId: tx.id.uuid });
        return fail(res, 502, 'refund-failed');
      }
      // The provider's share is paid out when this booking's funds are available
      const payout = await payOutOrSchedule({
        paymentIntentId,
        transactionId: tx.id.uuid,
        payment,
        amount: amounts.providerPayout,
      }).catch(e => {
        // The refund was made: don't fail the cancellation. The payout needs a manual check.
        log.error(e, 'cancellation-payout-not-scheduled', { transactionId: tx.id.uuid });
        return { status: 'failed' };
      });

      cancellation = {
        ...ruleDetails,
        cancelledAt: now.toISOString(),
        currency: payment.currency.toUpperCase(),
        paid,
        stripeFee,
        refund: amounts.refund,
        providerPayout: amounts.providerPayout,
        platformCommission: amounts.platformCommission,
        refundText: formatMoney(amounts.refund, payment.currency),
        feeText: formatMoney(stripeFee, payment.currency),
        providerPayoutText: formatMoney(amounts.providerPayout, payment.currency),
        payoutStatus: payout.status,
        ...(payout.availableOn ? { payoutAvailableOn: payout.availableOn.toISOString() } : {}),
      };
    }

    const trustedSdk = await getTrustedSdk(req, res, tokenStore);
    const response = await trustedSdk.transactions.transition(
      {
        id: tx.id,
        transition: getCancelTransition(lastTransition, hasRefund),
        params: { metadata: { cancellation } },
      },
      { expand: true, include: ['booking'] }
    );
    return sendTransaction(res, response);
  } catch (e) {
    if (e.code === 'payment-not-found') {
      return fail(res, 409, 'payment-not-found');
    }
    handleError(res, e);
  }
};
