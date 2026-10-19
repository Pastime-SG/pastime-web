const express = require('express');
const middleware = require('../../middleware');
const { getSummary } = require('./loyalty');

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

module.exports = router;
