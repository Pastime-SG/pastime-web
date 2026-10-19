/**
 * Express middleware for admin-only endpoints. Use after middleware.auth: the user must have
 * `isAdmin: true` in their profile metadata, which only a marketplace operator can set (Console
 * or Integration API), so users can't make themselves admins. Responds with 403 otherwise.
 */
const admin = (req, res, next) => {
  if (!admin.isAdmin(req)) {
    return res.status(403).json({ status: 403, code: 'forbidden' });
  }
  return next();
};

/**
 * Whether the signed-in user (from middleware.auth) is an admin.
 *
 * @param {Object} req
 * @returns {boolean}
 */
admin.isAdmin = req => req.currentUser?.attributes?.profile?.metadata?.isAdmin === true;

module.exports = admin;
