const express = require('express');
const { deleteMe, changePassword, sendLoginOtp, verifyLoginOtp, checkAuthStatus, signup, login, forgotPassword, resetPassword, getMe, updateMe, logout, refresh } = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/status', checkAuthStatus);
router.post('/signup', signup);
router.post('/login', login);
router.post('/otp/send', sendLoginOtp);
router.post('/otp/verify', verifyLoginOtp);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.patch('/change-password', requireAuth, changePassword);
router.post('/logout', requireAuth, logout);
router.post('/refresh', requireAuth, refresh);
router.delete('/me', requireAuth, deleteMe);
router.get('/me', requireAuth, getMe);
router.patch('/me', requireAuth, updateMe);

module.exports = router;
