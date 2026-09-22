'use strict';

const { all, get, run } = require('../db');

const listForChild = (childId) => all('SELECT * FROM progress WHERE child_id = ?', childId);
const findForLesson = (childId, lessonId) => get('SELECT * FROM progress WHERE child_id = ? AND lesson_id = ?', childId, lessonId);

// Record/refresh a score after an attempt (calling code computes the status).
function upsertForLesson(childId, lessonId, { bestScore, status }) {
  const existing = findForLesson(childId, lessonId);
  if (existing) {
    run(
      'UPDATE progress SET unlocked = 1, best_score = ?, status = ? WHERE child_id = ? AND lesson_id = ?',
      bestScore, status, childId, lessonId,
    );
  } else {
    run(
      'INSERT INTO progress (child_id, lesson_id, unlocked, best_score, status) VALUES (?, ?, 1, ?, ?)',
      childId, lessonId, bestScore, status,
    );
  }
}

// Unlock row for the next lesson (default 'locked' status until played).
const insertUnlockedZero = (childId, lessonId, status = 'locked') =>
  run('INSERT INTO progress (child_id, lesson_id, unlocked, best_score, status) VALUES (?, ?, 1, 0, ?)', childId, lessonId, status);

const markUnlocked = (childId, lessonId) =>
  run('UPDATE progress SET unlocked = 1 WHERE child_id = ? AND lesson_id = ?', childId, lessonId);

const countPassed = (childId) =>
  get("SELECT COUNT(*) AS n FROM progress WHERE child_id = ? AND status = 'passed'", childId).n;

module.exports = { listForChild, findForLesson, upsertForLesson, insertUnlockedZero, markUnlocked, countPassed };