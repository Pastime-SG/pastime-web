const {
  assertBookingStartAfterCutoff,
  getEarliestBookingStart,
  getPoliciesProtectedData,
} = require('./index');

const NOW = new Date('2026-11-01T10:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

const listingWith = (policies, transactionProcessAlias = 'default-booking/release-1') => ({
  attributes: { publicData: { policies, transactionProcessAlias } },
});

describe('listing policies', () => {
  it('copies the policies to booking requests', () => {
    const listing = listingWith({ reschedule: { allowed: false } });
    expect(getPoliciesProtectedData(listing, 'transition/request-payment').policies).toBeTruthy();
    expect(getPoliciesProtectedData(listing, 'transition/inquire')).toEqual({});
  });

  describe('booking cutoff', () => {
    const listing = listingWith({ bookingCutoff: { amount: 24, unit: 'hours' } });
    const request = bookingStart => () =>
      assertBookingStartAfterCutoff({
        listing,
        transitionName: 'transition/request-payment',
        bookingStart,
        now: NOW,
      });

    it('is the cutoff from now, or none', () => {
      expect(getEarliestBookingStart(listing, NOW).toISOString()).toBe('2026-11-02T10:00:00.000Z');
      expect(getEarliestBookingStart(listingWith({}), NOW)).toBe(null);
    });

    it('refuses booking requests that start within the cutoff', () => {
      expect(request(new Date(NOW.getTime() + 23 * HOUR_MS))).toThrow(
        'The booking starts within the booking cutoff'
      );
      try {
        request(new Date(NOW.getTime() + 2 * HOUR_MS))();
      } catch (e) {
        expect(e.status).toBe(400);
        expect(e.data.errors[0].code).toBe('booking-cutoff');
      }
      expect(request(new Date(NOW.getTime() + 25 * HOUR_MS))).not.toThrow();
    });

    it('only checks booking requests', () => {
      expect(() =>
        assertBookingStartAfterCutoff({
          listing,
          transitionName: 'transition/accept',
          bookingStart: NOW,
          now: NOW,
        })
      ).not.toThrow();
    });
  });
});
