const mockPromoCodes = {
  cancelPromoCodeUse: jest.fn(),
  completePromoCodeUse: jest.fn(),
  getPromoCodeSyncPosition: jest.fn(),
  setPromoCodeSyncPosition: jest.fn(),
};
jest.mock('./index', () => ({
  cancelPromoCodeUse: (...args) => mockPromoCodes.cancelPromoCodeUse(...args),
  completePromoCodeUse: (...args) => mockPromoCodes.completePromoCodeUse(...args),
  getPromoCodeSyncPosition: (...args) => mockPromoCodes.getPromoCodeSyncPosition(...args),
  setPromoCodeSyncPosition: (...args) => mockPromoCodes.setPromoCodeSyncPosition(...args),
}));
const mockLoyalty = { earnCredits: jest.fn(), returnCredits: jest.fn() };
jest.mock('../loyalty', () => ({
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

const { applyEvent, processBookingEvents } = require('./bookingEvents');

const event = (
  sequenceId,
  state,
  promoCode = { id: 'code-1', redemptionId: 'r1' },
  { loyalty, previousState = 'state/accepted', customerId = 'customer-1' } = {}
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
        state,
        payinTotal: { amount: 6000, currency: 'SGD' },
        protectedData: { ...(promoCode ? { promoCode } : {}), ...(loyalty ? { loyalty } : {}) },
      },
    },
  },
});

describe('promo code booking events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPromoCodes.cancelPromoCodeUse.mockResolvedValue(true);
    mockPromoCodes.completePromoCodeUse.mockResolvedValue(true);
    mockPromoCodes.setPromoCodeSyncPosition.mockResolvedValue();
    mockLoyalty.earnCredits.mockResolvedValue(100);
    mockLoyalty.returnCredits.mockResolvedValue(true);
  });

  it('gives the use back when the booking does not go ahead, completes it when finished', async () => {
    expect(await applyEvent(event(1, 'state/declined'))).toEqual(['cancelled']);
    expect(mockPromoCodes.cancelPromoCodeUse).toHaveBeenCalledWith(
      'code-1',
      'r1',
      'state/declined'
    );
    expect(await applyEvent(event(2, 'state/delivered'))).toEqual(['completed', 'credits-earned']);
    expect(await applyEvent(event(3, 'state/accepted'))).toEqual([]);
    // Bookings without a promo code or credits are skipped
    expect(await applyEvent(event(4, 'state/declined', null))).toEqual([]);
  });

  it('gives credits back when the booking does not go ahead', async () => {
    const loyalty = { customerId: 'customer-1', redemptionId: 'l1' };
    expect(await applyEvent(event(1, 'state/expired', null, { loyalty }))).toEqual([
      'credits-returned',
    ]);
    expect(mockLoyalty.returnCredits).toHaveBeenCalledWith('customer-1', 'l1', 'tx-1');
    expect(mockLoyalty.earnCredits).not.toHaveBeenCalled();
  });

  it('earns credits once, when the booking first becomes finished', async () => {
    await applyEvent(event(1, 'state/delivered', null));
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
  });

  it("fetches the customer only when the event doesn't name them", async () => {
    mockTransactionsShow.mockResolvedValue({
      data: { data: { relationships: { customer: { data: { id: { uuid: 'customer-2' } } } } } },
    });
    await applyEvent(event(1, 'state/delivered', null, { customerId: null }));
    expect(mockTransactionsShow).toHaveBeenCalledTimes(1);
    expect(mockLoyalty.earnCredits.mock.calls[0][0].customerId).toBe('customer-2');
  });

  it('resumes after the last event read and saves where it got to', async () => {
    mockPromoCodes.getPromoCodeSyncPosition.mockResolvedValue(10);
    mockEventsQuery.mockResolvedValue({
      data: { data: [event(11, 'state/accepted'), event(12, 'state/expired')] },
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
