const { isEnabled } = require('@librechat/api');
const requireJwtAuth = require('./requireJwtAuth');
const requireClerkAuth = require('./requireClerkAuth');

/**
 * Get the appropriate authentication middleware based on configuration
 * If CLERK_ENABLED is true, use Clerk auth, otherwise use JWT auth
 */
const getAuthMiddleware = () => {
  if (isEnabled(process.env.CLERK_ENABLED)) {
    return requireClerkAuth;
  }
  return requireJwtAuth;
};

/**
 * Get optional auth middleware (doesn't fail if no token)
 */
const getOptionalAuthMiddleware = () => {
  if (isEnabled(process.env.CLERK_ENABLED)) {
    return requireClerkAuth.optionalClerkAuth;
  }
  const { optionalJwtAuth } = require('./optionalJwtAuth');
  return optionalJwtAuth;
};

module.exports = {
  getAuthMiddleware,
  getOptionalAuthMiddleware,
};

