const { types } = require('sharetribe-flex-sdk');
const { transactionLineItems } = require('../../api-util/lineItems');

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

/**
 * The provider commission line item, taken from the amount before GST. The template's line item
 * uses the order total (with GST) as the base of the percentage: the base is replaced. If the
 * marketplace has a minimum commission that is more than the commission from the percentage, the
 * minimum is used instead (like the template does).
 *
 * @param {Object} item Provider commission line item from transactionLineItems
 * @param {Object} [commission] The provider commission used (percentage, minimum_amount)
 * @returns {Object} Line item
 */
const getCommissionBeforeGst = (item, commission) => {
  // A minimum commission is used already: it's more than the percentage of the total with GST,
  // so it's also more than the percentage of the amount before GST
  if (item.percentage == null) {
    return item;
  }
  const { currency } = item.unitPrice;
  const base = getAmountBeforeGst(item.unitPrice.amount);
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
 * commission percentage (if any) taken from the amount before GST.
 *
 * @param {Object} params
 * @param {Object} params.listing
 * @param {Object} params.orderData
 * @param {Object} [params.providerCommission] Marketplace-wide provider commission (Console)
 * @param {Object} [params.customerCommission] Marketplace-wide customer commission (Console)
 * @param {Object} [params.provider] User entity of the provider (for their own percentage)
 * @returns {Array<Object>}
 */
const getTransactionLineItems = ({
  listing,
  orderData,
  providerCommission,
  customerCommission,
  provider,
}) => {
  const commission = getProviderCommission(providerCommission, provider);
  return transactionLineItems(listing, orderData, commission, customerCommission).map(item =>
    item.code === PROVIDER_COMMISSION ? getCommissionBeforeGst(item, commission) : item
  );
};

module.exports = {
  getAmountBeforeGst,
  getIncludedRelationship,
  getTransactionLineItems,
  getProviderCommission,
  getProviderCommissionOverride,
};
