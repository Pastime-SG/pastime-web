const { FieldValue, getFirestore } = require('../firebase');
const { getIntegrationSdk } = require('../sharetribe/integration');

/**
 * The listing categories that have at least one published listing, for the hero search bar
 * (categories without listings aren't offered there; the listing form still offers them all).
 *
 * To keep Sharetribe API calls to a minimum, the listings aren't queried for this. Instead, the
 * category and state of each listing are kept in Firestore:
 *
 *   listingCategories/{listingId} { category, published, updatedAt }
 *   settings/listingCategories { seededAt }
 *
 * They're filled once from the existing listings (seedListingCategories: one paged Integration
 * API query), and then kept up to date from the listing events that the booking events job reads
 * anyway (see promoCodes/bookingEvents.js), so no extra calls are made.
 */

const COLLECTION = 'listingCategories';
const SETTINGS_DOC = ['settings', 'listingCategories'];
// The active categories are read from Firestore at most every 5 minutes per server process
const CACHE_MS = 5 * 60 * 1000;
const LISTINGS_PER_PAGE = 100;
// Firestore writes per batch (at most 500)
const BATCH_SIZE = 400;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cache = null;
let isSeeded = false;

const getUuid = value => value?.uuid || (typeof value === 'string' ? value : null);
const settingsRef = db => db.collection(SETTINGS_DOC[0]).doc(SETTINGS_DOC[1]);

// A listing's category (top level) and whether it's published, from its attributes
const toRecord = attributes => ({
  category: attributes?.publicData?.categoryLevel1 || null,
  published: attributes?.state === 'published' && attributes?.deleted !== true,
});

/**
 * Update a listing's record from an Integration API listing event (listing/created,
 * listing/updated or listing/deleted).
 *
 * @param {Object} event
 * @returns {Promise<boolean>} Whether the event was a listing event that was applied
 */
const applyListingEvent = async event => {
  const { eventType, resourceId, resource } = event?.attributes || {};
  if (!['listing/created', 'listing/updated', 'listing/deleted'].includes(eventType)) {
    return false;
  }
  const listingId = getUuid(resourceId) || getUuid(resource?.id);
  if (!listingId || !UUID_PATTERN.test(listingId)) {
    return false;
  }
  const ref = getFirestore()
    .collection(COLLECTION)
    .doc(listingId);
  if (eventType === 'listing/deleted' || !resource?.attributes) {
    await ref.delete();
  } else {
    await ref.set({ ...toRecord(resource.attributes), updatedAt: FieldValue.serverTimestamp() });
  }
  cache = null;
  return true;
};

/**
 * Fill the records from the existing listings, once (later changes come from listing events).
 * Paged Integration API query with only the needed fields.
 *
 * @returns {Promise<number|null>} Listings recorded, or null if this was done already
 */
const seedListingCategories = async () => {
  if (isSeeded) {
    return null;
  }
  const db = getFirestore();
  const settings = await settingsRef(db).get();
  if (settings.exists && settings.data().seededAt) {
    isSeeded = true;
    return null;
  }

  const records = [];
  for (let page = 1; ; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await getIntegrationSdk().listings.query({
      page,
      perPage: LISTINGS_PER_PAGE,
      'fields.listing': ['state', 'deleted', 'publicData.categoryLevel1'],
    });
    const listings = response.data.data;
    listings.forEach(listing =>
      records.push({ id: getUuid(listing.id), ...toRecord(listing.attributes) })
    );
    const totalPages = response.data.meta?.totalPages || 1;
    if (page >= totalPages || listings.length === 0) {
      break;
    }
  }

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = db.batch();
    records.slice(i, i + BATCH_SIZE).forEach(({ id, ...record }) => {
      batch.set(db.collection(COLLECTION).doc(id), {
        ...record,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
  await settingsRef(db).set({ seededAt: FieldValue.serverTimestamp() }, { merge: true });
  isSeeded = true;
  cache = null;
  return records.length;
};

/**
 * The categories (top-level ids) that have at least one published listing, or null before the
 * records have been filled (then every category is shown).
 *
 * @param {Object} [params]
 * @param {Date} [params.now]
 * @returns {Promise<Array<string>|null>}
 */
const getActiveCategoryIds = async ({ now = new Date() } = {}) => {
  if (cache && now.getTime() - cache.readAt < CACHE_MS) {
    return cache.categoryIds;
  }
  const db = getFirestore();
  const settings = await settingsRef(db).get();
  let categoryIds = null;
  if (settings.exists && settings.data().seededAt) {
    const snapshot = await db
      .collection(COLLECTION)
      .where('published', '==', true)
      .select('category')
      .get();
    categoryIds = [...new Set(snapshot.docs.map(doc => doc.data().category).filter(Boolean))];
  }
  cache = { categoryIds, readAt: now.getTime() };
  return categoryIds;
};

// For tests
const resetListingCategoriesState = () => {
  cache = null;
  isSeeded = false;
};

module.exports = {
  applyListingEvent,
  getActiveCategoryIds,
  resetListingCategoriesState,
  seedListingCategories,
};
