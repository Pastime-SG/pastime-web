const crypto = require('crypto');

const log = require('../../log');
const { BOOKING_REQUEST_TRANSITIONS } = require('../policies');
const { isBookingProcess } = require('../bookingData');
const {
  confirmPromoCodeUse,
  findPromoCodeForBooking,
  releasePromoCodeUse,
  reservePromoCodeUse,
} = require('./index');

/**
 * Promo codes when a booking is requested (initiate-privileged and transition-privileged).
 * The customer's code comes in orderData.promoCode: it's checked for the listing's provider, its
 * discount is added to the line items (see server/services/commission), a copy is stored in the
 * transaction's protected data, and a use is counted when the booking is made.
 */

const PROMO_DISCOUNT = 'line-item/promo-discount';

/**
 * The promo code entered at checkout, or null if none was entered. Only booking requests take
 * a code (not e.g. offers in the negotiation process). Throws a checkout error if the code
 * can't be used.
 *
 * @param {Object} params
 * @param {Object} [params.orderData]
 * @param {string} params.providerId The listing's author
 * @param {string} params.transitionName
 * @param {string} params.processName The transaction's process name or alias
 * @returns {Promise<Object|null>}
 */
const getBookingPromoCode = ({ orderData, providerId, transitionName, processName }) =>
  orderData?.promoCode &&
  BOOKING_REQUEST_TRANSITIONS.includes(transitionName) &&
  isBookingProcess(processName)
    ? findPromoCodeForBooking({ code: orderData.promoCode, providerId }).then(promoCode => ({
        ...promoCode,
        // The use of the code by this booking: it's stored with the booking, so that it can be
        // given back if the booking doesn't go ahead (see bookingEvents.js)
        redemptionId: crypto.randomUUID(),
      }))
    : Promise.resolve(null);

const getDiscountLineItem = lineItems => (lineItems || []).find(i => i.code === PROMO_DISCOUNT);

/**
 * A copy of the applied promo code for the transaction's protected data.
 *
 * @param {Object|null} promoCode
 * @param {Array<Object>} lineItems
 * @returns {Object} { promoCode: { id, redemptionId, code, createdBy, discount, currency } } or {}
 */
const getPromoCodeProtectedData = (promoCode, lineItems) => {
  const discountItem = getDiscountLineItem(lineItems);
  return promoCode && discountItem
    ? {
        promoCode: {
          id: promoCode.id,
          redemptionId: promoCode.redemptionId,
          code: promoCode.code,
          createdBy: promoCode.createdBy,
          discount: Math.abs(discountItem.unitPrice.amount),
          currency: discountItem.unitPrice.currency,
        },
      }
    : {};
};

/**
 * Make the booking request, counting a use of the promo code: a use is reserved first (which
 * enforces the usage limit), confirmed with the transaction id if the booking was made, and
 * given back if it wasn't. Previews (speculative requests) don't count.
 *
 * @param {Object} params
 * @param {Object|null} params.promoCode
 * @param {Array<Object>} params.lineItems
 * @param {boolean} params.isSpeculative
 * @param {Object} params.details Stored with the use (e.g. listingId, providerId)
 * @param {Function} makeRequest () => Promise of the SDK response
 * @returns {Promise<Object>} The SDK response
 */
const withPromoCodeUse = async ({ promoCode, lineItems, isSpeculative, details }, makeRequest) => {
  const discountItem = getDiscountLineItem(lineItems);
  if (!promoCode || !discountItem || isSpeculative) {
    return makeRequest();
  }

  const { redemptionId } = promoCode;
  await reservePromoCodeUse({
    promoCodeId: promoCode.id,
    redemptionId,
    details: {
      ...details,
      discount: Math.abs(discountItem.unitPrice.amount),
      currency: discountItem.unitPrice.currency,
    },
  });

  let response;
  try {
    response = await makeRequest();
  } catch (e) {
    await releasePromoCodeUse(promoCode.id, redemptionId).catch(releaseError =>
      log.error(releaseError, 'promo-code-release-failed', { promoCodeId: promoCode.id })
    );
    throw e;
  }

  const transactionId = response?.data?.data?.id?.uuid;
  // The booking is made: a failure here only affects the usage history
  await confirmPromoCodeUse(promoCode.id, redemptionId, transactionId).catch(e =>
    log.error(e, 'promo-code-confirm-failed', { promoCodeId: promoCode.id, transactionId })
  );
  return response;
};

module.exports = {
  getBookingPromoCode,
  getPromoCodeProtectedData,
  withPromoCodeUse,
};
