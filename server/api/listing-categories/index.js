const express = require('express');
const middleware = require('../../middleware');
const { getActive } = require('./listing-categories');

const router = express.Router();

// Per IP address: public endpoint
const ipLimit = middleware.createRateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyFn: req => `ip:${req.ip}`,
});

// The categories with published listings, for the hero search bar (no user needed)
router.get('/active', ipLimit, getActive);

module.exports = router;
