'use strict';

// Background in-process job queue for AI game generation.
//
// Teachers trigger one job per (variant x gender-theme) combination. Each job
// is picked up here, runs the AI (or offline) generator, validates the output
// and stores the resulting game as `pending_review`. Jobs that died mid-run
// (server restart) are swept back to `pending` on boot.

const ai = require('./ai');
const { Lesson, Subject, Game, Exam, Job } = require('../models');
const { PROFILES, TEMPLATES } = require('../i18n');

const GENDERS = ['male', 'female'];
const VARIANTS = PROFILES;

// Requeue runs that were interrupted (module load time, like the old routes).
Job.sweepStale();

async function processJob(job) {
  Job.setRunning(job.id);
  try {
    const payload = JSON.parse(job.payload || '{}');
    const lesson = Lesson.findById(job.lesson_id);
    const subject = Subject.findById(lesson.subject_id);

    if (payload.triple) {
      const result = await ai.generateThree({
        lesson,
        subjectName: subject.name,
        variant: payload.variant,
        genderTheme: payload.genderTheme,
        lang: payload.lang || 'en',
        extraInstructions: payload.extraInstructions,
        difficultyHint: payload.difficultyHint,
      });
      const ids = [];
      for (const tpl of TEMPLATES) {
        const game = result.games[tpl];
        if (!game) continue;
        // Replace the previous non-approved game for this combo/template only
        // AFTER the new one succeeded, so a failed regen never destroys the
        // existing pending version the teacher may already be reviewing.
        Game.deleteNonApprovedForCombo(lesson.id, payload.variant, payload.genderTheme, tpl);
        ids.push(Game.create({
          lessonId: lesson.id,
          variant: payload.variant,
          genderTheme: payload.genderTheme,
          templateType: tpl,
          gameJson: JSON.stringify(game),
          staticVersionJson: JSON.stringify(result.staticVersions && result.staticVersions[tpl] || ai.deriveStaticVersion(game)),
          notes: (result.note || '') + ' [triple-pack]',
        }));
      }
      Job.setDone(job.id, ids.join(','));
      return;
    }

    if (payload.exam) {
      const result = await ai.generateExam({
        lesson,
        subjectName: subject.name,
        lang: payload.lang || 'en',
        extraInstructions: payload.extraInstructions,
      });
      // A new generation becomes a fresh draft; the teacher edits before
      // publishing. Previous drafts stay untouched so nothing is lost.
      const examId = Exam.create({
        lessonId: lesson.id,
        questionsJson: JSON.stringify(result.questions),
        notes: (result.note || '') + (payload.extraInstructions ? ' [teacher instructions]' : ''),
      });
      Job.setDone(job.id, String(examId));
      return;
    }

    const template = TEMPLATES.includes(payload.template) ? payload.template : undefined;

    const result = await ai.generateOne({
      lesson,
      subjectName: subject.name,
      variant: payload.variant,
      genderTheme: payload.genderTheme,
      lang: payload.lang || 'en',
      extraInstructions: payload.extraInstructions,
      difficultyHint: payload.difficultyHint,
      template,
    });

    Game.deleteNonApprovedForCombo(lesson.id, payload.variant, payload.genderTheme, payload.template || null);
    const gameId = Game.create({
      lessonId: lesson.id,
      variant: payload.variant,
      genderTheme: payload.genderTheme,
      templateType: result.game.template,
      gameJson: JSON.stringify(result.game),
      staticVersionJson: JSON.stringify(result.staticVersion),
      notes: result.note,
    });
    Job.setDone(job.id, String(gameId));
  } catch (err) {
    Job.setFailed(job.id, (err.message || 'generation failed').slice(0, 500));
  }
}

// Run jobs one at a time so AI requests stay sequential: OpenRouter rejects
// concurrent bursts ("would exceed your available credits given your current
// in-flight requests"), and single calls succeed.
let chain = Promise.resolve();

function dispatch(lessonId, specs) {
  for (const spec of specs) {
    const id = Job.create(lessonId, 'generate', JSON.stringify(spec));
    const job = Job.findById(id);
    chain = chain.then(() => processJob(job));
  }
}

module.exports = { GENDERS, VARIANTS, processJob, dispatch };