'use strict';

// Spec-compliant JSON API for AI game generation.
//   POST /api/games/generate     { lessonText, level, ... } -> { metadata, games }
//   POST /api/games/regenerate   { previousJson, feedbackInstructions } -> { metadata, games }
// Both are stateless (no DB writes) and require a teacher session; the
// teacher then reviews/publishes through the normal flow.

const express = require('express');
const ai = require('../services/ai');
const { LANGS, PROFILES, TEMPLATES } = require('../i18n');

const router = express.Router();

const GENDER_THEMES = ['neutral', 'male', 'female'];

function jsonGuard(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ ok: false, message: 'Authentication required.' });
  if (res.locals.user.role !== 'teacher') return res.status(403).json({ ok: false, message: 'Teacher role required.' });
  next();
}

router.use(jsonGuard);

router.post('/games/generate', async (req, res) => {
  const lessonText = typeof req.body.lessonText === 'string' ? req.body.lessonText.trim().slice(0, 4000) : '';
  if (!lessonText) return res.status(400).json({ ok: false, message: 'lessonText is required.' });

  const level = typeof req.body.level === 'string' && req.body.level.trim() ? req.body.level.trim().slice(0, 24) : 'cp';
  const lang = LANGS.includes(req.body.lang) ? req.body.lang : 'en';
  const variant = PROFILES.includes(req.body.variant) ? req.body.variant : 'normale';
  const genderTheme = GENDER_THEMES.includes(req.body.genderTheme) ? req.body.genderTheme : 'neutral';
  const subjectName = typeof req.body.subjectName === 'string' && req.body.subjectName ? req.body.subjectName : 'english';
  const template = TEMPLATES.includes(req.body.template) ? req.body.template : undefined;

  try {
    const data = await ai.generateFromSpec({
      lessonText,
      level,
      lang,
      variant,
      genderTheme,
      subjectName,
      template,
      extraInstructions: typeof req.body.extraInstructions === 'string' ? req.body.extraInstructions : undefined,
    });
    return res.json({ ok: true, ...data });
  } catch (err) {
    const code = err.code === 'GENERATION_FAILED' ? 502 : 400;
    return res.status(code).json({ ok: false, message: (err.message || 'Game generation failed.').slice(0, 300) });
  }
});

router.post('/games/regenerate', async (req, res) => {
  const previousJson = req.body && typeof req.body.previousJson === 'object' ? req.body.previousJson : null;
  const feedbackInstructions = typeof req.body.feedbackInstructions === 'string' ? req.body.feedbackInstructions.trim().slice(0, 1200) : '';
  if (!previousJson || Array.isArray(previousJson)) {
    return res.status(400).json({ ok: false, message: 'previousJson must be a JSON object containing the previous game.' });
  }
  if (!feedbackInstructions) return res.status(400).json({ ok: false, message: 'feedbackInstructions is required.' });

  try {
    const data = await ai.regenerateFromFeedback({ previousJson, feedbackInstructions });
    return res.json({ ok: true, ...data });
  } catch (err) {
    const code = err.code === 'GENERATION_FAILED' ? 502 : 400;
    return res.status(code).json({ ok: false, message: (err.message || 'Regeneration failed.').slice(0, 300) });
  }
});

module.exports = router;