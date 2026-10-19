const mockStripe = {
  createPayout: jest.fn(),
  findPendingPayouts: jest.fn(),
  getDestinationPaymentAvailability: jest.fn(),
  updatePaymentIntentMetadata: jest.fn(),
};
jest.mock('../stripe', () => ({
  PAYOUT_PAID: 'paid',
  PAYOUT_PENDING: 'pending',
  PAYOUT_STATUS_KEY: 'pastime-cancellation-payout',
  createPayout: (...args) => mockStripe.createPayout(...args),
  findPendingPayouts: (...args) => mockStripe.findPendingPayouts(...args),
  getDestinationPaymentAvailability: (...args) =>
    mockStripe.getDestinationPaymentAvailability(...args),
  updatePaymentIntentMetadata: (...args) => mockStripe.updatePaymentIntentMetadata(...args),
}));
jest.mock('../../log', () => ({ error: jest.fn() }));

const { payOutOrSchedule, processPendingPayouts } = require('./payouts');

const payment = { accountId: 'acct_1', destinationPaymentId: 'py_1', currency: 'sgd' };
const availableOn = new Date('2026-11-05T00:00:00.000Z');

describe('cancellation payouts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStripe.createPayout.mockResolvedValue({ id: 'po_1' });
    mockStripe.updatePaymentIntentMetadata.mockResolvedValue({});
  });

  it("pays out right away when the booking's funds are available", async () => {
    mockStripe.getDestinationPaymentAvailability.mockResolvedValue({
      isAvailable: true,
      availableOn,
    });
    const result = await payOutOrSchedule({
      paymentIntentId: 'pi_1',
      transactionId: 'tx-1',
      payment,
      amount: 4500,
    });
    expect(result.status).toBe('paid');
    expect(mockStripe.createPayout).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct_1', amount: 4500, currency: 'sgd' })
    );
  });

  it('waits for the funds instead of paying out from other funds', async () => {
    mockStripe.getDestinationPaymentAvailability.mockResolvedValue({
      isAvailable: false,
      availableOn,
    });
    const result = await payOutOrSchedule({
      paymentIntentId: 'pi_1',
      transactionId: 'tx-1',
      payment,
      amount: 4500,
    });
    expect(result).toEqual({ status: 'pending', availableOn });
    expect(mockStripe.createPayout).not.toHaveBeenCalled();
    expect(mockStripe.updatePaymentIntentMetadata).toHaveBeenCalledWith(
      'pi_1',
      expect.objectContaining({
        'pastime-cancellation-payout': 'pending',
        'pastime-cancellation-payout-amount': '4500',
      })
    );
  });

  it('has nothing to pay out when the provider keeps nothing', async () => {
    const result = await payOutOrSchedule({ paymentIntentId: 'pi_1', payment, amount: 0 });
    expect(result.status).toBe('none');
    expect(mockStripe.getDestinationPaymentAvailability).not.toHaveBeenCalled();
  });

  it('pays the pending payouts whose funds have become available', async () => {
    const pending = (id, date) => ({
      id,
      currency: 'sgd',
      metadata: {
        'sharetribe-transaction-id': `tx-${id}`,
        'pastime-cancellation-payout-amount': '4500',
        'pastime-cancellation-payout-account': 'acct_1',
        'pastime-cancellation-payout-payment': 'py_1',
        'pastime-cancellation-payout-available-on': date,
      },
    });
    mockStripe.findPendingPayouts.mockResolvedValue([
      pending('pi_due', '2026-11-05T00:00:00.000Z'),
      pending('pi_later', '2026-11-20T00:00:00.000Z'),
    ]);
    mockStripe.getDestinationPaymentAvailability.mockResolvedValue({ isAvailable: true });

    const count = await processPendingPayouts(new Date('2026-11-06T00:00:00.000Z'));
    expect(count).toBe(1);
    expect(mockStripe.createPayout).toHaveBeenCalledTimes(1);
    expect(mockStripe.updatePaymentIntentMetadata).toHaveBeenCalledWith(
      'pi_due',
      expect.objectContaining({ 'pastime-cancellation-payout': 'paid' })
    );
  });
});
