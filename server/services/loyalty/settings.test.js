const mockDoc = { data: null };
jest.mock('../firebase', () => ({
  FieldValue: { serverTimestamp: () => Date.parse('2026-11-03T10:00:00Z') },
  getFirestore: () => ({
    collection: () => ({
      doc: () => ({
        get: () => Promise.resolve({ exists: !!mockDoc.data, data: () => mockDoc.data }),
        set: data => {
          mockDoc.data = { ...mockDoc.data, ...data };
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

const {
  clearLoyaltySettingsCache,
  getLoyaltySettings,
  setLoyaltyEnabled,
  wasLoyaltyEnabledAt,
} = require('./settings');

describe('loyalty settings', () => {
  beforeEach(() => {
    mockDoc.data = null;
    clearLoyaltySettingsCache();
  });

  it('is off until an admin turns it on', async () => {
    expect((await getLoyaltySettings()).enabled).toBe(false);
    expect((await setLoyaltyEnabled(true, 'admin-1')).enabled).toBe(true);
    expect(mockDoc.data).toMatchObject({ enabled: true, changedBy: 'admin-1' });
  });

  it('only takes true or false', async () => {
    await expect(setLoyaltyEnabled('yes', 'admin-1')).rejects.toMatchObject({ status: 400 });
    await expect(setLoyaltyEnabled(1, 'admin-1')).rejects.toMatchObject({ status: 400 });
  });

  it('tells whether it was on at a given time', () => {
    const changedAt = Date.parse('2026-11-03T10:00:00Z');
    const off = { enabled: false, changedAt };
    expect(wasLoyaltyEnabledAt(off, '2026-11-03T09:00:00Z')).toBe(true);
    expect(wasLoyaltyEnabledAt(off, '2026-11-03T11:00:00Z')).toBe(false);
    const on = { enabled: true, changedAt };
    expect(wasLoyaltyEnabledAt(on, '2026-11-03T09:00:00Z')).toBe(false);
    expect(wasLoyaltyEnabledAt(on, '2026-11-03T11:00:00Z')).toBe(true);
    expect(wasLoyaltyEnabledAt({ enabled: true, changedAt: null }, '2020-01-01')).toBe(true);
  });
});
