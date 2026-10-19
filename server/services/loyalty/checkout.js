const crypto = require('crypto');

const log = require('../../log');
const { BOOKING_REQUEST_TRANSITIONS } = require('../policies');
const { isBookingProcess } = require('../bookingData');
const { LOYALTY_CREDIT } = require('../commission');
const {
  confirmSpentCredits,
  getLoyaltyAccount,
  releaseSpentCredits,
  spendCredits,
} = require('./index');

/**
 * Loyalty credits when a booking is requested (initiate-privileged and transition-privileged).
 * The customer opts in at checkout (orderData.useCredits). Their balance is looked up here, the
 * credits are added to the line items (see server/services/commission), a copy is stored in the
 * transaction's protected data, and the credits are taken from the balance when the booking is
 * made.
 */

/**
 * The customer's credits for this booking request, or null if they don't use credits. Only
 * booking requests take credits. The customer is the signed-in user (one extra Sharetribe
 * call, only when they use credits).
 *
 * @param {Object} params
 * @param {Object} params.sdk The user's SDK
 * @param {Object} [params.orderData]
 * @param {string} params.transitionName
 * @param {string} params.processName The transaction's process name or alias
 * @returns {Promise<Object|null>} { customerId, balance, currency, redemptionId }
 */
const getBookingLoyalty = async ({ sdk, orderData, transitionName, processName }) => {
  if (
    orderData?.useCredits !== true ||
    !BOOKING_REQUEST_TRANSITIONS.includes(transitionName) ||
    !isBookingProcess(processName)
  ) {
    return null;
  }
  const userResponse = await sdk.currentUser.show({ 'fields.user': ['profile.displayName'] });
  const customerId = userResponse?.data?.data?.id?.uuid;
  if (!customerId) {
    return null;
  }
  const account = await getLoyaltyAccount(customerId);
  return {
    customerId,
    balance: account.creditBalance,
    currency: account.currency,
    // The use of credits by this booking: stored with the booking, so that the credits can be
    // given back if the booking doesn't go ahead (see promoCodes/bookingEvents.js)
    redemptionId: crypto.randomUUID(),
  };
};

/**
 * The credits to pass to getTransactionLineItems: none if the balance is in another currency.
 *
 * @param {Object|null} loyalty
 * @param {string} currency The listing's currency
 * @returns {number}
 */
const getLoyaltyCreditsToUse = (loyalty, currency) =>
  loyalty && loyalty.currency === currency ? loyalty.balance : 0;

const getCreditsLineItem = lineItems => (lineItems || []).find(i => i.code === LOYALTY_CREDIT);

/**
 * A copy of the used credits for the transaction's protected data.
 *
 * @param {Object|null} loyalty
 * @param {Array<Object>} lineItems
 * @returns {Object} { loyalty: { customerId, redemptionId, credits, currency } } or {}
 */
const getLoyaltyProtectedData = (loyalty, lineItems) => {
  const creditsItem = getCreditsLineItem(lineItems);
  return loyalty && creditsItem
    ? {
        loyalty: {
          customerId: loyalty.customerId,
          redemptionId: loyalty.redemptionId,
          credits: Math.abs(creditsItem.unitPrice.amount),
          currency: creditsItem.unitPrice.currency,
        },
      }
    : {};
};

/**
 * Make the booking request, taking the credits from the customer's balance first (which fails
 * if the balance is too low), linking them to the transaction if the booking was made, and
 * giving them back if it wasn't. Previews (speculative requests) don't take credits.
 *
 * @param {Object} params
 * @param {Object|null} params.loyalty
 * @param {Array<Object>} params.lineItems
 * @param {boolean} params.isSpeculative
 * @param {Function} makeRequest () => Promise of the SDK response
 * @returns {Promise<Object>} The SDK response
 */
const withLoyaltyCredits = async ({ loyalty, lineItems, isSpeculative }, makeRequest) => {
  const creditsItem = getCreditsLineItem(lineItems);
  if (!loyalty || !creditsItem || isSpeculative) {
    return makeRequest();
  }

  const { customerId, redemptionId } = loyalty;
  await spendCredits({
    customerId,
    redemptionId,
    amount: Math.abs(creditsItem.unitPrice.amount),
    currency: creditsItem.unitPrice.currency,
  });

  let response;
  try {
    response = await makeRequest();
  } catch (e) {
    await releaseSpentCredits(customerId, redemptionId).catch(releaseError =>
      log.error(releaseError, 'loyalty-credits-release-failed', { customerId })
    );
    throw e;
  }

  const transactionId = response?.data?.data?.id?.uuid;
  // The booking is made: a failure here only affects the history
  await confirmSpentCredits(customerId, redemptionId, transactionId).catch(e =>
    log.error(e, 'loyalty-credits-confirm-failed', { customerId, transactionId })
  );
  return response;
};

module.exports = {
  getBookingLoyalty,
  getLoyaltyCreditsToUse,
  getLoyaltyProtectedData,
  withLoyaltyCredits,
};
