const { getSdk, handleError } = require('../api-util/sdk');

/**
 * Authenticates the user of the request with their session (the token cookie).
 *
 * @param {Object} req Express request object
 * @param {Object} res Express response object
 * @returns {Promise<Object>} { currentUser, userId, userType, displayName }
 * @throws {Error} 401 if the user isn't signed in
 */
const authenticateUser = async (req, res) => {
  const sdk = getSdk(req, res);
  const userResponse = await sdk.currentUser.show({
    'fields.user': [
      'profile.firstName',
      'profile.lastName',
      'profile.publicData.userType',
      // isAdmin (see middleware.admin): metadata can only be set by an operator
      'profile.metadata',
    ],
  });
  const currentUser = userResponse?.data?.data;

  if (!currentUser) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }

  const { firstName, lastName, publicData } = currentUser.attributes?.profile || {};
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';

  return {
    currentUser,
    userId: currentUser.id.uuid,
    userType: publicData?.userType,
    displayName,
  };
};

/**
 * Express middleware for endpoints that need a signed-in user. Adds the user entity, id, user type
 * and display name to the request (req.currentUser, req.tokenUserId, req.userType,
 * req.displayName), or responds with the error if the user isn't signed in.
 */
const auth = async (req, res, next) => {
  try {
    const { currentUser, userId, userType, displayName } = await authenticateUser(req, res);
    req.currentUser = currentUser;
    req.tokenUserId = userId;
    req.userType = userType;
    req.displayName = displayName;
    next();
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports = auth;
