const log = require('../../log');
const {
  deleteMerchantPromoCodeByAdmin,
  listAllMerchantPromoCodes,
  listMerchantPromoCodeLedgerByAdmin,
  setMerchantPromoCodeActiveByAdmin,
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
const {
  getPromoCodeSettings,
  setMerchantCodesEnabled,
} = require('../../services/promoCodes/settings');

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
  createMerchantPromoCode(req.tokenUserId, req.body || {}, req.displayName)
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

// GET /api/promo-codes/settings: whether studio codes are turned on
const getSettings = (req, res) =>
  getPromoCodeSettings()
    .then(({ merchantCodesEnabled }) => res.status(200).json({ merchantCodesEnabled }))
    .catch(e => sendError(res, e, 'settings'));

// PUT /api/admin/promo-codes/settings: turn studio codes on or off
const adminUpdateSettings = (req, res) =>
  setMerchantCodesEnabled(req.body?.merchantCodesEnabled, req.tokenUserId)
    .then(({ merchantCodesEnabled }) => res.status(200).json({ merchantCodesEnabled }))
    .catch(e => sendError(res, e, 'admin-update-settings'));

// GET /api/admin/promo-codes/merchant: every studio's codes
const adminListMerchant = (req, res) =>
  listAllMerchantPromoCodes()
    .then(promoCodes => res.status(200).json({ promoCodes }))
    .catch(e => sendError(res, e, 'admin-list-merchant'));

// PATCH /api/admin/promo-codes/merchant/:id: turn a studio's code on or off ({ active })
const adminSetMerchantActive = (req, res) =>
  setMerchantPromoCodeActiveByAdmin(req.params.id, req.body?.active)
    .then(promoCode => res.status(200).json({ promoCode }))
    .catch(e => sendError(res, e, 'admin-update-merchant'));

// DELETE /api/admin/promo-codes/merchant/:id: delete a studio's unused code
const adminRemoveMerchant = (req, res) =>
  deleteMerchantPromoCodeByAdmin(req.params.id)
    .then(() => res.status(200).json({ id: req.params.id }))
    .catch(e => sendError(res, e, 'admin-delete-merchant'));

// GET /api/admin/promo-codes/merchant/:id/ledger: a studio code's history
const adminListMerchantLedger = (req, res) =>
  listMerchantPromoCodeLedgerByAdmin(req.params.id)
    .then(ledger => res.status(200).json({ ledger }))
    .catch(e => sendError(res, e, 'admin-list-merchant-ledger'));

module.exports = {
  adminListMerchant,
  adminListMerchantLedger,
  adminRemoveMerchant,
  adminSetMerchantActive,
  adminUpdateSettings,
  getSettings,
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
