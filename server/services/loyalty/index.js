const { FieldValue, getFirestore } = require('../firebase');

/**
 * Loyalty credits for customers, stored in Firestore:
 *
 *   loyaltyAccounts/{customerId} {
 *     creditBalance: 300,      // credits to use at checkout, in minor units ($3.00)
 *     points: 1000,            // amount spent towards the next credit, in minor units ($10.00)
 *     currency: 'SGD',
 *     updatedAt
 *   }
 *   loyaltyAccounts/{customerId}/ledger/{id} {
 *     type: 'earned' | 'spent' | 'returned',
 *     amount,                  // credits, in minor units
 *     currency, transactionId, createdAt,
 *     paidAmount, points       // 'earned': what the booking cost and the points after it
 *   }
 *
 * Every $50 paid for a finished booking earns $1 of credit. Credits are taken from the balance
 * when a booking is requested with them, and given back if the booking doesn't go ahead. The
 * ledger is only ever added to (a spent entry is removed only if the booking request failed),
 * and its ids come from the booking, so the same entry is never written twice.
 */

const ACCOUNTS = 'loyaltyAccounts';
const LEDGER = 'ledger';
// Every $50 paid earns $1 of credit (minor units)
const SPEND_PER_CREDIT = 5000;
const CREDIT_PER_SPEND = 100;

const LEDGER_EARNED = 'earned';
const LEDGER_SPENT = 'spent';
const LEDGER_RETURNED = 'returned';

const accountRef = (db, customerId) => {
  // Sharetribe user ids: nothing that could point to another document path
  if (typeof customerId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(customerId)) {
    throw new Error('Invalid customer id');
  }
  return db.collection(ACCOUNTS).doc(customerId);
};
const ledgerRef = (db, customerId, id) =>
  accountRef(db, customerId)
    .collection(LEDGER)
    .doc(id);

/**
 * A 400 error like the SDK's (see handleError), so that checkout can explain it.
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

const toMillis = value => (value?.toMillis ? value.toMillis() : value || null);

const serializeAccount = data => ({
  creditBalance: data?.creditBalance || 0,
  points: data?.points || 0,
  currency: data?.currency || null,
  spendPerCredit: SPEND_PER_CREDIT,
  creditPerSpend: CREDIT_PER_SPEND,
});

/**
 * The customer's credit balance and points (zero if they have no account yet).
 *
 * @param {string} customerId
 * @returns {Promise<Object>} { creditBalance, points, currency, spendPerCredit, creditPerSpend }
 */
const getLoyaltyAccount = async customerId => {
  const doc = await accountRef(getFirestore(), customerId).get();
  return serializeAccount(doc.exists ? doc.data() : null);
};

/**
 * The customer's account and their latest ledger entries (newest first, at most 50).
 *
 * @param {string} customerId
 * @returns {Promise<{account: Object, ledger: Array<Object>}>}
 */
const getLoyaltySummary = async customerId => {
  const db = getFirestore();
  const [doc, snapshot] = await Promise.all([
    accountRef(db, customerId).get(),
    accountRef(db, customerId)
      .collection(LEDGER)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get(),
  ]);
  const ledger = snapshot.docs.map(entry => {
    const { type, amount, currency, transactionId, paidAmount, createdAt } = entry.data();
    return {
      id: entry.id,
      type,
      amount: amount || 0,
      currency: currency || null,
      transactionId: transactionId || null,
      paidAmount: paidAmount ?? null,
      createdAt: toMillis(createdAt),
    };
  });
  return { account: serializeAccount(doc.exists ? doc.data() : null), ledger };
};

/**
 * Take credits from the customer's balance for a booking request. In one Firestore transaction
 * the balance is checked and lowered, so credits can't be spent twice.
 *
 * @param {Object} params
 * @param {string} params.customerId
 * @param {string} params.redemptionId Unique id for this use of credits
 * @param {number} params.amount Minor units
 * @param {string} params.currency
 */
const spendCredits = ({ customerId, redemptionId, amount, currency }) => {
  const db = getFirestore();
  const ref = accountRef(db, customerId);
  const entryRef = ledgerRef(db, customerId, `${redemptionId}_${LEDGER_SPENT}`);
  return db.runTransaction(async t => {
    const doc = await t.get(ref);
    const data = doc.exists ? doc.data() : {};
    if (!(amount > 0) || (data.creditBalance || 0) < amount || data.currency !== currency) {
      throw checkoutError('loyalty-credits-unavailable');
    }
    t.update(ref, {
      creditBalance: FieldValue.increment(-amount),
      updatedAt: FieldValue.serverTimestamp(),
    });
    t.set(entryRef, {
      type: LEDGER_SPENT,
      amount,
      currency,
      transactionId: null,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
};

/**
 * The booking was made: the spent credits are linked to the transaction.
 *
 * @param {string} customerId
 * @param {string} redemptionId
 * @param {string} transactionId
 */
const confirmSpentCredits = (customerId, redemptionId, transactionId) =>
  ledgerRef(getFirestore(), customerId, `${redemptionId}_${LEDGER_SPENT}`).update({
    transactionId,
  });

/**
 * The booking request failed: the credits go back, and the spent entry is removed.
 *
 * @param {string} customerId
 * @param {string} redemptionId
 */
const releaseSpentCredits = (customerId, redemptionId) => {
  const db = getFirestore();
  const ref = accountRef(db, customerId);
  const entryRef = ledgerRef(db, customerId, `${redemptionId}_${LEDGER_SPENT}`);
  return db.runTransaction(async t => {
    const entry = await t.get(entryRef);
    if (!entry.exists || entry.data().transactionId) {
      return;
    }
    t.update(ref, {
      creditBalance: FieldValue.increment(entry.data().amount),
      updatedAt: FieldValue.serverTimestamp(),
    });
    t.delete(entryRef);
  });
};

/**
 * The booking didn't go ahead (declined, expired or cancelled): the credits it used go back.
 * Calling this again for the same booking does nothing.
 *
 * @param {string} customerId
 * @param {string} redemptionId
 * @param {string} [transactionId]
 * @returns {Promise<boolean>} Whether credits were given back now
 */
const returnCredits = (customerId, redemptionId, transactionId = null) => {
  const db = getFirestore();
  const ref = accountRef(db, customerId);
  const spentRef = ledgerRef(db, customerId, `${redemptionId}_${LEDGER_SPENT}`);
  const returnedRef = ledgerRef(db, customerId, `${redemptionId}_${LEDGER_RETURNED}`);
  return db.runTransaction(async t => {
    const [spent, returned] = [await t.get(spentRef), await t.get(returnedRef)];
    if (!spent.exists || returned.exists) {
      return false;
    }
    const { amount, currency } = spent.data();
    t.update(ref, {
      creditBalance: FieldValue.increment(amount),
      updatedAt: FieldValue.serverTimestamp(),
    });
    t.set(returnedRef, {
      type: LEDGER_RETURNED,
      amount,
      currency,
      transactionId: transactionId || spent.data().transactionId || null,
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
};

/**
 * Credits and points after paying an amount: every SPEND_PER_CREDIT earns CREDIT_PER_SPEND,
 * and the rest is kept as points towards the next credit.
 *
 * @param {number} points Points before (minor units)
 * @param {number} paidAmount Minor units
 * @returns {{earned: number, points: number}}
 */
const getEarnedCredits = (points, paidAmount) => {
  const total = (points || 0) + Math.max(0, Math.round(paidAmount || 0));
  return {
    earned: Math.floor(total / SPEND_PER_CREDIT) * CREDIT_PER_SPEND,
    points: total % SPEND_PER_CREDIT,
  };
};

/**
 * The booking is finished: the customer earns credits for what they paid. Calling this again
 * for the same booking does nothing.
 *
 * @param {Object} params
 * @param {string} params.customerId
 * @param {string} params.transactionId
 * @param {number} params.paidAmount What the customer paid (minor units)
 * @param {string} params.currency
 * @returns {Promise<number|null>} Credits earned now, or null if this booking earned already
 */
const earnCredits = ({ customerId, transactionId, paidAmount, currency }) => {
  const db = getFirestore();
  const ref = accountRef(db, customerId);
  const entryRef = ledgerRef(db, customerId, `${transactionId}_${LEDGER_EARNED}`);
  return db.runTransaction(async t => {
    const [account, entry] = [await t.get(ref), await t.get(entryRef)];
    const data = account.exists ? account.data() : null;
    // One currency per account (the marketplace's)
    if (entry.exists || (data?.currency && data.currency !== currency)) {
      return null;
    }
    const { earned, points } = getEarnedCredits(data?.points, paidAmount);
    t.set(
      ref,
      {
        creditBalance: FieldValue.increment(earned),
        points,
        currency,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    t.set(entryRef, {
      type: LEDGER_EARNED,
      amount: earned,
      currency,
      transactionId,
      paidAmount,
      points,
      createdAt: FieldValue.serverTimestamp(),
    });
    return earned;
  });
};

module.exports = {
  CREDIT_PER_SPEND,
  SPEND_PER_CREDIT,
  confirmSpentCredits,
  earnCredits,
  getEarnedCredits,
  getLoyaltyAccount,
  getLoyaltySummary,
  releaseSpentCredits,
  returnCredits,
  spendCredits,
};
