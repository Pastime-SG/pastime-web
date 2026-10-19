import {
  getMatchingCancellationRule,
  getPolicies,
  getRescheduleDeadline,
  isRuleMatching,
} from './policies';

const HOUR_MS = 60 * 60 * 1000;

const rules = [
  {
    heading: 'Full refund',
    comparison: 'moreThan',
    amount: 48,
    unit: 'hours',
    refundPercentage: 100,
  },
  { heading: 'Half refund', comparison: 'moreThan', amount: 1, unit: 'days', refundPercentage: 50 },
  { heading: 'No refund', comparison: 'lessThan', amount: 24, unit: 'hours', refundPercentage: 0 },
];

describe('getPolicies', () => {
  it('turns rescheduling off and has no rules without policies', () => {
    expect(getPolicies(undefined)).toEqual({
      reschedule: { allowed: false },
      cancellation: { rules: [] },
      bookingCutoff: null,
    });
  });

  it('drops invalid rules and keeps at most 3', () => {
    const policies = getPolicies({
      reschedule: { allowed: true, minNoticeAmount: 2, minNoticeUnit: 'days' },
      cancellation: {
        rules: [
          ...rules,
          {
            heading: 'Extra',
            comparison: 'moreThan',
            amount: 1,
            unit: 'hours',
            refundPercentage: 10,
          },
          {
            heading: 'Invalid',
            comparison: 'about',
            amount: 1,
            unit: 'hours',
            refundPercentage: 10,
          },
        ],
      },
    });
    expect(policies.reschedule).toEqual({
      allowed: true,
      minNoticeAmount: 2,
      minNoticeUnit: 'days',
    });
    expect(policies.cancellation.rules.map(r => r.heading)).toEqual([
      'Full refund',
      'Half refund',
      'No refund',
    ]);
  });
});

describe('getMatchingCancellationRule', () => {
  it('uses the rule with the highest refund when more than one matches', () => {
    expect(getMatchingCancellationRule(rules, 72 * HOUR_MS).heading).toBe('Full refund');
    expect(getMatchingCancellationRule(rules, 30 * HOUR_MS).heading).toBe('Half refund');
    expect(getMatchingCancellationRule(rules, 2 * HOUR_MS).heading).toBe('No refund');
  });

  it('returns null when no rule matches', () => {
    // Exactly 24 hours: not more than 24 hours, not less than 24 hours
    expect(getMatchingCancellationRule(rules, 24 * HOUR_MS)).toBe(null);
    expect(getMatchingCancellationRule([], 72 * HOUR_MS)).toBe(null);
  });

  it('compares more than / less than strictly', () => {
    const rule = { comparison: 'moreThan', amount: 2, unit: 'days' };
    expect(isRuleMatching(rule, 48 * HOUR_MS)).toBe(false);
    expect(isRuleMatching(rule, 48 * HOUR_MS + 1)).toBe(true);
  });
});

describe('getRescheduleDeadline', () => {
  it("is the minimum notice before the booking's start, or null if not allowed", () => {
    const start = new Date('2026-11-10T10:00:00.000Z');
    const policy = { allowed: true, minNoticeAmount: 2, minNoticeUnit: 'days' };
    expect(getRescheduleDeadline(policy, start).toISOString()).toBe('2026-11-08T10:00:00.000Z');
    expect(getRescheduleDeadline({ allowed: false }, start)).toBe(null);
  });
});

describe('booking cutoff', () => {
  const { getEarliestBookingStart, getTimeSlotQueryAfterCutoff } = require('./policies');
  const now = new Date('2026-11-01T10:30:00.000Z');
  const policies = { bookingCutoff: { amount: 24, unit: 'hours' } };

  it('is optional', () => {
    expect(getPolicies({}).bookingCutoff).toBe(null);
    expect(getEarliestBookingStart({}, now)).toBe(null);
    expect(getEarliestBookingStart({ bookingCutoff: { amount: 0, unit: 'hours' } }, now)).toBe(
      null
    );
  });

  it('starts the time slot query after the cutoff', () => {
    const earliestStart = getEarliestBookingStart(policies, now);
    expect(earliestStart.toISOString()).toBe('2026-11-02T10:30:00.000Z');

    const query = getTimeSlotQueryAfterCutoff({
      start: now,
      end: new Date('2026-12-01T00:00:00.000Z'),
      timeZone: 'Etc/UTC',
      extraParams: { intervalDuration: 'P1D', intervalAlign: new Date('2026-11-01T00:00:00Z') },
      earliestStart,
    });
    expect(query.start).toBe(earliestStart);
    // Day intervals are aligned to the start of the earliest booking day
    expect(query.extraParams.intervalAlign.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('skips a query that is completely within the cutoff, and keeps later ones as they are', () => {
    const earliestStart = getEarliestBookingStart(policies, now);
    const params = { timeZone: 'Etc/UTC', extraParams: {}, earliestStart };
    expect(
      getTimeSlotQueryAfterCutoff({
        ...params,
        start: new Date('2026-11-01T00:00:00Z'),
        end: new Date('2026-11-02T00:00:00Z'),
      })
    ).toBe(null);
    const later = new Date('2026-11-05T00:00:00Z');
    expect(
      getTimeSlotQueryAfterCutoff({
        ...params,
        start: later,
        end: new Date('2026-11-06T00:00:00Z'),
      }).start
    ).toBe(later);
  });
});
