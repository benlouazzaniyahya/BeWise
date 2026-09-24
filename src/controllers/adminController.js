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

function speedScore(metrics, avg) {
  if (!metrics || metrics.totalAttempted === 0) return null;
  const ratioAtt = avg.avgAttemptsToPass && metrics.avgAttemptsToPass ? avg.avgAttemptsToPass / metrics.avgAttemptsToPass : 1;
  const ratioTime = avg.avgSeconds && metrics.avgSeconds ? avg.avgSeconds / metrics.avgSeconds : 1;
  const ratioFirst = avg.firstTryRate ? metrics.firstTryRate / avg.firstTryRate : 1;
  return ratioAtt * 0.4 + ratioTime * 0.3 + ratioFirst * 0.3;
}

function speedLabel(child, avg) {
  if (!child || child.totalAttempted === 0) return 'none';
  const score = speedScore(child, avg);
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
      score: speedScore(m, avg),
      label: speedLabel(m, avg),
      avgAttemptsToPass: m.avgAttemptsToPass === null ? null : Math.round(m.avgAttemptsToPass * 10) / 10,
      firstTryPct: Math.round(m.firstTryRate * 100),
      avgTimeLabel: fmtSeconds(m.avgSeconds),
    };
  });

  // Girls vs boys: average learning-speed score + faster/about/slower shares.
  const genders = [...new Set(children.map((c) => c.gender).filter(Boolean))];
  const speedByGender = genders.map((g) => {
    const rows = speed.filter((s) => s.child.gender === g);
    const withScore = rows.filter((s) => s.score !== null);
    return {
      gender: g,
      children: rows.length,
      active: withScore.length,
      faster: rows.filter((r) => r.label === 'faster').length,
      about: rows.filter((r) => r.label === 'about').length,
      slower: rows.filter((r) => r.label === 'slower').length,
      none: rows.filter((r) => r.label === 'none').length,
      avgScore: withScore.length ? withScore.reduce((s, r) => s + r.score, 0) / withScore.length : null,
      fasterShare: rows.length ? rows.filter((r) => r.label === 'faster').length / rows.length : 0,
    };
  });

  // Preferred pass method per gender: games vs written exam.
  const prefByGender = genders.map((g) => {
    const rows = prefByChild.filter((r) => r.gender === g);
    return {
      gender: g,
      games: rows.reduce((s, r) => s + (r.games || 0), 0),
      exams: rows.reduce((s, r) => s + (r.exams || 0), 0),
    };
  });

  // Passed-attempt method per course (game vs exam), from the same union rows.
  const passByLesson = [];
  {
    const byLesson = {};
    for (const r of allRows) {
      const pct = r.max_score > 0 ? (r.score / r.max_score) * 100 : 0;
      if (pct < r.target_score) continue;
      if (!byLesson[r.lesson_id]) byLesson[r.lesson_id] = { lesson_id: r.lesson_id, lesson_title: r.lesson_title || '—', games: 0, exams: 0 };
      byLesson[r.lesson_id][r.method === 'exam' ? 'exams' : 'games'] += 1;
    }
    for (const id of Object.keys(byLesson)) passByLesson.push(byLesson[id]);
    passByLesson.sort((a, b) => (b.games + b.exams) - (a.games + a.exams));
  }

  res.render('admin/index', {
    page: 'admin', titleKey: 'admin.title', users, children, stats: stats || {}, t,
    pref, prefTotal, prefByChild,
    activeChildren: activeIds.size,
    speed, avg: { ...avg, avgTimeLabel: fmtSeconds(avg.avgSeconds), avgAttemptsToPass: avg.avgAttemptsToPass === null ? null : Math.round(avg.avgAttemptsToPass * 10) / 10, firstTryPct: Math.round(avg.firstTryRate * 100) },
    speedByGender, prefByGender, passByLesson,
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