const mockSdk = { transactions: { show: jest.fn(), transition: jest.fn() } };
jest.mock('../../api-util/sdk', () => ({
  createCookieTokenStore: () => ({}),
  getSdk: () => mockSdk,
  getTrustedSdk: () => Promise.resolve(mockSdk),
  serialize: data => JSON.stringify(data),
  handleError: (res, e) => res.status(e.status || 500).json({ status: e.status || 500 }),
}));
const mockStripe = {
  createRefund: jest.fn(),
  createTransferReversal: jest.fn(),
  findPaymentIntentsForTransaction: jest.fn(),
  retrievePaymentIntent: jest.fn(),
};
jest.mock('../../services/stripe', () => ({
  createRefund: (...args) => mockStripe.createRefund(...args),
  createTransferReversal: (...args) => mockStripe.createTransferReversal(...args),
  findPaymentIntentsForTransaction: (...args) =>
    mockStripe.findPaymentIntentsForTransaction(...args),
  retrievePaymentIntent: (...args) => mockStripe.retrievePaymentIntent(...args),
}));
const mockPayOutOrSchedule = jest.fn();
jest.mock('../../services/cancellation/payouts', () => ({
  payOutOrSchedule: (...args) => mockPayOutOrSchedule(...args),
}));
jest.mock('../../log', () => ({ error: jest.fn() }));

const cancel = require('./cancel');

const HOUR_MS = 60 * 60 * 1000;
const TX_ID = '6ad5cceb-74d4-4517-9a75-3aff45dc039a';
const CUSTOMER_ID = 'customer-1';
const PROVIDER_ID = 'provider-1';
const money = amount => ({ amount, currency: 'SGD' });

const policies = {
  cancellation: {
    rules: [
      { heading: 'Full', comparison: 'moreThan', amount: 48, unit: 'hours', refundPercentage: 100 },
      { heading: 'Half', comparison: 'moreThan', amount: 24, unit: 'hours', refundPercentage: 50 },
      { heading: 'None', comparison: 'lessThan', amount: 24, unit: 'hours', refundPercentage: 0 },
    ],
  },
};

const txResponse = ({ hoursToStart, protectedData = { policies } }) => {
  const start = new Date(Date.now() + hoursToStart * HOUR_MS);
  return {
    data: {
      data: {
        id: { uuid: TX_ID },
        type: 'transaction',
        attributes: {
          lastTransition: 'transition/accept',
          protectedData,
          payinTotal: money(10500),
          payoutTotal: money(9000),
          lineItems: [
            {
              code: 'line-item/fixed',
              includeFor: ['customer', 'provider'],
              lineTotal: money(10000),
            },
            {
              code: 'line-item/provider-commission',
              includeFor: ['provider'],
              lineTotal: money(-1000),
            },
            {
              code: 'line-item/customer-commission',
              includeFor: ['customer'],
              lineTotal: money(500),
            },
          ],
        },
        relationships: {
          booking: { data: { id: { uuid: 'booking-1' }, type: 'booking' } },
          customer: { data: { id: { uuid: CUSTOMER_ID }, type: 'user' } },
          provider: { data: { id: { uuid: PROVIDER_ID }, type: 'user' } },
        },
      },
      included: [
        {
          id: { uuid: 'booking-1' },
          type: 'booking',
          attributes: { start, end: new Date(start.getTime() + HOUR_MS) },
        },
      ],
    },
  };
};

const paymentIntent = {
  id: 'pi_1',
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
};

const createResponse = () => {
  const res = {};
  ['status', 'json', 'set', 'send', 'end'].forEach(m => (res[m] = jest.fn().mockReturnValue(res)));
  return res;
};

const call = async (userId, action) => {
  const res = createResponse();
  await cancel({ tokenUserId: userId, body: { transactionId: TX_ID, action } }, res);
  return res;
};

describe('POST /api/cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSdk.transactions.transition.mockResolvedValue({ status: 200, data: { data: {} } });
    mockStripe.findPaymentIntentsForTransaction.mockResolvedValue([
      { id: 'pi_1', status: 'succeeded' },
    ]);
    mockStripe.retrievePaymentIntent.mockResolvedValue(paymentIntent);
    mockStripe.createTransferReversal.mockResolvedValue({});
    mockStripe.createRefund.mockResolvedValue({});
    mockPayOutOrSchedule.mockResolvedValue({ status: 'pending', availableOn: new Date() });
  });

  it('previews the refund without cancelling', async () => {
    mockSdk.transactions.show.mockResolvedValue(txResponse({ hoursToStart: 30 }));
    const res = await call(CUSTOMER_ID, 'preview');

    expect(res.json).toHaveBeenCalledWith({
      ruleHeading: 'Half',
      refundPercentage: 50,
      currency: 'SGD',
      paid: 10500,
      stripeFee: 335,
      refund: 4915,
    });
    expect(mockStripe.createRefund).not.toHaveBeenCalled();
    expect(mockSdk.transactions.transition).not.toHaveBeenCalled();
  });

  it('refunds part of the payment and keeps the provider share for the payout', async () => {
    mockSdk.transactions.show.mockResolvedValue(txResponse({ hoursToStart: 30 }));
    const res = await call(CUSTOMER_ID, 'cancel');

    expect(res.status).toHaveBeenCalledWith(200);
    // Provider share 90.00, keeps 45.00
    expect(mockStripe.createTransferReversal).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: 'tr_1', amount: 4500 })
    );
    expect(mockStripe.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: 'pi_1', amount: 4915 })
    );
    expect(mockPayOutOrSchedule).toHaveBeenCalledWith(expect.objectContaining({ amount: 4500 }));
    const [params] = mockSdk.transactions.transition.mock.calls[0];
    expect(params.transition).toBe('transition/customer-cancel');
    expect(params.params.metadata.cancellation).toMatchObject({
      ruleHeading: 'Half',
      refund: 4915,
      providerPayout: 4500,
      payoutStatus: 'pending',
    });
  });

  it('cancels without a refund through the process when the 0% rule applies', async () => {
    mockSdk.transactions.show.mockResolvedValue(txResponse({ hoursToStart: 2 }));
    await call(CUSTOMER_ID, 'cancel');

    expect(mockStripe.findPaymentIntentsForTransaction).not.toHaveBeenCalled();
    const [params] = mockSdk.transactions.transition.mock.calls[0];
    expect(params.transition).toBe('transition/customer-cancel-no-refund');
    expect(params.params.metadata.cancellation).toMatchObject({ refund: 0, providerPayout: 9000 });
  });

  it("doesn't cancel when no rule applies or for the provider", async () => {
    mockSdk.transactions.show.mockResolvedValue(
      txResponse({ hoursToStart: 30, protectedData: {} })
    );
    const res = await call(CUSTOMER_ID, 'cancel');
    expect(res.json).toHaveBeenCalledWith({ status: 403, code: 'not-cancellable' });

    mockSdk.transactions.show.mockResolvedValue(txResponse({ hoursToStart: 30 }));
    const providerRes = await call(PROVIDER_ID, 'cancel');
    expect(providerRes.json).toHaveBeenCalledWith({ status: 403, code: 'not-allowed' });
    expect(mockSdk.transactions.transition).not.toHaveBeenCalled();
  });

  it("doesn't cancel the booking if the refund fails", async () => {
    mockSdk.transactions.show.mockResolvedValue(txResponse({ hoursToStart: 72 }));
    mockStripe.createRefund.mockRejectedValue(new Error('card_declined'));
    const res = await call(CUSTOMER_ID, 'cancel');

    expect(res.json).toHaveBeenCalledWith({ status: 502, code: 'refund-failed' });
    expect(mockSdk.transactions.transition).not.toHaveBeenCalled();
  });
});
