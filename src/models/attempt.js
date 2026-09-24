'use strict';

const { all, get, run } = require('../db');

const countForChildLesson = (childId, lessonId) =>
  get('SELECT COUNT(*) AS n FROM attempts WHERE child_id = ? AND lesson_id = ?', childId, lessonId).n;

const listForChildLesson = (childId, lessonId) =>
  all(
    'SELECT * FROM attempts WHERE child_id = ? AND lesson_id = ? ORDER BY attempt_number ASC',
    childId, lessonId,
  );

// Parent dashboard: recent attempts with lesson titles and subject names.
const listForChildLessonRecent = (childId, limit = 20) =>
  all(
    `SELECT a.*, l.title AS lesson_title, l.target_score, s.name AS subject_name
     FROM attempts a
     JOIN lessons l ON l.id = a.lesson_id
     JOIN subjects s ON s.id = l.subject_id
     WHERE a.child_id = ?
     ORDER BY a.completed_at DESC LIMIT ?`,
    childId, limit,
  );

// Adaptive: full chronological history for the learning-speed report.
const historyForChild = (childId) =>
  all(
    `SELECT a.*, l.title AS lesson_title, l.target_score, s.name AS subject
     FROM attempts a
     JOIN lessons l ON l.id = a.lesson_id
     JOIN subjects s ON s.id = l.subject_id
     WHERE a.child_id = ?
     ORDER BY a.completed_at ASC, a.id ASC`,
    childId,
  );

// Adaptive: per lesson, per attempt — used to derive first-try/attempts-to-pass.
const perLessonPassRows = (childId) =>
  all(
    `SELECT l.id AS lesson_id, l.target_score, a.attempt_number, a.score, a.max_score, a.completed_at
     FROM attempts a JOIN lessons l ON l.id = a.lesson_id
     WHERE a.child_id = ?
     ORDER BY l.id ASC, a.attempt_number ASC`,
    childId,
  );

// Adaptive: difficulty suggestions — one child in one subject.
const scoreRowsForSubject = (childId, subjectId) =>
  all(
    `SELECT a.score, a.max_score, l.target_score
     FROM attempts a JOIN lessons l ON l.id = a.lesson_id
     WHERE a.child_id = ? AND l.subject_id = ? AND a.max_score > 0`,
    childId, subjectId,
  );

// Adaptive: class-level difficulty hint across a whole subject.
const scoreRowsForSubjectAll = (subjectId) =>
  all(
    `SELECT a.score, a.max_score, l.target_score
     FROM attempts a JOIN lessons l ON l.id = a.lesson_id
     WHERE l.subject_id = ? AND a.max_score > 0`,
    subjectId,
  );

function create({ childId, gameId, lessonId, attemptNumber, score, maxScore, answersJson, startedAt, completedAt }) {
  run(
    'INSERT INTO attempts (child_id, game_id, lesson_id, attempt_number, score, max_score, answers_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    childId, gameId, lessonId, attemptNumber, score, maxScore, answersJson, startedAt, completedAt,
  );
}

module.exports = {
  countForChildLesson, listForChildLesson, listForChildLessonRecent,
  historyForChild, perLessonPassRows, scoreRowsForSubject, scoreRowsForSubjectAll, create,
};