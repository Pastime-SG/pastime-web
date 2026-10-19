const admin = require('./admin');
const auth = require('./auth');
const { createRateLimit } = require('./rateLimit');

const middleware = {
  admin,
  auth,
  createRateLimit,
};

module.exports = middleware;
