'use strict';

const { all, get, run } = require('../db');

const listByLesson = (lessonId) => all('SELECT * FROM exams WHERE lesson_id = ? ORDER BY id ASC', lessonId);

// The single exam children can take: the latest published one.
const findApprovedByLesson = (lessonId) =>
  get("SELECT * FROM exams WHERE lesson_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1", lessonId);

const findApprovedById = (id) =>
  get("SELECT * FROM exams WHERE id = ? AND status = 'approved'", id);

const findById = (id) => get('SELECT * FROM exams WHERE id = ?', id);

const findOwnedById = (id, teacherId) =>
  get(
    `SELECT e.*, l.title AS lesson_title, l.target_score, l.teacher_id, s.name AS subject_name
     FROM exams e JOIN lessons l ON l.id = e.lesson_id JOIN subjects s ON s.id = l.subject_id
     WHERE e.id = ? AND l.teacher_id = ?`,
    id, teacherId,
  );

function create({ lessonId, questionsJson, notes = null, status = 'draft', approvedAt = null, approvedBy = null }) {
  const cols = ['lesson_id', 'status', 'questions_json', 'notes', 'created_at'];
  const vals = [lessonId, status, questionsJson, notes, new Date().toISOString()];
  if (approvedAt) { cols.push('approved_at'); vals.push(approvedAt); }
  if (approvedBy) { cols.push('approved_by'); vals.push(approvedBy); }
  const placeholders = cols.map(() => '?').join(', ');
  const info = run(`INSERT INTO exams (${cols.join(', ')}) VALUES (${placeholders})`, ...vals);
  return info.lastInsertRowid;
}

const updateQuestions = (id, questionsJson, notes) =>
  run('UPDATE exams SET questions_json = ?, notes = ?, updated_at = ? WHERE id = ?', questionsJson, notes, new Date().toISOString(), id);

const approve = (id, approvedBy) => {
  const approvedAt = new Date().toISOString();
  run("UPDATE exams SET status = 'approved', approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?", approvedAt, approvedBy, new Date().toISOString(), id);
};

const setStatus = (id, status) => run('UPDATE exams SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id);

const deleteById = (id) => run('DELETE FROM exams WHERE id = ?', id);

module.exports = {
  listByLesson, findApprovedByLesson, findApprovedById, findById, findOwnedById,
  create, updateQuestions, approve, setStatus, deleteById,
};