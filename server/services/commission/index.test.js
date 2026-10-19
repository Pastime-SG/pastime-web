const { transactionLineItems } = require('../../api-util/lineItems');
const {
  getIncludedRelationship,
  getProviderCommission,
  getProviderCommissionOverride,
} = require('./index');

const providerWith = metadata => ({
  id: { uuid: 'provider-1' },
  type: 'user',
  attributes: { profile: { metadata } },
});

const marketplaceCommission = { percentage: 15, minimum_amount: 100 };

describe('provider commission', () => {
  it("uses the provider's own percentage from their metadata", () => {
    expect(
      getProviderCommission(marketplaceCommission, providerWith({ providerCommission: 8 }))
    ).toEqual({ percentage: 8, minimum_amount: 100 });
    // 0% is a valid commission
    expect(getProviderCommissionOverride(providerWith({ providerCommission: 0 }))).toBe(0);
  });

  it('keeps the marketplace commission without a valid override', () => {
    [undefined, {}, { providerCommission: '8' }, { providerCommission: 120 }].forEach(metadata =>
      expect(getProviderCommission(marketplaceCommission, providerWith(metadata))).toBe(
        marketplaceCommission
      )
    );
    expect(getProviderCommission(marketplaceCommission, null)).toBe(marketplaceCommission);
  });

  it('applies the override even without a marketplace commission', () => {
    expect(getProviderCommission(undefined, providerWith({ providerCommission: 5 }))).toEqual({
      percentage: 5,
    });
  });

  it('finds the included relationship of a response', () => {
    const provider = providerWith({ providerCommission: 8 });
    const responseData = {
      data: { relationships: { provider: { data: { id: { uuid: 'provider-1' }, type: 'user' } } } },
      included: [{ id: { uuid: 'listing-1' }, type: 'listing' }, provider],
    };
    expect(getIncludedRelationship(responseData, 'provider')).toBe(provider);
    expect(getIncludedRelationship(responseData, 'author')).toBe(null);
  });

  it("changes the provider commission line item of the provider's bookings", () => {
    const { Money } = require('sharetribe-flex-sdk').types;
    const listing = {
      attributes: {
        price: new Money(10000, 'SGD'),
        publicData: { unitType: 'item' },
      },
    };
    const lineItems = transactionLineItems(
      listing,
      { stockReservationQuantity: 1 },
      getProviderCommission({ percentage: 15 }, providerWith({ providerCommission: 8 })),
      undefined
    );
    const commission = lineItems.find(item => item.code === 'line-item/provider-commission');
    expect(commission.percentage).toBe(-8);
  });
});
