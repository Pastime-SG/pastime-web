const express = require('express');
const middleware = require('../../middleware');
const { listPayouts } = require('./platform-payouts');

const MINUTE_MS = 60 * 1000;
// Per IP address, before middleware.auth
const ipLimit = middleware.createRateLimit({
  windowMs: MINUTE_MS,
  max: 60,
  keyFn: req => `ip:${req.ip}`,
});
const readLimit = middleware.createRateLimit({ windowMs: MINUTE_MS, max: 30 });

// Admins only (profile.metadata.isAdmin, checked on every request)
const adminRouter = express.Router();
adminRouter.use(ipLimit);
adminRouter.get('/', middleware.auth, middleware.admin, readLimit, listPayouts);

module.exports = { adminRouter };
