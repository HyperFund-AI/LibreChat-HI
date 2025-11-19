const { isEnabled } = require('@librechat/api');
const requireJwtAuth = require('./requireJwtAuth');

/**
 * Get the appropriate authentication middleware based on configuration
 * If CLERK_ENABLED is true, use Clerk auth, otherwise use JWT auth
 */
const getAuthMiddleware = () => {
  if (isEnabled(process.env.CLERK_ENABLED)) {
    // Lazy load Clerk auth to avoid errors if Clerk isn't configured
    try {
      const requireClerkAuth = require('./requireClerkAuth');
      return requireClerkAuth;
    } catch (error) {
      // If Clerk auth fails to load, fall back to JWT
      console.warn('[getAuthMiddleware] Clerk auth not available, falling back to JWT:', error.message);
      return requireJwtAuth;
    }
  }
  return requireJwtAuth;
};

/**
 * Get optional auth middleware (doesn't fail if no token)
 */
const getOptionalAuthMiddleware = () => {
  if (isEnabled(process.env.CLERK_ENABLED)) {
    try {
      const requireClerkAuth = require('./requireClerkAuth');
      return requireClerkAuth.optionalClerkAuth;
    } catch (error) {
      console.warn('[getOptionalAuthMiddleware] Clerk auth not available, falling back to JWT:', error.message);
      const { optionalJwtAuth } = require('./optionalJwtAuth');
      return optionalJwtAuth;
    }
  }
  const { optionalJwtAuth } = require('./optionalJwtAuth');
  return optionalJwtAuth;
};

module.exports = {
  getAuthMiddleware,
  getOptionalAuthMiddleware,
};

