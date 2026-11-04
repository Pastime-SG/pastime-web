const log = require('../../log');
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
      log.error(e, 'listing-categories-active-failed', {});
      res.status(500).json({ status: 500, code: 'unknown' });
    });

module.exports = { getActive };
