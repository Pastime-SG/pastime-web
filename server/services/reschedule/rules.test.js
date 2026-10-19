const {
  DAY_MS,
  TRANSITIONS,
  formatBookingTime,
  getMaxStart,
  getNewBookingTimes,
  getNewTimeError,
  getRequestError,
  getRescheduleStage,
  getStartTimeIntervalMinutes,
  isTimeAvailable,
} = require('./rules');

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-10-01T12:00:00.000Z');
const TIME_ZONE = 'America/New_York';

describe('reschedule', () => {
  describe('getRescheduleStage', () => {
    it('maps the last transition to the reschedule stage', () => {
      expect(getRescheduleStage('transition/accept')).toBe('accepted');
      expect(getRescheduleStage(TRANSITIONS.DECLINE_BY_PROVIDER)).toBe('accepted');
      expect(getRescheduleStage(TRANSITIONS.REQUEST_BY_CUSTOMER)).toBe('requested-by-customer');
      expect(getRescheduleStage(TRANSITIONS.COUNTER_BY_PROVIDER)).toBe('requested-by-provider');
      expect(getRescheduleStage('transition/complete')).toBe(null);
    });
  });

  describe('getRequestError', () => {
    const inEightDays = new Date(NOW.getTime() + 8 * DAY_MS);
    const accepted = [{ transition: 'transition/accept' }];

    it('allows the first request at least 7 days before the booking', () => {
      expect(
        getRequestError({
          stage: 'accepted',
          transitions: accepted,
          bookingStart: inEightDays,
          now: NOW,
        })
      ).toBe(null);
    });

    it('rejects a request less than 7 days before the booking', () => {
      const inSixDays = new Date(NOW.getTime() + 6 * DAY_MS);
      expect(
        getRequestError({
          stage: 'accepted',
          transitions: accepted,
          bookingStart: inSixDays,
          now: NOW,
        })
      ).toBe('too-late');
    });

    it('allows only one reschedule loop per booking', () => {
      const transitions = [
        ...accepted,
        { transition: TRANSITIONS.REQUEST_BY_CUSTOMER },
        { transition: TRANSITIONS.DECLINE_BY_PROVIDER },
      ];
      expect(
        getRequestError({ stage: 'accepted', transitions, bookingStart: inEightDays, now: NOW })
      ).toBe('already-rescheduled');
    });

    it('rejects a request when the booking is not accepted', () => {
      expect(
        getRequestError({ stage: null, transitions: [], bookingStart: inEightDays, now: NOW })
      ).toBe('not-allowed');
    });
  });

  describe('getNewBookingTimes', () => {
    it('keeps the duration of the booking', () => {
      const bookingStart = new Date('2026-10-20T18:00:00.000Z');
      const bookingEnd = new Date('2026-10-20T21:00:00.000Z');
      const { start, end } = getNewBookingTimes({
        start: '2026-10-22T15:00:00.000Z',
        bookingStart,
        bookingEnd,
      });
      expect(start.toISOString()).toBe('2026-10-22T15:00:00.000Z');
      expect(end.toISOString()).toBe('2026-10-22T18:00:00.000Z');
    });
  });

  describe('getNewTimeError', () => {
    const bookingStart = new Date('2026-10-20T18:00:00.000Z');
    const maxStart = new Date('2026-12-01T00:00:00.000Z');
    const params = { now: NOW, bookingStart, maxStart, timeZone: TIME_ZONE };

    it('accepts a future time on the hour', () => {
      expect(getNewTimeError({ ...params, start: new Date('2026-10-22T15:00:00.000Z') })).toBe(
        null
      );
    });

    it('rejects invalid, past, too far, same and off-the-hour times', () => {
      expect(getNewTimeError({ ...params, start: new Date('nope') })).toBe('invalid-time');
      expect(getNewTimeError({ ...params, start: new Date('2026-10-22T15:30:00.000Z') })).toBe(
        'invalid-time'
      );
      expect(getNewTimeError({ ...params, start: new Date('2026-09-30T15:00:00.000Z') })).toBe(
        'time-in-past'
      );
      expect(getNewTimeError({ ...params, start: new Date('2026-12-02T15:00:00.000Z') })).toBe(
        'time-too-far'
      );
      expect(getNewTimeError({ ...params, start: bookingStart })).toBe('same-time');
    });

    it("accepts times on the listing's start time interval", () => {
      const quarterPast = new Date('2026-10-22T15:15:00.000Z');
      expect(getNewTimeError({ ...params, start: quarterPast, intervalMinutes: 15 })).toBe(null);
      expect(getNewTimeError({ ...params, start: quarterPast, intervalMinutes: 30 })).toBe(
        'invalid-time'
      );
    });
  });

  describe('getStartTimeIntervalMinutes', () => {
    it("reads the listing's start time interval, defaulting to an hour", () => {
      expect(getStartTimeIntervalMinutes({ startTimeInterval: 'quarterHour' })).toBe(15);
      expect(getStartTimeIntervalMinutes({ startTimeInterval: 'halfHour' })).toBe(30);
      expect(getStartTimeIntervalMinutes({})).toBe(60);
    });
  });

  describe('getMaxStart', () => {
    it('is 90 days from the payment', () => {
      const paidAt = new Date('2026-09-01T10:00:00.000Z');
      const maxStart = getMaxStart({
        createdAt: new Date('2026-08-31T10:00:00.000Z'),
        transitions: [{ transition: TRANSITIONS.CONFIRM_PAYMENT, createdAt: paidAt }],
      });
      expect(maxStart.getTime()).toBe(paidAt.getTime() + 90 * DAY_MS);
    });
  });

  describe('isTimeAvailable', () => {
    const slot = (start, end, seats = 1) => ({ attributes: { start, end, seats } });
    const start = new Date('2026-10-22T15:00:00.000Z');
    const end = new Date(start.getTime() + 3 * HOUR_MS);

    it('needs the whole time to be free', () => {
      expect(
        isTimeAvailable({
          timeSlots: [slot('2026-10-22T12:00:00.000Z', '2026-10-22T20:00:00.000Z')],
          start,
          end,
        })
      ).toBe(true);
      expect(
        isTimeAvailable({
          timeSlots: [slot('2026-10-22T12:00:00.000Z', '2026-10-22T17:00:00.000Z')],
          start,
          end,
        })
      ).toBe(false);
    });

    it('joins back-to-back time slots and ignores slots without seats', () => {
      const timeSlots = [
        slot('2026-10-22T14:00:00.000Z', '2026-10-22T16:00:00.000Z'),
        slot('2026-10-22T16:00:00.000Z', '2026-10-22T19:00:00.000Z'),
      ];
      expect(isTimeAvailable({ timeSlots, start, end })).toBe(true);
      expect(
        isTimeAvailable({
          timeSlots: [slot('2026-10-22T12:00:00.000Z', '2026-10-22T20:00:00.000Z', 0)],
          start,
          end,
        })
      ).toBe(false);
    });

    it("counts the booking's own time as available", () => {
      // The booking is 14-17, the new time 15-18 overlaps it
      const ownBooking = {
        start: new Date('2026-10-22T14:00:00.000Z'),
        end: new Date('2026-10-22T17:00:00.000Z'),
      };
      const timeSlots = [slot('2026-10-22T17:00:00.000Z', '2026-10-22T20:00:00.000Z')];
      expect(isTimeAvailable({ timeSlots, start, end, ownBooking })).toBe(true);
      expect(isTimeAvailable({ timeSlots, start, end })).toBe(false);
    });

    it("needs enough free seats for the booking's seats", () => {
      const timeSlots = [slot('2026-10-22T12:00:00.000Z', '2026-10-22T20:00:00.000Z', 2)];
      expect(isTimeAvailable({ timeSlots, start, end, seats: 2 })).toBe(true);
      expect(isTimeAvailable({ timeSlots, start, end, seats: 3 })).toBe(false);
    });
  });

  describe('formatBookingTime', () => {
    it("formats the time in the listing's time zone", () => {
      const text = formatBookingTime({
        start: new Date('2026-10-22T18:00:00.000Z'),
        end: new Date('2026-10-22T21:00:00.000Z'),
        timeZone: TIME_ZONE,
      });
      expect(text).toContain('Oct 22, 2026');
      expect(text).toContain('2:00');
      expect(text).toContain('5:00');
    });
  });
});
