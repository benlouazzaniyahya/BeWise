'use strict';

const { Subject, Lesson, Game, Progress, Badge, Attempt } = require('../models');
const { tFor, subjectLabel } = require('../i18n');
const { recordAttempt, selectGameForChild } = require('../services/grading');
const { suggestDifficulty } = require('../services/adaptive');
const ai = require('../services/ai');

function notFound(res) {
  return res.status(404).render('error', { titleKey: 'common.notFound', messageKey: 'common.notFound', code: 404 });
}

function forbidden(res) {
  return res.status(403).render('error', { titleKey: 'common.error', messageKey: 'err.forbidden', code: 403 });
}

// ---------------------------------------------------------------------------
// Lesson map + status derivation
// ---------------------------------------------------------------------------
function computeLessonMap(child) {
  const subjects = Subject.list();
  const grade = child.school_level;
  const lessons = grade
    ? Lesson.listWithSubject().filter((l) => (l.school_level || null) === grade)
    : Lesson.listWithSubject();
  const progress = Progress.listForChild(child.id);
  const progMap = {};
  for (const p of progress) progMap[p.lesson_id] = p;
  const passed = new Set(progress.filter((p) => p.status === 'passed').map((p) => p.lesson_id));

  const bySubject = [];
  for (const s of subjects) {
    const ls = lessons.filter((l) => l.subject_id === s.id);
    if (!ls.length) continue;
    const firstNotPassed = ls.findIndex((l) => !passed.has(l.id));
    const maxLevel = Math.max(0, ...ls.map((l) => Number(l.level) || 0));
    const reached = firstNotPassed === -1 ? maxLevel : firstNotPassed === 0 ? 0 : (Number(ls[firstNotPassed - 1].level) || 0);
    const mapped = ls.map((l, i) => {
      let status = passed.has(l.id) ? 'passed' : i === firstNotPassed ? 'unlocked' : 'locked';
      const row = progMap[l.id];
      let best = row ? row.best_score : null;
      if (row && row.status === 'in_progress' && !passed.has(l.id)) status = 'in_progress';
      const badge = Boolean(Badge.findForChildLesson(child.id, l.id));
      return { lesson: l, status, best, badge };
    });
    bySubject.push({
      subject: s,
      label: subjectLabel(child.language, s.name),
      lessons: mapped,
      reached,
      max: maxLevel,
    });
  }
  return bySubject;
}

function statusAllowed(status) {
  return status !== 'locked';
}

function findEntry(child, lessonId) {
  const map = computeLessonMap(child);
  return map.flatMap((g) => g.lessons).find((m) => m.lesson.id === lessonId);
}

// ---------------------------------------------------------------------------
// Lesson map
// ---------------------------------------------------------------------------
function index(req, res) {
  const t = tFor(res.locals.lang);
  const child = res.locals.child;
  const bySubject = computeLessonMap(child);
  res.render('child/index', { page: 'child', titleKey: 'child.lessonMap', child, bySubject, t });
}

// ---------------------------------------------------------------------------
// Play page (renders the real game template)
// ---------------------------------------------------------------------------
function lessonShow(req, res) {
  const t = tFor(res.locals.lang);
  const child = res.locals.child;
  const lesson = Lesson.findById(Number(req.params.id));
  if (!lesson) return notFound(res);

  const entry = findEntry(child, lesson.id);
  const status = entry ? entry.status : 'locked';

  const game = selectGameForChild(child, lesson, { preferGameId: req.query.game ? Number(req.query.game) : null });
  const teacherApproved = Game.listApprovedByLesson(lesson.id).length > 0;
  const attempts = Attempt.listForChildLesson(child.id, lesson.id);
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;

  let gameJson = null;
  if (game) { try { gameJson = JSON.parse(game.game_json); } catch { gameJson = null; } }
  const eligible = statusAllowed(status);
  const showResult = req.query.result === '1' && lastAttempt;

  const subject = Subject.findById(lesson.subject_id);
  res.render('child/lesson', {
    page: 'child', titleKey: 'child.play', child, subject, lesson,
    subject_label: subjectLabel(child.language, subject.name),
    status, eligible, game, gameJson, attempts, lastAttempt, showResult, teacherApproved, t,
  });
}

// ---------------------------------------------------------------------------
// Completion — server recomputes + stores the score
// ---------------------------------------------------------------------------
function complete(req, res) {
  const child = res.locals.child;
  const lesson = Lesson.findById(Number(req.params.id));
  if (!lesson) return res.status(400).json({ ok: false, message: 'lesson not found' });

  const preferGameId = Number(req.body.game_id) || null;
  const game = selectGameForChild(child, lesson, { preferGameId });
  if (!game) return res.status(403).json({ ok: false, message: 'no approved game matches your profile' });

  let submitted;
  try {
    submitted = Array.isArray(req.body.answers) ? req.body.answers
      : typeof req.body.answers === 'string' ? JSON.parse(req.body.answers) : [];
  } catch { submitted = []; }

  const result = recordAttempt({ childId: child.id, game, lesson, submitted });
  return res.json({
    ok: true,
    redirect: `/child/lessons/${lesson.id}?result=1`,
    result: {
      score: result.grade.score,
      maxScore: result.grade.maxScore,
      pct: result.grade.pct,
      target: lesson.target_score,
      passed: result.passed,
      attempt: result.attempt_number,
      badgeAwarded: result.badgeAwarded,
    },
  });
}

// ---------------------------------------------------------------------------
// Static (non-game) read-through version
// ---------------------------------------------------------------------------
function staticPage(req, res) {
  const t = tFor(res.locals.lang);
  const child = res.locals.child;
  const lesson = Lesson.findById(Number(req.params.id));
  if (!lesson) return notFound(res);

  const entry = findEntry(child, lesson.id);
  const status = entry ? entry.status : 'locked';
  if (!statusAllowed(status)) return forbidden(res);

  const game = selectGameForChild(child, lesson);
  let staticVersion = null;
  if (game) {
    if (game.static_version_json) { try { staticVersion = JSON.parse(game.static_version_json); } catch { staticVersion = null; } }
    if (!staticVersion) staticVersion = ai.deriveStaticVersion(JSON.parse(game.game_json));
  }

  const subject = Subject.findById(lesson.subject_id);
  res.render('child/static', {
    page: 'child', titleKey: 'child.staticTitle', child, subject, lesson,
    subject_label: subjectLabel(child.language, subject.name), staticVersion, t,
  });
}

// ---------------------------------------------------------------------------
// Adaptive booster — AI-generated practice game at the child's own level.
// Goes straight to 'approved' because it derives from an ALREADY-approved
// lesson, targets the child's exact profile (age/gender/language/type) and
// passes the same strict server-side validation + safety filter. NO PII.
// ---------------------------------------------------------------------------
async function booster(req, res) {
  const t = tFor(res.locals.lang);
  const child = res.locals.child;
  const lesson = Lesson.findById(Number(req.params.id));
  if (!lesson) return notFound(res);

  const entry = findEntry(child, lesson.id);
  const status = entry ? entry.status : 'locked';
  if (!statusAllowed(status) || status === 'passed') {
    req.flash('error', t('common.error'));
    return res.redirect(`/child/lessons/${lesson.id}`);
  }
  const baseApproved = Game.listApprovedByLesson(lesson.id).length > 0;
  if (!baseApproved) { req.flash('error', t('child.gameNotReady')); return res.redirect(`/child/lessons/${lesson.id}`); }

  const difficulty = suggestDifficulty(child.id, lesson.subject_id, lesson.level);

  // Reuse a recent booster for this combo if it exists
  const existing = Game.findBooster(lesson.id, child.profile_type, child.gender);
  if (existing) { req.flash('success', t('child.boosterReady')); return res.redirect(`/child/lessons/${lesson.id}?game=${existing.id}`); }

  const subject = Subject.findById(lesson.subject_id);
  try {
    const result = await ai.generateOne({
      lesson,
      subjectName: subject.name,
      variant: child.profile_type,
      genderTheme: child.gender,
      lang: child.language,
      difficultyHint: difficulty,
    });
    const gameId = Game.create({
      lessonId: lesson.id,
      variant: child.profile_type,
      genderTheme: child.gender,
      templateType: result.game.type,
      gameJson: JSON.stringify(result.game),
      staticVersionJson: JSON.stringify(result.staticVersion),
      notes: 'adaptive-booster',
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy: lesson.teacher_id,
    });
    req.flash('success', `${t('child.boosterReady')} ${t('child.boosterExplained', { level: difficulty })}`);
    res.redirect(`/child/lessons/${lesson.id}?game=${gameId}`);
  } catch (err) {
    req.flash('error', t('child.boosterFailed'));
    res.redirect(`/child/lessons/${lesson.id}`);
  }
}

module.exports = { index, lessonShow, complete, staticPage, booster };