'use strict';

const { Subject, Lesson, Game, Job } = require('../models');
const { tFor, subjectLabel, gradeInfo, MAX_LEVEL, TEMPLATES } = require('../i18n');
const ai = require('../services/ai');
const generator = require('../services/generator');
const { suggestLevelForSubject } = require('../services/adaptive');

const { GENDERS, VARIANTS } = generator;
const clampTarget = (n) => Math.min(100, Math.max(1, n));
const clampLevel = (n) => Math.min(MAX_LEVEL, Math.max(1, n));
const localNow = () => new Date().toISOString();

function gameJsonSafe(game) {
  try { JSON.parse(game.game_json); return true; } catch { return false; }
}

function notFound(res) {
  return res.status(404).render('error', { titleKey: 'common.notFound', messageKey: 'common.notFound', code: 404 });
}

// ---------------------------------------------------------------------------
// Subjects overview
// ---------------------------------------------------------------------------
function subjectsPage(req, res) {
  const t = tFor(res.locals.lang);
  const subjects = Subject.listWithLessonCounts()
    .map((s) => ({ ...s, label: subjectLabel(res.locals.lang, s.name) }));
  res.render('teacher/subjects', { page: 'teacher', titleKey: 'teacher.subjectsTitle', subjects, t });
}

// ---------------------------------------------------------------------------
// Lessons list / create / detail
// ---------------------------------------------------------------------------
function lessonsList(req, res) {
  const t = tFor(res.locals.lang);
  const lessons = Lesson.listByTeacher(res.locals.user.id).map((l) => ({
    ...l,
    subject_label: subjectLabel(res.locals.lang, l.subject_name),
    games: Game.listByLesson(l.id),
  }));
  res.render('teacher/index', { page: 'teacher', titleKey: 'teacher.lessonsTitle', lessons, t });
}

function lessonNew(req, res) {
  const t = tFor(res.locals.lang);
  const subjects = Subject.list().map((s) => ({ ...s, label: subjectLabel(res.locals.lang, s.name) }));
  res.render('teacher/lesson-form', { page: 'teacher', titleKey: 'teacher.newLesson', lesson: null, subjects, t, defaultGrade: 'cp' });
}

const gradeFromBody = (body, fallback) => {
  const info = gradeInfo(String(body.school_level || ''));
  return info ? info.code : fallback;
};

function lessonCreate(req, res) {
  const t = tFor(res.locals.lang);
  const title = String(req.body.title || '').trim();
  const raw = String(req.body.raw_lesson_text || '').trim();
  const subjectId = Number(req.body.subject_id);
  const schoolLevel = gradeFromBody(req.body, 'cp');
  const level = clampLevel(Number(req.body.level) || 1);
  const target = clampTarget(Number(req.body.target_score) || 60);

  if (!title || !raw || !Subject.findById(subjectId)) {
    req.flash('error', t('common.error'));
    return res.redirect('/teacher/lessons/new');
  }
  const id = Lesson.create({
    subjectId,
    teacherId: res.locals.user.id,
    title,
    rawLessonText: raw,
    level,
    targetScore: target,
    orderIndex: Number(req.body.order_index) || 0,
    schoolLevel,
    created_at: localNow(),
  });
  req.flash('success', t('teacher.lessonCreated'));
  res.redirect(`/teacher/lessons/${id}`);
}

function lessonShow(req, res) {
  const t = tFor(res.locals.lang);
  const lesson = Lesson.findOwnedById(Number(req.params.id), res.locals.user.id);
  if (!lesson) return notFound(res);
  const subject = Subject.findById(lesson.subject_id);
  const games = Game.listByLesson(lesson.id);
  const jobs = Job.listByLesson(lesson.id);
  const busy = jobs.some((j) => j.status === 'pending' || j.status === 'running');
  const suggested = suggestLevelForSubject(subject.id, lesson.level);

  res.render('teacher/lesson-detail', {
    page: 'teacher', titleKey: 'teacher.lessonDetail', lesson, subject, games, jobs, busy,
    subject_label: subjectLabel(res.locals.lang, subject.name),
    suggested, t, GENDERS, VARIANTS,
  });
}

function lessonEdit(req, res) {
  const t = tFor(res.locals.lang);
  const lesson = Lesson.findOwnedById(Number(req.params.id), res.locals.user.id);
  if (!lesson) return notFound(res);
  const subjects = Subject.list().map((s) => ({ ...s, label: subjectLabel(res.locals.lang, s.name) }));
  res.render('teacher/lesson-form', { page: 'teacher', titleKey: 'teacher.editLesson', lesson, subjects, t, defaultGrade: lesson.school_level || 'cp' });
}

function lessonUpdate(req, res) {
  const t = tFor(res.locals.lang);
  const lesson = Lesson.findOwnedById(Number(req.params.id), res.locals.user.id);
  if (!lesson) return notFound(res);
  const schoolLevel = gradeFromBody(req.body, lesson.school_level || 'cp');
  Lesson.update(lesson.id, {
    title: String(req.body.title || '').trim() || lesson.title,
    rawLessonText: String(req.body.raw_lesson_text || '').trim() || lesson.raw_lesson_text,
    subjectId: Number(req.body.subject_id) || lesson.subject_id,
    level: clampLevel(Number(req.body.level) || lesson.level),
    targetScore: clampTarget(Number(req.body.target_score) || lesson.target_score),
    orderIndex: Number(req.body.order_index) ?? lesson.order_index,
    schoolLevel,
  });
  req.flash('success', t('teacher.lessonUpdated'));
  res.redirect(`/teacher/lessons/${lesson.id}`);
}

// ---------------------------------------------------------------------------
// Generate games — one job per (variant x gender theme) combination
// ---------------------------------------------------------------------------
function lessonGenerate(req, res) {
  const t = tFor(res.locals.lang);
  const lesson = Lesson.findOwnedById(Number(req.params.id), res.locals.user.id);
  if (!lesson) return notFound(res);

  if (Job.countActiveByLesson(lesson.id) > 0) {
    req.flash('error', t('teacher.generating'));
    return res.redirect(`/teacher/lessons/${lesson.id}`);
  }

  const chosen = req.body.genderTheme === 'both'
    ? ['male', 'female']
    : GENDERS.includes(req.body.genderTheme) ? [req.body.genderTheme] : ['neutral'];

  const extraInstructions = String(req.body.extraInstructions || '').trim().slice(0, 1200);
  const difficultyHint = Number(req.body.difficultyHint) || lesson.level;
  const template = TEMPLATES.includes(req.body.template) ? req.body.template : undefined;
  const subject = Subject.findById(lesson.subject_id);

  const jobs = [];
  for (const variant of VARIANTS) {
    for (const genderTheme of chosen) {
      jobs.push({
        variant,
        genderTheme,
        template,
        lang: Subject.defaultLanguage(subject.name),
        extraInstructions,
        difficultyHint,
        adaptiveNote: difficultyHint !== lesson.level ? t('adaptive.delegate') : null,
      });
    }
  }
  generator.dispatch(lesson.id, jobs);
  req.flash('success', t('gen.started') + ` (${jobs.length} job${jobs.length > 1 ? 's' : ''})`);
  res.redirect(`/teacher/lessons/${lesson.id}`);
}

// ---------------------------------------------------------------------------
// TRIPLE-pack generation + review (one AI call fills all 3 templates at once)
// ---------------------------------------------------------------------------
function lessonGenerateTriple(req, res) {
  const t = tFor(res.locals.lang);
  const lesson = Lesson.findOwnedById(Number(req.params.id), res.locals.user.id);
  if (!lesson) return notFound(res);

  if (Job.countActiveByLesson(lesson.id) > 0) {
    req.flash('error', t('teacher.generating'));
    return res.redirect(`/teacher/lessons/${lesson.id}`);
  }

  const genderTheme = GENDERS.includes(req.body.genderTheme) ? req.body.genderTheme : 'neutral';
  const variant = VARIANTS.includes(req.body.variant) ? req.body.variant : 'normale';
  const subject = Subject.findById(lesson.subject_id);

  generator.dispatch(lesson.id, [{
    triple: true,
    variant,
    genderTheme,
    lang: Subject.defaultLanguage(subject.name),
    extraInstructions: String(req.body.extraInstructions || '').trim().slice(0, 1200),
    difficultyHint: Number(req.body.difficultyHint) || lesson.level,
  }]);
  req.flash('success', t('teacher.tripleStarted'));
  res.redirect(`/teacher/lessons/${lesson.id}/triple-preview?variant=${encodeURIComponent(variant)}&genderTheme=${encodeURIComponent(genderTheme)}`);
}

function triplePreview(req, res) {
  const t = tFor(res.locals.lang);
  const lesson = Lesson.findOwnedById(Number(req.params.id), res.locals.user.id);
  if (!lesson) return notFound(res);
  const subject = Subject.findById(lesson.subject_id);
  const variant = VARIANTS.includes(req.query.variant) ? req.query.variant : 'normale';
  const genderTheme = GENDERS.includes(req.query.genderTheme) ? req.query.genderTheme : 'neutral';

  // Latest pending_review game per template for THIS (lesson, variant, gender) combo.
  const games = {};
  for (const tpl of TEMPLATES) {
    const row = Game.listByLesson(lesson.id).filter((g) => g.status === 'pending_review' && g.variant === variant && g.gender_theme === genderTheme && g.template_type === tpl);
    games[tpl] = row.length ? row[row.length - 1] : null;
  }

  // Also pull any approved rows for the same combo so the teacher can see
  // the live/published version per template alongside the pending one.
  const approved = {};
  for (const tpl of TEMPLATES) {
    const row = Game.listByLesson(lesson.id).filter((g) => g.status === 'approved' && g.variant === variant && g.gender_theme === genderTheme && g.template_type === tpl);
    approved[tpl] = row.length ? row[row.length - 1] : null;
  }

  const jobs = Job.listByLesson(lesson.id);
  const busy = jobs.some((j) => j.status === 'pending' || j.status === 'running');
  // Track the triple-pack jobs scoped to THIS (variant, gender) combo so we can
  // show "generating…" or a helpful failure banner instead of silent empty rows.
  const tripleJobs = jobs.filter((j) => {
    if (j.status !== 'pending' && j.status !== 'running' && j.status !== 'failed') return false;
    if (!j.payload) return false;
    try {
      const p = JSON.parse(j.payload);
      return p.triple === true && p.variant === variant && p.genderTheme === genderTheme;
    } catch (e) { return false; }
  });
  const busyTriple = tripleJobs.some((j) => j.status === 'pending' || j.status === 'running');
  const lastTriple = tripleJobs[tripleJobs.length - 1];
  const tripleFailed = lastTriple && lastTriple.status === 'failed' ? (lastTriple.error || '') : '';

  res.render('teacher/triple-preview', {
    page: 'teacher', titleKey: 'teacher.tripleTitle', lesson, subject,
    subject_label: subjectLabel(res.locals.lang, subject.name),
    variant, genderTheme, games, approved, jobs, busy, busyTriple, tripleFailed, t, GENDERS, VARIANTS,
  });
}

function tripleApprove(req, res) {
  const t = tFor(res.locals.lang);
  const lesson = Lesson.findOwnedById(Number(req.params.id), res.locals.user.id);
  if (!lesson) return notFound(res);
  const variant = VARIANTS.includes(req.body.variant) ? req.body.variant : 'normale';
  const genderTheme = GENDERS.includes(req.body.genderTheme) ? req.body.genderTheme : 'neutral';
  const teacherId = res.locals.user.id;

  // Approve the latest pending_review row of each template for this combo,
  // demote any previously approved siblings for the same combo+template.
  // The body may include a list of specific game ids; if absent, we approve
  // the most recent pending row per template.
  const wanted = Array.isArray(req.body.gameIds) ? req.body.gameIds.map((v) => Number(v)).filter(Boolean) : null;
  let approvedCount = 0;
  for (const tpl of TEMPLATES) {
    const candidates = Game.listByLesson(lesson.id)
      .filter((g) => g.status === 'pending_review' && g.variant === variant && g.gender_theme === genderTheme && g.template_type === tpl);
    const row = (wanted && wanted.length ? candidates.find((g) => wanted.includes(g.id)) : null) || (candidates.length ? candidates[candidates.length - 1] : null);
    if (!row) continue;
    Game.approve(row.id, teacherId);
    Game.demoteApprovedExcept(lesson.id, variant, genderTheme, row.id, row.template_type);
    approvedCount += 1;
  }
  req.flash(approvedCount ? 'success' : 'error', approvedCount
    ? t('teacher.tripleApproved', { count: approvedCount })
    : t('teacher.tripleNothingToApprove'));
  res.redirect(`/teacher/lessons/${lesson.id}`);
}

function tripleRegenerate(req, res) {
  const t = tFor(res.locals.lang);
  const lesson = Lesson.findOwnedById(Number(req.params.id), res.locals.user.id);
  if (!lesson) return notFound(res);
  if (Job.countActiveByLesson(lesson.id) > 0) {
    req.flash('error', t('teacher.generating'));
    return res.redirect(`/teacher/lessons/${lesson.id}/triple-preview?variant=${req.body.variant || 'normale'}&genderTheme=${req.body.genderTheme || 'neutral'}`);
  }
  const variant = VARIANTS.includes(req.body.variant) ? req.body.variant : 'normale';
  const genderTheme = GENDERS.includes(req.body.genderTheme) ? req.body.genderTheme : 'neutral';
  const subject = Subject.findById(lesson.subject_id);
  generator.dispatch(lesson.id, [{
    triple: true,
    variant,
    genderTheme,
    lang: Subject.defaultLanguage(subject.name),
    extraInstructions: String(req.body.extraInstructions || '').trim().slice(0, 1200),
    difficultyHint: Number(req.body.difficultyHint) || lesson.level,
  }]);
  req.flash('success', t('teacher.tripleStarted'));
  res.redirect(`/teacher/lessons/${lesson.id}/triple-preview?variant=${encodeURIComponent(variant)}&genderTheme=${encodeURIComponent(genderTheme)}`);
}

// ---------------------------------------------------------------------------
// Single-game review / approval actions
// ---------------------------------------------------------------------------
function gamePreview(req, res) {
  const t = tFor(res.locals.lang);
  const game = Game.findReviewById(Number(req.params.id));
  if (!game || game.teacher_id !== res.locals.user.id) return notFound(res);
  let gameJson = null;
  let staticVersion = null;
  try { gameJson = JSON.parse(game.game_json); } catch { /* reject below */ }
  try { staticVersion = JSON.parse(game.static_version_json || 'null'); } catch { staticVersion = null; }
  if (!staticVersion && gameJson) staticVersion = ai.deriveStaticVersion(gameJson);

  res.render('teacher/game-review', {
    page: 'teacher', titleKey: 'teacher.previewTitle', game, gameJson, staticVersion,
    subject_label: subjectLabel(res.locals.lang, game.subject_name), t,
  });
}

function gameApprove(req, res) {
  const t = tFor(res.locals.lang);
  const game = Game.findReviewById(Number(req.params.id));
  if (!game || game.teacher_id !== res.locals.user.id) return notFound(res);
  // Approve the new game first, then demote the previous approved version for
  // this combo + template (adaptive boosters survive). Order matters: the
  // partial unique index allows only ONE non-approved game per
  // (lesson, variant, gender, template_type).
  Game.approve(game.id, res.locals.user.id);
  Game.demoteApprovedExcept(game.lesson_id, game.variant, game.gender_theme, game.id, game.template_type);
  req.flash('success', t('teacher.published'));
  res.redirect(`/teacher/games/${game.id}/preview`);
}

function gameReject(req, res) {
  const t = tFor(res.locals.lang);
  const game = Game.findReviewById(Number(req.params.id));
  if (!game || game.teacher_id !== res.locals.user.id) return notFound(res);
  Game.setStatus(game.id, 'rejected');
  req.flash('success', t('teacher.rejected'));
  res.redirect(`/teacher/games/${game.id}/preview`);
}

async function gameFix(req, res) {
  const t = tFor(res.locals.lang);
  const game = Game.findFixById(Number(req.params.id));
  if (!game || game.teacher_id !== res.locals.user.id) return notFound(res);
  const feedback = String(req.body.feedback || '').trim().slice(0, 1200);
  if (!feedback || !gameJsonSafe(game)) {
    req.flash('error', t('common.error'));
    return res.redirect(`/teacher/games/${game.id}/preview`);
  }
  const lesson = Lesson.findById(game.lesson_id);
  try {
    const result = await ai.fixGame({
      lesson,
      game: JSON.parse(game.game_json),
      feedback,
      lang: Subject.defaultLanguage(game.subject_name),
      variant: game.variant,
      genderTheme: game.gender_theme,
      subjectName: game.subject_name,
    });
    Game.applyFix(game.id, {
      gameJson: JSON.stringify(result.game),
      staticVersionJson: JSON.stringify(result.staticVersion || ai.deriveStaticVersion(result.game)),
      notes: result.note,
    });
    req.flash('success', t('teacher.redoDone'));
  } catch (err) {
    req.flash('error', t('teacher.generationFailed'));
  }
  res.redirect(`/teacher/games/${game.id}/preview`);
}

function gameRegenerate(req, res) {
  const t = tFor(res.locals.lang);
  const game = Game.findReviewById(Number(req.params.id));
  if (!game || game.teacher_id !== res.locals.user.id) return notFound(res);
  generator.dispatch(game.lesson_id, [{
    variant: game.variant,
    genderTheme: game.gender_theme,
    template: game.template_type,
    lang: Subject.defaultLanguage(game.subject_name),
    extraInstructions: String(req.body.extraInstructions || '').trim().slice(0, 1200),
    difficultyHint: Number(req.body.difficultyHint) || Lesson.findById(game.lesson_id).level,
  }]);
  req.flash('success', t('teacher.regenerated'));
  res.redirect(`/teacher/games/${game.id}/preview`);
}

module.exports = {
  subjectsPage, lessonsList, lessonNew, lessonCreate, lessonShow, lessonEdit, lessonUpdate,
  lessonGenerate, lessonGenerateTriple, triplePreview, tripleApprove, tripleRegenerate,
  gamePreview, gameApprove, gameReject, gameFix, gameRegenerate,
};