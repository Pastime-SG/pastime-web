import { useEffect, useState } from 'react';

import { fetchPromoCodeSettings } from './api';

// Fetched once per page load, and shared by everything that asks
let settingsPromise = null;

/**
 * Whether studio promo codes are turned on (admins can turn them off, and then studios don't see
 * the promo codes section at all). Fetched in the browser only, from the app's server: false
 * until it's known, so that the section never flashes up while it's off.
 *
 * @returns {boolean}
 */
export const useStudioPromoCodesEnabled = () => {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    if (!settingsPromise) {
      settingsPromise = Promise.resolve()
        .then(() => fetchPromoCodeSettings())
        .then(response => response?.merchantCodesEnabled !== false)
        .catch(() => {
          settingsPromise = null;
          return false;
        });
    }
    settingsPromise.then(value => {
      if (active) {
        setEnabled(value);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  return enabled;
};
