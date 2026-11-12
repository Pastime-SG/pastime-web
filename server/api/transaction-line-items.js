const { getSdk, handleError, serialize, fetchCommission } = require('../api-util/sdk');
const { constructValidLineItems } = require('../api-util/lineItemHelpers');
const { getIncludedRelationship, getTransactionLineItems } = require('../services/commission');

module.exports = (req, res) => {
  const { isOwnListing, listingId, orderData } = req.body || {};

  const sdk = getSdk(req, res);

  // The author is included for their own commission percentage (if they have one)
  const listingPromise = () =>
    isOwnListing
      ? sdk.ownListings.show({ id: listingId, include: ['author'] })
      : sdk.listings.show({ id: listingId, include: ['author'] });

  Promise.all([listingPromise(), fetchCommission(sdk)])
    .then(([showListingResponse, fetchAssetsResponse]) => {
      const listing = showListingResponse.data.data;
      const author = getIncludedRelationship(showListingResponse.data, 'author');
      const commissionAsset = fetchAssetsResponse.data.data[0];

      const { providerCommission, customerCommission } =
        commissionAsset?.type === 'jsonAsset' ? commissionAsset.attributes.data : {};

      const lineItems = getTransactionLineItems({
        listing,
        orderData: orderData,
        providerCommission,
        customerCommission,
        provider: author,
      });

      // Because we are using returned lineItems directly in this template we need to use the helper function
      // to add some attributes like lineTotal and reversal that Marketplace API also adds to the response.
      const validLineItems = constructValidLineItems(lineItems);

      res
        .status(200)
        .set('Content-Type', 'application/transit+json')
        .send(serialize({ data: validLineItems }))
        .end();
    })
    .catch(e => {
      handleError(res, e);
    });
};
