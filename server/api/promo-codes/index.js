const express = require('express');
const middleware = require('../../middleware');
const {
  adminListMerchant,
  adminListMerchantLedger,
  adminRemoveMerchant,
  adminSetMerchantActive,
  adminUpdateSettings,
  getSettings,
  adminCreate,
  adminList,
  adminListLedger,
  adminRemove,
  adminUpdate,
  create,
  list,
  listLedger,
  remove,
  update,
} = require('./promo-codes');

const router = express.Router();

const MINUTE_MS = 60 * 1000;
// Per IP address, before middleware.auth: a flood of requests doesn't reach the Sharetribe API
const ipLimit = middleware.createRateLimit({
  windowMs: MINUTE_MS,
  max: 120,
  keyFn: req => `ip:${req.ip}`,
});
// Per signed-in user, after middleware.auth. Changes are limited more than reads.
const readLimit = middleware.createRateLimit({ windowMs: MINUTE_MS, max: 60 });
const writeLimit = middleware.createRateLimit({ windowMs: MINUTE_MS, max: 20 });

router.use(ipLimit);

// The signed-in merchant's promo codes
// Whether studio codes are turned on (no user needed)
router.get('/settings', getSettings);
router.get('/', middleware.auth, readLimit, list);
router.get('/:id/ledger', middleware.auth, readLimit, listLedger);
router.post('/', middleware.auth, writeLimit, create);
router.patch('/:id', middleware.auth, writeLimit, update);
router.delete('/:id', middleware.auth, writeLimit, remove);

// The marketplace's promo codes: admins only (profile.metadata.isAdmin, checked on every request)
const adminRouter = express.Router();
adminRouter.use(ipLimit);
adminRouter.get('/', middleware.auth, middleware.admin, readLimit, adminList);
// Studio codes: admins see them all, turn them on or off, delete unused ones, see their history
adminRouter.get('/merchant', middleware.auth, middleware.admin, readLimit, adminListMerchant);
adminRouter.get(
  '/merchant/:id/ledger',
  middleware.auth,
  middleware.admin,
  readLimit,
  adminListMerchantLedger
);
adminRouter.patch(
  '/merchant/:id',
  middleware.auth,
  middleware.admin,
  writeLimit,
  adminSetMerchantActive
);
adminRouter.delete(
  '/merchant/:id',
  middleware.auth,
  middleware.admin,
  writeLimit,
  adminRemoveMerchant
);
// The switch for studio codes
adminRouter.put('/settings', middleware.auth, middleware.admin, writeLimit, adminUpdateSettings);
adminRouter.get('/:id/ledger', middleware.auth, middleware.admin, readLimit, adminListLedger);
adminRouter.post('/', middleware.auth, middleware.admin, writeLimit, adminCreate);
adminRouter.patch('/:id', middleware.auth, middleware.admin, writeLimit, adminUpdate);
adminRouter.delete('/:id', middleware.auth, middleware.admin, writeLimit, adminRemove);

module.exports = { router, adminRouter };
