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
  // Subcollections are stored with their path as the id
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
      // Firestore ids are the last part of the path
      id: id.split('/').pop(),
      exists: mockStore.has(id),
      data: () => mockStore.get(id),
    }),
  create: data => {
    if (mockStore.has(id)) {
      const error = new Error('ALREADY_EXISTS');
      error.code = 6;
      return Promise.reject(error);
    }
    mockStore.set(id, { ...data, createdAt: Date.now(), updatedAt: Date.now() });
    return Promise.resolve();
  },
  update: data => {
    mockApplyUpdate(id, data);
    return Promise.resolve();
  },
  delete: () => {
    mockStore.delete(id);
    return Promise.resolve();
  },
});
jest.mock('../firebase', () => ({
  FieldValue: { serverTimestamp: () => Date.now(), increment: n => ({ mockIncrement: n }) },
  getFirestore: () => ({
    // Transactions run on the same store: t.get/update/set/delete on document refs
    runTransaction: fn =>
      fn({
        get: ref => ref.get(),
        update: (ref, data) => mockApplyUpdate(ref.mockId, data),
        set: (ref, data, options) =>
          options?.merge ? mockApplyUpdate(ref.mockId, data) : mockStore.set(ref.mockId, data),
        delete: ref => mockStore.delete(ref.mockId),
      }),
    collection: name => {
      const filters = [];
      const query = {
        doc: id => mockDocRef(name === 'promoCodes' ? id : `${name}/${id}`),
        where: (field, op, value) => {
          filters.push([field, value]);
          return query;
        },
        get: () =>
          Promise.resolve({
            docs: [...mockStore.entries()]
              .filter(([key]) =>
                name === 'promoCodes'
                  ? !key.includes('/')
                  : key.startsWith(`${name}/`) && key.split('/').length === 2
              )
              .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
              .map(([id, data]) => ({ id: id.split('/').pop(), data: () => data })),
          }),
      };
      return query;
    },
  }),
}));

const {
  createMerchantPromoCode,
  deleteMerchantPromoCode,
  listMerchantPromoCodes,
  findPromoCodeForBooking,
  getPromoCodeDiscount,
  releasePromoCodeUse,
  reservePromoCodeUse,
  updateMerchantPromoCode,
  validatePromoCodeInput,
} = require('./index');

const percentageCode = { code: ' summer10 ', discountType: 'percentage', percentage: 10 };

describe('promo codes', () => {
  beforeEach(() => mockStore.clear());

  describe('validatePromoCodeInput', () => {
    it('normalizes the code and keeps the discount', () => {
      expect(validatePromoCodeInput(percentageCode, { isNew: true })).toMatchObject({
        code: 'SUMMER10',
        discountType: 'percentage',
        percentage: 10,
        amount: null,
        maxUses: null,
        expiresAt: null,
        active: true,
      });
    });

    it('rejects invalid values', () => {
      const invalid = (input, code) =>
        expect(() => validatePromoCodeInput(input, { isNew: true })).toThrow(code);
      invalid({ ...percentageCode, code: 'a b' }, 'invalid-code');
      invalid({ ...percentageCode, percentage: 0 }, 'invalid-percentage');
      invalid({ code: 'FIVE', discountType: 'fixed', amount: 500 }, 'invalid-amount');
      invalid({ ...percentageCode, maxUses: 0 }, 'invalid-max-uses');
      invalid({ ...percentageCode, expiresAt: '2000-01-01T00:00:00Z' }, 'invalid-expiry');
    });
  });

  it("creates, lists and deletes a merchant's codes", async () => {
    const created = await createMerchantPromoCode('provider-1', percentageCode);
    expect(created).toMatchObject({ id: 'merchant_provider-1_SUMMER10', createdBy: 'merchant' });
    await expect(createMerchantPromoCode('provider-1', percentageCode)).rejects.toThrow(
      'code-exists'
    );
    // Another merchant can use the same code
    await createMerchantPromoCode('provider-2', percentageCode);

    expect((await listMerchantPromoCodes('provider-1')).map(c => c.code)).toEqual(['SUMMER10']);
    await deleteMerchantPromoCode('provider-1', created.id);
    expect(await listMerchantPromoCodes('provider-1')).toEqual([]);
  });

  it("doesn't let a merchant change another merchant's code", async () => {
    const created = await createMerchantPromoCode('provider-1', percentageCode);
    await expect(
      updateMerchantPromoCode('provider-2', created.id, { ...percentageCode, active: false })
    ).rejects.toThrow('not-found');
    await expect(deleteMerchantPromoCode('provider-2', created.id)).rejects.toThrow('not-found');
  });

  it('keeps used codes: no deleting, no discount changes, limit not below the uses', async () => {
    const created = await createMerchantPromoCode('provider-1', percentageCode);
    mockStore.get(created.id).usesCount = 3;

    await expect(deleteMerchantPromoCode('provider-1', created.id)).rejects.toThrow('code-in-use');
    await expect(
      updateMerchantPromoCode('provider-1', created.id, { ...percentageCode, percentage: 20 })
    ).rejects.toThrow('code-in-use');
    await expect(
      updateMerchantPromoCode('provider-1', created.id, { ...percentageCode, maxUses: 2 })
    ).rejects.toThrow('max-uses-below-uses');

    const deactivated = await updateMerchantPromoCode('provider-1', created.id, {
      ...percentageCode,
      active: false,
    });
    expect(deactivated.active).toBe(false);
  });

  describe('at checkout', () => {
    it("finds the provider's code, or else an admin's code", async () => {
      await createMerchantPromoCode('provider-1', percentageCode);
      mockStore.set('adminPromoCodes/admin_WELCOME', {
        code: 'WELCOME',
        createdBy: 'admin',
        discountType: 'fixed',
        amount: 500,
        currency: 'SGD',
        active: true,
      });

      const own = await findPromoCodeForBooking({ code: 'summer10', providerId: 'provider-1' });
      expect(own).toMatchObject({ id: 'merchant_provider-1_SUMMER10', createdBy: 'merchant' });
      const admin = await findPromoCodeForBooking({ code: 'WELCOME', providerId: 'provider-1' });
      expect(admin.createdBy).toBe('admin');
      // Another provider's code doesn't work on this provider's listings
      await expect(
        findPromoCodeForBooking({ code: 'SUMMER10', providerId: 'provider-2' })
      ).rejects.toThrow('promo-code-invalid');
    });

    it('works out the discount', () => {
      const total = { amount: 5000, currency: 'SGD' };
      expect(getPromoCodeDiscount({ discountType: 'percentage', percentage: 10 }, total)).toBe(500);
      expect(
        getPromoCodeDiscount({ discountType: 'fixed', amount: 9000, currency: 'SGD' }, total)
      ).toBe(5000);
      expect(() =>
        getPromoCodeDiscount({ discountType: 'fixed', amount: 500, currency: 'USD' }, total)
      ).toThrow('promo-code-invalid');
    });

    it('counts uses up to the limit, and gives back a use that was not needed', async () => {
      const created = await createMerchantPromoCode('provider-1', {
        ...percentageCode,
        maxUses: 1,
      });
      const reserve = redemptionId =>
        reservePromoCodeUse({ promoCodeId: created.id, redemptionId, details: {} });

      await reserve('r1');
      expect(mockStore.get(created.id).usesCount).toBe(1);
      await expect(reserve('r2')).rejects.toThrow('promo-code-used-up');

      await releasePromoCodeUse(created.id, 'r1');
      expect(mockStore.get(created.id).usesCount).toBe(0);
      await reserve('r3');
      expect(mockStore.get(created.id).usesCount).toBe(1);
    });
  });

  describe('after the booking', () => {
    const {
      cancelPromoCodeUse,
      completePromoCodeUse,
      confirmPromoCodeUse,
      listMerchantPromoCodeLedger,
    } = require('./index');

    it('gives a use back once when the booking does not go ahead, completes finished ones', async () => {
      const created = await createMerchantPromoCode('provider-1', percentageCode);
      const details = { discount: 2500, currency: 'SGD' };
      await reservePromoCodeUse({ promoCodeId: created.id, redemptionId: 'r1', details });
      await reservePromoCodeUse({ promoCodeId: created.id, redemptionId: 'r2', details });
      await confirmPromoCodeUse(created.id, 'r1', 'tx-1');
      await confirmPromoCodeUse(created.id, 'r2', 'tx-2');
      expect(mockStore.get(created.id).usesCount).toBe(2);

      expect(await cancelPromoCodeUse(created.id, 'r1', 'state/declined')).toBe(true);
      expect(await cancelPromoCodeUse(created.id, 'r1', 'state/declined')).toBe(false);
      expect(mockStore.get(created.id).usesCount).toBe(1);
      expect(mockStore.get(`${created.id}/redemptions/r1`).status).toBe('cancelled');

      expect(await completePromoCodeUse(created.id, 'r2')).toBe(true);
      expect(mockStore.get(created.id).usesCount).toBe(1);
      expect(mockStore.get(`${created.id}/redemptions/r2`).status).toBe('completed');
    });

    it('keeps a ledger of uses and returned uses, newest first, for the owner only', async () => {
      const created = await createMerchantPromoCode('provider-1', percentageCode);
      const details = { discount: 2500, currency: 'SGD' };
      await reservePromoCodeUse({ promoCodeId: created.id, redemptionId: 'r1', details });
      await confirmPromoCodeUse(created.id, 'r1', 'tx-1');
      // Confirming again doesn't add a second use
      await confirmPromoCodeUse(created.id, 'r1', 'tx-1');
      await cancelPromoCodeUse(created.id, 'r1', 'state/expired');
      await cancelPromoCodeUse(created.id, 'r1', 'state/expired');

      const ledger = await listMerchantPromoCodeLedger('provider-1', created.id);
      expect(ledger.map(e => [e.type, e.transactionId, e.transactionState])).toEqual([
        ['returned', 'tx-1', 'state/expired'],
        ['used', 'tx-1', null],
      ]);
      expect(ledger[1]).toMatchObject({ discount: 2500, currency: 'SGD' });
      await expect(listMerchantPromoCodeLedger('provider-2', created.id)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('admin codes', () => {
    const {
      createAdminPromoCode,
      deleteAdminPromoCode,
      listAdminPromoCodes,
      listMerchantPromoCodeLedger,
      updateAdminPromoCode,
    } = require('./index');

    it('are kept apart from merchant codes', async () => {
      const merchantCode = await createMerchantPromoCode('provider-1', percentageCode);
      const adminCode = await createAdminPromoCode('admin-1', percentageCode);
      expect(adminCode).toMatchObject({ id: 'admin_SUMMER10', createdBy: 'admin' });
      expect(mockStore.get('adminPromoCodes/admin_SUMMER10')).toMatchObject({
        createdBy: 'admin',
        createdById: 'admin-1',
        providerId: null,
      });
      expect((await listAdminPromoCodes()).map(c => c.id)).toEqual(['admin_SUMMER10']);
      expect((await listMerchantPromoCodes('provider-1')).map(c => c.id)).toEqual([
        merchantCode.id,
      ]);

      // A merchant can't reach an admin code, and the admin routes can't reach merchant codes
      await expect(
        updateMerchantPromoCode('provider-1', adminCode.id, percentageCode)
      ).rejects.toMatchObject({ status: 404 });
      await expect(listMerchantPromoCodeLedger('provider-1', adminCode.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(updateAdminPromoCode(merchantCode.id, percentageCode)).rejects.toMatchObject({
        status: 404,
      });
      await expect(deleteAdminPromoCode(merchantCode.id)).rejects.toMatchObject({ status: 404 });

      await deleteAdminPromoCode(adminCode.id);
      expect(await listAdminPromoCodes()).toEqual([]);
    });

    it('ignores fields that only the server sets', async () => {
      const created = await createMerchantPromoCode('provider-1', {
        ...percentageCode,
        createdBy: 'admin',
        providerId: 'provider-2',
        usesCount: -100,
      });
      expect(mockStore.get(created.id)).toMatchObject({
        createdBy: 'merchant',
        providerId: 'provider-1',
        usesCount: 0,
      });
    });

    it("rejects ids that aren't promo code ids", async () => {
      const created = await createMerchantPromoCode('provider-1', percentageCode);
      await expect(
        updateMerchantPromoCode('provider-1', `${created.id}/redemptions/r1`, percentageCode)
      ).rejects.toMatchObject({ status: 404 });
      await expect(deleteAdminPromoCode('../promoCodes/x')).rejects.toMatchObject({ status: 404 });
    });
  });
});
