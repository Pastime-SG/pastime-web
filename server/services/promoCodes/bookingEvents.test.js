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
const mockEventsQuery = jest.fn();
jest.mock('../sharetribe/integration', () => ({
  getIntegrationSdk: () => ({ events: { query: (...args) => mockEventsQuery(...args) } }),
}));
jest.mock('../../log', () => ({ error: jest.fn() }));

const { applyEvent, processBookingEvents } = require('./bookingEvents');

const event = (sequenceId, state, promoCode = { id: 'code-1', redemptionId: 'r1' }) => ({
  attributes: {
    sequenceId,
    resource: { attributes: { state, protectedData: promoCode ? { promoCode } : {} } },
  },
});

describe('promo code booking events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPromoCodes.cancelPromoCodeUse.mockResolvedValue(true);
    mockPromoCodes.completePromoCodeUse.mockResolvedValue(true);
    mockPromoCodes.setPromoCodeSyncPosition.mockResolvedValue();
  });

  it('gives the use back when the booking does not go ahead, completes it when finished', async () => {
    expect(await applyEvent(event(1, 'state/declined'))).toBe('cancelled');
    expect(mockPromoCodes.cancelPromoCodeUse).toHaveBeenCalledWith(
      'code-1',
      'r1',
      'state/declined'
    );
    expect(await applyEvent(event(2, 'state/delivered'))).toBe('completed');
    expect(await applyEvent(event(3, 'state/accepted'))).toBe(null);
    // Bookings without a promo code are skipped
    expect(await applyEvent(event(4, 'state/declined', null))).toBe(null);
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
