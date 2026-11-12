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
} = require('../../services/cancellation');
const { payOutOrSchedule } = require('../../services/cancellation/payouts');
const { createRefund, createTransferReversal } = require('../../services/stripe');
const { getPayment } = require('../../services/cancellation/payment');
const { hasStripePayment, isPaidOutByPlatform } = require('../../services/bookingData');
const { getPaymentPlan } = require('../../services/commission');
const { payProvider } = require('../../services/platformPayouts');

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
      include: ['booking', 'customer', 'provider'],
      'fields.user': ['profile.displayName'],
    });
    const { data: tx, included = [] } = txResponse.data;
    const booking = findIncluded(tx, included, 'booking');
    const customerId = tx.relationships?.customer?.data?.id?.uuid;
    const { lastTransition, protectedData, lineItems, payinTotal, processName } = tx.attributes;
    // Bookings that Pastime pays part of, or free bookings: Pastime's server pays the provider
    const isPlatformPayout = isPaidOutByPlatform(processName);
    // What the provider is paid for the whole booking (Pastime's part included)
    const fullPayout = getPaymentPlan(lineItems).providerPayout;
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
        providerPayout: fullPayout,
        providerPayoutText: formatMoney(fullPayout, currency),
        payoutStatus: 'with-booking-end',
      };
    } else {
      // Free bookings have no Stripe payment: nothing to refund, the credits are given back by
      // the booking events job
      const { paymentIntentId, payment } = hasStripePayment(processName)
        ? await getPayment(tx.id.uuid, protectedData)
        : { paymentIntentId: null, payment: { paid: 0, stripeFee: 0, currency } };
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

      if (paymentIntentId) {
        try {
          await refundPayment({ transactionId: tx.id.uuid, paymentIntentId, payment, amounts });
        } catch (e) {
          log.error(e, 'cancellation-refund-failed', { transactionId: tx.id.uuid });
          return fail(res, 502, 'refund-failed');
        }
      }
      // The provider's share is paid out when this booking's funds are available. For bookings
      // paid out by Pastime, it can be more than the payment left in the provider's account:
      // Pastime sends the rest from its balance.
      const payOut = isPlatformPayout
        ? payProvider({
            transactionId: tx.id.uuid,
            processName,
            protectedData,
            providerId: tx.relationships?.provider?.data?.id?.uuid,
            payoutAmount: amounts.providerPayout,
            currency,
            reason: 'cancelled',
          }).then(record => ({
            status: record.status === 'paid' ? 'paid' : 'pending',
            ...(record.availableOn instanceof Date ? { availableOn: record.availableOn } : {}),
          }))
        : payOutOrSchedule({
            paymentIntentId,
            transactionId: tx.id.uuid,
            payment,
            amount: amounts.providerPayout,
          });
      const payout = await payOut.catch(e => {
        // The refund was made: don't fail the cancellation. The payout needs a manual check.
        log.error(e, 'cancellation-payout-not-scheduled', { transactionId: tx.id.uuid });
        return { status: 'failed' };
      });

      cancellation = {
        ...ruleDetails,
        cancelledAt: now.toISOString(),
        currency: (payment.currency || currency).toUpperCase(),
        paid,
        stripeFee,
        refund: amounts.refund,
        providerPayout: amounts.providerPayout,
        platformCommission: amounts.platformCommission,
        refundText: formatMoney(amounts.refund, payment.currency || currency),
        feeText: formatMoney(stripeFee, payment.currency || currency),
        providerPayoutText: formatMoney(amounts.providerPayout, payment.currency || currency),
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
