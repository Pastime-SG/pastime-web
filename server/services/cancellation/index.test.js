const {
  getApplicableRule,
  getBookingAmounts,
  getCancelTransition,
  getCancellationAmounts,
  getPaymentDetails,
} = require('./index');

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-11-01T10:00:00.000Z');

const money = amount => ({ amount, currency: 'SGD' });

// $100 booking, 10% provider commission, 5% customer commission: the customer paid $105
const lineItems = [
  {
    code: 'line-item/fixed',
    includeFor: ['customer', 'provider'],
    lineTotal: money(10000),
    reversal: false,
  },
  {
    code: 'line-item/provider-commission',
    includeFor: ['provider'],
    lineTotal: money(-1000),
    reversal: false,
  },
  {
    code: 'line-item/customer-commission',
    includeFor: ['customer'],
    lineTotal: money(500),
    reversal: false,
  },
];

const policies = {
  cancellation: {
    rules: [
      { heading: 'Full', comparison: 'moreThan', amount: 48, unit: 'hours', refundPercentage: 100 },
      { heading: 'Half', comparison: 'moreThan', amount: 24, unit: 'hours', refundPercentage: 50 },
      { heading: 'None', comparison: 'lessThan', amount: 24, unit: 'hours', refundPercentage: 0 },
    ],
  },
};

describe('cancellation', () => {
  describe('getCancelTransition', () => {
    it('picks the transition by the stage and whether there is a refund', () => {
      expect(getCancelTransition('transition/accept', true)).toBe('transition/customer-cancel');
      expect(getCancelTransition('transition/accept', false)).toBe(
        'transition/customer-cancel-no-refund'
      );
      expect(getCancelTransition('transition/request-reschedule-by-provider', true)).toBe(
        'transition/customer-cancel-reschedule-requested-by-provider'
      );
      expect(getCancelTransition('transition/confirm-payment', true)).toBe(null);
    });
  });

  describe('getApplicableRule', () => {
    const at = hours => new Date(NOW.getTime() + hours * HOUR_MS);

    it('uses the policies copied to the booking', () => {
      const protectedData = { policies };
      expect(getApplicableRule({ protectedData, bookingStart: at(72), now: NOW }).heading).toBe(
        'Full'
      );
      expect(getApplicableRule({ protectedData, bookingStart: at(30), now: NOW }).heading).toBe(
        'Half'
      );
      expect(getApplicableRule({ protectedData, bookingStart: at(2), now: NOW }).heading).toBe(
        'None'
      );
    });

    it("can't cancel without policies or after the start", () => {
      expect(getApplicableRule({ protectedData: {}, bookingStart: at(72), now: NOW })).toBe(null);
      expect(
        getApplicableRule({ protectedData: { policies }, bookingStart: at(-1), now: NOW })
      ).toBe(null);
    });
  });

  describe('getCancellationAmounts', () => {
    const bookingAmounts = getBookingAmounts(lineItems);
    const params = { bookingAmounts, paid: 10500, stripeFee: 335 };

    it('reads the price and commissions from the line items', () => {
      expect(bookingAmounts).toEqual({
        price: 10000,
        providerCommission: 1000,
        customerCommission: 500,
      });
    });

    it('refunds everything but the Stripe fee with a 100% rule', () => {
      expect(getCancellationAmounts({ ...params, refundPercentage: 100 })).toEqual({
        retainedPrice: 0,
        providerPayout: 0,
        platformCommission: 0,
        refund: 10165,
      });
    });

    it('applies the commissions to the part that is not refunded', () => {
      // $50 retained: provider gets $45, platform keeps $5 + $2.50
      expect(getCancellationAmounts({ ...params, refundPercentage: 50 })).toEqual({
        retainedPrice: 5000,
        providerPayout: 4500,
        platformCommission: 750,
        refund: 10500 - 5000 - 250 - 335,
      });
    });

    it('leaves the platform with exactly its commission', () => {
      // Destination charge: the platform gets the application fee, pays the Stripe fee, takes
      // back the reversal and pays the refund
      const amounts = getCancellationAmounts({ ...params, refundPercentage: 50 });
      const applicationFee = 1500;
      const providerShare = 10500 - applicationFee;
      const reversal = providerShare - amounts.providerPayout;
      const platformNet = applicationFee - 335 + reversal - amounts.refund;
      expect(platformNet).toBe(amounts.platformCommission);
    });
  });

  describe('getPaymentDetails', () => {
    it('needs a captured payment with a transfer', () => {
      expect(() => getPaymentDetails({ latest_charge: { captured: false } })).toThrow();
      const details = getPaymentDetails({
        latest_charge: {
          captured: true,
          amount: 10500,
          currency: 'sgd',
          application_fee_amount: 1500,
          amount_refunded: 0,
          balance_transaction: { fee: 335, currency: 'sgd' },
          transfer: {
            id: 'tr_1',
            amount: 10500,
            amount_reversed: 0,
            destination: 'acct_1',
            destination_payment: 'py_1',
          },
        },
      });
      expect(details).toMatchObject({
        paid: 10500,
        stripeFee: 335,
        providerShare: 9000,
        accountId: 'acct_1',
        destinationPaymentId: 'py_1',
      });
    });
  });
});
