'use strict';

const { all, get, run } = require('../db');

const findById = (id) => get('SELECT * FROM lessons WHERE id = ?', id);
const findOwnedById = (id, teacherId) =>
  get('SELECT * FROM lessons WHERE id = ? AND teacher_id = ?', id, teacherId);
const listByTeacher = (teacherId) =>
  all(
    `SELECT l.*, s.name AS subject_name FROM lessons l
     JOIN subjects s ON s.id = l.subject_id
     WHERE l.teacher_id = ?
     ORDER BY l.order_index ASC, l.id ASC`,
    teacherId,
  );
const listWithSubject = () =>
  all(
    `SELECT l.*, s.name AS subject_name FROM lessons l
     JOIN subjects s ON s.id = l.subject_id
     ORDER BY s.id ASC, l.order_index ASC, l.id ASC`,
  );
const countAll = () => get('SELECT COUNT(*) AS n FROM lessons').n;

function create({ subjectId, teacherId, title, rawLessonText, level, targetScore, orderIndex, created_at }) {
  const info = run(
    'INSERT INTO lessons (subject_id, teacher_id, title, raw_lesson_text, level, target_score, order_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    subjectId, teacherId, title, rawLessonText, level, targetScore, orderIndex, created_at,
  );
  return info.lastInsertRowid;
}

const update = (id, { title, rawLessonText, subjectId, level, targetScore, orderIndex }) =>
  run(
    'UPDATE lessons SET title = ?, raw_lesson_text = ?, subject_id = ?, level = ?, target_score = ?, order_index = ? WHERE id = ?',
    title, rawLessonText, subjectId, level, targetScore, orderIndex, id,
  );

const deleteById = (id) => run('DELETE FROM lessons WHERE id = ?', id);

// First lesson after `from` (same subject) the child hasn't passed yet.
const findNextToUnlock = ({ subjectId, fromId, fromOrder, childId }) =>
  get(
    `SELECT * FROM lessons
     WHERE subject_id = ? AND id != ? AND order_index >= ?
       AND id NOT IN (SELECT lesson_id FROM progress WHERE child_id = ? AND status = 'passed')
     ORDER BY order_index ASC, id ASC LIMIT 1`,
    subjectId, fromId, fromOrder, childId,
  );

module.exports = {
  findById, findOwnedById, listByTeacher, listWithSubject, countAll,
  create, update, deleteById, findNextToUnlock,
};