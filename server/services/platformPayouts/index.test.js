jest.mock('../../log', () => ({ error: jest.fn() }));
jest.mock('../firebase', () => ({ getFirestore: jest.fn(), FieldValue: {} }));
jest.mock('../sharetribe/integration', () => ({ getIntegrationSdk: jest.fn() }));
jest.mock('../cancellation/payment', () => ({ getPayment: jest.fn() }));
jest.mock('../stripe', () => ({
  createPayout: jest.fn(),
  createTransfer: jest.fn(),
  getDestinationPaymentAvailability: jest.fn(),
  isInsufficientBalanceError: e => e?.code === 'balance_insufficient',
}));

const { getIntegrationSdk } = require('../sharetribe/integration');
const { getPayment } = require('../cancellation/payment');
const { createPayout, createTransfer, getDestinationPaymentAvailability } = require('../stripe');
const { ERROR_BALANCE, advancePayout, applyPayoutEvent } = require('./index');

const platformPaidRecord = {
  transactionId: 'tx-1',
  processName: 'booking-platform-paid',
  paymentIntentId: 'pi_1',
  providerId: 'provider-1',
  payoutAmount: 4541,
  currency: 'sgd',
  accountId: null,
};

const available = { isAvailable: true };

beforeEach(() => {
  jest.clearAllMocks();
  getPayment.mockResolvedValue({
    paymentIntentId: 'pi_1',
    payment: {
      accountId: 'acct_1',
      currency: 'sgd',
      providerShare: 3000,
      alreadyReversed: 0,
      destinationPaymentId: 'py_booking',
    },
  });
  createTransfer.mockResolvedValue({ id: 'tr_1', destination_payment: 'py_transfer' });
  createPayout.mockResolvedValue({ id: 'po_1' });
  getDestinationPaymentAvailability.mockResolvedValue(available);
});

describe('platform payouts', () => {
  it("transfers Pastime's part and pays the provider in one payout", async () => {
    const changes = await advancePayout(platformPaidRecord);
    // The booking left $30 in the provider's account: Pastime sends the other $15.41
    expect(createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct_1',
        amount: 1541,
        idempotencyKey: 'platform-transfer-tx-1',
      })
    );
    expect(createPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct_1',
        amount: 4541,
        idempotencyKey: 'platform-payout-tx-1',
      })
    );
    expect(changes).toEqual(
      expect.objectContaining({ status: 'paid', transferId: 'tr_1', payoutId: 'po_1' })
    );
  });

  it("waits when Pastime's balance is too low, without paying out", async () => {
    createTransfer.mockRejectedValue({ code: 'balance_insufficient' });
    const changes = await advancePayout(platformPaidRecord);
    expect(changes.lastError).toBe(ERROR_BALANCE);
    expect(changes.status).toBeUndefined();
    expect(createPayout).not.toHaveBeenCalled();
  });

  it("waits for the booking's funds before paying out (never from other funds)", async () => {
    const availableOn = new Date('2026-11-20T00:00:00Z');
    getDestinationPaymentAvailability.mockImplementation(({ destinationPaymentId }) =>
      Promise.resolve(
        destinationPaymentId === 'py_booking' ? { isAvailable: false, availableOn } : available
      )
    );
    const changes = await advancePayout(platformPaidRecord);
    expect(createPayout).not.toHaveBeenCalled();
    expect(changes).toEqual(
      expect.objectContaining({ transferId: 'tr_1', availableOn, lastError: null })
    );
  });

  it("doesn't transfer again once Pastime's part was sent", async () => {
    await advancePayout({
      ...platformPaidRecord,
      accountId: 'acct_1',
      bookingPaymentId: 'py_booking',
      platformAmount: 1541,
      transferId: 'tr_1',
      transferPaymentId: 'py_transfer',
    });
    expect(createTransfer).not.toHaveBeenCalled();
    expect(createPayout).toHaveBeenCalledTimes(1);
  });

  it('pays the whole payout of a free booking from Pastime', async () => {
    const usersShow = jest.fn().mockResolvedValue({
      data: {
        data: { relationships: { stripeAccount: { data: { id: { uuid: 'sa-1' } } } } },
        included: [
          {
            type: 'stripeAccount',
            id: { uuid: 'sa-1' },
            attributes: { stripeAccountId: 'acct_2' },
          },
        ],
      },
    });
    getIntegrationSdk.mockReturnValue({ users: { show: usersShow } });
    const changes = await advancePayout({
      ...platformPaidRecord,
      processName: 'booking-free',
      paymentIntentId: null,
    });
    expect(getPayment).not.toHaveBeenCalled();
    expect(createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct_2', amount: 4541 })
    );
    expect(changes.status).toBe('paid');
  });

  it('ignores bookings that Sharetribe pays out', async () => {
    const event = {
      attributes: {
        resourceId: { uuid: 'tx-2' },
        resource: {
          attributes: { processName: 'default-booking', lastTransition: 'transition/complete' },
        },
      },
    };
    await expect(applyPayoutEvent(event)).resolves.toBe(false);
  });
});
