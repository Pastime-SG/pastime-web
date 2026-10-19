const log = require('../../log');
const { getLoyaltySummary } = require('../../services/loyalty');

/**
 * The signed-in customer's loyalty credits (see server/services/loyalty). The user comes from
 * the session (middleware.auth): customers only see their own credits.
 */

// GET /api/loyalty
const getSummary = (req, res) =>
  getLoyaltySummary(req.tokenUserId)
    .then(summary => res.status(200).json(summary))
    .catch(e => {
      log.error(e, 'loyalty-summary-failed', {});
      res.status(500).json({ status: 500, code: 'unknown' });
    });

module.exports = { getSummary };
