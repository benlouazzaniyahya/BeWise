'use strict';

const jwt = require('jsonwebtoken');
const { get } = require('../db');
const { LANGS, LANG_META, tFor, translate } = require('../i18n');

const TOKEN_COOKIE = 'bewize_token';
const LANG_COOKIE = 'bewize_lang';
const FLASH_COOKIE = 'bewize_flash';

const JWT_SECRET = process.env.JWT_SECRET || 'bewize-dev-secret';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'bewize-dev-cookie-secret';

function signUser(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie(TOKEN_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
}

function clearAuthCookie(res) {
  res.clearCookie(TOKEN_COOKIE);
}

function readToken(req) {
  const cookie = req.cookies && req.cookies[TOKEN_COOKIE];
  if (!cookie) return null;
  try {
    return jwt.verify(cookie, JWT_SECRET);
  } catch {
    return null;
  }
}

function getLang(req, user) {
  if (user && user.language && LANGS.includes(user.language)) return user.language;
  const cookie = req.cookies && req.cookies[LANG_COOKIE];
  if (cookie && LANGS.includes(cookie)) return cookie;
  return 'en';
}

// ---------------------------------------------------------------------------
// Attach user + language + t() to every render
// ---------------------------------------------------------------------------
function setLocals(req, res, next) {
  const payload = readToken(req);
  let user = null;
  if (payload && payload.id) user = get('SELECT * FROM users WHERE id = ?', payload.id);
  if (payload && !user) clearAuthCookie(res);

  res.locals.user = user;
  res.locals.lang = getLang(req, user);
  res.locals.dir = LANG_META[res.locals.lang].dir;
  res.locals.isRTL = res.locals.dir === 'rtl';
  res.locals.requestPath = req.originalUrl;
  res.locals.t = tFor(res.locals.lang);
  res.locals.translate = translate;
  res.locals.subjectLabel = (name) => translate(res.locals.lang, {
    arabic: 'subject.arabic', french: 'subject.french', english: 'subject.english', math: 'subject.math',
  }[name] || 'subject.english');
  res.locals.SCHOOL_LEVELS = require('../i18n').SCHOOL_LEVELS;
  res.locals.gradeLabel = (code) => translate(res.locals.lang, `grade.${code}`);
  res.locals.gradeForAge = (age) => require('../i18n').gradeForAge(age).code;
  res.locals.gradeInfo = (code) => require('../i18n').gradeInfo(code);
  res.locals.aiHasKey = () => Boolean(process.env.OPENROUTER_API_KEY);

  next();
}

// First visit: choose app language before anything else. Logged-in users and
// children already have a stored language, so they pass through.
function ensureLang(req, res, next) {
  const hasLang = Boolean(
    (req.cookies && req.cookies[LANG_COOKIE]) || res.locals.user || res.locals.child,
  );
  const p = req.path;
  if (!hasLang) {
    const excluded = ['/language', '/assets', '/favicon', '/_', '/auth/google', '/child-login'];
    const isExcluded = excluded.some((x) => p.startsWith(x));
    if (!isExcluded) {
      return res.redirect('/language?next=' + encodeURIComponent(p + (req.url.includes('?') ? '' : '')));
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!res.locals.user) {
    req.flash('error', 'Please sign in to continue.');
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!res.locals.user) {
      req.flash('error', translate(res.locals.lang, 'err.loginRequired'));
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    if (!roles.includes(res.locals.user.role)) {
      req.flash('error', translate(res.locals.lang, 'err.forbidden'));
      return res.status(403).render('error', { titleKey: 'common.error', messageKey: 'err.forbidden', code: 403 });
    }
    next();
  };
}

// Child login uses its own cookie (children are not `users`).
const CHILD_COOKIE = 'bewize_child';
function setChildCookie(res, childId) {
  res.cookie(CHILD_COOKIE, jwt.sign({ childId }, JWT_SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
}
function clearChildCookie(res) {
  res.clearCookie(CHILD_COOKIE);
}
function readChild(req) {
  const cookie = req.cookies && req.cookies[CHILD_COOKIE];
  if (!cookie) return null;
  try {
    const payload = jwt.verify(cookie, JWT_SECRET);
    return get('SELECT * FROM children WHERE id = ?', payload.childId);
  } catch {
    return null;
  }
}
function setChildLocals(req, res, next) {
  let child = null;
  if (readToken(req)) {
    // adult session; ignore any child cookie
  } else {
    child = readChild(req);
  }
  res.locals.child = child;
  if (child) {
    res.locals.lang = child.language;
    res.locals.dir = LANG_META[child.language].dir;
    res.locals.isRTL = res.locals.dir === 'rtl';
    res.locals.t = tFor(child.language);
  }
  next();
}
function requireChild(req, res, next) {
  if (!res.locals.child) {
    req.flash('error', translate(res.locals.lang, 'err.loginRequired'));
    return res.redirect('/child-login');
  }
  next();
}

// ---------------------------------------------------------------------------
// Flash messages (one-time), stored in a signed cookie.
// ---------------------------------------------------------------------------
function flashMiddleware(req, res, next) {
  req.flash = (type, message) => {
    res.cookie(FLASH_COOKIE, JSON.stringify({ type, message }), { httpOnly: true, signed: true, sameSite: 'lax', maxAge: 60 * 1000 });
  };
  const raw = req.signedCookies && req.signedCookies[FLASH_COOKIE];
  res.locals.flash = null;
  if (raw) {
    try {
      res.locals.flash = JSON.parse(raw);
    } catch {
      res.locals.flash = null;
    }
  }
  next();
}

function clearFlash(req, res, next) {
  if (req.signedCookies && req.signedCookies[FLASH_COOKIE]) res.clearCookie(FLASH_COOKIE);
  next();
}

module.exports = {
  TOKEN_COOKIE, LANG_COOKIE, JWT_SECRET, COOKIE_SECRET,
  signUser, setAuthCookie, clearAuthCookie, readToken,
  setLocals, ensureLang, requireAuth, requireRole,
  setChildCookie, clearChildCookie, readChild, setChildLocals, requireChild,
  flashMiddleware, clearFlash,
};