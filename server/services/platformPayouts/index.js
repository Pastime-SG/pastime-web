const log = require('../../log');
const { getFirestore, FieldValue } = require('../firebase');
const { getIntegrationSdk } = require('../sharetribe/integration');
const { getPaymentPlan } = require('../commission');
const { hasStripePayment, isPaidOutByPlatform } = require('../bookingData');
const { getPayment } = require('../cancellation/payment');
const {
  createPayout,
  createTransfer,
  getDestinationPaymentAvailability,
  isInsufficientBalanceError,
  isRefusedRequestError,
} = require('../stripe');

/**
 * Payouts that Pastime's server makes to providers, instead of Sharetribe.
 *
 * Bookings where loyalty credits, an admin's promo code (or a remainder below Stripe's minimum
 * charge) are more than Pastime's commission use the booking-platform-paid process, and bookings
 * the customer pays nothing for use booking-free (see services/commission getPaymentPlan). The
 * provider is still paid in full, and doesn't see what Pastime paid:
 *
 *  1. When the booking ends (or is cancelled), Pastime's part is sent from its Stripe balance to
 *     the provider's connected account (a Stripe Transfer).
 *  2. When the booking's own funds and Pastime's transfer are available in the connected account,
 *     the provider's whole payout is paid to their bank in one payout. Never from other funds.
 *
 * Every payout is kept in Firestore (platformPayouts/{transactionId}) until it's paid, and retried
 * every 15 minutes (with the booking events job): e.g. when Pastime's Stripe balance is too low
 * for the transfer. Stripe calls use idempotency keys, so a booking is never paid twice. Stripe
 * replays a refused request for the same key for 24 hours, so after a refusal (nothing was
 * created) the next attempt uses a new key; after a network error it keeps the same key.
 */

const COLLECTION = 'platformPayouts';

const STATUS_PENDING = 'pending';
const STATUS_PAID = 'paid';

// Transitions after which the provider is paid in full (the process has no Sharetribe payout)
const PAYOUT_TRANSITIONS = [
  'transition/complete',
  'transition/operator-complete',
  'transition/payout-cancelled-without-refund',
];

// Errors shown in the admin list
const ERROR_BALANCE = 'platform-balance-too-low';
const ERROR_NO_ACCOUNT = 'provider-stripe-account-missing';
const ERROR_OTHER = 'stripe-error';

const payoutRef = transactionId =>
  getFirestore()
    .collection(COLLECTION)
    .doc(transactionId);

// Idempotency key of a Stripe call: a new one after each refused attempt
const idempotencyKey = (name, transactionId, refusedCount) =>
  refusedCount > 0
    ? `platform-${name}-${transactionId}-retry-${refusedCount}`
    : `platform-${name}-${transactionId}`;

// The refusal counter to save after a failed Stripe call
const refusalChanges = (field, record, e) =>
  isRefusedRequestError(e) ? { [field]: (record[field] || 0) + 1 } : {};

const getUuid = value => value?.uuid || (typeof value === 'string' ? value : null);

/**
 * The provider's Stripe connected account id (one Integration API call; only for free bookings,
 * which have no Stripe payment to read it from).
 *
 * @param {string} providerId
 * @returns {Promise<string|null>}
 */
const getProviderStripeAccountId = async providerId => {
  const response = await getIntegrationSdk().users.show({
    id: providerId,
    include: ['stripeAccount'],
    'fields.user': ['profile.displayName'],
  });
  const ref = response.data.data.relationships?.stripeAccount?.data;
  const account = (response.data.included || []).find(
    i => i.type === 'stripeAccount' && ref && i.id.uuid === ref.id.uuid
  );
  return account?.attributes?.stripeAccountId || null;
};

/**
 * Where the provider's money comes from: the booking's payment (in their connected account
 * already) and Pastime's balance (the rest).
 *
 * @param {Object} record Firestore record (transactionId, processName, paymentIntentId,
 * providerId, payoutAmount)
 * @returns {Promise<Object>} { accountId, currency?, bookingPaymentId, platformAmount }
 */
const getPayoutSources = async record => {
  const { transactionId, processName, paymentIntentId, providerId, payoutAmount } = record;
  if (!hasStripePayment(processName)) {
    const accountId = providerId ? await getProviderStripeAccountId(providerId) : null;
    return { accountId, bookingPaymentId: null, platformAmount: payoutAmount };
  }
  const protectedData = {
    stripePaymentIntents: { default: { stripePaymentIntentId: paymentIntentId } },
  };
  const { payment } = await getPayment(transactionId, protectedData);
  // What the booking's payment left in the provider's account (after any reversal)
  const fromBooking = payment.providerShare - payment.alreadyReversed;
  return {
    accountId: payment.accountId,
    currency: payment.currency,
    bookingPaymentId: payment.destinationPaymentId,
    platformAmount: Math.max(payoutAmount - fromBooking, 0),
  };
};

const isAvailable = (accountId, paymentId) =>
  paymentId
    ? getDestinationPaymentAvailability({ accountId, destinationPaymentId: paymentId })
    : Promise.resolve({ isAvailable: true });

/**
 * Move one payout forward: transfer Pastime's part, then pay out when the funds are available.
 *
 * @param {Object} record Firestore record
 * @returns {Promise<Object>} The changes saved to the record
 */
const advancePayout = async savedRecord => {
  let sourceChanges = {};
  if (savedRecord.accountId == null) {
    try {
      sourceChanges = await getPayoutSources(savedRecord);
    } catch (e) {
      log.error(e, 'platform-payout-sources-failed', { transactionId: savedRecord.transactionId });
      return { lastError: ERROR_OTHER };
    }
    if (!sourceChanges.accountId) {
      return { lastError: ERROR_NO_ACCOUNT };
    }
  }
  const record = { ...savedRecord, ...sourceChanges };
  const { transactionId, accountId, currency, payoutAmount, platformAmount } = record;
  const metadata = { 'sharetribe-transaction-id': transactionId };
  let changes = sourceChanges;

  if (payoutAmount <= 0) {
    return { ...changes, status: STATUS_PAID, lastError: null };
  }

  // 1. Pastime's part, from the platform's available balance
  let transferPaymentId = record.transferPaymentId || null;
  if (platformAmount > 0 && !record.transferId) {
    try {
      const transfer = await createTransfer({
        accountId,
        amount: platformAmount,
        currency,
        idempotencyKey: idempotencyKey('transfer', transactionId, record.transferRefusals || 0),
        metadata,
      });
      transferPaymentId = transfer.destination_payment || null;
      changes = {
        ...changes,
        transferId: transfer.id,
        transferPaymentId,
        transferredAt: new Date(),
      };
    } catch (e) {
      const lastError = isInsufficientBalanceError(e) ? ERROR_BALANCE : ERROR_OTHER;
      log.error(e, 'platform-payout-transfer-failed', { transactionId, lastError });
      return { ...changes, ...refusalChanges('transferRefusals', record, e), lastError };
    }
  }

  // 2. One payout of the whole amount, when this booking's funds are available
  const [booking, transfer] = await Promise.all([
    isAvailable(accountId, record.bookingPaymentId),
    isAvailable(accountId, transferPaymentId),
  ]);
  if (!booking.isAvailable || !transfer.isAvailable) {
    const dates = [booking.availableOn, transfer.availableOn].filter(Boolean);
    const availableOn = dates.length ? new Date(Math.max(...dates.map(d => d.getTime()))) : null;
    return { ...changes, availableOn, lastError: null };
  }
  try {
    const payout = await createPayout({
      accountId,
      amount: payoutAmount,
      currency,
      idempotencyKey: idempotencyKey('payout', transactionId, record.payoutRefusals || 0),
      metadata,
    });
    return {
      ...changes,
      status: STATUS_PAID,
      payoutId: payout.id,
      paidAt: new Date(),
      lastError: null,
    };
  } catch (e) {
    log.error(e, 'platform-payout-failed', { transactionId });
    return { ...changes, ...refusalChanges('payoutRefusals', record, e), lastError: ERROR_OTHER };
  }
};

const saveChanges = (transactionId, changes) =>
  payoutRef(transactionId).set(
    { ...changes, updatedAt: FieldValue.serverTimestamp(), attempts: FieldValue.increment(1) },
    { merge: true }
  );

const processRecord = async record => {
  const changes = await advancePayout(record);
  await saveChanges(record.transactionId, changes);
  return { ...record, ...changes };
};

/**
 * Pay the provider of a booking (once per booking: an existing record is only moved forward).
 *
 * @param {Object} params
 * @param {string} params.transactionId
 * @param {string} params.processName
 * @param {Object} params.protectedData For the booking's Stripe payment
 * @param {string} [params.providerId] For free bookings (their Stripe account)
 * @param {number} params.payoutAmount What the provider is paid in total (minor units)
 * @param {string} params.currency
 * @param {string} params.reason 'completed' | 'cancelled'
 * @returns {Promise<Object>} The record
 */
const payProvider = async params => {
  const { transactionId, processName, protectedData, providerId, payoutAmount, reason } = params;
  const ref = payoutRef(transactionId);
  const existing = await ref.get();
  if (existing.exists) {
    const saved = existing.data();
    return saved.status === STATUS_PAID ? saved : processRecord(saved);
  }
  const paymentIntentId = protectedData?.stripePaymentIntents?.default?.stripePaymentIntentId;
  // Saved first, so that it's retried even if Stripe or Sharetribe can't be reached now
  const record = {
    transactionId,
    processName,
    providerId: providerId || null,
    paymentIntentId: typeof paymentIntentId === 'string' ? paymentIntentId : null,
    reason,
    payoutAmount,
    currency: (params.currency || '').toLowerCase(),
    accountId: null,
    bookingPaymentId: null,
    platformAmount: null,
    status: STATUS_PENDING,
    transferId: null,
    transferPaymentId: null,
    payoutId: null,
    lastError: null,
    attempts: 0,
    createdAt: FieldValue.serverTimestamp(),
  };
  // create() fails if another run made the record meanwhile: that run pays it
  await ref.create(record);
  return processRecord(record);
};

/**
 * A booking event: pay the provider when a booking paid out by Pastime ends.
 *
 * @param {Object} event Integration API transaction event
 * @returns {Promise<boolean>} Whether a payout was started
 */
const applyPayoutEvent = async event => {
  const transaction = event?.attributes?.resource;
  const attributes = transaction?.attributes || {};
  const { processName, lastTransition, lineItems, protectedData, payinTotal } = attributes;
  if (!isPaidOutByPlatform(processName) || !PAYOUT_TRANSITIONS.includes(lastTransition)) {
    return false;
  }
  const transactionId = getUuid(event.attributes.resourceId) || getUuid(transaction.id);
  const plan = getPaymentPlan(lineItems);
  await payProvider({
    transactionId,
    processName,
    protectedData,
    providerId: getUuid(transaction.relationships?.provider?.data?.id),
    payoutAmount: plan.providerPayout,
    currency: payinTotal?.currency,
    reason:
      lastTransition === 'transition/payout-cancelled-without-refund' ? 'cancelled' : 'completed',
  });
  return true;
};

/**
 * Retry the payouts that are still waiting (balance too low, funds not available yet).
 *
 * @returns {Promise<number>} Number of payouts paid now
 */
const processPendingPlatformPayouts = async () => {
  const snapshot = await getFirestore()
    .collection(COLLECTION)
    .where('status', '==', STATUS_PENDING)
    .limit(100)
    .get();
  let paid = 0;
  for (const doc of snapshot.docs) {
    const record = doc.data();
    const due = !record.availableOn || record.availableOn.toDate?.() <= new Date();
    if (due) {
      // eslint-disable-next-line no-await-in-loop
      const result = await processRecord(record).catch(e => {
        log.error(e, 'platform-payout-retry-failed', { transactionId: record.transactionId });
        return null;
      });
      paid += result?.status === STATUS_PAID ? 1 : 0;
    }
  }
  return paid;
};

/**
 * Payouts for the admin list (newest first).
 *
 * @param {Object} [options]
 * @param {number} [options.limit]
 * @returns {Promise<Array<Object>>}
 */
const listPlatformPayouts = async ({ limit = 100 } = {}) => {
  const snapshot = await getFirestore()
    .collection(COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const toIso = value => (value?.toDate ? value.toDate().toISOString() : value || null);
  return snapshot.docs.map(doc => {
    const r = doc.data();
    return {
      transactionId: r.transactionId,
      reason: r.reason,
      status: r.status,
      currency: r.currency,
      payoutAmount: r.payoutAmount,
      platformAmount: r.platformAmount,
      lastError: r.lastError || null,
      availableOn: toIso(r.availableOn),
      createdAt: toIso(r.createdAt),
      paidAt: toIso(r.paidAt),
    };
  });
};

module.exports = {
  ERROR_BALANCE,
  PAYOUT_TRANSITIONS,
  advancePayout,
  applyPayoutEvent,
  listPlatformPayouts,
  payProvider,
  processPendingPlatformPayouts,
};
