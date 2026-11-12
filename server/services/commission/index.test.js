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
  const lineItemsWith = (promoCode, providerCommission = { percentage: 10 }, loyaltyCredits = 0) =>
    constructValidLineItems(
      getTransactionLineItems({
        listing,
        orderData: { stockReservationQuantity: 1 },
        providerCommission,
        promoCode,
        loyaltyCredits,
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

  const { getPaymentPlan } = require('./index');
  const FUNDED = 'line-item/platform-funded';

  it("pays an admin's discount from Pastime: the provider is still paid in full", () => {
    const lineItems = lineItemsWith({
      createdBy: 'admin',
      discountType: 'fixed',
      amount: 1000,
      currency: 'SGD',
    });
    // $10 off $50: the customer pays $40, the provider's payout is $45.41 ($4.59 commission)
    expect(lineTotal(lineItems, 'line-item/promo-discount')).toBe(-1000);
    expect(totalFor(lineItems, 'customer')).toBe(4000);
    // Sharetribe can't pay out more than the customer pays: Pastime pays the other $5.41
    expect(totalFor(lineItems, 'provider')).toBe(4000);
    expect(lineTotal(lineItems, FUNDED)).toBe(-541);
    expect(getPaymentPlan(lineItems)).toEqual({
      type: 'platform-paid',
      payinTotal: 4000,
      platformFunded: 541,
      providerPayout: 4541,
    });
  });

  it("doesn't need Pastime's money while the discount is within the commission", () => {
    const lineItems = lineItemsWith({
      createdBy: 'admin',
      discountType: 'fixed',
      amount: 300,
      currency: 'SGD',
    });
    expect(totalFor(lineItems, 'customer')).toBe(4700);
    expect(totalFor(lineItems, 'provider')).toBe(4541);
    expect(lineTotal(lineItems, FUNDED)).toBeUndefined();
    expect(getPaymentPlan(lineItems).type).toBe('standard');
  });

  it('makes the booking free with a 100% admin code, paid to the provider by Pastime', () => {
    const lineItems = lineItemsWith({
      createdBy: 'admin',
      discountType: 'percentage',
      percentage: 100,
    });
    expect(totalFor(lineItems, 'customer')).toBe(0);
    expect(totalFor(lineItems, 'provider')).toBe(0);
    expect(getPaymentPlan(lineItems)).toEqual({
      type: 'free',
      payinTotal: 0,
      platformFunded: 4541,
      providerPayout: 4541,
    });
  });

  it('pays nothing to the provider for their own 100% code', () => {
    const lineItems = lineItemsWith(
      { createdBy: 'merchant', discountType: 'percentage', percentage: 100 },
      { percentage: 10, minimum_amount: 100 }
    );
    expect(totalFor(lineItems, 'customer')).toBe(0);
    // The minimum commission can't make the payout negative
    expect(totalFor(lineItems, 'provider')).toBe(0);
    expect(getPaymentPlan(lineItems)).toEqual({
      type: 'free',
      payinTotal: 0,
      platformFunded: 0,
      providerPayout: 0,
    });
  });

  it("covers less than Stripe's S$0.50 minimum charge, making the booking free", () => {
    // $49.70 off: 30 cents would be left to pay
    const lineItems = lineItemsWith({
      createdBy: 'admin',
      discountType: 'fixed',
      amount: 4970,
      currency: 'SGD',
    });
    expect(lineTotal(lineItems, 'line-item/platform-covered')).toBe(-30);
    expect(totalFor(lineItems, 'customer')).toBe(0);
    expect(getPaymentPlan(lineItems).type).toBe('free');
    expect(getPaymentPlan(lineItems).providerPayout).toBe(4541);
  });

  it('charges exactly the minimum of S$0.50', () => {
    const lineItems = lineItemsWith({
      createdBy: 'admin',
      discountType: 'fixed',
      amount: 4950,
      currency: 'SGD',
    });
    expect(lineTotal(lineItems, 'line-item/platform-covered')).toBeUndefined();
    expect(totalFor(lineItems, 'customer')).toBe(50);
    expect(getPaymentPlan(lineItems)).toEqual({
      type: 'platform-paid',
      payinTotal: 50,
      platformFunded: 4491,
      providerPayout: 4541,
    });
  });

  describe('loyalty credits', () => {
    const merchantCode = { createdBy: 'merchant', discountType: 'percentage', percentage: 10 };
    const adminCode = { createdBy: 'admin', discountType: 'percentage', percentage: 5 };

    it('are paid by Pastime, up to the whole price', () => {
      // $20 of credits on $50: the customer pays $30, the provider still gets $45.41
      const lineItems = lineItemsWith(null, undefined, 2000);
      expect(lineTotal(lineItems, 'line-item/loyalty-credit')).toBe(-2000);
      expect(totalFor(lineItems, 'customer')).toBe(3000);
      expect(getPaymentPlan(lineItems)).toEqual({
        type: 'platform-paid',
        payinTotal: 3000,
        platformFunded: 1541,
        providerPayout: 4541,
      });
    });

    it('use only the balance when it is lower', () => {
      const lineItems = lineItemsWith(null, undefined, 200);
      expect(lineTotal(lineItems, 'line-item/loyalty-credit')).toBe(-200);
      expect(totalFor(lineItems, 'customer')).toBe(4800);
      expect(getPaymentPlan(lineItems).type).toBe('standard');
    });

    it('use at most the price: a larger balance makes the booking free', () => {
      const lineItems = lineItemsWith(null, undefined, 10000);
      expect(lineTotal(lineItems, 'line-item/loyalty-credit')).toBe(-5000);
      expect(getPaymentPlan(lineItems)).toEqual({
        type: 'free',
        payinTotal: 0,
        platformFunded: 4541,
        providerPayout: 4541,
      });
    });

    it("come on top of a merchant's discount; the provider gets the discounted payout", () => {
      // $45 after 10% off: commission $4.13, provider $40.87
      const lineItems = lineItemsWith(merchantCode, undefined, 1000);
      expect(lineTotal(lineItems, 'line-item/loyalty-credit')).toBe(-1000);
      expect(totalFor(lineItems, 'customer')).toBe(3500);
      expect(getPaymentPlan(lineItems).providerPayout).toBe(4087);
      expect(getPaymentPlan(lineItems).platformFunded).toBe(587);
    });

    it("add up with an admin's discount", () => {
      // 5% ($2.50) and $10 of credits: the customer pays $37.50
      const lineItems = lineItemsWith(adminCode, undefined, 1000);
      expect(lineTotal(lineItems, 'line-item/promo-discount')).toBe(-250);
      expect(lineTotal(lineItems, 'line-item/loyalty-credit')).toBe(-1000);
      expect(getPaymentPlan(lineItems)).toEqual({
        type: 'platform-paid',
        payinTotal: 3750,
        platformFunded: 791,
        providerPayout: 4541,
      });
    });
  });
});

describe('booking request process', () => {
  const { types } = require('sharetribe-flex-sdk');
  const { getBookingRequestForLineItems, getTransactionLineItems } = require('./index');
  const listing = {
    attributes: { price: new types.Money(5000, 'SGD'), publicData: { unitType: 'item' } },
  };
  const lineItemsWith = loyaltyCredits =>
    getTransactionLineItems({
      listing,
      orderData: { stockReservationQuantity: 1 },
      providerCommission: { percentage: 10 },
      loyaltyCredits,
    });
  const requestFor = (lineItems, processName = 'default-booking/release-1') =>
    getBookingRequestForLineItems({
      processName,
      transitionName: 'transition/request-payment',
      lineItems,
    });

  it('keeps the default booking process when the payment covers the payout', () => {
    expect(requestFor(lineItemsWith(0))).toEqual({
      processAlias: 'default-booking/release-1',
      transition: 'transition/request-payment',
      paymentType: 'standard',
    });
  });

  it('uses the platform-paid process when Pastime pays part of the payout', () => {
    expect(requestFor(lineItemsWith(2000))).toEqual({
      processAlias: 'booking-platform-paid/release-1',
      transition: 'transition/request-payment',
      paymentType: 'platform-paid',
    });
  });

  it('uses the free process, without a payment, when nothing is left to pay', () => {
    expect(requestFor(lineItemsWith(5000))).toEqual({
      processAlias: 'booking-free/release-1',
      transition: 'transition/request',
      paymentType: 'free',
    });
  });

  it("doesn't change other processes or transitions", () => {
    expect(requestFor(lineItemsWith(5000), 'default-purchase/release-1')).toBe(null);
    expect(
      getBookingRequestForLineItems({
        processName: 'default-booking/release-1',
        transitionName: 'transition/inquire',
        lineItems: lineItemsWith(5000),
      })
    ).toBe(null);
  });
});
