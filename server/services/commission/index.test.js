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

describe('commission before GST', () => {
  const { types } = require('sharetribe-flex-sdk');
  const { constructValidLineItems } = require('../../api-util/lineItemHelpers');
  const { getAmountBeforeGst, getTransactionLineItems } = require('./index');

  // A $50 listing (GST included), sold as one item
  const listing = {
    attributes: {
      price: new types.Money(5000, 'SGD'),
      publicData: { unitType: 'item' },
    },
  };
  const lineItemsWith = (providerCommission, provider) =>
    constructValidLineItems(
      getTransactionLineItems({
        listing,
        orderData: { stockReservationQuantity: 1 },
        providerCommission,
        provider,
      })
    );
  const commissionOf = lineItems =>
    lineItems.find(item => item.code === 'line-item/provider-commission').lineTotal.amount;

  it('takes the amount before 9% GST', () => {
    expect(getAmountBeforeGst(5000)).toBe(4587);
  });

  it('takes the commission from the amount before GST: $50 at 10% is $4.59', () => {
    const lineItems = lineItemsWith({ percentage: 10 });
    expect(commissionOf(lineItems)).toBe(-459);
    // The customer still pays the listed price
    const order = lineItems.find(item => item.code === 'line-item/item');
    expect(order.lineTotal.amount).toBe(5000);
  });

  it("uses the provider's own percentage", () => {
    expect(
      commissionOf(lineItemsWith({ percentage: 10 }, providerWith({ providerCommission: 20 })))
    ).toBe(-917);
  });

  it('uses the minimum commission when it is more', () => {
    // 1% of $45.87 is $0.46: the $0.47 minimum applies (1% of $50 would be $0.50)
    expect(commissionOf(lineItemsWith({ percentage: 1, minimum_amount: 47 }))).toBe(-47);
  });
});

describe('promo code discounts', () => {
  const { types } = require('sharetribe-flex-sdk');
  const { constructValidLineItems } = require('../../api-util/lineItemHelpers');
  const { getTransactionLineItems } = require('./index');

  const listing = {
    attributes: { price: new types.Money(5000, 'SGD'), publicData: { unitType: 'item' } },
  };
  const lineItemsWith = (promoCode, providerCommission = { percentage: 10 }) =>
    constructValidLineItems(
      getTransactionLineItems({
        listing,
        orderData: { stockReservationQuantity: 1 },
        providerCommission,
        promoCode,
      })
    );
  const totalFor = (lineItems, role) =>
    lineItems
      .filter(item => item.includeFor.includes(role))
      .reduce((sum, item) => sum + item.lineTotal.amount, 0);
  const lineTotal = (lineItems, code) => lineItems.find(i => i.code === code)?.lineTotal.amount;

  it("takes a merchant's discount from the price and the payout, commission from the net pre-GST amount", () => {
    // $50, 10% off: $45, $41.28 before GST, 10% commission $4.13, merchant gets $40.87
    const lineItems = lineItemsWith({
      createdBy: 'merchant',
      discountType: 'percentage',
      percentage: 10,
    });
    expect(lineTotal(lineItems, 'line-item/promo-discount')).toBe(-500);
    expect(lineTotal(lineItems, 'line-item/provider-commission')).toBe(-413);
    expect(totalFor(lineItems, 'customer')).toBe(4500);
    expect(totalFor(lineItems, 'provider')).toBe(4087);
  });

  it("pays an admin's discount from the marketplace commission, at most the commission", () => {
    const lineItems = lineItemsWith({
      createdBy: 'admin',
      discountType: 'fixed',
      amount: 1000,
      currency: 'SGD',
    });
    // Commission is $4.59 (from $45.87 before GST): the $10 discount is limited to it
    expect(lineTotal(lineItems, 'line-item/promo-discount')).toBe(-459);
    expect(totalFor(lineItems, 'customer')).toBe(4541);
    // The provider's payout doesn't change
    expect(totalFor(lineItems, 'provider')).toBe(4541);
  });

  it("leaves the merchant's payout as without a discount for an admin's percentage code", () => {
    // $50, 10% off from an admin code: the merchant still gets $50 minus 10% of $45.87 = $45.41.
    // The $5 discount is more than the $4.59 commission, so it's limited to the commission.
    const lineItems = lineItemsWith({
      createdBy: 'admin',
      discountType: 'percentage',
      percentage: 10,
    });
    expect(lineTotal(lineItems, 'line-item/provider-commission')).toBe(-459);
    expect(totalFor(lineItems, 'provider')).toBe(4541);
    expect(lineTotal(lineItems, 'line-item/promo-discount')).toBe(-459);
    expect(totalFor(lineItems, 'customer')).toBe(4541);
  });
});
