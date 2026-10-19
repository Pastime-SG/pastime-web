import {
  OUTCOME_ACCEPTED,
  OUTCOME_DECLINED,
  STAGE_ACCEPTED,
  STAGE_REQUESTED_BY_CUSTOMER,
  getRescheduleInfo,
  getStartTimeOptions,
} from './Reschedule.helpers';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TIME_ZONE = 'Etc/UTC';
const NOW = new Date('2026-10-01T09:30:00.000Z');
const bookingStart = new Date('2026-10-20T14:00:00.000Z');
const bookingEnd = new Date('2026-10-20T17:00:00.000Z');

const transaction = ({
  lastTransition = 'transition/accept',
  transitions,
  protectedData = {},
  publicData = { unitType: 'fixed', startTimeInterval: 'hour' },
} = {}) => ({
  attributes: {
    processName: 'default-booking',
    lastTransition,
    transitions: transitions || [
      { transition: 'transition/confirm-payment', createdAt: new Date('2026-09-25T10:00:00Z') },
      { transition: lastTransition, by: 'provider' },
    ],
    protectedData,
    createdAt: new Date('2026-09-25T10:00:00Z'),
  },
  booking: { attributes: { start: bookingStart, end: bookingEnd, seats: 2 } },
  listing: { attributes: { publicData } },
});

const nextTransitions = names => names.map(name => ({ attributes: { name } }));

describe('getRescheduleInfo', () => {
  it('lets a party request a reschedule once, at least 7 days before the booking', () => {
    const info = getRescheduleInfo({
      transaction: transaction(),
      transactionRole: 'customer',
      nextTransitions: nextTransitions(['transition/request-reschedule-by-customer']),
      now: NOW,
    });
    expect(info.stage).toBe(STAGE_ACCEPTED);
    expect(info.canRequest).toBe(true);
    expect(info.durationMs).toBe(3 * HOUR_MS);
    expect(info.requestDeadline.getTime()).toBe(bookingStart.getTime() - 7 * DAY_MS);
  });

  it('does not offer the request on an older process version or too close to the booking', () => {
    const olderVersion = getRescheduleInfo({
      transaction: transaction(),
      transactionRole: 'customer',
      nextTransitions: [],
      now: NOW,
    });
    expect(olderVersion.canRequest).toBe(false);

    const tooLate = getRescheduleInfo({
      transaction: transaction(),
      transactionRole: 'customer',
      nextTransitions: nextTransitions(['transition/request-reschedule-by-customer']),
      now: new Date(bookingStart.getTime() - 6 * DAY_MS),
    });
    expect(tooLate.canRequest).toBe(false);
  });

  it('shows who answers a pending request', () => {
    const tx = transaction({
      lastTransition: 'transition/request-reschedule-by-customer',
      protectedData: {
        reschedule: {
          status: 'requested',
          requestedBy: 'customer',
          bookingStart: '2026-10-22T15:00:00.000Z',
          bookingEnd: '2026-10-22T18:00:00.000Z',
        },
      },
    });
    const provider = getRescheduleInfo({ transaction: tx, transactionRole: 'provider', now: NOW });
    const customer = getRescheduleInfo({ transaction: tx, transactionRole: 'customer', now: NOW });

    expect(provider.stage).toBe(STAGE_REQUESTED_BY_CUSTOMER);
    expect(provider.isResponder).toBe(true);
    expect(provider.suggestion.start.toISOString()).toBe('2026-10-22T15:00:00.000Z');
    expect(customer.isRequester).toBe(true);
    expect(customer.isResponder).toBe(false);
  });

  it('ends the reschedule loop when the new time is accepted or declined', () => {
    const accepted = getRescheduleInfo({
      transaction: transaction({
        lastTransition: 'transition/accept-reschedule-by-provider',
        transitions: [
          { transition: 'transition/accept', by: 'provider' },
          { transition: 'transition/request-reschedule-by-customer', by: 'customer' },
          { transition: 'transition/accept-reschedule-by-provider', by: 'provider' },
        ],
        protectedData: {
          reschedule: {
            status: 'accepted',
            originalBookingStart: '2026-10-18T14:00:00.000Z',
            originalBookingEnd: '2026-10-18T17:00:00.000Z',
          },
        },
      }),
      transactionRole: 'customer',
      nextTransitions: nextTransitions(['transition/request-reschedule-by-customer']),
      now: NOW,
    });
    expect(accepted.outcome).toBe(OUTCOME_ACCEPTED);
    expect(accepted.canRequest).toBe(false);
    expect(accepted.previousBooking.start.toISOString()).toBe('2026-10-18T14:00:00.000Z');

    const declined = getRescheduleInfo({
      transaction: transaction({
        lastTransition: 'transition/decline-reschedule-by-customer',
        transitions: [
          { transition: 'transition/accept', by: 'provider' },
          { transition: 'transition/request-reschedule-by-provider', by: 'provider' },
          { transition: 'transition/decline-reschedule-by-customer', by: 'customer' },
        ],
      }),
      transactionRole: 'customer',
      nextTransitions: nextTransitions(['transition/request-reschedule-by-customer']),
      now: NOW,
    });
    expect(declined.outcome).toBe(OUTCOME_DECLINED);
    expect(declined.outcomeByYou).toBe(true);
    expect(declined.canRequest).toBe(false);
  });

  it('ignores other processes', () => {
    const tx = transaction();
    tx.attributes.processName = 'default-purchase';
    expect(getRescheduleInfo({ transaction: tx, transactionRole: 'customer', now: NOW })).toBe(
      null
    );
  });
});

describe('getRescheduleInfo for fixed sessions', () => {
  it("keeps the booking's seats and follows the listing's start time interval", () => {
    const info = getRescheduleInfo({
      transaction: transaction({
        publicData: { unitType: 'fixed', startTimeInterval: 'quarterHour' },
      }),
      transactionRole: 'customer',
      nextTransitions: nextTransitions(['transition/request-reschedule-by-customer']),
      now: NOW,
    });
    expect(info.seats).toBe(2);
    expect(info.timeUnit).toBe('quarterHour');
  });

  it('ignores bookings without a start time (day and night listings)', () => {
    const info = getRescheduleInfo({
      transaction: transaction({ publicData: { unitType: 'day' } }),
      transactionRole: 'customer',
      nextTransitions: nextTransitions(['transition/request-reschedule-by-customer']),
      now: NOW,
    });
    expect(info).toBe(null);
  });
});

describe('getStartTimeOptions', () => {
  const slot = (start, end, seats = 1) => ({
    attributes: { start: new Date(start), end: new Date(end), seats },
  });
  const dayStart = new Date('2026-10-20T00:00:00.000Z');
  const params = {
    dayStart,
    timeZone: TIME_ZONE,
    ownBooking: { start: bookingStart, end: bookingEnd },
    durationMs: 3 * HOUR_MS,
    maxStart: new Date('2026-12-01T00:00:00.000Z'),
    now: NOW,
  };

  it("offers start times where the whole booking fits, including over the booking's own time", () => {
    // Free 10-14 and 17-20, the booking itself is 14-17
    const timeSlots = [
      slot('2026-10-20T10:00:00.000Z', '2026-10-20T14:00:00.000Z'),
      slot('2026-10-20T17:00:00.000Z', '2026-10-20T20:00:00.000Z'),
    ];
    const starts = getStartTimeOptions({ ...params, timeSlots }).map(o =>
      o.start.toISOString().slice(11, 16)
    );
    // 10, 11, 12, 13, 15, 16, 17 (14 is the current time)
    expect(starts).toEqual(['10:00', '11:00', '12:00', '13:00', '15:00', '16:00', '17:00']);
  });

  it('keeps the duration for the end time', () => {
    const timeSlots = [slot('2026-10-20T08:00:00.000Z', '2026-10-20T12:00:00.000Z')];
    const options = getStartTimeOptions({ ...params, timeSlots });
    expect(options[0].start.toISOString()).toBe('2026-10-20T08:00:00.000Z');
    expect(options[0].end.toISOString()).toBe('2026-10-20T11:00:00.000Z');
  });
});

describe('getStartTimeOptions for fixed sessions', () => {
  const slot = (start, end, seats) => ({
    attributes: { start: new Date(start), end: new Date(end), seats },
  });
  const params = {
    dayStart: new Date('2026-10-20T00:00:00.000Z'),
    timeZone: TIME_ZONE,
    // A 90-minute session for 2 seats, 14:00-15:30
    ownBooking: {
      start: new Date('2026-10-20T14:00:00.000Z'),
      end: new Date('2026-10-20T15:30:00.000Z'),
    },
    durationMs: 1.5 * HOUR_MS,
    seats: 2,
    timeUnit: 'halfHour',
    maxStart: new Date('2026-12-01T00:00:00.000Z'),
    now: NOW,
  };

  it('offers start times every half hour where the session fits with enough seats', () => {
    // 2 seats free 10:00-12:00, only 1 seat free 16:00-18:00
    const timeSlots = [
      slot('2026-10-20T10:00:00.000Z', '2026-10-20T12:00:00.000Z', 2),
      slot('2026-10-20T16:00:00.000Z', '2026-10-20T18:00:00.000Z', 1),
    ];
    const starts = getStartTimeOptions({ ...params, timeSlots }).map(o =>
      o.start.toISOString().slice(11, 16)
    );
    // 14:30 and 15:00 overlap the booking's own time, which counts as free, but not past 15:30
    expect(starts).toEqual(['10:00', '10:30']);
  });
});

describe('getStartTimeOptions with a booking cutoff', () => {
  it('leaves out start times within the cutoff', () => {
    const slot = (start, end) => ({
      attributes: { start: new Date(start), end: new Date(end), seats: 1 },
    });
    const starts = getStartTimeOptions({
      dayStart: new Date('2026-10-20T00:00:00.000Z'),
      timeZone: TIME_ZONE,
      timeSlots: [slot('2026-10-20T08:00:00.000Z', '2026-10-20T14:00:00.000Z')],
      ownBooking: { start: bookingStart, end: bookingEnd },
      durationMs: HOUR_MS,
      maxStart: new Date('2026-12-01T00:00:00.000Z'),
      earliestStart: new Date('2026-10-20T11:00:00.000Z'),
      now: NOW,
    }).map(o => o.start.toISOString().slice(11, 16));
    // 15:00 and 16:00 are within the booking's own time (14:00-17:00), which counts as free
    expect(starts).toEqual(['11:00', '12:00', '13:00', '15:00', '16:00']);
  });
});
