const mockSdk = {
  transactions: { show: jest.fn(), transition: jest.fn() },
  timeslots: { query: jest.fn() },
};
// Plain functions: mocks are reset between tests
jest.mock('../../api-util/sdk', () => ({
  createCookieTokenStore: () => ({}),
  getSdk: () => mockSdk,
  getTrustedSdk: () => Promise.resolve(mockSdk),
  serialize: data => JSON.stringify(data),
  handleError: (res, e) => res.status(e.status || 500).json({ status: e.status || 500 }),
}));

const reschedule = require('./reschedule');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CUSTOMER_ID = 'customer-1';
const PROVIDER_ID = 'provider-1';

const MINUTE_MS = 60 * 1000;
const SESSION_MS = 90 * MINUTE_MS;

// A 90-minute fixed session for 2 seats 10 days from now, starting on the hour. The listing's
// sessions start every half hour.
const startOfHour = date => new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
const bookingStart = startOfHour(new Date(Date.now() + 10 * DAY_MS));
const bookingEnd = new Date(bookingStart.getTime() + SESSION_MS);
const newStart = new Date(bookingStart.getTime() + DAY_MS + 30 * MINUTE_MS);
const newEnd = new Date(newStart.getTime() + SESSION_MS);

const txResponse = ({
  lastTransition = 'transition/accept',
  transitions,
  protectedData = {},
  start = bookingStart,
  end = bookingEnd,
} = {}) => ({
  data: {
    data: {
      id: { uuid: 'tx-1' },
      type: 'transaction',
      attributes: {
        lastTransition,
        transitions: transitions || [
          { transition: 'transition/confirm-payment', createdAt: new Date() },
          { transition: lastTransition, createdAt: new Date() },
        ],
        protectedData,
        createdAt: new Date(),
      },
      relationships: {
        booking: { data: { id: { uuid: 'booking-1' }, type: 'booking' } },
        listing: { data: { id: { uuid: 'listing-1' }, type: 'listing' } },
        customer: { data: { id: { uuid: CUSTOMER_ID }, type: 'user' } },
        provider: { data: { id: { uuid: PROVIDER_ID }, type: 'user' } },
      },
    },
    included: [
      { id: { uuid: 'booking-1' }, type: 'booking', attributes: { start, end, seats: 2 } },
      {
        id: { uuid: 'listing-1' },
        type: 'listing',
        attributes: {
          availabilityPlan: { timezone: 'Etc/UTC' },
          publicData: { unitType: 'fixed', startTimeInterval: 'halfHour' },
        },
      },
    ],
  },
});

const freeSlots = { data: { data: [{ attributes: { start: newStart, end: newEnd, seats: 2 } }] } };
const oneSeatLeft = {
  data: { data: [{ attributes: { start: newStart, end: newEnd, seats: 1 } }] },
};
const noSlots = { data: { data: [] } };

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res;
};

const call = async (userId, body) => {
  const res = createResponse();
  // middleware.auth sets the signed-in user's id
  await reschedule({ tokenUserId: userId, body: { transactionId: 'tx-1', ...body } }, res);
  return res;
};

// The updated transaction from the transition
const transitionResponse = { status: 200, statusText: 'OK', data: { data: { id: 'tx-1' } } };

const pendingRequest = requestedBy => ({
  reschedule: {
    status: 'requested',
    requestedBy,
    bookingStart: newStart.toISOString(),
    bookingEnd: newEnd.toISOString(),
  },
});

describe('POST /api/reschedule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSdk.transactions.transition.mockResolvedValue(transitionResponse);
    mockSdk.timeslots.query.mockResolvedValue(freeSlots);
  });

  it('stores the request in protected data without changing the booking', async () => {
    mockSdk.transactions.show.mockResolvedValue(txResponse());
    const res = await call(CUSTOMER_ID, { action: 'request', bookingStart: newStart });

    expect(res.status).toHaveBeenCalledWith(200);
    const args = mockSdk.transactions.transition.mock.calls[0][0];
    expect(args.transition).toBe('transition/request-reschedule-by-customer');
    expect(args.params.bookingStart).toBeUndefined();
    expect(args.params.protectedData.reschedule).toMatchObject({
      status: 'requested',
      requestedBy: 'customer',
      bookingStart: newStart.toISOString(),
      bookingEnd: newEnd.toISOString(),
    });
  });

  it('rejects a first request less than 7 days before the booking', async () => {
    const soon = startOfHour(new Date(Date.now() + 5 * DAY_MS));
    mockSdk.transactions.show.mockResolvedValue(
      txResponse({ start: soon, end: new Date(soon.getTime() + SESSION_MS) })
    );
    const res = await call(PROVIDER_ID, { action: 'request', bookingStart: newStart });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ status: 403, code: 'too-late' });
    expect(mockSdk.transactions.transition).not.toHaveBeenCalled();
  });

  it('rejects a new time that is not available', async () => {
    mockSdk.transactions.show.mockResolvedValue(txResponse());
    mockSdk.timeslots.query.mockResolvedValue(noSlots);
    const res = await call(CUSTOMER_ID, { action: 'request', bookingStart: newStart });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockSdk.transactions.transition).not.toHaveBeenCalled();
  });

  it("rejects a new time that doesn't have enough seats for the booking", async () => {
    mockSdk.transactions.show.mockResolvedValue(txResponse());
    mockSdk.timeslots.query.mockResolvedValue(oneSeatLeft);
    const res = await call(CUSTOMER_ID, { action: 'request', bookingStart: newStart });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockSdk.transactions.transition).not.toHaveBeenCalled();
  });

  it("rejects a start time that is not on the listing's start time interval", async () => {
    mockSdk.transactions.show.mockResolvedValue(txResponse());
    const offInterval = new Date(newStart.getTime() + 15 * MINUTE_MS);
    const res = await call(CUSTOMER_ID, { action: 'request', bookingStart: offInterval });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ status: 400, code: 'invalid-time' });
  });

  it('moves the booking when the other party accepts', async () => {
    mockSdk.transactions.show.mockResolvedValue(
      txResponse({
        lastTransition: 'transition/request-reschedule-by-customer',
        protectedData: pendingRequest('customer'),
      })
    );
    const res = await call(PROVIDER_ID, { action: 'accept' });

    expect(res.status).toHaveBeenCalledWith(200);
    // The updated transaction and its moved booking are sent back: the client doesn't refetch
    expect(mockSdk.transactions.transition.mock.calls[0][1]).toEqual({
      expand: true,
      include: ['booking'],
    });
    expect(res.send).toHaveBeenCalledWith(JSON.stringify(transitionResponse));
    const args = mockSdk.transactions.transition.mock.calls[0][0];
    expect(args.transition).toBe('transition/accept-reschedule-by-provider');
    expect(args.params.bookingStart).toEqual(newStart);
    expect(args.params.bookingEnd).toEqual(newEnd);
    expect(args.params.protectedData.reschedule.status).toBe('accepted');
  });

  it('does not let the requester accept their own request', async () => {
    mockSdk.transactions.show.mockResolvedValue(
      txResponse({
        lastTransition: 'transition/request-reschedule-by-customer',
        protectedData: pendingRequest('customer'),
      })
    );
    const res = await call(CUSTOMER_ID, { action: 'accept' });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSdk.transactions.transition).not.toHaveBeenCalled();
  });

  it('does not accept a suggested time that was booked meanwhile', async () => {
    mockSdk.transactions.show.mockResolvedValue(
      txResponse({
        lastTransition: 'transition/request-reschedule-by-provider',
        protectedData: pendingRequest('provider'),
      })
    );
    mockSdk.timeslots.query.mockResolvedValue(noSlots);
    const res = await call(CUSTOMER_ID, { action: 'accept' });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ status: 409, code: 'time-unavailable' });
    expect(mockSdk.transactions.transition).not.toHaveBeenCalled();
  });

  it('lets the other party decline, keeping the booking time', async () => {
    mockSdk.transactions.show.mockResolvedValue(
      txResponse({
        lastTransition: 'transition/counter-reschedule-by-provider',
        protectedData: pendingRequest('provider'),
      })
    );
    const res = await call(CUSTOMER_ID, { action: 'decline' });

    expect(res.status).toHaveBeenCalledWith(200);
    const args = mockSdk.transactions.transition.mock.calls[0][0];
    expect(args.transition).toBe('transition/decline-reschedule-by-customer');
    expect(args.params.bookingStart).toBeUndefined();
    expect(args.params.protectedData.reschedule.status).toBe('declined');
  });

  it('allows only one reschedule loop per booking', async () => {
    mockSdk.transactions.show.mockResolvedValue(
      txResponse({
        lastTransition: 'transition/decline-reschedule-by-provider',
        transitions: [
          { transition: 'transition/accept' },
          { transition: 'transition/request-reschedule-by-customer' },
          { transition: 'transition/decline-reschedule-by-provider' },
        ],
      })
    );
    const res = await call(CUSTOMER_ID, { action: 'request', bookingStart: newStart });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ status: 403, code: 'already-rescheduled' });
  });
});
