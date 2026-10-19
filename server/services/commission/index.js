const { types } = require('sharetribe-flex-sdk');
const { transactionLineItems } = require('../../api-util/lineItems');
const {
  calculateLineTotal,
  calculateTotalFromLineItems,
} = require('../../api-util/lineItemHelpers');
const { CREATED_BY_MERCHANT, getPromoCodeDiscount } = require('../promoCodes');

const { Money } = types;

/**
 * Provider commission for a booking or order.
 *
 * The marketplace-wide commission comes from the hosted commission asset (Console). An operator
 * can give a provider their own commission percentage in the provider's user metadata
 * (profile.metadata.providerCommission, e.g. 10 for 10%): it overrides the marketplace-wide
 * percentage for that provider's listings. Only operators can set user metadata (Console or
 * Integration API), so users can't change it themselves.
 *
 * Listing prices include GST (what customers see and pay). The provider commission is taken from
 * the amount before GST: e.g. a $50 listing is $45.87 before 9% GST, and a 10% commission is
 * $4.59, so the provider is paid $45.41.
 *
 * Promo codes (see server/services/promoCodes) add a discount line item:
 *  - A merchant's code lowers the price for the customer and the provider's payout. The commission
 *    is taken from the amount before GST, net of the discount: $50 with 10% off is $45, which is
 *    $41.28 before GST, so a 10% commission is $4.13 and the provider is paid $40.87.
 *  - An admin's (marketplace-wide) code is paid by the marketplace: only the customer's price is
 *    lowered, at most by the marketplace's commission, so the provider's payout doesn't change.
 */

// GST included in listing prices (Singapore: 9%). Can be changed with the GST_PERCENTAGE env var.
const DEFAULT_GST_PERCENTAGE = 9;
const getGstPercentage = () => {
  const value = Number(process.env.GST_PERCENTAGE);
  return process.env.GST_PERCENTAGE != null && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_GST_PERCENTAGE;
};

/**
 * The amount without GST, in minor units (rounded to the nearest).
 *
 * @param {number} amount Amount including GST, in minor units
 * @param {number} [gstPercentage]
 * @returns {number}
 */
const getAmountBeforeGst = (amount, gstPercentage = getGstPercentage()) =>
  Math.round((amount * 100) / (100 + gstPercentage));

/**
 * The provider's own commission percentage, or null if they don't have one.
 *
 * @param {Object} [provider] User entity (attributes.profile.metadata)
 * @returns {number|null}
 */
const getProviderCommissionOverride = provider => {
  const value = provider?.attributes?.profile?.metadata?.providerCommission;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
};

/**
 * The provider commission to use: the marketplace-wide one, with the provider's own percentage
 * if they have one. The other settings of the marketplace-wide commission (e.g. minimum_amount)
 * stay the same.
 *
 * @param {Object} [marketplaceCommission] providerCommission of the commission asset
 * @param {Object} [provider] User entity of the provider
 * @returns {Object|undefined}
 */
const getProviderCommission = (marketplaceCommission, provider) => {
  const percentage = getProviderCommissionOverride(provider);
  return percentage == null ? marketplaceCommission : { ...marketplaceCommission, percentage };
};

/**
 * Included entity of a relationship (e.g. the listing's author) from an SDK response.
 *
 * @param {Object} responseData SDK response data: { data, included }
 * @param {string} relationship E.g. 'author' or 'provider'
 * @returns {Object|null}
 */
const getIncludedRelationship = (responseData, relationship) => {
  const ref = responseData?.data?.relationships?.[relationship]?.data;
  const included = responseData?.included || [];
  return ref ? included.find(i => i.type === ref.type && i.id.uuid === ref.id.uuid) || null : null;
};

const PROVIDER_COMMISSION = 'line-item/provider-commission';
const CUSTOMER_COMMISSION = 'line-item/customer-commission';
const PROMO_DISCOUNT = 'line-item/promo-discount';
const LOYALTY_CREDIT = 'line-item/loyalty-credit';

const isCommission = item => [PROVIDER_COMMISSION, CUSTOMER_COMMISSION].includes(item.code);
const isOrderItem = item =>
  !isCommission(item) &&
  item.includeFor.includes('customer') &&
  item.includeFor.includes('provider');

/**
 * The provider commission line item, taken from the amount before GST. The template's line item
 * uses the order total (with GST) as the base of the percentage: the base is replaced. If the
 * marketplace has a minimum commission that is more than the commission from the percentage, the
 * minimum is used instead (like the template does).
 *
 * @param {Object} item Provider commission line item from transactionLineItems
 * @param {Object} [commission] The provider commission used (percentage, minimum_amount)
 * @param {number} [baseAmount] The amount (with GST) the commission is taken from, if not the
 * line item's (e.g. the order total net of a merchant's discount)
 * @returns {Object} Line item
 */
const getCommissionBeforeGst = (item, commission, baseAmount) => {
  // A minimum commission is used already: it's more than the percentage of the total with GST,
  // so it's also more than the percentage of the amount before GST
  if (item.percentage == null) {
    return item;
  }
  const { currency } = item.unitPrice;
  const base = getAmountBeforeGst(baseAmount != null ? baseAmount : item.unitPrice.amount);
  const commissionFromPercentage = (base * Math.abs(item.percentage)) / 100;
  const minimum = commission?.minimum_amount;
  return minimum > commissionFromPercentage
    ? {
        code: PROVIDER_COMMISSION,
        unitPrice: new Money(minimum, currency),
        quantity: -1,
        includeFor: ['provider'],
      }
    : { ...item, unitPrice: new Money(base, currency) };
};

/**
 * Line items of a booking or order: the template's line items, with the provider's own
 * commission percentage (if any) taken from the amount before GST, and the promo code's
 * discount (if any).
 *
 * @param {Object} params
 * @param {Object} params.listing
 * @param {Object} params.orderData
 * @param {Object} [params.providerCommission] Marketplace-wide provider commission (Console)
 * @param {Object} [params.customerCommission] Marketplace-wide customer commission (Console)
 * @param {Object} [params.provider] User entity of the provider (for their own percentage)
 * @param {Object} [params.promoCode] Promo code from findPromoCodeForBooking
 * @param {number} [params.loyaltyCredits] The customer's credit balance to use (minor units)
 * @returns {Array<Object>}
 */
const getTransactionLineItems = ({
  listing,
  orderData,
  providerCommission,
  customerCommission,
  provider,
  promoCode,
  loyaltyCredits = 0,
}) => {
  const commission = getProviderCommission(providerCommission, provider);
  const lineItems = transactionLineItems(listing, orderData, commission, customerCommission);
  const orderTotal = calculateTotalFromLineItems(lineItems.filter(isOrderItem));
  const discount = promoCode ? getPromoCodeDiscount(promoCode, orderTotal) : 0;
  const isMerchantDiscount = promoCode?.createdBy === CREATED_BY_MERCHANT;

  // A merchant's discount lowers the amount the commission is taken from
  const commissionBase = isMerchantDiscount ? orderTotal.amount - discount : undefined;
  const withCommission = lineItems.map(item =>
    item.code === PROVIDER_COMMISSION
      ? getCommissionBeforeGst(item, commission, commissionBase)
      : item
  );
  // An admin's discount is paid from the marketplace's commission: at most the commission
  const marketplaceCommission = withCommission
    .filter(isCommission)
    .reduce((sum, item) => sum + Math.abs(calculateLineTotal(item).amount), 0);
  const discountAmount = !discount
    ? 0
    : isMerchantDiscount
    ? discount
    : Math.min(discount, marketplaceCommission);
  const discountItemMaybe =
    discountAmount > 0
      ? [
          {
            code: PROMO_DISCOUNT,
            unitPrice: new Money(-discountAmount, orderTotal.currency),
            quantity: 1,
            includeFor: isMerchantDiscount ? ['customer', 'provider'] : ['customer'],
          },
        ]
      : [];

  // Loyalty credits are paid from the marketplace's commission too (what's left of it after an
  // admin's discount), and are at most the booking's price after discounts
  const commissionLeft = marketplaceCommission - (isMerchantDiscount ? 0 : discountAmount);
  const creditsAmount = Math.max(
    0,
    Math.min(Math.floor(loyaltyCredits || 0), orderTotal.amount - discountAmount, commissionLeft)
  );
  const creditsItemMaybe =
    creditsAmount > 0
      ? [
          {
            code: LOYALTY_CREDIT,
            unitPrice: new Money(-creditsAmount, orderTotal.currency),
            quantity: 1,
            includeFor: ['customer'],
          },
        ]
      : [];

  // After the order's line items, before the commissions
  const firstCommissionIndex = withCommission.findIndex(isCommission);
  const insertAt = firstCommissionIndex === -1 ? withCommission.length : firstCommissionIndex;
  return [
    ...withCommission.slice(0, insertAt),
    ...discountItemMaybe,
    ...creditsItemMaybe,
    ...withCommission.slice(insertAt),
  ];
};

module.exports = {
  LOYALTY_CREDIT,
  PROMO_DISCOUNT,
  getAmountBeforeGst,
  getIncludedRelationship,
  getTransactionLineItems,
  getProviderCommission,
  getProviderCommissionOverride,
};
