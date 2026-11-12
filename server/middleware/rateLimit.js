/**
 * In-memory rate limiting: at most `max` requests per `windowMs` for each key (the signed-in user,
 * or the IP address). Requests over the limit get 429 'too-many-requests' with a Retry-After
 * header.
 *
 * The counts are kept in this server process: with several server instances, each one counts on
 * its own. That's enough to stop misuse (e.g. guessing promo codes) without an external store.
 */

/**
 * The signed-in user (middleware.auth sets req.tokenUserId), or the IP address.
 *
 * @param {Object} req
 * @returns {string}
 */
const userOrIpKey = req => (req.tokenUserId ? `user:${req.tokenUserId}` : `ip:${req.ip}`);

/**
 * Create a rate limiting middleware.
 *
 * @param {Object} params
 * @param {number} params.windowMs Length of the counting window
 * @param {number} params.max Requests allowed in a window per key
 * @param {Function} [params.keyFn] Request => key (defaults to the user or the IP address)
 * @param {Function} [params.now] For tests
 * @returns {Function} Express middleware, with a `reset()` method for tests
 */
const createRateLimit = ({ windowMs, max, keyFn = userOrIpKey, now = () => Date.now() }) => {
  const windows = new Map();

  // Drop finished windows now and then, so that the map doesn't grow forever
  const pruneExpired = currentTime => {
    windows.forEach((window, key) => {
      if (window.resetAt <= currentTime) {
        windows.delete(key);
      }
    });
  };
  let lastPrune = now();

  const middleware = (req, res, next) => {
    const currentTime = now();
    if (currentTime - lastPrune > windowMs) {
      pruneExpired(currentTime);
      lastPrune = currentTime;
    }

    const key = keyFn(req);
    const window = windows.get(key);
    if (!window || window.resetAt <= currentTime) {
      windows.set(key, { count: 1, resetAt: currentTime + windowMs });
      return next();
    }

    window.count += 1;
    if (window.count > max) {
      const retryAfterSeconds = Math.ceil((window.resetAt - currentTime) / 1000);
      res.set('Retry-After', `${retryAfterSeconds}`);
      return res.status(429).json({ status: 429, code: 'too-many-requests' });
    }
    return next();
  };

  middleware.reset = () => windows.clear();
  return middleware;
};

module.exports = { createRateLimit, userOrIpKey };
