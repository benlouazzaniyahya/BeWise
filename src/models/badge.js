'use strict';

const { all, get, run } = require('../db');

const findForChildLesson = (childId, lessonId) => get('SELECT * FROM badges WHERE child_id = ? AND lesson_id = ?', childId, lessonId);
const create = (childId, lessonId, badgeType) =>
  run('INSERT INTO badges (child_id, lesson_id, badge_type, awarded_at) VALUES (?, ?, ?, ?)', childId, lessonId, badgeType, new Date().toISOString());
const listForChild = (childId) =>
  all(
    `SELECT b.*, l.title AS lesson_title, l.subject_id
     FROM badges b JOIN lessons l ON l.id = b.lesson_id
     WHERE b.child_id = ? ORDER BY b.awarded_at DESC`,
    childId,
  );

module.exports = { findForChildLesson, create, listForChild };