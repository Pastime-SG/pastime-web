const express = require('express');
const middleware = require('../../middleware');
const reschedule = require('./reschedule');

const router = express.Router();

// POST /api/reschedule: request, counter, accept or decline a new time for an accepted booking
router.post('/', middleware.auth, reschedule);

module.exports = router;
