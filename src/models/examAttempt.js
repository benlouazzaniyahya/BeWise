'use strict';

const { all, get, run } = require('../db');

const countForChildLesson = (childId, lessonId) =>
  get('SELECT COUNT(*) AS n FROM exam_attempts WHERE child_id = ? AND lesson_id = ?', childId, lessonId).n;

const listForChildLesson = (childId, lessonId) =>
  all(
    'SELECT * FROM exam_attempts WHERE child_id = ? AND lesson_id = ? ORDER BY attempt_number ASC',
    childId, lessonId,
  );

const lastForChildLesson = (childId, lessonId) =>
  get(
    'SELECT * FROM exam_attempts WHERE child_id = ? AND lesson_id = ? ORDER BY attempt_number DESC LIMIT 1',
    childId, lessonId,
  );

const historyForChild = (childId) =>
  all(
    `SELECT ea.*, l.title AS lesson_title, l.target_score, s.name AS subject
     FROM exam_attempts ea
     JOIN lessons l ON l.id = ea.lesson_id
     JOIN subjects s ON s.id = l.subject_id
     WHERE ea.child_id = ?
     ORDER BY ea.completed_at ASC, ea.id ASC`,
    childId,
  );

function create({ childId, examId, lessonId, attemptNumber, score, maxScore, correctCount, answersJson, startedAt, completedAt }) {
  run(
    'INSERT INTO exam_attempts (child_id, exam_id, lesson_id, attempt_number, score, max_score, correct_count, answers_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    childId, examId, lessonId, attemptNumber, score, maxScore, correctCount, answersJson, startedAt, completedAt,
  );
}

module.exports = { countForChildLesson, listForChildLesson, lastForChildLesson, historyForChild, create };