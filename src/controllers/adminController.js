'use strict';

const bcrypt = require('bcryptjs');
const { User, Child, Stats } = require('../models');
const { transaction } = require('../db');
const { tFor } = require('../i18n');

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Learning-speed metrics (per child + class average).
// Composite: attempts needed to pass, first-try pass rate, average time.
// ---------------------------------------------------------------------------
function computeChildMetrics(rows) {
  const lessons = {};
  for (const r of rows) {
    if (!lessons[r.lesson_id]) lessons[r.lesson_id] = { target: r.target_score, attempts: 0, passedAt: null };
    const pct = r.max_score > 0 ? (r.score / r.max_score) * 100 : 0;
    lessons[r.lesson_id].attempts += 1;
    if (pct >= r.target_score && lessons[r.lesson_id].passedAt === null) {
      lessons[r.lesson_id].passedAt = lessons[r.lesson_id].attempts;
    }
  }
  let passedCount = 0, firstTry = 0, attSum = 0, attN = 0, timeSum = 0, timeN = 0;
  for (const id of Object.keys(lessons)) {
    const info = lessons[id];
    if (info.passedAt !== null) {
      passedCount++;
      if (info.passedAt === 1) firstTry++;
      attSum += info.passedAt;
      attN++;
    }
  }
  for (const r of rows) {
    const t0 = Date.parse(r.started_at);
    const t1 = Date.parse(r.completed_at);
    if (isFinite(t0) && isFinite(t1) && t1 >= t0) { timeSum += (t1 - t0) / 1000; timeN++; }
  }
  return {
    totalAttempted: Object.keys(lessons).length,
    attemptCount: rows.length,
    passedCount,
    firstTryRate: passedCount ? firstTry / passedCount : 0,
    avgAttemptsToPass: attN ? attSum / attN : null,
    avgSeconds: timeN ? timeSum / timeN : null,
  };
}

function speedLabel(child, avg) {
  if (!child || child.totalAttempted === 0) return 'none';
  const ratioAtt = avg.avgAttemptsToPass && child.avgAttemptsToPass ? avg.avgAttemptsToPass / child.avgAttemptsToPass : 1;
  const ratioTime = avg.avgSeconds && child.avgSeconds ? avg.avgSeconds / child.avgSeconds : 1;
  const ratioFirst = avg.firstTryRate ? child.firstTryRate / avg.firstTryRate : 1;
  const score = ratioAtt * 0.4 + ratioTime * 0.3 + ratioFirst * 0.3;
  if (score >= 1.1) return 'faster';
  if (score <= 0.9) return 'slower';
  return 'about';
}

function preferenceLabel(games, exams) {
  const total = games + exams;
  if (!total) return 'none';
  const gPct = games / total;
  if (exams === 0) return 'games';
  if (games === 0) return 'exam';
  if (gPct >= 0.66) return 'games';
  if (gPct <= 0.34) return 'exam';
  return 'balanced';
}

const fmtSeconds = (s) => {
  if (s === null || s === undefined || !isFinite(s)) return null;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m${String(sec).padStart(2, '0')}`;
};

function dashboard(req, res) {
  const t = tFor(res.locals.lang);
  const users = User.listAll();
  const children = Child.listAllWithParentEmail();
  const stats = Stats.overview();

  // Method preference (games vs written exam), all children + per child.
  const pref = Stats.preferenceTotals();
  const prefTotal = (pref.games || 0) + (pref.exams || 0);
  const prefByChild = Stats.preferenceByChild().map((row) => ({
    ...row,
    games: row.games || 0,
    exams: row.exams || 0,
    label: preferenceLabel(row.games || 0, row.exams || 0),
  }));

  // Learning speed: per child + class average, from every saved attempt.
  const allRows = Stats.speedRowsAll();
  const metricsById = {};
  const activeIds = new Set();
  for (const r of allRows) {
    if (!metricsById[r.child_id]) metricsById[r.child_id] = [];
    metricsById[r.child_id].push(r);
  }
  for (const id of Object.keys(metricsById)) {
    if (metricsById[id].length) activeIds.add(Number(id));
    metricsById[id] = computeChildMetrics(metricsById[id]);
  }

  const activeMetrics = [...activeIds].map((id) => metricsById[id]);
  const avg = {
    avgAttemptsToPass: activeMetrics.length ? activeMetrics.reduce((s, m) => s + (m.avgAttemptsToPass || 0), 0) / activeMetrics.length : null,
    firstTryRate: activeMetrics.length ? activeMetrics.reduce((s, m) => s + m.firstTryRate, 0) / activeMetrics.length : 0,
    avgSeconds: activeMetrics.length ? activeMetrics.reduce((s, m) => s + (m.avgSeconds || 0), 0) / activeMetrics.length : null,
  };

  const speed = children.map((c) => {
    const m = metricsById[Number(c.id)] || computeChildMetrics([]);
    return {
      child: c,
      metrics: m,
      label: speedLabel(m, avg),
      avgAttemptsToPass: m.avgAttemptsToPass === null ? null : Math.round(m.avgAttemptsToPass * 10) / 10,
      firstTryPct: Math.round(m.firstTryRate * 100),
      avgTimeLabel: fmtSeconds(m.avgSeconds),
    };
  });

  res.render('admin/index', {
    page: 'admin', titleKey: 'admin.title', users, children, stats: stats || {}, t,
    pref, prefTotal, prefByChild,
    activeChildren: activeIds.size,
    speed, avg: { ...avg, avgTimeLabel: fmtSeconds(avg.avgSeconds), avgAttemptsToPass: avg.avgAttemptsToPass === null ? null : Math.round(avg.avgAttemptsToPass * 10) / 10, firstTryPct: Math.round(avg.firstTryRate * 100) },
  });
}

function createUser(req, res) {
  const t = tFor(res.locals.lang);
  const role = req.body.role === 'teacher' ? 'teacher' : 'parent';
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!VALID_EMAIL.test(email) || password.length < 6) {
    req.flash('error', t('common.error'));
    return res.redirect('/admin');
  }
  if (User.findByEmail(email)) {
    req.flash('error', t('auth.signupFailedEmail'));
    return res.redirect('/admin');
  }
  User.create({ role, email, passwordHash: bcrypt.hashSync(password, 10), language: res.locals.lang, created_at: new Date().toISOString() });
  req.flash('success', t('admin.createdUser'));
  res.redirect('/admin');
}

function deleteUser(req, res) {
  const t = tFor(res.locals.lang);
  const target = User.findById(Number(req.params.id));
  if (!target || target.role === 'admin') return res.redirect('/admin');
  transaction(() => {
    if (target.role === 'parent') Child.deleteByParent(target.id);
    User.deleteById(target.id);
  });
  req.flash('success', t('admin.deletedUser'));
  res.redirect('/admin');
}

function deleteChild(req, res) {
  const t = tFor(res.locals.lang);
  Child.deleteById(Number(req.params.id));
  req.flash('success', t('admin.deletedChild'));
  res.redirect('/admin');
}

module.exports = { dashboard, createUser, deleteUser, deleteChild };