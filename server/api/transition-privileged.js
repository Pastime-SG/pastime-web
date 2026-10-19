const sharetribeSdk = require('sharetribe-flex-sdk');
const { assertExpectedPayinTotal } = require('../api-util/assertExpectedPayinTotal');
const {
  addOfferToMetadata,
  getAmountFromPreviousOffer,
  isIntentionToMakeCounterOffer,
  isIntentionToMakeOffer,
  isIntentionToRevokeCounterOffer,
  isIntentionToUpdateOffer,
  throwErrorIfNegotiationOfferHasInvalidHistory,
} = require('../api-util/negotiation');
const {
  createCookieTokenStore,
  getSdk,
  getTrustedSdk,
  handleError,
  serialize,
  fetchCommission,
} = require('../api-util/sdk');
const { RESCHEDULE_USER_TRANSITIONS } = require('../services/reschedule');
const { assertBookingStartAfterCutoff, getPoliciesProtectedData } = require('../services/policies');
const { CANCEL_PRIVILEGED_TRANSITIONS } = require('../services/cancellation');
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

// The provider is included for their own commission percentage (if they have one)
const transactionPromise = (sdk, id) =>
  sdk.transactions.show({ id, include: ['listing', 'provider'] });
const getListingRelationShip = transactionShowAPIData => {
  const { data, included } = transactionShowAPIData;
  const { relationships } = data;
  const { listing: listingRef } = relationships;
  return included.find(i => i.id.uuid === listingRef.data.id.uuid);
};

// When a provider is making an offer, make sure that customer related
// protected data is not being saved
const getRoleBasedBodyParams = (orderData, bodyParams) => {
  const { offerInSubunits } = orderData || {};
  const transitionName = bodyParams?.transition;
  const isProviderOffer =
    isIntentionToMakeOffer(offerInSubunits, transitionName) ||
    isIntentionToUpdateOffer(offerInSubunits, transitionName);

  if (!isProviderOffer) {
    return bodyParams;
  } else {
    const protectedData = bodyParams?.params?.protectedData || {};

    const filteredProtectedData = Object.entries(protectedData).reduce(
      (validEntries, [key, value]) => {
        if (key === 'customerDefaultMessage' || key.startsWith('customer_')) {
          return validEntries;
        } else {
          return { ...validEntries, [key]: value };
        }
      },
      {}
    );

    return {
      ...bodyParams,
      params: {
        ...bodyParams.params,
        protectedData: filteredProtectedData,
      },
    };
  }
};

const getFullOrderData = (orderData, bodyParams, currency, offers) => {
  const { offerInSubunits } = orderData || {};
  const transitionName = bodyParams.transition;

  const roleBasedBodyParams = getRoleBasedBodyParams(orderData, bodyParams);
  const orderDataAndParams = { ...orderData, ...roleBasedBodyParams.params, currency };

  const isNewOffer =
    isIntentionToMakeOffer(offerInSubunits, transitionName) ||
    isIntentionToMakeCounterOffer(offerInSubunits, transitionName) ||
    isIntentionToUpdateOffer(offerInSubunits, transitionName);

  return isNewOffer
    ? {
        ...orderDataAndParams,
        offer: new Money(offerInSubunits, currency),
      }
    : isIntentionToRevokeCounterOffer(transitionName)
    ? {
        ...orderDataAndParams,
        offer: new Money(getAmountFromPreviousOffer(offers), currency),
      }
    : orderDataAndParams;
};

const getUpdatedMetadata = (orderData, transition, existingMetadata) => {
  const { actor, offerInSubunits } = orderData || {};
  // NOTE: for default-negotiation process, the actor is always "provider" when making an offer.
  const hasActor = ['provider', 'customer'].includes(actor);
  const by = hasActor ? actor : null;

  const isNewOffer =
    isIntentionToMakeOffer(offerInSubunits, transition) ||
    isIntentionToMakeCounterOffer(offerInSubunits, transition) ||
    isIntentionToUpdateOffer(offerInSubunits, transition);

  return isNewOffer
    ? addOfferToMetadata(existingMetadata, {
        offerInSubunits,
        by,
        transition,
      })
    : isIntentionToRevokeCounterOffer(transition)
    ? addOfferToMetadata(existingMetadata, {
        offerInSubunits: getAmountFromPreviousOffer(existingMetadata.offers),
        by,
        transition,
      })
    : addOfferToMetadata(existingMetadata, null);
};

module.exports = (req, res) => {
  const { isSpeculative, orderData, bodyParams, queryParams } = req.body || {};

  // Reschedule transitions are validated in server/api/reschedule/reschedule.js: they can't be
  // made through this generic endpoint, which passes the params through.
  if (RESCHEDULE_USER_TRANSITIONS.includes(bodyParams?.transition)) {
    return res.status(403).json({ status: 403, code: 'use-reschedule-endpoint' });
  }
  // Cancel transitions refund the payment: see server/api/cancel
  if (CANCEL_PRIVILEGED_TRANSITIONS.includes(bodyParams?.transition)) {
    return res.status(403).json({ status: 403, code: 'use-cancel-endpoint' });
  }

  // Share one cookie token store so a refresh during transactions.show is reused for exchangeToken.
  const tokenStore = createCookieTokenStore(req, res);
  const sdk = getSdk(req, res, tokenStore);
  const transitionName = bodyParams.transition;
  let lineItems = null;
  let metadataMaybe = {};
  let policiesMaybe = {};
  let promoCode = null;
  let loyalty = null;
  let providerId = null;

  Promise.all([transactionPromise(sdk, bodyParams?.id), fetchCommission(sdk)])
    .then(async responses => {
      const [showTransactionResponse, fetchAssetsResponse] = responses;
      const transaction = showTransactionResponse.data.data;
      const listing = getListingRelationShip(showTransactionResponse.data);
      const provider = getIncludedRelationship(showTransactionResponse.data, 'provider');
      const commissionAsset = fetchAssetsResponse.data.data[0];
      providerId = provider?.id?.uuid;

      // The promo code entered at checkout (if any), for booking requests after an inquiry
      promoCode = await getBookingPromoCode({ orderData, providerId, transitionName });
      // The customer's loyalty credits, if they chose to use them
      loyalty = await getBookingLoyalty({ sdk, orderData, transitionName });

      const existingMetadata = transaction?.attributes?.metadata;
      const existingOffers = existingMetadata?.offers || [];
      const transitions = transaction.attributes.transitions;

      // Check if the transition is related to negotiation offers and if the offers are valid
      throwErrorIfNegotiationOfferHasInvalidHistory(transitionName, existingOffers, transitions);

      const currency =
        transaction.attributes.payinTotal?.currency ||
        listing.attributes.price?.currency ||
        orderData.currency;
      const { providerCommission, customerCommission } =
        commissionAsset?.type === 'jsonAsset' ? commissionAsset.attributes.data : {};

      lineItems = getTransactionLineItems({
        listing,
        orderData: getFullOrderData(orderData, bodyParams, currency, existingOffers),
        providerCommission,
        customerCommission,
        provider: provider,
        promoCode,
        loyaltyCredits: getLoyaltyCreditsToUse(loyalty, currency),
      });

      // If the client sends expectedPayinTotal (checkout payment flows), ensure it
      assertExpectedPayinTotal(lineItems, orderData?.expectedPayinTotal);

      metadataMaybe = getUpdatedMetadata(orderData, transitionName, existingMetadata);
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
      // Pass role based params to make sure that protectedData only contains protected data
      // for the correct role.
      // - For the default-negotiation process, this removes any customer
      //   related protected data fields if the transition is from a provider
      // - If you customize the transaction process to allow customers to update protected data
      //   after a provider's offer, you can add that logic in this same function.
      const roleBasedBodyParams = getRoleBasedBodyParams(orderData, bodyParams);
      // Omit listingId from params (transition/request-payment-after-inquiry does not need it)
      const { listingId, ...restParams } = roleBasedBodyParams?.params || {};
      // Policies are only set here, from the listing: never from the client
      const { policies, ...protectedData } = restParams.protectedData || {};
      // Copies of the applied promo code and credits, set here only (never from the client)
      const {
        promoCode: clientPromoCode,
        loyalty: clientLoyalty,
        ...clientProtectedData
      } = protectedData;
      const promoCodeMaybe = getPromoCodeProtectedData(promoCode, lineItems);
      const loyaltyMaybe = getLoyaltyProtectedData(loyalty, lineItems);
      const hasProtectedData =
        !!restParams.protectedData ||
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
          ...restParams,
          ...protectedDataMaybe,
          lineItems,
          ...metadataMaybe,
        },
      };

      if (isSpeculative) {
        return trustedSdk.transactions.transitionSpeculative(body, queryParams);
      }
      // A use of the promo code is counted only when the booking is made
      return withPromoCodeUse(
        {
          promoCode,
          lineItems,
          isSpeculative,
          details: { providerId, listingId: listingId?.uuid || null },
        },
        () =>
          withLoyaltyCredits({ loyalty, lineItems, isSpeculative }, () =>
            trustedSdk.transactions.transition(body, queryParams)
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
