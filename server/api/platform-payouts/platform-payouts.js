const log = require('../../log');
const { listPlatformPayouts } = require('../../services/platformPayouts');

/**
 * Admins: the payouts Pastime's server makes to providers (bookings with credits or an admin's
 * promo code above the commission, and free bookings), with the ones still waiting, e.g. because
 * Pastime's Stripe balance is too low. Read only.
 */
const listPayouts = async (req, res) => {
  try {
    const payouts = await listPlatformPayouts({ limit: 100 });
    res.status(200).json({ payouts });
  } catch (e) {
    log.error(e, 'platform-payouts-list-failed', {});
    res.status(500).json({ status: 500, code: 'platform-payouts-unavailable' });
  }
};

module.exports = { listPayouts };
