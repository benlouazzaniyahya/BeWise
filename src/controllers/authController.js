'use strict';

const bcrypt = require('bcryptjs');
const { User, Child } = require('../models');
const { LANGS, tFor } = require('../i18n');
const {
  signUser, setAuthCookie, clearAuthCookie, setChildCookie, clearChildCookie, LANG_COOKIE,
} = require('../middleware/auth');
const oauth = require('../services/oauth');

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const localNow = () => new Date().toISOString();

const homeFor = (role) => (role === 'admin' ? '/admin' : role === 'teacher' ? '/teacher' : '/parent');

function bad(req, res, message, to) {
  req.flash('error', message);
  res.redirect(to);
}

// ---------------------------------------------------------------------------
// Home routing
// ---------------------------------------------------------------------------
function home(req, res) {
  if (!(req.cookies && req.cookies[LANG_COOKIE])) return res.redirect('/language');
  res.redirect('/home');
}

function homeForUser(req, res) {
  if (res.locals.user) return res.redirect(homeFor(res.locals.user.role));
  res.redirect('/login');
}

// ---------------------------------------------------------------------------
// Language picker
// ---------------------------------------------------------------------------
function languagePage(req, res) {
  const t = tFor(res.locals.lang);
  res.render('language', { page: 'language', titleKey: 'lang.pickerTitle', next: req.query.next || '/home' });
}

function languageSave(req, res) {
  const lang = LANGS.includes(req.body.lang) ? req.body.lang : 'en';
  res.cookie(LANG_COOKIE, lang, { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000 });
  if (res.locals.user) User.updateLanguage(res.locals.user.id, lang);
  res.redirect(req.body.next || '/home');
}

// ---------------------------------------------------------------------------
// Login / signup (admin, teacher, parent)
// ---------------------------------------------------------------------------
function loginPage(req, res) {
  if (res.locals.user) return res.redirect(homeFor(res.locals.user.role));
  res.render('auth/login', {
    page: 'login', titleKey: 'auth.loginTitle', next: req.query.next || '/home',
    googleEnabled: Boolean(oauth.configured()),
  });
}

function login(req, res) {
  const t = tFor(res.locals.lang);
  const identifier = String(req.body.email || req.body.child_login_id || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const next = String(req.body.next || '/home');

  // Adult accounts (admin, teacher, parent) sign in with email.
  const user = User.findByEmail(identifier);
  if (user) {
    if (!user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
      req.flash('error', t('auth.loginFailed'));
      return res.redirect(`/login?next=${encodeURIComponent(next)}`);
    }
    User.updateLanguage(user.id, res.locals.lang);
    setAuthCookie(res, signUser(user));
    res.redirect(next.startsWith('/') ? next : homeFor(user.role));
    return;
  }

  // Kids sign in with their login id or display name.
  const child = Child.findByLoginOrName(identifier);
  if (child && bcrypt.compareSync(password, child.password_hash)) {
    setChildCookie(res, child.id);
    res.redirect('/child');
    return;
  }

  req.flash('error', t('auth.loginFailed'));
  res.redirect(`/login?next=${encodeURIComponent(next)}`);
}

function signupPage(req, res) {
  if (res.locals.user) return res.redirect(homeFor(res.locals.user.role));
  const t = tFor(res.locals.lang);
  res.render('auth/signup', {
    page: 'signup', titleKey: 'auth.signupTitle', googleEnabled: Boolean(oauth.configured()),
  });
}

function signup(req, res) {
  const t = tFor(res.locals.lang);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!VALID_EMAIL.test(email)) return bad(req, res, t('auth.invalidEmail'), '/signup');
  if (password.length < 6) return bad(req, res, t('auth.passwordTooShort'), '/signup');
  if (User.findByEmail(email)) return bad(req, res, t('auth.signupFailedEmail'), '/signup');

  const id = User.create({ role: 'parent', email, passwordHash: bcrypt.hashSync(password, 10), language: res.locals.lang, created_at: localNow() });
  const user = User.findById(id);
  req.flash('success', t('auth.registered'));
  setAuthCookie(res, signUser(user));
  res.redirect('/parent');
}

// ---------------------------------------------------------------------------
// Google OAuth (parents)
// ---------------------------------------------------------------------------
function googleStart(req, res) {
  if (!oauth.configured()) {
    req.flash('error', tFor(res.locals.lang)('auth.googleUnavailable'));
    return res.redirect('/login');
  }
  res.redirect(oauth.authorizationUrl());
}

async function googleCallback(req, res) {
  const t = tFor(res.locals.lang);

  try {
    const { googleId, email } = await oauth.fetchGoogleUser(req.query.code);

    let user = User.findByGoogleId(googleId);
    if (!user && email) user = User.findByEmail(email);
    if (!user) {
      const id = User.create({
        role: 'parent',
        email: email || `g-${googleId}`,
        passwordHash: null,
        googleId,
        language: res.locals.lang,
        created_at: localNow(),
      });
      user = User.findById(id);
    } else {
      User.setGoogleId(user.id, googleId);
    }
    setAuthCookie(res, signUser(user));
    res.redirect('/parent');
  } catch (err) {
    req.flash('error', t('auth.googleFailed'));
    res.redirect('/login');
  }
}

// ---------------------------------------------------------------------------
// Child login (kid-friendly, child_id + password only)
// ---------------------------------------------------------------------------
function childLoginPage(req, res) {
  // Merged into the main login page; keep old bookmarks working.
  if (res.locals.child) return res.redirect('/child');
  res.redirect('/login');
}

function childLogin(req, res) {
  const t = tFor(res.locals.lang);
  const loginId = String(req.body.child_login_id || '').trim();
  const password = String(req.body.password || '');

  const child = Child.findByLoginOrName(loginId);
  if (!child || !bcrypt.compareSync(password, child.password_hash)) {
    req.flash('error', t('childAuth.failed'));
    return res.redirect('/login');
  }
  setChildCookie(res, child.id);
  res.redirect('/child');
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
function logout(req, res) {
  clearAuthCookie(res);
  clearChildCookie(res);
  res.redirect('/home');
}

module.exports = { home, homeForUser, languagePage, languageSave, loginPage, login, signupPage, signup, googleStart, googleCallback, childLoginPage, childLogin, logout };