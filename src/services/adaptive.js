'use strict';

const { Attempt } = require('../models');

// ---------------------------------------------------------------------------
// Adaptive learning: uses each child's saved attempt history (score over
// time, per subject) to (a) suggest a difficulty for the next AI generation
// and (b) compute a plain-language "learning speed" metric.
// ---------------------------------------------------------------------------

const attemptHistory = (childId) => Attempt.historyForChild(childId);

function perLessonPassInfo(childId) {
  // for each lesson the child attempted: first-try pass? attempts-to-pass
  const rows = Attempt.perLessonPassRows(childId);
  const lessons = {};
  for (const r of rows) {
    if (!lessons[r.lesson_id]) lessons[r.lesson_id] = { target: r.target_score, attempts: [], passedAt: null };
    const pct = r.max_score > 0 ? (r.score / r.max_score) * 100 : 0;
    lessons[r.lesson_id].attempts.push({ n: r.attempt_number, pct });
    if (pct >= r.target_score && lessons[r.lesson_id].passedAt === null) lessons[r.lesson_id].passedAt = r.attempt_number;
  }
  return lessons;
}

function computeLearningSpeed(childId) {
  const history = attemptHistory(childId);
  const lessons = perLessonPassInfo(childId);
  const lessonIds = Object.keys(lessons);

  const pcts = history.map((h) => (h.max_score > 0 ? (h.score / h.max_score) * 100 : 0));

  let passedCount = 0;
  let firstTryPass = 0;
  let attemptsToPassSum = 0;
  let attemptsToPassN = 0;
  for (const id of lessonIds) {
    const info = lessons[id];
    if (info.passedAt !== null) {
      passedCount++;
      if (info.passedAt === 1) firstTryPass++;
      attemptsToPassSum += info.passedAt;
      attemptsToPassN++;
    }
  }

  const firstTryRate = passedCount > 0 ? firstTryPass / passedCount : 0;
  const avgAttemptsToPass = attemptsToPassN > 0 ? attemptsToPassSum / attemptsToPassN : null;

  // score trend: mean pct of last 3 vs previous
  let trend = 'flat';
  if (pcts.length >= 3) {
    const recent = pcts.slice(-3);
    const before = pcts.slice(0, -3);
    const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const delta = avg(recent) - (before.length ? avg(before) : avg(recent));
    if (delta > 5) trend = 'up';
    else if (delta < -5) trend = 'down';
  }

  const speedScore = Math.round(
    Math.min(100, Math.max(0,
      firstTryRate * 70
      + (avgAttemptsToPass === null ? 30 : Math.max(0, 60 - (avgAttemptsToPass - 1) * 12))
      + (trend === 'up' ? 15 : trend === 'down' ? -10 : 5),
    )),
  );

  return {
    history,
    passedCount,
    totalAttempted: lessonIds.length,
    firstTryRate,
    avgAttemptsToPass,
    trend,
    speedScore,
    series: history.map((h) => ({ x: h.completed_at, score: h.max_score > 0 ? Math.round((h.score / h.max_score) * 100) : 0 })),
  };
}

function speedLabelKey(speed) {
  if (speed.firstTryRate >= 0.6 && speed.speedScore >= 70) return 'fast';
  if (speed.speedScore >= 40) return 'steady';
  return 'slow';
}

// Difficulty suggestion for a child in a subject (used for adaptive generation).
// Returns the level to ask the AI for (1..5).
function suggestDifficulty(childId, subjectId, baseLevel) {
  const rows = Attempt.scoreRowsForSubject(childId, subjectId);
  if (!rows.length) return baseLevel;

  const avgPct = rows.reduce((s, r) => s + (r.score / r.max_score) * 100, 0) / rows.length;
  const passRate = rows.filter((r) => (r.score / r.max_score) * 100 >= r.target_score).length / rows.length;

  let level = baseLevel;
  if (avgPct >= 85 && passRate >= 0.75) level = baseLevel + 1;
  else if (avgPct < 60 || passRate < 0.4) level = baseLevel - 1;
  return Math.min(6, Math.max(1, level));
}

// Class-level suggestion: difficulty to ask the AI when generating for a whole
// subject, based on every saved attempt in that subject (the "learning speed"
// of the class informs generation). Returns baseLevel +- 1.
function suggestLevelForSubject(subjectId, baseLevel) {
  const rows = Attempt.scoreRowsForSubjectAll(subjectId);
  if (!rows.length) return baseLevel;
  const passRate = rows.filter((r) => (r.score / r.max_score) * 100 >= r.target_score).length / rows.length;
  const avgPct = rows.reduce((s, r) => s + (r.score / r.max_score) * 100, 0) / rows.length;
  let level = baseLevel;
  if (avgPct >= 82 && passRate >= 0.7) level = baseLevel + 1;
  else if (avgPct < 55 || passRate < 0.35) level = baseLevel - 1;
  return Math.min(6, Math.max(1, level));
}

module.exports = { attemptHistory, computeLearningSpeed, speedLabelKey, suggestDifficulty, suggestLevelForSubject };