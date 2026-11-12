const express = require('express');
const middleware = require('../../middleware');
const { getSettings, getSummary, updateSettings } = require('./loyalty');

const router = express.Router();

const MINUTE_MS = 60 * 1000;
// Per IP address, before middleware.auth: a flood of requests doesn't reach the Sharetribe API
const ipLimit = middleware.createRateLimit({
  windowMs: MINUTE_MS,
  max: 120,
  keyFn: req => `ip:${req.ip}`,
});
// Per signed-in user, after middleware.auth
const readLimit = middleware.createRateLimit({ windowMs: MINUTE_MS, max: 60 });

router.use(ipLimit);

// The signed-in customer's credit balance, points and history (read only: credits change only
// with bookings, on the server)
router.get('/', middleware.auth, readLimit, getSummary);
// Whether the loyalty program is on (no user needed)
router.get('/settings', getSettings);

// Admins turn the loyalty program on or off (profile.metadata.isAdmin, checked on every request)
const writeLimit = middleware.createRateLimit({ windowMs: MINUTE_MS, max: 20 });
const adminRouter = express.Router();
adminRouter.use(ipLimit);
adminRouter.put('/settings', middleware.auth, middleware.admin, writeLimit, updateSettings);

module.exports = { router, adminRouter };
