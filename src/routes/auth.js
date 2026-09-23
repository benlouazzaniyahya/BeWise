'use strict';

const express = require('express');
const c = require('../controllers/authController');

const router = express.Router();

router.get('/', c.home);
router.get('/home', c.homeForUser);

router.get('/language', c.languagePage);
router.post('/language', c.languageSave);

router.get('/login', c.loginPage);
router.post('/login', c.login);

router.get('/signup', c.signupPage);
router.post('/signup', c.signup);

router.get('/auth/google', c.googleStart);
router.get('/auth/google/callback', c.googleCallback);

// router.get('/child-login', c.childLoginPage);
// router.post('/child-login', c.childLogin);

router.post('/logout', c.logout);

module.exports = router;