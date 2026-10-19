const { FieldValue, getFirestore } = require('../firebase');

/**
 * Promo codes, stored in Firestore:
 *
 *   promoCodes/{id} {
 *     code: 'SUMMER10',                 // what customers enter (uppercase)
 *     createdBy: 'merchant' | 'admin',
 *     providerId: '<user id>' | null,   // merchant codes apply to that merchant's listings
 *     createdById: '<user id>' | null,  // the admin who created an admin code
 *     discountType: 'percentage' | 'fixed',
 *     percentage: 10,                   // percentage codes (1-100)
 *     amount: 500, currency: 'SGD',     // fixed codes, in minor units
 *     maxUses: 100 | null,              // null: unlimited
 *     usesCount: 0,                     // increased when a booking uses the code
 *     expiresAt: Timestamp | null,
 *     active: true,
 *     createdAt, updatedAt
 *   }
 *
 * Merchant codes are in promoCodes, and marketplace-wide codes created by admins (users with
 * profile.metadata.isAdmin) in adminPromoCodes. Both have the same fields, and the same
 * redemptions and ledger subcollections. The document id contains the owner and the code
 * (merchant_<providerId>_<CODE>, admin_<CODE>), so the same code can't be created twice, and
 * creating a code is a single write that fails if it exists.
 */

const COLLECTION = 'promoCodes';
const ADMIN_COLLECTION = 'adminPromoCodes';
const CREATED_BY_MERCHANT = 'merchant';
const CREATED_BY_ADMIN = 'admin';
const DISCOUNT_PERCENTAGE = 'percentage';
const DISCOUNT_FIXED = 'fixed';

const CODE_PATTERN = /^[A-Z0-9_-]{3,20}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const promoCodeError = (status, code) => {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
};

const isWholeNumber = (value, min, max = Number.MAX_SAFE_INTEGER) =>
  Number.isInteger(value) && value >= min && value <= max;

/**
 * Code as stored and entered: trimmed and uppercase.
 *
 * @param {string} code
 * @returns {string}
 */
const normalizeCode = code => (typeof code === 'string' ? code.trim().toUpperCase() : '');

const merchantCodeId = (providerId, code) => `merchant_${providerId}_${code}`;
const adminCodeId = code => `admin_${code}`;

// Promo code ids are merchant_<providerId>_<CODE> or admin_<CODE>. Ids are checked before use,
// so that an id from a request can't point to another document path (e.g. 'a/redemptions/b').
const ID_PATTERN = /^(merchant_[A-Za-z0-9-]{1,64}_|admin_)[A-Z0-9_-]{3,20}$/;
const isPromoCodeId = id => typeof id === 'string' && ID_PATTERN.test(id);
// Redemption ids are UUIDs made by the server (see checkout.js)
const isRedemptionId = id =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

// The promo code document of the id: admin codes are in their own collection
const promoCodeRef = (db, id) => {
  if (!isPromoCodeId(id)) {
    throw promoCodeError(404, 'not-found');
  }
  return db.collection(id.startsWith('admin_') ? ADMIN_COLLECTION : COLLECTION).doc(id);
};

/**
 * Validated values of a merchant's promo code, or throws a 400 error with the reason.
 *
 * @param {Object} input From the web app
 * @param {Object} [options]
 * @param {boolean} [options.isNew] Validate the code too (it can't be changed later)
 * @param {Date} [options.now]
 * @returns {Object} Values to store (without timestamps and ownership)
 */
const validatePromoCodeInput = (input, { isNew = false, now = new Date() } = {}) => {
  const {
    code,
    discountType,
    percentage,
    amount,
    currency,
    maxUses = null,
    expiresAt = null,
    active = true,
  } = input || {};
  const values = {};

  if (isNew) {
    const normalized = normalizeCode(code);
    if (!CODE_PATTERN.test(normalized)) {
      throw promoCodeError(400, 'invalid-code');
    }
    values.code = normalized;
  }

  if (discountType === DISCOUNT_PERCENTAGE) {
    if (!isWholeNumber(percentage, 1, 100)) {
      throw promoCodeError(400, 'invalid-percentage');
    }
    Object.assign(values, { discountType, percentage, amount: null, currency: null });
  } else if (discountType === DISCOUNT_FIXED) {
    if (!isWholeNumber(amount, 1) || !CURRENCY_PATTERN.test(currency || '')) {
      throw promoCodeError(400, 'invalid-amount');
    }
    Object.assign(values, { discountType, amount, currency, percentage: null });
  } else {
    throw promoCodeError(400, 'invalid-discount-type');
  }

  if (maxUses !== null && !isWholeNumber(maxUses, 1)) {
    throw promoCodeError(400, 'invalid-max-uses');
  }
  values.maxUses = maxUses;

  if (expiresAt !== null) {
    const date = new Date(expiresAt);
    if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
      throw promoCodeError(400, 'invalid-expiry');
    }
    values.expiresAt = date;
  } else {
    values.expiresAt = null;
  }

  if (typeof active !== 'boolean') {
    throw promoCodeError(400, 'invalid-active');
  }
  values.active = active;
  return values;
};

/**
 * Promo code document as JSON for the web app (timestamps in milliseconds).
 *
 * @param {Object} doc Firestore document snapshot
 * @returns {Object}
 */
const serializePromoCode = doc => {
  const data = doc.data();
  const toMillis = value => (value?.toMillis ? value.toMillis() : value || null);
  return {
    id: doc.id,
    code: data.code,
    createdBy: data.createdBy,
    discountType: data.discountType,
    percentage: data.percentage ?? null,
    amount: data.amount ?? null,
    currency: data.currency ?? null,
    maxUses: data.maxUses ?? null,
    usesCount: data.usesCount || 0,
    expiresAt: toMillis(data.expiresAt),
    active: data.active !== false,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  };
};

/**
 * Who manages promo codes: a merchant (their own codes) or an admin (the marketplace's codes).
 * Every change checks that the code belongs to the owner.
 */
const merchantOwner = providerId => ({
  collection: COLLECTION,
  docId: code => merchantCodeId(providerId, code),
  fields: { createdBy: CREATED_BY_MERCHANT, providerId },
  owns: data => data.createdBy === CREATED_BY_MERCHANT && data.providerId === providerId,
  list: collection =>
    collection
      .where('providerId', '==', providerId)
      .where('createdBy', '==', CREATED_BY_MERCHANT)
      .get(),
});
const adminOwner = adminId => ({
  collection: ADMIN_COLLECTION,
  docId: adminCodeId,
  fields: { createdBy: CREATED_BY_ADMIN, providerId: null, createdById: adminId },
  owns: data => data.createdBy === CREATED_BY_ADMIN,
  list: collection => collection.get(),
});

// The owner's promo codes, newest first
const listPromoCodes = async owner => {
  const snapshot = await owner.list(getFirestore().collection(owner.collection));
  // Sorted here: ordering in the query would need a composite index
  return snapshot.docs.map(serializePromoCode).sort((a, b) => b.createdAt - a.createdAt);
};

// Create a promo code. Fails with 409 'code-exists' if the owner has it already.
const createPromoCode = async (owner, input) => {
  const values = validatePromoCodeInput(input, { isNew: true });
  const ref = getFirestore()
    .collection(owner.collection)
    .doc(owner.docId(values.code));
  try {
    await ref.create({
      ...values,
      ...owner.fields,
      usesCount: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    // gRPC ALREADY_EXISTS
    if (e.code === 6) {
      throw promoCodeError(409, 'code-exists');
    }
    throw e;
  }
  return serializePromoCode(await ref.get());
};

// The owner's promo code, or throws 404
const getOwnPromoCodeRef = async (owner, id) => {
  if (!isPromoCodeId(id)) {
    throw promoCodeError(404, 'not-found');
  }
  const ref = getFirestore()
    .collection(owner.collection)
    .doc(id);
  const doc = await ref.get();
  const data = doc.exists ? doc.data() : null;
  if (!data || !owner.owns(data)) {
    throw promoCodeError(404, 'not-found');
  }
  return { ref, data };
};

// Update a promo code. The code can't be changed. Once the code has been used, only its status,
// usage limit and expiry can change (not the discount).
const updatePromoCode = async (owner, id, input) => {
  const { ref, data } = await getOwnPromoCodeRef(owner, id);
  const usesCount = data.usesCount || 0;
  const values = validatePromoCodeInput(input);
  const changesDiscount =
    values.discountType !== data.discountType ||
    values.percentage !== (data.percentage ?? null) ||
    values.amount !== (data.amount ?? null) ||
    values.currency !== (data.currency ?? null);
  if (usesCount > 0 && changesDiscount) {
    throw promoCodeError(409, 'code-in-use');
  }
  if (values.maxUses !== null && values.maxUses < usesCount) {
    throw promoCodeError(400, 'max-uses-below-uses');
  }
  await ref.update({ ...values, updatedAt: FieldValue.serverTimestamp() });
  return serializePromoCode(await ref.get());
};

// Delete a promo code. Codes that have been used are kept for the history: they can be
// deactivated instead (409 'code-in-use').
const deletePromoCode = async (owner, id) => {
  const { ref, data } = await getOwnPromoCodeRef(owner, id);
  if ((data.usesCount || 0) > 0) {
    throw promoCodeError(409, 'code-in-use');
  }
  await ref.delete();
};

/**
 * The merchant's own promo codes, newest first.
 *
 * @param {string} providerId
 * @returns {Promise<Array<Object>>}
 */
const listMerchantPromoCodes = providerId => listPromoCodes(merchantOwner(providerId));

/**
 * Create a promo code for the merchant. Fails with 409 'code-exists' if they have it already.
 *
 * @param {string} providerId
 * @param {Object} input
 * @returns {Promise<Object>} The created promo code
 */
const createMerchantPromoCode = (providerId, input) =>
  createPromoCode(merchantOwner(providerId), input);

/**
 * Update the merchant's promo code (404 if it isn't theirs).
 *
 * @param {string} providerId
 * @param {string} id
 * @param {Object} input
 * @returns {Promise<Object>} The updated promo code
 */
const updateMerchantPromoCode = (providerId, id, input) =>
  updatePromoCode(merchantOwner(providerId), id, input);

/**
 * Delete the merchant's promo code (404 if it isn't theirs, 409 if it has been used).
 *
 * @param {string} providerId
 * @param {string} id
 */
const deleteMerchantPromoCode = (providerId, id) => deletePromoCode(merchantOwner(providerId), id);

/**
 * The marketplace's promo codes, created by admins, newest first. The caller must have checked
 * that the user is an admin (middleware.admin).
 *
 * @returns {Promise<Array<Object>>}
 */
const listAdminPromoCodes = () => listPromoCodes(adminOwner(null));

/**
 * Create a marketplace promo code. It applies to every listing, and the marketplace pays for
 * the discount (from its commission).
 *
 * @param {string} adminId The admin who creates it
 * @param {Object} input
 * @returns {Promise<Object>}
 */
const createAdminPromoCode = (adminId, input) => createPromoCode(adminOwner(adminId), input);

/**
 * @param {string} id
 * @param {Object} input
 * @returns {Promise<Object>}
 */
const updateAdminPromoCode = (id, input) => updatePromoCode(adminOwner(null), id, input);

/**
 * @param {string} id
 */
const deleteAdminPromoCode = id => deletePromoCode(adminOwner(null), id);

// ================ Promo codes at checkout ================ //

const REDEMPTIONS = 'redemptions';
// The code's history, only ever added to: a use (a booking was made with the code) and a
// returned use (the booking didn't go ahead). The entry id comes from the redemption, so the
// same entry is never written twice.
const LEDGER = 'ledger';
const LEDGER_USED = 'used';
const LEDGER_RETURNED = 'returned';
const ledgerEntry = (type, redemption, extra = {}) => {
  const { transactionId = null, discount = null, currency = null } = redemption;
  return {
    type,
    transactionId,
    discount,
    currency,
    ...extra,
    createdAt: FieldValue.serverTimestamp(),
  };
};

// Where the reading of booking events got to (see bookingEvents.js)
const SYNC_DOC = ['promoCodeSync', 'transactionEvents'];
const syncRef = db => db.collection(SYNC_DOC[0]).doc(SYNC_DOC[1]);

/**
 * A 400 error like the SDK's (see handleError), so that checkout can explain it: the code is in
 * data.errors[0].code ('promo-code-invalid', 'promo-code-expired' or 'promo-code-used-up').
 *
 * @param {string} code
 * @returns {Error}
 */
const checkoutError = code => {
  const error = new Error(code);
  error.status = 400;
  error.statusText = code;
  error.data = { errors: [{ status: 400, code }] };
  return error;
};

// Why the code can't be used now, or null
const getUnusableReason = (data, now) => {
  if (!data || data.active === false) {
    return 'promo-code-invalid';
  }
  const expiresAt = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : data.expiresAt;
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) {
    return 'promo-code-expired';
  }
  if (data.maxUses != null && (data.usesCount || 0) >= data.maxUses) {
    return 'promo-code-used-up';
  }
  return null;
};

/**
 * The promo code a customer entered at checkout, for a listing of the given provider: the
 * provider's own code, or else a marketplace-wide code created by an admin. Throws a checkout
 * error if there's no such code or it can't be used now.
 *
 * @param {Object} params
 * @param {string} params.code As entered
 * @param {string} params.providerId The listing's author
 * @param {Date} [params.now]
 * @returns {Promise<Object>} { id, code, createdBy, discountType, percentage, amount, currency }
 */
const findPromoCodeForBooking = async ({ code, providerId, now = new Date() }) => {
  const normalized = normalizeCode(code);
  if (!CODE_PATTERN.test(normalized)) {
    throw checkoutError('promo-code-invalid');
  }
  const db = getFirestore();
  const merchantDoc = await promoCodeRef(db, merchantCodeId(providerId, normalized)).get();
  const doc = merchantDoc.exists
    ? merchantDoc
    : await promoCodeRef(db, adminCodeId(normalized)).get();
  const data = doc.exists ? doc.data() : null;
  const reason = getUnusableReason(data, now);
  if (reason) {
    throw checkoutError(reason);
  }
  const { createdBy, discountType, percentage, amount, currency } = data;
  return { id: doc.id, code: data.code, createdBy, discountType, percentage, amount, currency };
};

/**
 * The discount of a promo code on an order total (minor units): a percentage of it, or a fixed
 * amount (at most the order total). A fixed amount in another currency doesn't apply.
 *
 * @param {Object} promoCode See findPromoCodeForBooking
 * @param {{amount: number, currency: string}} orderTotal
 * @returns {number} Discount in minor units
 */
const getPromoCodeDiscount = (promoCode, orderTotal) => {
  if (promoCode.discountType === DISCOUNT_PERCENTAGE) {
    return Math.round((orderTotal.amount * promoCode.percentage) / 100);
  }
  if (promoCode.currency !== orderTotal.currency) {
    throw checkoutError('promo-code-invalid');
  }
  return Math.min(promoCode.amount, orderTotal.amount);
};

/**
 * Reserve a use of the promo code before the booking is made. In one Firestore transaction, the
 * code is checked again (active, expiry, usage limit) and its use count increased, so the usage
 * limit holds even when customers check out at the same time. The use is recorded in the code's
 * redemptions, with the given id.
 *
 * @param {Object} params
 * @param {string} params.promoCodeId
 * @param {string} params.redemptionId Unique id for this use
 * @param {Object} params.details Stored with the use (customerId, providerId, listingId, discount, currency)
 * @param {Date} [params.now]
 */
const reservePromoCodeUse = ({ promoCodeId, redemptionId, details, now = new Date() }) => {
  const db = getFirestore();
  const codeRef = promoCodeRef(db, promoCodeId);
  const redemptionRef = codeRef.collection(REDEMPTIONS).doc(redemptionId);
  return db.runTransaction(async t => {
    const doc = await t.get(codeRef);
    const reason = getUnusableReason(doc.exists ? doc.data() : null, now);
    if (reason) {
      throw checkoutError(reason);
    }
    t.update(codeRef, { usesCount: FieldValue.increment(1) });
    t.set(redemptionRef, {
      ...details,
      status: 'reserved',
      createdAt: FieldValue.serverTimestamp(),
    });
  });
};

/**
 * The booking was made: the use is linked to the transaction.
 *
 * @param {string} promoCodeId
 * @param {string} redemptionId
 * @param {string} transactionId
 */
const confirmPromoCodeUse = (promoCodeId, redemptionId, transactionId) => {
  if (!isPromoCodeId(promoCodeId) || !isRedemptionId(redemptionId) || !transactionId) {
    return Promise.resolve();
  }
  const db = getFirestore();
  const codeRef = promoCodeRef(db, promoCodeId);
  const redemptionRef = codeRef.collection(REDEMPTIONS).doc(redemptionId);
  const ledgerRef = codeRef.collection(LEDGER).doc(`${redemptionId}_${LEDGER_USED}`);
  return db.runTransaction(async t => {
    const redemption = await t.get(redemptionRef);
    if (!redemption.exists || redemption.data().status !== 'reserved') {
      return;
    }
    t.update(redemptionRef, {
      status: 'used',
      transactionId,
      usedAt: FieldValue.serverTimestamp(),
    });
    t.set(ledgerRef, ledgerEntry(LEDGER_USED, { ...redemption.data(), transactionId }));
  });
};

/**
 * The booking didn't go ahead after it was made (declined, expired or cancelled): the use is
 * given back. The use stays in the code's history as cancelled. Only the booking that made the
 * use can give it back, and calling this again for the same use does nothing.
 *
 * @param {string} promoCodeId
 * @param {string} redemptionId
 * @param {string} transactionId The booking: must be the one the use was confirmed with
 * @param {string} [transactionState] E.g. 'state/declined'
 * @returns {Promise<boolean>} Whether a use was given back
 */
const cancelPromoCodeUse = (promoCodeId, redemptionId, transactionId, transactionState) => {
  if (!isPromoCodeId(promoCodeId) || !isRedemptionId(redemptionId) || !transactionId) {
    return Promise.resolve(false);
  }
  const db = getFirestore();
  const codeRef = promoCodeRef(db, promoCodeId);
  const redemptionRef = codeRef.collection(REDEMPTIONS).doc(redemptionId);
  const ledgerRef = codeRef.collection(LEDGER).doc(`${redemptionId}_${LEDGER_RETURNED}`);
  return db.runTransaction(async t => {
    const [code, redemption] = [await t.get(codeRef), await t.get(redemptionRef)];
    const { status, transactionId: usedBy } = redemption.exists ? redemption.data() : {};
    if (status !== 'used' || usedBy !== transactionId) {
      return false;
    }
    if (code.exists) {
      t.update(codeRef, { usesCount: FieldValue.increment(-1) });
    }
    t.update(redemptionRef, {
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp(),
      ...(transactionState ? { transactionState } : {}),
    });
    t.set(
      ledgerRef,
      ledgerEntry(LEDGER_RETURNED, redemption.data(), {
        transactionState: transactionState || null,
      })
    );
    return true;
  });
};

/**
 * The booking is finished (e.g. delivered or reviewed): the use is counted for good. Calling
 * this again for the same use does nothing.
 *
 * @param {string} promoCodeId
 * @param {string} redemptionId
 * @param {string} transactionId The booking: must be the one the use was confirmed with
 * @returns {Promise<boolean>} Whether the use was completed now
 */
const completePromoCodeUse = (promoCodeId, redemptionId, transactionId) => {
  if (!isPromoCodeId(promoCodeId) || !isRedemptionId(redemptionId) || !transactionId) {
    return Promise.resolve(false);
  }
  const db = getFirestore();
  const redemptionRef = promoCodeRef(db, promoCodeId)
    .collection(REDEMPTIONS)
    .doc(redemptionId);
  return db.runTransaction(async t => {
    const redemption = await t.get(redemptionRef);
    const { status, transactionId: usedBy } = redemption.exists ? redemption.data() : {};
    if (status !== 'used' || usedBy !== transactionId) {
      return false;
    }
    t.update(redemptionRef, { status: 'completed', completedAt: FieldValue.serverTimestamp() });
    return true;
  });
};

/**
 * The sequence id of the last booking event read, or null before the first read.
 *
 * @returns {Promise<number|null>}
 */
const getPromoCodeSyncPosition = async () => {
  const doc = await syncRef(getFirestore()).get();
  return doc.exists ? doc.data().lastSequenceId ?? null : null;
};

/**
 * Save the sequence id of the last booking event read.
 *
 * @param {number} lastSequenceId
 */
const setPromoCodeSyncPosition = lastSequenceId =>
  syncRef(getFirestore()).set({ lastSequenceId }, { merge: true });

/**
 * The history of the owner's promo code (newest first, at most 100): uses, and uses returned
 * when the booking didn't go ahead.
 *
 * @param {Object} owner See merchantOwner and adminOwner
 * @param {string} id Promo code id
 * @returns {Promise<Array<Object>>}
 */
const listPromoCodeLedger = async (owner, id) => {
  const { ref } = await getOwnPromoCodeRef(owner, id);
  const snapshot = await ref
    .collection(LEDGER)
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  const toMillis = value => (value?.toMillis ? value.toMillis() : value || null);
  return snapshot.docs.map(doc => {
    const { type, transactionId, transactionState, discount, currency, createdAt } = doc.data();
    return {
      id: doc.id,
      type,
      transactionId: transactionId || null,
      transactionState: transactionState || null,
      discount,
      currency,
      createdAt: toMillis(createdAt),
    };
  });
};

const listMerchantPromoCodeLedger = (providerId, id) =>
  listPromoCodeLedger(merchantOwner(providerId), id);
const listAdminPromoCodeLedger = id => listPromoCodeLedger(adminOwner(null), id);

/**
 * The booking wasn't made: the reserved use is given back.
 *
 * @param {string} promoCodeId
 * @param {string} redemptionId
 */
const releasePromoCodeUse = (promoCodeId, redemptionId) => {
  const db = getFirestore();
  const codeRef = promoCodeRef(db, promoCodeId);
  const redemptionRef = codeRef.collection(REDEMPTIONS).doc(redemptionId);
  return db.runTransaction(async t => {
    const redemption = await t.get(redemptionRef);
    if (redemption.exists && redemption.data().status === 'reserved') {
      t.update(codeRef, { usesCount: FieldValue.increment(-1) });
      t.delete(redemptionRef);
    }
  });
};

module.exports = {
  CREATED_BY_ADMIN,
  createAdminPromoCode,
  deleteAdminPromoCode,
  listAdminPromoCodeLedger,
  listAdminPromoCodes,
  updateAdminPromoCode,
  cancelPromoCodeUse,
  completePromoCodeUse,
  getPromoCodeSyncPosition,
  setPromoCodeSyncPosition,
  listMerchantPromoCodeLedger,
  CREATED_BY_MERCHANT,
  DISCOUNT_FIXED,
  DISCOUNT_PERCENTAGE,
  confirmPromoCodeUse,
  createMerchantPromoCode,
  deleteMerchantPromoCode,
  findPromoCodeForBooking,
  getPromoCodeDiscount,
  listMerchantPromoCodes,
  normalizeCode,
  releasePromoCodeUse,
  reservePromoCodeUse,
  serializePromoCode,
  updateMerchantPromoCode,
  validatePromoCodeInput,
};
