const log = require('../../log');
const {
  createAdminPromoCode,
  createMerchantPromoCode,
  deleteAdminPromoCode,
  listAdminPromoCodeLedger,
  listAdminPromoCodes,
  updateAdminPromoCode,
  deleteMerchantPromoCode,
  listMerchantPromoCodeLedger,
  listMerchantPromoCodes,
  updateMerchantPromoCode,
} = require('../../services/promoCodes');

/**
 * The signed-in merchant's promo codes (see server/services/promoCodes). The user comes from the
 * session (middleware.auth): merchants only see and change their own codes.
 *
 * Errors: { status, code }, e.g. 400 'invalid-code', 404 'not-found', 409 'code-exists' or
 * 'code-in-use'.
 */

const sendError = (res, e, action) => {
  if (e.status && e.code) {
    return res.status(e.status).json({ status: e.status, code: e.code });
  }
  log.error(e, `promo-codes-${action}-failed`, {});
  return res.status(500).json({ status: 500, code: 'unknown' });
};

/**
 * Handlers for the merchant's own codes (/api/promo-codes) or, for admins, the marketplace's
 * codes (/api/admin/promo-codes, behind middleware.admin).
 */

// GET /api/promo-codes
const list = (req, res) =>
  listMerchantPromoCodes(req.tokenUserId)
    .then(promoCodes => res.status(200).json({ promoCodes }))
    .catch(e => sendError(res, e, 'list'));

// POST /api/promo-codes
const create = (req, res) =>
  createMerchantPromoCode(req.tokenUserId, req.body || {})
    .then(promoCode => res.status(201).json({ promoCode }))
    .catch(e => sendError(res, e, 'create'));

// PATCH /api/promo-codes/:id
const update = (req, res) =>
  updateMerchantPromoCode(req.tokenUserId, req.params.id, req.body || {})
    .then(promoCode => res.status(200).json({ promoCode }))
    .catch(e => sendError(res, e, 'update'));

// DELETE /api/promo-codes/:id
const remove = (req, res) =>
  deleteMerchantPromoCode(req.tokenUserId, req.params.id)
    .then(() => res.status(200).json({ id: req.params.id }))
    .catch(e => sendError(res, e, 'delete'));

// GET /api/promo-codes/:id/ledger
const listLedger = (req, res) =>
  listMerchantPromoCodeLedger(req.tokenUserId, req.params.id)
    .then(ledger => res.status(200).json({ ledger }))
    .catch(e => sendError(res, e, 'list-ledger'));

// GET /api/admin/promo-codes
const adminList = (req, res) =>
  listAdminPromoCodes()
    .then(promoCodes => res.status(200).json({ promoCodes }))
    .catch(e => sendError(res, e, 'admin-list'));

// POST /api/admin/promo-codes
const adminCreate = (req, res) =>
  createAdminPromoCode(req.tokenUserId, req.body || {})
    .then(promoCode => res.status(201).json({ promoCode }))
    .catch(e => sendError(res, e, 'admin-create'));

// PATCH /api/admin/promo-codes/:id
const adminUpdate = (req, res) =>
  updateAdminPromoCode(req.params.id, req.body || {})
    .then(promoCode => res.status(200).json({ promoCode }))
    .catch(e => sendError(res, e, 'admin-update'));

// DELETE /api/admin/promo-codes/:id
const adminRemove = (req, res) =>
  deleteAdminPromoCode(req.params.id)
    .then(() => res.status(200).json({ id: req.params.id }))
    .catch(e => sendError(res, e, 'admin-delete'));

// GET /api/admin/promo-codes/:id/ledger
const adminListLedger = (req, res) =>
  listAdminPromoCodeLedger(req.params.id)
    .then(ledger => res.status(200).json({ ledger }))
    .catch(e => sendError(res, e, 'admin-list-ledger'));

module.exports = {
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
};
