import { useEffect, useState } from 'react';

import { fetchActiveCategories } from './api';

// Fetched once per page load, and shared by everything that asks
let activePromise = null;

/**
 * The listing categories (top-level ids) that have at least one published listing, for the hero
 * search bar. Fetched in the browser only, from the app's server. Null until known (or if it
 * can't be fetched): then every category is shown.
 *
 * @returns {Array<string>|null}
 */
export const useActiveCategoryIds = () => {
  const [categoryIds, setCategoryIds] = useState(null);
  useEffect(() => {
    let active = true;
    if (!activePromise) {
      activePromise = Promise.resolve()
        .then(() => fetchActiveCategories())
        .then(response => (Array.isArray(response?.categoryIds) ? response.categoryIds : null))
        .catch(() => {
          activePromise = null;
          return null;
        });
    }
    activePromise.then(value => {
      if (active) {
        setCategoryIds(value);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  return categoryIds;
};
