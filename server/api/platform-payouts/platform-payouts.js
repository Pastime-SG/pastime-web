const log = require('../../log');
const { isFeatureUnavailableError } = require('../../services/firebase');
const { listPlatformPayouts } = require('../../services/platformPayouts');

/**
 * Admins: the payouts Pastime's server makes to providers (bookings with credits or an admin's
 * promo code above the commission, and free bookings), with the ones still waiting, e.g. because
 * Pastime's Stripe balance is too low. Read only.
 */
const listPayouts = async (req, res) => {
  try {
    const payouts = await listPlatformPayouts({ limit: 100 });
    return res.status(200).json({ payouts });
  } catch (e) {
    // Firebase isn't set up on this server (e.g. the dev site)
    if (isFeatureUnavailableError(e)) {
      return res.status(e.status).json({ status: e.status, code: e.code });
    }
    log.error(e, 'platform-payouts-list-failed', {});
    return res.status(500).json({ status: 500, code: 'platform-payouts-unavailable' });
  }
};

module.exports = { listPayouts };
