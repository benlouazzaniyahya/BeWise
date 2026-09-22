'use strict';

const bcrypt = require('bcryptjs');
const { Child, Subject, Lesson, Progress, Badge, Attempt } = require('../models');
const { tFor, subjectLabel, LANGS } = require('../i18n');
const { computeLearningSpeed, speedLabelKey } = require('../services/adaptive');

const NAME_RE = /[^\p{L}\p{N}\s'\-]/u;
const LOGIN_RE = /^[a-zA-Z0-9_-]{3,24}$/;
const localNow = () => new Date().toISOString();

function ownChild(req, res) {
  return Child.findByIdOwned(Number(req.params.id), res.locals.user.id);
}

function childFormValues(req, child) {
  return {
    display_name: child ? child.display_name : String(req.body.display_name || '').trim(),
    age: child ? child.age : Number(req.body.age) || 6,
    gender: child ? child.gender : ['male', 'female'].includes(req.body.gender) ? req.body.gender : 'male',
    profile_type: child ? child.profile_type : ['standard', 'special_needs'].includes(req.body.profile_type) ? req.body.profile_type : 'standard',
    language: child ? child.language : LANGS.includes(req.body.language) ? req.body.language : res.locals.lang,
    child_login_id: child ? child.child_login_id : String(req.body.child_login_id || '').trim(),
    password: String(req.body.password || ''),
  };
}

function bad(req, res, message, to) {
  req.flash('error', message);
  res.redirect(to);
}

function notFound(res) {
  return res.status(404).render('error', { titleKey: 'common.notFound', messageKey: 'common.notFound', code: 404 });
}

// Build an SVG-friendly sparkline path from [{x,score}/...]
function sparkPoints(series) {
  const pts = series.map((s, i) => ({ pct: s.score != null ? s.score : 0, i }));
  const N = pts.length;
  if (N <= 1) return null;
  const W = 140, H = 34, pad = 3;
  const maxPct = Math.max(100, ...pts.map((p) => p.pct));
  const minPct = Math.min(...pts.map((p) => p.pct));
  const range = Math.max(maxPct - minPct, 10);
  const coords = pts.map((p) => {
    const x = pad + (W - pad * 2) * (p.i / (N - 1));
    const y = pad + (H - pad * 2) * (1 - (p.pct - minPct) / range);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
  const line = coords.map((c, i) => (i === 0 ? `M${c[0]},${c[1]}` : `L${c[0]},${c[1]}`)).join(' ');
  const area = `${line} L${coords[coords.length - 1][0]},${H - pad} L${coords[0][0]},${H - pad} Z`;
  return { line, area, last: coords[coords.length - 1], first: coords[0], w: W, h: H };
}

// ---------------------------------------------------------------------------
// Children overview
// ---------------------------------------------------------------------------
function index(req, res) {
  const t = tFor(res.locals.lang);
  const total = Lesson.countAll();
  const children = Child.listByParent(res.locals.user.id).map((c) => {
    const passed = Progress.countPassed(c.id);
    return {
      ...c,
      passed,
      total,
      pct: total > 0 ? Math.round((passed / total) * 100) : 0,
    };
  });
  res.render('parent/index', { page: 'parent', titleKey: 'parent.title', children, t });
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------
function childNew(req, res) {
  const t = tFor(res.locals.lang);
  res.render('parent/child-form', { page: 'parent', titleKey: 'parent.addChild', child: null, t, LANGS });
}

function childCreate(req, res) {
  const t = tFor(res.locals.lang);
  const v = childFormValues(req, null);
  if (!v.display_name || NAME_RE.test(v.display_name)) return bad(req, res, t('common.error'), '/parent/children/new');
  const age = v.age;
  if (!Number.isInteger(age) || age < 3 || age > 18) return bad(req, res, t('common.error'), '/parent/children/new');
  if (v.password.length < 6) return bad(req, res, t('parent.childPasswordHint'), '/parent/children/new');

  let loginId = v.child_login_id;
  if (!loginId) {
    let candidate;
    do {
      candidate = 'kid' + Math.random().toString(36).slice(2, 6);
    } while (Child.loginIdExists(candidate));
    loginId = candidate;
  } else {
    if (!LOGIN_RE.test(loginId) || Child.loginIdExists(loginId)) {
      return bad(req, res, t('common.error'), '/parent/children/new');
    }
  }

  const id = Child.create({
    parentId: res.locals.user.id,
    loginId,
    passwordHash: bcrypt.hashSync(v.password, 10),
    displayName: v.display_name,
    age,
    gender: v.gender,
    profileType: v.profile_type,
    language: v.language,
    created_at: localNow(),
  });
  req.flash('success', `${t('parent.childCreated')} · ${t('childAuth.loginId')}: ${loginId}`);
  res.redirect(`/parent/children/${id}`);
}

function childEdit(req, res) {
  const t = tFor(res.locals.lang);
  const child = ownChild(req, res);
  if (!child) return notFound(res);
  res.render('parent/child-form', { page: 'parent', titleKey: 'parent.editChild', child, t, LANGS });
}

function childUpdate(req, res) {
  const t = tFor(res.locals.lang);
  const child = ownChild(req, res);
  if (!child) return notFound(res);
  const display_name = String(req.body.display_name || '').trim();
  const age = Number(req.body.age);
  const gender = ['male', 'female'].includes(req.body.gender) ? req.body.gender : child.gender;
  const profile_type = ['standard', 'special_needs'].includes(req.body.profile_type) ? req.body.profile_type : child.profile_type;
  const language = LANGS.includes(req.body.language) ? req.body.language : child.language;
  if (!display_name || NAME_RE.test(display_name) || !Number.isInteger(age) || age < 3 || age > 18) {
    return bad(req, res, t('common.error'), `/parent/children/${child.id}/edit`);
  }
  Child.update(child.id, { displayName: display_name, age, gender, profileType: profile_type, language });
  req.flash('success', t('parent.childUpdated'));
  res.redirect(`/parent/children/${child.id}`);
}

function childResetPassword(req, res) {
  const t = tFor(res.locals.lang);
  const child = ownChild(req, res);
  if (!child) return notFound(res);
  const password = String(req.body.password || '').trim();
  if (password.length < 6) return bad(req, res, t('parent.childPasswordHint'), `/parent/children/${child.id}`);
  Child.updatePassword(child.id, bcrypt.hashSync(password, 10));
  req.flash('success', t('parent.passwordReset'));
  res.redirect(`/parent/children/${child.id}`);
}

function childDelete(req, res) {
  const t = tFor(res.locals.lang);
  const child = ownChild(req, res);
  if (!child) return notFound(res);
  Child.deleteById(child.id);
  req.flash('success', t('parent.childDeleted'));
  res.redirect('/parent');
}

// ---------------------------------------------------------------------------
// Per-child dashboard
// ---------------------------------------------------------------------------
function childShow(req, res) {
  const t = tFor(res.locals.lang);
  const child = ownChild(req, res);
  if (!child) return notFound(res);

  const subjects = Subject.list();
  const lessons = Lesson.listWithSubject();
  const progress = Progress.listForChild(child.id);
  const progMap = Object.fromEntries(progress.map((p) => [`${p.lesson_id}`, p]));
  const badges = Badge.listForChild(child.id);
  const attempts = Attempt.listForChildLessonRecent(child.id, 20);
  const speed = computeLearningSpeed(child.id);

  // per-subject aggregation
  const bySubject = subjects.map((s) => {
    const subLessons = lessons.filter((l) => l.subject_id === s.id);
    const passed = subLessons.filter((l) => progMap[l.id] && progMap[l.id].status === 'passed').length;
    const bests = subLessons.map((l) => (progMap[l.id] ? progMap[l.id].best_score : 0));
    const spark = attempts.filter((a) => a.subject_name === s.name).reverse();
    return {
      subject: s,
      label: subjectLabel(res.locals.lang, s.name),
      total: subLessons.length,
      passed,
      pct: subLessons.length ? Math.round((passed / subLessons.length) * 100) : 0,
      avgBest: bests.length ? Math.round(bests.reduce((a, b) => a + b, 0) / bests.length) : 0,
      latest: spark.length ? Math.round((spark[spark.length - 1].score / (spark[spark.length - 1].max_score || 1)) * 100) : null,
      spark: sparkPoints(spark),
    };
  });

  const total = lessons.length;
  const passedCount = lessons.filter((l) => progMap[l.id] && progMap[l.id].status === 'passed').length;
  const overallPct = total ? Math.round((passedCount / total) * 100) : 0;

  res.render('parent/child-dashboard', {
    page: 'parent',
    titleKey: 'parent.dashboard',
    child, t, badges, attempts, speed, speedKey: speedLabelKey(speed),
    bySubject, overallPct, passedCount, total, spark: sparkPoints(speed.series),
  });
}

module.exports = { index, childNew, childCreate, childEdit, childUpdate, childResetPassword, childDelete, childShow };