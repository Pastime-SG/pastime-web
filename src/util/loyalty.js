import { useEffect, useState } from 'react';

import { fetchLoyaltySettings } from './api';

// Fetched once per page load, and shared by everything that asks
let settingsPromise = null;

/**
 * Whether the loyalty program is on (admins can turn it off). Fetched in the browser only, from
 * the app's server: false until it's known, so that credits never show while it's off.
 *
 * @returns {boolean}
 */
export const useLoyaltyEnabled = () => {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    if (!settingsPromise) {
      settingsPromise = Promise.resolve()
        .then(() => fetchLoyaltySettings())
        .then(response => response?.enabled === true)
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
