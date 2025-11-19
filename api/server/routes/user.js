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
const requireAuth = getAuthMiddleware();

router.get('/', requireAuth, getUserController);
router.get('/terms', requireAuth, getTermsStatusController);
router.post('/terms/accept', requireAuth, acceptTermsController);
router.post('/plugins', requireAuth, updateUserPluginsController);
router.delete('/delete', requireAuth, canDeleteAccount, deleteUserController);
router.post('/verify', verifyEmailController);
router.post('/verify/resend', verifyEmailLimiter, resendVerificationController);

module.exports = router;
