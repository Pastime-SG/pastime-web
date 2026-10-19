const express = require('express');
const middleware = require('../../middleware');
const cancel = require('./cancel');

const router = express.Router();

// POST /api/cancel: preview or make a customer's cancellation of an accepted booking
router.post('/', middleware.auth, cancel);

module.exports = router;
