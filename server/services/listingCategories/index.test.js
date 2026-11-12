// In-memory stand-in for the Firestore calls the service makes
const mockStore = new Map();
const mockDoc = path => ({
  get: () => Promise.resolve({ exists: mockStore.has(path), data: () => mockStore.get(path) }),
  set: (data, options) => {
    mockStore.set(path, options?.merge ? { ...mockStore.get(path), ...data } : data);
    return Promise.resolve();
  },
  delete: () => {
    mockStore.delete(path);
    return Promise.resolve();
  },
  mockPath: path,
});
const mockCollection = name => {
  const filters = [];
  const query = {
    doc: id => mockDoc(`${name}/${id}`),
    where: (field, op, value) => {
      filters.push([field, value]);
      return query;
    },
    select: () => query,
    get: () =>
      Promise.resolve({
        docs: [...mockStore.entries()]
          .filter(([key]) => key.startsWith(`${name}/`))
          .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
          .map(([key, data]) => ({ id: key.split('/').pop(), data: () => data })),
      }),
  };
  return query;
};
jest.mock('../firebase', () => ({
  FieldValue: { serverTimestamp: () => 'now' },
  getFirestore: () => ({
    collection: mockCollection,
    batch: () => {
      const writes = [];
      return {
        set: (ref, data) => writes.push([ref.mockPath, data]),
        commit: () => {
          writes.forEach(([path, data]) => mockStore.set(path, data));
          return Promise.resolve();
        },
      };
    },
  }),
}));
const mockListingsQuery = jest.fn();
jest.mock('../sharetribe/integration', () => ({
  getIntegrationSdk: () => ({ listings: { query: (...args) => mockListingsQuery(...args) } }),
}));

const {
  applyListingEvent,
  getActiveCategoryIds,
  resetListingCategoriesState,
  seedListingCategories,
} = require('./index');

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';
const ID_3 = '33333333-3333-4333-8333-333333333333';
const listing = (id, state, category) => ({
  id: { uuid: id },
  attributes: { state, publicData: { categoryLevel1: category } },
});
const event = (eventType, id, resourceAttributes) => ({
  attributes: {
    eventType,
    resourceId: { uuid: id },
    resource: resourceAttributes ? { id: { uuid: id }, attributes: resourceAttributes } : null,
  },
});

describe('listing categories', () => {
  beforeEach(() => {
    mockStore.clear();
    mockListingsQuery.mockReset();
    resetListingCategoriesState();
  });

  it('shows every category until the listings have been recorded', async () => {
    expect(await getActiveCategoryIds()).toBe(null);
  });

  it('records the existing listings once, then lists the categories with published listings', async () => {
    mockListingsQuery
      .mockResolvedValueOnce({
        data: {
          data: [listing(ID_1, 'published', 'painting'), listing(ID_2, 'closed', 'pottery')],
          meta: { totalPages: 2 },
        },
      })
      .mockResolvedValueOnce({
        data: { data: [listing(ID_3, 'published', 'painting')], meta: { totalPages: 2 } },
      });
    expect(await seedListingCategories()).toBe(3);
    expect(mockListingsQuery).toHaveBeenCalledTimes(2);
    // Only the fields needed
    expect(mockListingsQuery.mock.calls[0][0]['fields.listing']).toEqual([
      'state',
      'deleted',
      'publicData.categoryLevel1',
    ]);
    expect(await getActiveCategoryIds()).toEqual(['painting']);

    // Never again: no more Sharetribe calls
    resetListingCategoriesState();
    expect(await seedListingCategories()).toBe(null);
    expect(mockListingsQuery).toHaveBeenCalledTimes(2);
  });

  it('keeps the records up to date from listing events', async () => {
    mockListingsQuery.mockResolvedValue({ data: { data: [], meta: { totalPages: 1 } } });
    await seedListingCategories();
    expect(await getActiveCategoryIds()).toEqual([]);

    const pottery = { state: 'published', publicData: { categoryLevel1: 'pottery' } };
    expect(await applyListingEvent(event('listing/created', ID_1, pottery))).toBe(true);
    expect(await getActiveCategoryIds()).toEqual(['pottery']);

    // Closed: no longer counted
    await applyListingEvent(event('listing/updated', ID_1, { ...pottery, state: 'closed' }));
    expect(await getActiveCategoryIds()).toEqual([]);

    await applyListingEvent(event('listing/updated', ID_1, pottery));
    await applyListingEvent(event('listing/deleted', ID_1, null));
    expect(await getActiveCategoryIds()).toEqual([]);

    // Other events aren't listing events
    expect(await applyListingEvent(event('transaction/transitioned', ID_2, {}))).toBe(false);
    expect(await applyListingEvent(event('listing/updated', 'not/an-id', pottery))).toBe(false);
  });
});
