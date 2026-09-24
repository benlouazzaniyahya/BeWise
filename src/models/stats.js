'use strict';

const { all, get } = require('../db');

// Admin dashboard counts.
const overview = () =>
  get(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role='teacher') AS teachers,
      (SELECT COUNT(*) FROM users WHERE role='parent') AS parents,
      (SELECT COUNT(*) FROM children) AS children,
      (SELECT COUNT(*) FROM lessons) AS lessons,
      (SELECT COUNT(*) FROM games WHERE status='approved') AS approved_games
  `);

// ---------------------------------------------------------------------------
// Method preference: games (animated, AI) vs written exam (classic quiz).
// ---------------------------------------------------------------------------
const preferenceTotals = () =>
  get(`
    SELECT
      (SELECT COUNT(*) FROM attempts) AS games,
      (SELECT COUNT(*) FROM exam_attempts) AS exams
  `);

const preferenceByChild = () =>
  all(`
    SELECT c.id, c.display_name, c.school_level,
      (SELECT COUNT(*) FROM attempts a WHERE a.child_id = c.id) AS games,
      (SELECT COUNT(*) FROM exam_attempts ea WHERE ea.child_id = c.id) AS exams
    FROM children c
    ORDER BY c.display_name ASC
  `);

// ---------------------------------------------------------------------------
// Learning-speed rows: every saved attempt, game or exam, for one child or for
// every child (union keeps both methods in one ranking).
// ---------------------------------------------------------------------------
const SPEED_SELECT = `
SELECT 'game' AS method, a.child_id, a.lesson_id, a.attempt_number,
       a.score, a.max_score, a.started_at, a.completed_at,
       l.target_score, l.title AS lesson_title
FROM attempts a JOIN lessons l ON l.id = a.lesson_id
UNION ALL
SELECT 'exam', ea.child_id, ea.lesson_id, ea.attempt_number,
       ea.score, ea.max_score, ea.started_at, ea.completed_at,
       l.target_score, l.title
FROM exam_attempts ea JOIN lessons l ON l.id = ea.lesson_id
`;

const speedRowsForChild = (childId) =>
  all(`SELECT * FROM (${SPEED_SELECT}) t WHERE child_id = ? ORDER BY completed_at ASC, attempt_number ASC`, childId);

const speedRowsAll = () =>
  all(`SELECT * FROM (${SPEED_SELECT}) t ORDER BY completed_at ASC, attempt_number ASC`);

module.exports = { overview, preferenceTotals, preferenceByChild, speedRowsForChild, speedRowsAll };