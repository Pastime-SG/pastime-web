const sharetribeSdk = require('sharetribe-flex-sdk');
const { assertExpectedPayinTotal } = require('../api-util/assertExpectedPayinTotal');
const { isIntentionToMakeOffer } = require('../api-util/negotiation');
const {
  createCookieTokenStore,
  getSdk,
  getTrustedSdk,
  handleError,
  serialize,
  fetchCommission,
} = require('../api-util/sdk');
const { assertBookingStartAfterCutoff, getPoliciesProtectedData } = require('../services/policies');
const { getIncludedRelationship, getTransactionLineItems } = require('../services/commission');
const {
  getBookingPromoCode,
  getPromoCodeProtectedData,
  withPromoCodeUse,
} = require('../services/promoCodes/checkout');
const {
  getBookingLoyalty,
  getLoyaltyCreditsToUse,
  getLoyaltyProtectedData,
  withLoyaltyCredits,
} = require('../services/loyalty/checkout');

const { Money } = sharetribeSdk.types;

// The author is included for their own commission percentage (if they have one)
const listingPromise = (sdk, id) => sdk.listings.show({ id, include: ['author'] });

const getFullOrderData = (orderData, bodyParams, currency) => {
  const { offerInSubunits } = orderData || {};
  const transitionName = bodyParams.transition;

  return isIntentionToMakeOffer(offerInSubunits, transitionName)
    ? {
        ...orderData,
        ...bodyParams.params,
        currency,
        offer: new Money(offerInSubunits, currency),
      }
    : { ...orderData, ...bodyParams.params };
};

const getMetadata = (orderData, transition) => {
  const { actor, offerInSubunits } = orderData || {};
  // NOTE: for now, the actor is always "provider".
  const hasActor = ['provider', 'customer'].includes(actor);
  const by = hasActor ? actor : null;

  return isIntentionToMakeOffer(offerInSubunits, transition)
    ? {
        metadata: {
          offers: [
            {
              offerInSubunits,
              by,
              transition,
            },
          ],
        },
      }
    : {};
};

module.exports = (req, res) => {
  const { isSpeculative, orderData, bodyParams, queryParams } = req.body || {};
  const transitionName = bodyParams.transition;
  // Share one cookie token store so a refresh during listings.show is reused for exchangeToken.
  const tokenStore = createCookieTokenStore(req, res);
  const sdk = getSdk(req, res, tokenStore);
  let lineItems = null;
  let metadataMaybe = {};
  let policiesMaybe = {};
  let promoCode = null;
  let loyalty = null;
  let providerId = null;

  Promise.all([listingPromise(sdk, bodyParams?.params?.listingId), fetchCommission(sdk)])
    .then(async ([showListingResponse, fetchAssetsResponse]) => {
      const listing = showListingResponse.data.data;
      const author = getIncludedRelationship(showListingResponse.data, 'author');
      const commissionAsset = fetchAssetsResponse.data.data[0];
      providerId = author?.id?.uuid;

      // The promo code entered at checkout (if any): the provider's own code or an admin's
      promoCode = await getBookingPromoCode({ orderData, providerId, transitionName });
      // The customer's loyalty credits, if they chose to use them
      loyalty = await getBookingLoyalty({ sdk, orderData, transitionName });

      const currency = listing.attributes.price?.currency || orderData.currency;
      const { providerCommission, customerCommission } =
        commissionAsset?.type === 'jsonAsset' ? commissionAsset.attributes.data : {};

      lineItems = getTransactionLineItems({
        listing,
        orderData: getFullOrderData(orderData, bodyParams, currency),
        providerCommission,
        customerCommission,
        provider: author,
        promoCode,
        loyaltyCredits: getLoyaltyCreditsToUse(loyalty, currency),
      });

      // If the client sends expectedPayinTotal (checkout payment flows), ensure it
      assertExpectedPayinTotal(lineItems, orderData?.expectedPayinTotal);

      metadataMaybe = getMetadata(orderData, transitionName);
      // Bookings can't start within the listing's booking cutoff (e.g. 24 hours)
      assertBookingStartAfterCutoff({
        listing,
        transitionName,
        bookingStart: bodyParams?.params?.bookingStart,
      });
      // A booking keeps the cancellation and rescheduling policies it was made with
      policiesMaybe = getPoliciesProtectedData(listing, transitionName);

      return getTrustedSdk(req, res, tokenStore);
    })
    .then(trustedSdk => {
      const { params } = bodyParams;
      // Policies are only set here, from the listing: never from the client
      const { policies, ...protectedData } = params?.protectedData || {};
      // Copies of the applied promo code and credits, set here only (never from the client)
      const {
        promoCode: clientPromoCode,
        loyalty: clientLoyalty,
        ...clientProtectedData
      } = protectedData;
      const promoCodeMaybe = getPromoCodeProtectedData(promoCode, lineItems);
      const loyaltyMaybe = getLoyaltyProtectedData(loyalty, lineItems);
      const hasProtectedData =
        !!params?.protectedData ||
        !!policiesMaybe.policies ||
        !!promoCodeMaybe.promoCode ||
        !!loyaltyMaybe.loyalty;
      const protectedDataMaybe = hasProtectedData
        ? {
            protectedData: {
              ...clientProtectedData,
              ...policiesMaybe,
              ...promoCodeMaybe,
              ...loyaltyMaybe,
            },
          }
        : {};

      // Add lineItems to the body params
      const body = {
        ...bodyParams,
        params: {
          ...params,
          ...protectedDataMaybe,
          lineItems,
          ...metadataMaybe,
        },
      };

      if (isSpeculative) {
        return trustedSdk.transactions.initiateSpeculative(body, queryParams);
      }
      // A use of the promo code is counted, and credits taken, only when the booking is made
      return withPromoCodeUse(
        {
          promoCode,
          lineItems,
          isSpeculative,
          details: { providerId, listingId: params?.listingId?.uuid || null },
        },
        () =>
          withLoyaltyCredits({ loyalty, lineItems, isSpeculative }, () =>
            trustedSdk.transactions.initiate(body, queryParams)
          )
      );
    })
    .then(apiResponse => {
      const { status, statusText, data } = apiResponse;
      res
        .status(status)
        .set('Content-Type', 'application/transit+json')
        .send(
          serialize({
            status,
            statusText,
            data,
          })
        )
        .end();
    })
    .catch(e => {
      handleError(res, e);
    });
};
