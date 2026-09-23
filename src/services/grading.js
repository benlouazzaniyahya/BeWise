'use strict';

const { Child, Lesson, Game, Attempt, Progress, Badge } = require('../models');

// ---------------------------------------------------------------------------
// Game scoring. The server ALWAYS recomputes the score from the stored
// game_json + the submitted answers — never trusts the client's number.
// ---------------------------------------------------------------------------

function computeMaxScore(game) {
  if (!game || !Array.isArray(game.items)) return 0;
  return game.items.reduce((sum, it) => sum + (Number.isInteger(it.points) && it.points > 0 ? it.points : 10), 0);
}

function cleanAnswers(submitted) {
  if (!Array.isArray(submitted)) return [];
  return submitted
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      itemIndex: Number.isInteger(a.itemIndex) ? a.itemIndex : -1,
      selectedIndex: Number.isInteger(a.selectedIndex) ? a.selectedIndex : null,
      matchedRight: typeof a.matchedRight === 'string' ? a.matchedRight.trim() : null,
      text: typeof a.text === 'string' ? a.text.trim() : null,
    }));
}

const eq = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function gradeGame(game, submitted) {
  const answers = cleanAnswers(submitted);
  const maxScore = computeMaxScore(game);
  let score = 0;
  let correctCount = 0;
  const details = [];

  game.items.forEach((item, i) => {
    const ans = answers.find((a) => a.itemIndex === i);
    let correct = false;

    if (game.type === 'quiz') {
      const picked = ans && ans.selectedIndex !== null ? ans.selectedIndex : null;
      correct = picked === item.correctIndex;
      if (correct) { score += item.points; correctCount++; }
    } else if (game.type === 'match') {
      const picked = ans && ans.matchedRight ? ans.matchedRight : null;
      correct = picked != null && eq(picked, item.right);
      if (correct) { score += item.points; correctCount++; }
    } else if (game.type === 'fill') {
      const picked = ans && ans.text ? ans.text : null;
      const accepted = Array.isArray(item.aliases) && item.aliases.length ? item.aliases : [item.answer];
      correct = picked != null && accepted.some((a) => eq(a, picked));
      if (correct) { score += item.points; correctCount++; }
    }

    details.push({ itemIndex: i, correct });
  });

  return {
    score: Math.round(score),
    maxScore,
    correctCount,
    totalItems: game.items.length,
    details,
    pct: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Persist an attempt + update progress + (maybe) badge + unlock next lesson.
// ---------------------------------------------------------------------------
function recordAttempt({ childId, game, lesson, submitted }) {
  const child = Child.findById(childId);
  if (!child) throw new Error('child not found');

  const grade = gradeGame(JSON.parse(game.game_json), submitted);
  const passed = grade.pct >= lesson.target_score;

  const result = (() => {
    const attemptNumber = Attempt.countForChildLesson(childId, lesson.id) + 1;

    Attempt.create({
      childId,
      gameId: game.id,
      lessonId: lesson.id,
      attemptNumber,
      score: grade.score,
      maxScore: grade.maxScore,
      answersJson: JSON.stringify({ submitted: cleanAnswers(submitted), correct: grade.details }),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const existing = Progress.findForLesson(childId, lesson.id);
    const bestScore = Math.max(existing ? existing.best_score : 0, grade.pct);
    const status = passed ? 'passed' : 'in_progress';
    Progress.upsertForLesson(childId, lesson.id, { bestScore, status });

    let badgeAwarded = null;
    if (passed) {
      const existingBadge = Badge.findForChildLesson(childId, lesson.id);
      if (!existingBadge) {
        Badge.create(childId, lesson.id, 'lesson_passed');
        badgeAwarded = 'lesson_passed';
      } else {
        badgeAwarded = existingBadge.badge_type;
      }
    }

    return { attempt_number: attemptNumber, grade, passed, badgeAwarded, bestScore };
  })();

  if (result.passed) unlockNextLesson(childId, lesson);
  return result;
}

function unlockNextLesson(childId, lesson) {
  const next = Lesson.findNextToUnlock({
    subjectId: lesson.subject_id,
    fromId: lesson.id,
    fromLevel: lesson.level,
    fromOrder: lesson.order_index,
    childId,
  });
  if (!next) return;
  const existing = Progress.findForLesson(childId, next.id);
  if (!existing) {
    Progress.insertUnlockedZero(childId, next.id, 'locked');
  } else if (existing.status === 'locked') {
    Progress.markUnlocked(childId, next.id);
  }
}

// ---------------------------------------------------------------------------
// Which game a child can play: approved + their profile variant, then the
// best gender-theme match (their gender wins, then neutral).
// ---------------------------------------------------------------------------
function selectGameForChild(child, lesson, { preferGameId } = {}) {
  const candidates = Game.listApprovedByLesson(lesson.id);

  if (preferGameId) {
    const target = candidates.find((g) => g.id === Number(preferGameId) && g.variant === child.profile_type);
    if (target) return target;
  }

  // Prefer the teacher's own approved game over adaptive boosters.
  const own = candidates.filter((g) => g.variant === child.profile_type && (g.notes || '') !== 'adaptive-booster');
  const pool = own.length ? own : candidates.filter((g) => g.variant === child.profile_type);

  if (!pool.length) return null;

  const exact = pool.filter((g) => g.gender_theme === child.gender);
  if (exact.length) return exact[0];
  const neutral = pool.find((g) => g.gender_theme === 'neutral');
  return neutral || pool[0];
}

module.exports = { computeMaxScore, gradeGame, cleanAnswers, recordAttempt, selectGameForChild, unlockNextLesson };