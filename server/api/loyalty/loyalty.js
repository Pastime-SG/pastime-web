const log = require('../../log');
const { getLoyaltySummary } = require('../../services/loyalty');
const { getLoyaltySettings, setLoyaltyEnabled } = require('../../services/loyalty/settings');

/**
 * The signed-in customer's loyalty credits (see server/services/loyalty). The user comes from
 * the session (middleware.auth): customers only see their own credits.
 */

const sendError = (res, e, action) => {
  if (e.status && e.code) {
    return res.status(e.status).json({ status: e.status, code: e.code });
  }
  log.error(e, `loyalty-${action}-failed`, {});
  return res.status(500).json({ status: 500, code: 'unknown' });
};

// GET /api/loyalty: the signed-in customer's credits, and whether the program is on
const getSummary = (req, res) =>
  Promise.all([getLoyaltySummary(req.tokenUserId), getLoyaltySettings()])
    .then(([summary, settings]) => res.status(200).json({ ...summary, enabled: settings.enabled }))
    .catch(e => sendError(res, e, 'summary'));

// GET /api/loyalty/settings: whether the program is on (public: e.g. for the menu)
const getSettings = (req, res) =>
  getLoyaltySettings()
    .then(({ enabled }) => res.status(200).json({ enabled }))
    .catch(e => sendError(res, e, 'settings'));

// PUT /api/admin/loyalty/settings: turn the program on or off (admins only)
const updateSettings = (req, res) =>
  setLoyaltyEnabled(req.body?.enabled, req.tokenUserId)
    .then(({ enabled }) => res.status(200).json({ enabled }))
    .catch(e => sendError(res, e, 'update-settings'));

module.exports = { getSettings, getSummary, updateSettings };
