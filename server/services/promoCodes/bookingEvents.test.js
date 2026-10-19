const mockPromoCodes = {
  cancelPromoCodeUse: jest.fn(),
  completePromoCodeUse: jest.fn(),
  confirmPromoCodeUse: jest.fn(),
  getPromoCodeSyncPosition: jest.fn(),
  setPromoCodeSyncPosition: jest.fn(),
};
jest.mock('./index', () => ({
  cancelPromoCodeUse: (...args) => mockPromoCodes.cancelPromoCodeUse(...args),
  completePromoCodeUse: (...args) => mockPromoCodes.completePromoCodeUse(...args),
  confirmPromoCodeUse: (...args) => mockPromoCodes.confirmPromoCodeUse(...args),
  getPromoCodeSyncPosition: (...args) => mockPromoCodes.getPromoCodeSyncPosition(...args),
  setPromoCodeSyncPosition: (...args) => mockPromoCodes.setPromoCodeSyncPosition(...args),
}));
const mockLoyalty = {
  confirmSpentCredits: jest.fn(),
  earnCredits: jest.fn(),
  returnCredits: jest.fn(),
};
jest.mock('../loyalty', () => ({
  confirmSpentCredits: (...args) => mockLoyalty.confirmSpentCredits(...args),
  earnCredits: (...args) => mockLoyalty.earnCredits(...args),
  returnCredits: (...args) => mockLoyalty.returnCredits(...args),
}));
const mockEventsQuery = jest.fn();
const mockTransactionsShow = jest.fn();
jest.mock('../sharetribe/integration', () => ({
  getIntegrationSdk: () => ({
    events: { query: (...args) => mockEventsQuery(...args) },
    transactions: { show: (...args) => mockTransactionsShow(...args) },
  }),
}));
jest.mock('../../log', () => ({ error: jest.fn() }));

const { applyEvent, getRefundShare, processBookingEvents } = require('./bookingEvents');

const event = (
  sequenceId,
  state,
  promoCode = { id: 'code-1', redemptionId: 'r1' },
  {
    loyalty,
    lastTransition = 'transition/accept',
    previousState = 'state/accepted',
    customerId = 'customer-1',
    metadata = {},
    processName = 'default-booking',
  } = {}
) => ({
  attributes: {
    sequenceId,
    resourceId: { uuid: 'tx-1' },
    previousValues: { attributes: { state: previousState } },
    resource: {
      id: { uuid: 'tx-1' },
      ...(customerId
        ? { relationships: { customer: { data: { id: { uuid: customerId } } } } }
        : {}),
      attributes: {
        processName,
        state,
        lastTransition,
        metadata,
        payinTotal: { amount: 6000, currency: 'SGD' },
        protectedData: { ...(promoCode ? { promoCode } : {}), ...(loyalty ? { loyalty } : {}) },
      },
    },
  },
});
const loyalty = { customerId: 'customer-1', redemptionId: 'l1' };

describe('promo code booking events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPromoCodes.cancelPromoCodeUse.mockResolvedValue(true);
    mockPromoCodes.completePromoCodeUse.mockResolvedValue(true);
    mockPromoCodes.setPromoCodeSyncPosition.mockResolvedValue();
    mockLoyalty.earnCredits.mockResolvedValue(100);
    mockLoyalty.returnCredits.mockResolvedValue(true);
    mockLoyalty.confirmSpentCredits.mockResolvedValue();
    mockPromoCodes.confirmPromoCodeUse.mockResolvedValue();
  });

  it('gives the use and credits back when the booking does not go ahead with a full refund', async () => {
    const declined = event(1, 'state/declined', undefined, {
      loyalty,
      lastTransition: 'transition/decline',
    });
    expect(await applyEvent(declined)).toEqual(['cancelled', 'credits-returned']);
    expect(mockPromoCodes.cancelPromoCodeUse).toHaveBeenCalledWith(
      'code-1',
      'r1',
      'tx-1',
      'state/declined'
    );
    expect(mockLoyalty.returnCredits).toHaveBeenCalledWith({
      customerId: 'customer-1',
      redemptionId: 'l1',
      transactionId: 'tx-1',
      share: 1,
    });
    expect(mockLoyalty.earnCredits).not.toHaveBeenCalled();
  });

  it("gives credits back in proportion to a customer's cancellation refund, keeps the use", async () => {
    const cancelled = percentage =>
      event(1, 'state/cancelled', undefined, {
        loyalty,
        lastTransition: 'transition/customer-cancel',
        metadata: { cancellation: { refundPercentage: percentage } },
      });
    expect(await applyEvent(cancelled(50))).toEqual(['credits-returned']);
    expect(mockLoyalty.returnCredits.mock.calls[0][0].share).toBe(0.5);
    expect(mockPromoCodes.cancelPromoCodeUse).not.toHaveBeenCalled();

    // No refund: nothing comes back
    const noRefund = event(2, 'state/cancelled-without-refund', undefined, {
      loyalty,
      lastTransition: 'transition/customer-cancel-no-refund',
      metadata: { cancellation: { refundPercentage: 0 } },
    });
    expect(await applyEvent(noRefund)).toEqual([]);
    // Paying out a no-refund cancellation isn't a refund either
    const paidOut = event(3, 'state/cancelled', undefined, {
      loyalty,
      lastTransition: 'transition/payout-cancelled-without-refund',
    });
    expect(await applyEvent(paidOut)).toEqual([]);
    expect(mockLoyalty.returnCredits).toHaveBeenCalledTimes(1);
  });

  it("ignores other processes' transactions, whatever their protected data says", async () => {
    const purchase = event(1, 'state/payment-expired', undefined, {
      loyalty,
      lastTransition: 'transition/expire-payment',
      processName: 'default-negotiation',
    });
    expect(await applyEvent(purchase)).toEqual([]);
    expect(mockPromoCodes.cancelPromoCodeUse).not.toHaveBeenCalled();
    expect(mockLoyalty.returnCredits).not.toHaveBeenCalled();
  });

  it('links the use and credits to the booking request, in case that failed at checkout', async () => {
    const requested = event(1, 'state/pending-payment', undefined, {
      loyalty,
      lastTransition: 'transition/request-payment',
    });
    await applyEvent(requested);
    expect(mockPromoCodes.confirmPromoCodeUse).toHaveBeenCalledWith('code-1', 'r1', 'tx-1');
    expect(mockLoyalty.confirmSpentCredits).toHaveBeenCalledWith('customer-1', 'l1', 'tx-1');
  });

  it('works out the refund share from the transition and server-set metadata only', () => {
    expect(getRefundShare({ lastTransition: 'transition/expire-payment' })).toBe(1);
    expect(getRefundShare({ lastTransition: 'transition/cancel' })).toBe(1);
    expect(getRefundShare({ lastTransition: 'transition/accept' })).toBe(null);
    expect(
      getRefundShare({
        lastTransition: 'transition/customer-cancel',
        metadata: { cancellation: { refundPercentage: 250 } },
      })
    ).toBe(1);
    expect(
      getRefundShare({
        lastTransition: 'transition/customer-cancel',
        metadata: { cancellation: { refundPercentage: 'lots' } },
      })
    ).toBe(0);
    expect(getRefundShare({ lastTransition: 'transition/customer-cancel' })).toBe(0);
  });

  it('completes the use and earns credits once, when the booking first becomes finished', async () => {
    expect(await applyEvent(event(1, 'state/delivered'))).toEqual(['completed', 'credits-earned']);
    expect(mockPromoCodes.completePromoCodeUse).toHaveBeenCalledWith('code-1', 'r1', 'tx-1');
    expect(mockLoyalty.earnCredits).toHaveBeenCalledWith({
      customerId: 'customer-1',
      transactionId: 'tx-1',
      paidAmount: 6000,
      currency: 'SGD',
    });
    // A review after the booking is finished doesn't earn again
    await applyEvent(event(2, 'state/reviewed', null, { previousState: 'state/delivered' }));
    expect(mockLoyalty.earnCredits).toHaveBeenCalledTimes(1);
    expect(mockTransactionsShow).not.toHaveBeenCalled();
    // Other transitions change nothing
    expect(await applyEvent(event(3, 'state/accepted'))).toEqual([]);
  });

  it('earns for the customer of the transaction, never one named in protected data', async () => {
    mockTransactionsShow.mockResolvedValue({
      data: { data: { relationships: { customer: { data: { id: { uuid: 'customer-2' } } } } } },
    });
    const finished = event(1, 'state/delivered', null, {
      customerId: null,
      loyalty: { customerId: 'someone-else', redemptionId: 'l1' },
    });
    await applyEvent(finished);
    expect(mockTransactionsShow).toHaveBeenCalledTimes(1);
    expect(mockLoyalty.earnCredits.mock.calls[0][0].customerId).toBe('customer-2');
  });

  it('resumes after the last event read and saves where it got to', async () => {
    mockPromoCodes.getPromoCodeSyncPosition.mockResolvedValue(10);
    mockEventsQuery.mockResolvedValue({
      data: {
        data: [
          event(11, 'state/accepted'),
          event(12, 'state/expired', undefined, { lastTransition: 'transition/expire' }),
        ],
      },
    });

    const result = await processBookingEvents();
    expect(mockEventsQuery).toHaveBeenCalledTimes(1);
    expect(mockEventsQuery.mock.calls[0][0]).toMatchObject({
      startAfterSequenceId: 10,
      eventTypes: 'transaction/transitioned',
    });
    expect(result).toEqual({ events: 2, changed: 1 });
    expect(mockPromoCodes.setPromoCodeSyncPosition).toHaveBeenCalledWith(12);
  });

  it('starts an hour back on the very first read', async () => {
    mockPromoCodes.getPromoCodeSyncPosition.mockResolvedValue(null);
    mockEventsQuery.mockResolvedValue({ data: { data: [] } });
    await processBookingEvents(new Date('2026-11-01T10:00:00Z'));
    expect(mockEventsQuery.mock.calls[0][0].createdAtStart.toISOString()).toBe(
      '2026-11-01T09:00:00.000Z'
    );
    // Nothing read, so no position to save yet
    expect(mockPromoCodes.setPromoCodeSyncPosition).not.toHaveBeenCalled();
  });

  it('reads the next page while pages are full', async () => {
    mockPromoCodes.getPromoCodeSyncPosition.mockResolvedValue(0);
    const fullPage = Array.from({ length: 100 }, (_, i) => event(i + 1, 'state/accepted'));
    mockEventsQuery
      .mockResolvedValueOnce({ data: { data: fullPage } })
      .mockResolvedValueOnce({ data: { data: [event(101, 'state/accepted')] } });
    const result = await processBookingEvents();
    expect(mockEventsQuery).toHaveBeenCalledTimes(2);
    expect(mockEventsQuery.mock.calls[1][0].startAfterSequenceId).toBe(100);
    expect(result.events).toBe(101);
    expect(mockPromoCodes.setPromoCodeSyncPosition).toHaveBeenLastCalledWith(101);
  });
});
