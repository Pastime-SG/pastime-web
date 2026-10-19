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
