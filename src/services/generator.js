'use strict';

// Background in-process job queue for AI game generation.
//
// Teachers trigger one job per (variant x gender-theme) combination. Each job
// is picked up here, runs the AI (or offline) generator, validates the output
// and stores the resulting game as `pending_review`. Jobs that died mid-run
// (server restart) are swept back to `pending` on boot.

const ai = require('./ai');
const { Lesson, Subject, Game, Job } = require('../models');
const { PROFILES, TEMPLATES } = require('../i18n');

const GENDERS = ['neutral', 'male', 'female'];
const VARIANTS = PROFILES;

// Requeue runs that were interrupted (module load time, like the old routes).
Job.sweepStale();

async function processJob(job) {
  Job.setRunning(job.id);
  try {
    const payload = JSON.parse(job.payload || '{}');
    const lesson = Lesson.findById(job.lesson_id);
    const subject = Subject.findById(lesson.subject_id);

    // clean older non-approved games for this combo before inserting the fresh one
    Game.deleteNonApprovedForCombo(lesson.id, payload.variant, payload.genderTheme);

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