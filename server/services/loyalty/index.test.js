// In-memory stand-in for the few Firestore calls the service makes
const mockStore = new Map();
const mockApplyUpdate = (id, data) => {
  const current = mockStore.get(id) || {};
  const next = { ...current };
  Object.entries(data).forEach(([key, value]) => {
    next[key] = value?.mockIncrement != null ? (current[key] || 0) + value.mockIncrement : value;
  });
  mockStore.set(id, next);
};
const mockDocRef = id => ({
  mockId: id,
  collection: name => {
    const prefix = `${id}/${name}/`;
    const query = {
      doc: subId => mockDocRef(`${prefix}${subId}`),
      orderBy: () => query,
      limit: () => query,
      get: () =>
        Promise.resolve({
          docs: [...mockStore.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .reverse()
            .map(([key, data]) => ({ id: key.slice(prefix.length), data: () => data })),
        }),
    };
    return query;
  },
  get: () =>
    Promise.resolve({
      id: id.split('/').pop(),
      exists: mockStore.has(id),
      data: () => mockStore.get(id),
    }),
  update: data => {
    mockApplyUpdate(id, data);
    return Promise.resolve();
  },
});
jest.mock('../firebase', () => ({
  FieldValue: { serverTimestamp: () => Date.now(), increment: n => ({ mockIncrement: n }) },
  getFirestore: () => ({
    runTransaction: fn =>
      fn({
        get: ref => ref.get(),
        update: (ref, data) => mockApplyUpdate(ref.mockId, data),
        set: (ref, data, options) => {
          if (options?.merge) {
            mockApplyUpdate(ref.mockId, data);
          } else {
            mockStore.set(ref.mockId, {});
            mockApplyUpdate(ref.mockId, data);
          }
        },
        delete: ref => mockStore.delete(ref.mockId),
      }),
    collection: name => ({ doc: id => mockDocRef(`${name}/${id}`) }),
  }),
}));

const {
  earnCredits,
  getEarnedCredits,
  getLoyaltyAccount,
  getLoyaltySummary,
  releaseSpentCredits,
  returnCredits,
  spendCredits,
  confirmSpentCredits,
} = require('./index');

const earn = (transactionId, paidAmount) =>
  earnCredits({ customerId: 'customer-1', transactionId, paidAmount, currency: 'SGD' });
const spend = (redemptionId, amount) =>
  spendCredits({ customerId: 'customer-1', redemptionId, amount, currency: 'SGD' });

describe('loyalty credits', () => {
  beforeEach(() => mockStore.clear());

  it('earns $1 for every $50 paid, and keeps the rest as points', () => {
    expect(getEarnedCredits(0, 6000)).toEqual({ earned: 100, points: 1000 });
    expect(getEarnedCredits(1000, 4000)).toEqual({ earned: 100, points: 0 });
    expect(getEarnedCredits(0, 4999)).toEqual({ earned: 0, points: 4999 });
    expect(getEarnedCredits(0, 15000)).toEqual({ earned: 300, points: 0 });
  });

  it('earns once per booking, carrying points over', async () => {
    expect(await earn('tx-1', 6000)).toBe(100);
    expect(await earn('tx-1', 6000)).toBe(null);
    expect(await getLoyaltyAccount('customer-1')).toMatchObject({
      creditBalance: 100,
      points: 1000,
      currency: 'SGD',
    });
    expect(await earn('tx-2', 4000)).toBe(100);
    expect(await getLoyaltyAccount('customer-1')).toMatchObject({ creditBalance: 200, points: 0 });
  });

  it("can't spend more than the balance", async () => {
    await earn('tx-1', 10000);
    await expect(spend('r1', 300)).rejects.toMatchObject({
      status: 400,
      data: { errors: [{ code: 'loyalty-credits-unavailable' }] },
    });
    await expect(spend('r1', 0)).rejects.toMatchObject({ status: 400 });
    await spend('r1', 200);
    expect((await getLoyaltyAccount('customer-1')).creditBalance).toBe(0);
    await expect(spend('r2', 100)).rejects.toMatchObject({ status: 400 });
  });

  it('gives the credits back if the request fails, removing the spent entry', async () => {
    await earn('tx-1', 10000);
    await spend('r1', 150);
    await releaseSpentCredits('customer-1', 'r1');
    expect((await getLoyaltyAccount('customer-1')).creditBalance).toBe(200);
    const { ledger } = await getLoyaltySummary('customer-1');
    expect(ledger.map(e => e.type)).toEqual(['earned']);
  });

  it('gives the credits back once when the booking does not go ahead', async () => {
    await earn('tx-1', 10000);
    await spend('r1', 150);
    await confirmSpentCredits('customer-1', 'r1', 'tx-9');
    // A made booking isn't released by a failed request handler
    await releaseSpentCredits('customer-1', 'r1');
    expect((await getLoyaltyAccount('customer-1')).creditBalance).toBe(50);

    expect(await returnCredits('customer-1', 'r1', 'tx-9')).toBe(true);
    expect(await returnCredits('customer-1', 'r1', 'tx-9')).toBe(false);
    expect((await getLoyaltyAccount('customer-1')).creditBalance).toBe(200);
    const { ledger } = await getLoyaltySummary('customer-1');
    expect(ledger.map(e => [e.type, e.amount, e.transactionId])).toEqual([
      ['returned', 150, 'tx-9'],
      ['spent', 150, 'tx-9'],
      ['earned', 200, 'tx-1'],
    ]);
  });

  it("rejects customer ids that aren't user ids", async () => {
    await expect(getLoyaltyAccount('a/ledger/b')).rejects.toThrow('Invalid customer id');
  });
});
