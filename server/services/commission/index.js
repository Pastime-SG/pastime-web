/**
 * Provider commission for a booking or order.
 *
 * The marketplace-wide commission comes from the hosted commission asset (Console). An operator
 * can give a provider their own commission percentage in the provider's user metadata
 * (profile.metadata.providerCommission, e.g. 10 for 10%): it overrides the marketplace-wide
 * percentage for that provider's listings. Only operators can set user metadata (Console or
 * Integration API), so users can't change it themselves.
 */

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

module.exports = {
  getIncludedRelationship,
  getProviderCommission,
  getProviderCommissionOverride,
};
