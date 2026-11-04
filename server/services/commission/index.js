const { types } = require('sharetribe-flex-sdk');
const { transactionLineItems } = require('../../api-util/lineItems');
const {
  calculateTotalFromLineItems,
  constructValidLineItems,
} = require('../../api-util/lineItemHelpers');
const { CREATED_BY_MERCHANT, getPromoCodeDiscount } = require('../promoCodes');
const { getBookingRequest, isBookingProcess } = require('../bookingData');

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
 *    lowered (up to the whole price), and the provider is still paid in full.
 *
 * Loyalty credits are paid by the marketplace too. When an admin's discount and credits are more
 * than the commission, Pastime pays the rest of the provider's payout from its Stripe balance
 * (line item PLATFORM_FUNDED, see getPaymentPlan and server/services/platformPayouts).
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
// Customer: a remainder below Stripe's minimum charge, covered by Pastime
const PLATFORM_COVERED = 'line-item/platform-covered';
// Provider: the part of the provider's payout that Pastime pays (not shown to providers)
const PLATFORM_FUNDED = 'line-item/platform-funded';

// Stripe's minimum charge amounts (minor units) for the currencies Pastime could use
// (https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts)
const MINIMUM_CHARGES = { SGD: 50, USD: 50, EUR: 50, AUD: 50, GBP: 30, MYR: 200, HKD: 400 };
const getMinimumCharge = currency => MINIMUM_CHARGES[currency] || 50;

const discountLineItem = (amount, currency, isMerchantDiscount) => ({
  code: PROMO_DISCOUNT,
  unitPrice: new Money(-amount, currency),
  quantity: 1,
  includeFor: isMerchantDiscount ? ['customer', 'provider'] : ['customer'],
});

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
  // (at most the amount it's taken from, e.g. 0 after a merchant's 100% discount)
  if (item.percentage == null) {
    const maximum = baseAmount != null ? Math.max(baseAmount, 0) : item.unitPrice.amount;
    return item.unitPrice.amount > maximum
      ? { ...item, unitPrice: new Money(maximum, item.unitPrice.currency) }
      : item;
  }
  const { currency } = item.unitPrice;
  const base = getAmountBeforeGst(baseAmount != null ? baseAmount : item.unitPrice.amount);
  const commissionFromPercentage = (base * Math.abs(item.percentage)) / 100;
  // The minimum commission is at most the amount it's taken from (e.g. 0 after a 100% discount)
  const minimum = Math.min(
    commission?.minimum_amount || 0,
    baseAmount != null ? baseAmount : item.unitPrice.amount
  );
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
  const currency = orderTotal.currency;
  // What the customer pays before discounts and credits (the order, plus any customer commission)
  const customerTotal = calculateTotalFromLineItems(
    withCommission.filter(item => item.includeFor.includes('customer'))
  ).amount;
  // A discount is at most the price
  const discountAmount = Math.min(discount, customerTotal);
  const customerAfterDiscount = customerTotal - discountAmount;
  const discountItems =
    discountAmount > 0 ? [discountLineItem(discountAmount, currency, isMerchantDiscount)] : [];

  // Loyalty credits: at most what's left to pay
  const creditsAmount = Math.max(
    0,
    Math.min(Math.floor(loyaltyCredits || 0), customerAfterDiscount)
  );
  const creditsItemMaybe =
    creditsAmount > 0
      ? [
          {
            code: LOYALTY_CREDIT,
            unitPrice: new Money(-creditsAmount, currency),
            quantity: 1,
            includeFor: ['customer'],
          },
        ]
      : [];

  // Stripe can't charge less than its minimum (S$0.50): a smaller amount left to pay is covered by
  // Pastime, and the booking is free
  const leftToPay = customerAfterDiscount - creditsAmount;
  const coveredAmount = leftToPay > 0 && leftToPay < getMinimumCharge(currency) ? leftToPay : 0;
  const coveredItemMaybe =
    coveredAmount > 0
      ? [
          {
            code: PLATFORM_COVERED,
            unitPrice: new Money(-coveredAmount, currency),
            quantity: 1,
            includeFor: ['customer'],
          },
        ]
      : [];

  // After the order's line items, before the commissions
  const firstCommissionIndex = withCommission.findIndex(isCommission);
  const insertAt = firstCommissionIndex === -1 ? withCommission.length : firstCommissionIndex;
  const allLineItems = [
    ...withCommission.slice(0, insertAt),
    ...discountItems,
    ...creditsItemMaybe,
    ...coveredItemMaybe,
    ...withCommission.slice(insertAt),
  ];

  // Credits, an admin's discount and the covered amount are paid by Pastime: the provider is
  // paid in full. Sharetribe can't pay the provider more than the customer pays, so the part
  // paid by Pastime is taken out of the Sharetribe payout, and Pastime's server pays it to the
  // provider together with the rest (see server/services/platformPayouts).
  const payin = calculateTotalFromLineItems(
    allLineItems.filter(item => item.includeFor.includes('customer'))
  ).amount;
  const payout = calculateTotalFromLineItems(
    allLineItems.filter(item => item.includeFor.includes('provider'))
  ).amount;
  const platformFunded = payout - Math.max(payin, 0);
  return platformFunded > 0
    ? [
        ...allLineItems,
        {
          code: PLATFORM_FUNDED,
          unitPrice: new Money(-platformFunded, currency),
          quantity: 1,
          includeFor: ['provider'],
        },
      ]
    : allLineItems;
};

/**
 * How a booking is paid, from its line items:
 *  - 'free': the customer pays nothing (no Stripe payment)
 *  - 'platform-paid': Pastime pays part of the provider's payout
 *  - 'standard': the customer's payment covers the payout
 *
 * @param {Array<Object>} lineItems
 * @returns {{type: string, payinTotal: number, platformFunded: number, providerPayout: number}}
 */
const getPaymentPlan = lineItems => {
  // A transaction's line items have their totals already (refund reversals left out); new ones
  // from getTransactionLineItems don't
  const active = (lineItems || []).filter(item => !item.reversal);
  const items = active.every(item => item.lineTotal) ? active : constructValidLineItems(active);
  const sum = role =>
    items.filter(i => i.includeFor.includes(role)).reduce((t, i) => t + i.lineTotal.amount, 0);
  const funded = items.find(i => i.code === PLATFORM_FUNDED);
  const platformFunded = funded ? Math.abs(funded.lineTotal.amount) : 0;
  const payinTotal = sum('customer');
  return {
    type: payinTotal === 0 ? 'free' : platformFunded > 0 ? 'platform-paid' : 'standard',
    payinTotal,
    platformFunded,
    providerPayout: sum('provider') + platformFunded,
  };
};

/**
 * The provider's whole payout for the provider's emails, for bookings paid out by Pastime (in
 * major units, e.g. 45.41, like the money in Sharetribe's email templates).
 *
 * @param {Array<Object>} lineItems
 * @returns {Object} { providerPayout: { amount, currency } } or {}
 */
const getProviderPayoutProtectedData = lineItems => {
  const plan = getPaymentPlan(lineItems);
  const currency = (lineItems || [])[0]?.unitPrice?.currency;
  return plan.type === 'standard' || !currency
    ? {}
    : { providerPayout: { amount: plan.providerPayout / 100, currency } };
};

// The booking request transitions the client can send (the server picks the final one)
const CLIENT_BOOKING_REQUESTS = [
  'transition/request-payment',
  'transition/request-payment-after-inquiry',
];

/**
 * The process alias and transition of a booking request, by how it's paid: the server decides
 * them from the line items, never the client. Other transactions are left as they are.
 *
 * @param {Object} params
 * @param {string} params.processName The client's process alias (or the transaction's process)
 * @param {string} params.transitionName The client's transition
 * @param {Array<Object>} params.lineItems
 * @returns {{processAlias: string, transition: string, paymentType: string}|null} null if not a
 * booking request
 */
const getBookingRequestForLineItems = ({ processName, transitionName, lineItems }) => {
  if (!isBookingProcess(processName) || !CLIENT_BOOKING_REQUESTS.includes(transitionName)) {
    return null;
  }
  const paymentType = getPaymentPlan(lineItems).type;
  return { ...getBookingRequest(paymentType), paymentType };
};

module.exports = {
  LOYALTY_CREDIT,
  getBookingRequestForLineItems,
  getProviderPayoutProtectedData,
  PLATFORM_COVERED,
  PLATFORM_FUNDED,
  getMinimumCharge,
  getPaymentPlan,
  PROMO_DISCOUNT,
  getAmountBeforeGst,
  getIncludedRelationship,
  getTransactionLineItems,
  getProviderCommission,
  getProviderCommissionOverride,
};
