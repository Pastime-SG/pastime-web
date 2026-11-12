const log = require('../../log');
const { isFeatureUnavailableError } = require('../../services/firebase');
const { getActiveCategoryIds } = require('../../services/listingCategories');

/**
 * The listing categories with at least one published listing (see
 * server/services/listingCategories). Read from Firestore: no Sharetribe API calls.
 */

// GET /api/listing-categories/active: { categoryIds } (null: not known yet, show all)
const getActive = (req, res) =>
  getActiveCategoryIds()
    .then(categoryIds => {
      res.set('Cache-Control', 'public, max-age=300');
      res.status(200).json({ categoryIds });
    })
    .catch(e => {
      // Firebase isn't set up on this server (e.g. the dev site): the categories aren't known,
      // so the search bar shows them all
      if (isFeatureUnavailableError(e)) {
        return res.status(200).json({ categoryIds: null });
      }
      log.error(e, 'listing-categories-active-failed', {});
      res.status(500).json({ status: 500, code: 'unknown' });
    });

module.exports = { getActive };
