'use strict';

const { Child, Lesson, Game, Attempt, Progress, Badge } = require('../models');

// ---------------------------------------------------------------------------
// Game scoring. The server ALWAYS recomputes the score from the stored
// game_json + the submitted answers — never trusts the client's number.
// ---------------------------------------------------------------------------

function computeMaxScore(game) {
  if (!game) return 0;
  // airplane: every question counts.
  if (Array.isArray(game.questions)) {
    return game.questions.reduce((sum, it) => sum + (Number.isInteger(it.points) && it.points > 0 ? it.points : 10), 0);
  }
  // whack_a_mole / flying_fruit: only the correct targets award points.
  if (Array.isArray(game.targets)) {
    return game.targets.reduce((sum, it) => sum + (it.is_correct ? (Number.isInteger(it.points) && it.points > 0 ? it.points : 10) : 0), 0);
  }
  if (Array.isArray(game.items)) {
    return game.items.reduce((sum, it) => sum + (it.is_correct ? (Number.isInteger(it.points) && it.points > 0 ? it.points : 10) : 0), 0);
  }
  // legacy fallback (entries with options)
  if (Array.isArray(game.entries)) {
    return game.entries.reduce((sum, it) => sum + (Number.isInteger(it.points) && it.points > 0 ? it.points : 10), 0);
  }
  return 0;
}

function cleanAnswers(submitted) {
  if (!Array.isArray(submitted)) return [];
  return submitted
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      itemIndex: Number.isInteger(a.itemIndex) ? a.itemIndex : -1,
      selectedIndex: Number.isInteger(a.selectedIndex) ? a.selectedIndex : null,
      selected: typeof a.selected === 'string' ? a.selected.trim() : null,
      wrongHits: Array.isArray(a.wrongHits)
        ? a.wrongHits.map((h) => String(h).trim()).filter(Boolean)
        : [],
      matchedRight: typeof a.matchedRight === 'string' ? a.matchedRight.trim() : null,
      tapped: a.tapped === true,
      text: typeof a.text === 'string' ? a.text.trim() : null,
    }));
}

// The server compares real answers against the stored game_json — it never
// trusts a client-computed score.
const eq = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function gradeGame(game, submitted) {
  const answers = cleanAnswers(submitted);
  const maxScore = computeMaxScore(game);
  let score = 0;
  let correctCount = 0;
  const details = [];

  const findAns = (i) => answers.find((a) => a.itemIndex === i);

  // airplane — fly into the correct clouds. +10 per correct answer, -5 per
  // wrong cloud hit on that question (clamped so a question still scores >=0).
  if (Array.isArray(game.questions)) {
    game.questions.forEach((q, i) => {
      const ans = findAns(i);
      const picked = ans && ans.selected ? ans.selected : null;
      const correct = picked != null && eq(picked, q.correct_answer);
      const pts = Number.isInteger(q.points) && q.points > 0 ? q.points : 10;
      if (correct) {
        const hits = (ans.wrongHits || [])
          .map((h) => String(h).trim())
          .filter(Boolean)
          .filter((t) => !eq(t, q.correct_answer));
        const distinct = [...new Set(hits.map((t) => t.toLowerCase()))];
        score += Math.max(0, pts - 5 * distinct.length);
        correctCount++;
      }
      details.push({ itemIndex: i, correct });
    });
    return { score: Math.round(score), maxScore, correctCount, totalItems: game.questions.length, details, pct: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0 };
  }

  // whack_a_mole / flying_fruit — tap the right ones, avoid the wrong ones.
  const tapList = game.targets || game.items || null;
  if (Array.isArray(tapList)) {
    tapList.forEach((item, i) => {
      const ans = findAns(i);
      const tapped = ans ? ans.tapped : false;
      const correct = item.is_correct ? tapped : !tapped;
      const pts = Number.isInteger(item.points) && item.points > 0 ? item.points : 10;
      // +10 for a correct tap, -5 for a wrong one (arcade scoring).
      if (tapped) score += item.is_correct ? pts : -5;
      if (correct) correctCount++;
      details.push({ itemIndex: i, correct, tapped });
    });
    if (score < 0) score = 0;
    return { score: Math.round(score), maxScore, correctCount, totalItems: tapList.length, details, pct: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0 };
  }

  // legacy fallback (entries with options)
  (game.entries || []).forEach((item, i) => {
    const ans = findAns(i);
    let correct = false;

    if (Array.isArray(item.options) && Number.isInteger(item.correctIndex)) {
      const picked = ans && ans.selectedIndex !== null ? ans.selectedIndex : null;
      correct = picked === item.correctIndex;
    } else {
      const picked = ans && ans.text ? ans.text : null;
      const accepted = Array.isArray(item.aliases) && item.aliases.length ? item.aliases : (item.answer ? [item.answer] : []);
      correct = picked != null && accepted.some((a) => eq(a, picked));
    }

    if (correct) { score += Number.isInteger(item.points) && item.points > 0 ? item.points : 10; correctCount++; }
    details.push({ itemIndex: i, correct });
  });

  return {
    score: Math.round(score),
    maxScore,
    correctCount,
    totalItems: (game.entries || []).length,
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