'use strict';

const { all, get, run } = require('../db');

const listByLesson = (lessonId) => all('SELECT * FROM games WHERE lesson_id = ? ORDER BY id ASC', lessonId);
const listApprovedByLesson = (lessonId) =>
  all("SELECT * FROM games WHERE lesson_id = ? AND status = 'approved' ORDER BY id ASC", lessonId);
const findById = (id) => get('SELECT * FROM games WHERE id = ?', id);

const findReviewById = (id) =>
  get(
    `SELECT g.*, l.title AS lesson_title, l.level, l.target_score, l.subject_id, l.teacher_id, s.name AS subject_name
     FROM games g JOIN lessons l ON l.id = g.lesson_id JOIN subjects s ON s.id = l.subject_id
     WHERE g.id = ?`,
    id,
  );

const findFixById = (id) =>
  get(
    `SELECT g.*, l.raw_lesson_text, l.level, l.title AS lesson_title, s.name AS subject_name
     FROM games g JOIN lessons l ON l.id = g.lesson_id JOIN subjects s ON s.id = l.subject_id
     WHERE g.id = ?`,
    id,
  );

// Generic insert so both teacher-generated (pending_review) and adaptive
// boosters (approved, with approver) can be created from the same code.
function create({ lessonId, variant, genderTheme, templateType, gameJson, staticVersionJson, notes = null, status = 'pending_review', approvedAt = null, approvedBy = null }) {
  const cols = ['lesson_id', 'variant', 'gender_theme', 'status', 'template_type', 'game_json', 'static_version_json', 'notes', 'created_at'];
  const vals = [lessonId, variant, genderTheme, status, templateType, gameJson, staticVersionJson, notes, new Date().toISOString()];
  if (approvedAt) { cols.push('approved_at'); vals.push(approvedAt); }
  if (approvedBy) { cols.push('approved_by'); vals.push(approvedBy); }
  const placeholders = cols.map(() => '?').join(', ');
  const info = run(`INSERT INTO games (${cols.join(', ')}) VALUES (${placeholders})`, ...vals);
  return info.lastInsertRowid;
}

const deleteNonApprovedForCombo = (lessonId, variant, genderTheme, templateType) => {
  if (templateType) {
    return run(
      "DELETE FROM games WHERE lesson_id = ? AND variant = ? AND gender_theme = ? AND template_type = ? AND status != 'approved'",
      lessonId, variant, genderTheme, templateType,
    );
  }
  return run(
    "DELETE FROM games WHERE lesson_id = ? AND variant = ? AND gender_theme = ? AND status != 'approved'",
    lessonId, variant, genderTheme,
  );
};

// Keep the newest approved version for a combo (adaptive boosters survive).
// A templateType scopes the demotion to that template so approving one game
// never demotes an approved sibling of another template in the same combo.
const demoteApprovedExcept = (lessonId, variant, genderTheme, exceptId, templateType) =>
  templateType
    ? run(
        "UPDATE games SET status = 'pending_review' WHERE lesson_id = ? AND variant = ? AND gender_theme = ? AND template_type = ? AND id != ? AND status = 'approved' AND COALESCE(notes, '') != 'adaptive-booster'",
        lessonId, variant, genderTheme, templateType, exceptId,
      )
    : run(
        "UPDATE games SET status = 'pending_review' WHERE lesson_id = ? AND variant = ? AND gender_theme = ? AND id != ? AND status = 'approved' AND COALESCE(notes, '') != 'adaptive-booster'",
        lessonId, variant, genderTheme, exceptId,
      );

const setStatus = (id, status) => run('UPDATE games SET status = ? WHERE id = ?', status, id);

const approve = (id, approvedBy) => {
  const approvedAt = new Date().toISOString();
  run("UPDATE games SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?", approvedAt, approvedBy, id);
};

// Apply an AI fix and set the game back to review.
const applyFix = (id, { gameJson, staticVersionJson, notes }) => {
  run(
    "UPDATE games SET game_json = ?, static_version_json = ?, status = 'pending_review', notes = ?, updated_at = ? WHERE id = ?",
    gameJson, staticVersionJson, notes, new Date().toISOString(), id,
  );
};

const countApproved = () => get("SELECT COUNT(*) AS n FROM games WHERE status = 'approved'").n;

// Most recent approved adaptive booster for a combo (or null).
const findBooster = (lessonId, variant, genderTheme) =>
  get(
    `SELECT * FROM games WHERE lesson_id = ? AND variant = ? AND gender_theme = ? AND status = 'approved' AND notes = 'adaptive-booster' ORDER BY id DESC LIMIT 1`,
    lessonId, variant, genderTheme,
  );

module.exports = {
  listByLesson, listApprovedByLesson, findById, findReviewById, findFixById,
  create, deleteNonApprovedForCombo, demoteApprovedExcept, setStatus, approve, applyFix, countApproved, findBooster,
};