const express = require('express');
const {
  updateUserPluginsController,
  resendVerificationController,
  getTermsStatusController,
  acceptTermsController,
  verifyEmailController,
  deleteUserController,
  getUserController,
} = require('~/server/controllers/UserController');
const { getAuthMiddleware, canDeleteAccount, verifyEmailLimiter } = require('~/server/middleware');

const router = express.Router();

// Lazy-load auth middleware to avoid errors during module load
let requireAuth;
const getRequireAuth = () => {
  if (!requireAuth) {
    try {
      requireAuth = getAuthMiddleware();
    } catch (error) {
      console.error('[user.js] Error loading auth middleware:', error);
      // Fallback to JWT auth if there's an error
      const { requireJwtAuth } = require('~/server/middleware');
      requireAuth = requireJwtAuth;
    }
  }
  return requireAuth;
};

// Wrapper middleware that resolves auth middleware on each request
const requireAuthWrapper = (req, res, next) => {
  const authMiddleware = getRequireAuth();
  return authMiddleware(req, res, next);
};

router.get('/', requireAuthWrapper, getUserController);
router.get('/terms', requireAuthWrapper, getTermsStatusController);
router.post('/terms/accept', requireAuthWrapper, acceptTermsController);
router.post('/plugins', requireAuthWrapper, updateUserPluginsController);
router.delete('/delete', requireAuthWrapper, canDeleteAccount, deleteUserController);
router.post('/verify', verifyEmailController);
router.post('/verify/resend', verifyEmailLimiter, resendVerificationController);

module.exports = router;
