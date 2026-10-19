const express = require('express');
const middleware = require('../../middleware');
const {
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
router.get('/', middleware.auth, readLimit, list);
router.get('/:id/ledger', middleware.auth, readLimit, listLedger);
router.post('/', middleware.auth, writeLimit, create);
router.patch('/:id', middleware.auth, writeLimit, update);
router.delete('/:id', middleware.auth, writeLimit, remove);

// The marketplace's promo codes: admins only (profile.metadata.isAdmin, checked on every request)
const adminRouter = express.Router();
adminRouter.use(ipLimit);
adminRouter.get('/', middleware.auth, middleware.admin, readLimit, adminList);
adminRouter.get('/:id/ledger', middleware.auth, middleware.admin, readLimit, adminListLedger);
adminRouter.post('/', middleware.auth, middleware.admin, writeLimit, adminCreate);
adminRouter.patch('/:id', middleware.auth, middleware.admin, writeLimit, adminUpdate);
adminRouter.delete('/:id', middleware.auth, middleware.admin, writeLimit, adminRemove);

module.exports = { router, adminRouter };
