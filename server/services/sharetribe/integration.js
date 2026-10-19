const http = require('http');
const https = require('https');
const sharetribeIntegrationSdk = require('sharetribe-flex-integration-sdk');

/**
 * Sharetribe Integration API, for server jobs that work on all transactions (e.g. reading booking
 * events). Needs SHARETRIBE_INTEGRATION_CLIENT_ID and SHARETRIBE_INTEGRATION_CLIENT_SECRET
 * (Console: Build > Applications).
 */

const BASE_URL = process.env.REACT_APP_SHARETRIBE_SDK_BASE_URL;

let integrationSdk = null;

/**
 * Whether the Integration API credentials are set.
 *
 * @returns {boolean}
 */
const hasIntegrationCredentials = () =>
  !!process.env.SHARETRIBE_INTEGRATION_CLIENT_ID &&
  !!process.env.SHARETRIBE_INTEGRATION_CLIENT_SECRET;

/**
 * The Integration SDK instance (created on the first call), with the API's rate limits.
 *
 * @returns {Object}
 */
const getIntegrationSdk = () => {
  if (!integrationSdk) {
    const { util } = sharetribeIntegrationSdk;
    integrationSdk = sharetribeIntegrationSdk.createInstance({
      clientId: process.env.SHARETRIBE_INTEGRATION_CLIENT_ID,
      clientSecret: process.env.SHARETRIBE_INTEGRATION_CLIENT_SECRET,
      // At most 10 concurrent requests, as the API asks
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 10 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
      queryLimiter: util.createRateLimiter(util.prodQueryLimiterConfig),
      commandLimiter: util.createRateLimiter(util.prodCommandLimiterConfig),
      ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
    });
  }
  return integrationSdk;
};

module.exports = { getIntegrationSdk, hasIntegrationCredentials };
