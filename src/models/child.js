'use strict';

const { all, get, run } = require('../db');

const findById = (id) => get('SELECT * FROM children WHERE id = ?', id);
const findByIdOwned = (id, parentId) => get('SELECT * FROM children WHERE id = ? AND parent_id = ?', id, parentId);
const listByParent = (parentId) => all('SELECT * FROM children WHERE parent_id = ? ORDER BY id ASC', parentId);
const findByLoginId = (loginId) =>
  get('SELECT * FROM children WHERE lower(child_login_id) = lower(?)', loginId);
const loginIdExists = (loginId) =>
  Boolean(get('SELECT 1 AS x FROM children WHERE child_login_id = ?', loginId));
const listAllWithParentEmail = () =>
  all(
    'SELECT c.*, u.email AS parent_email FROM children c JOIN users u ON u.id = c.parent_id ORDER BY c.id DESC',
  );

function create({ parentId, loginId, passwordHash, displayName, age, gender, profileType, language, schoolLevel, created_at }) {
  const info = run(
    'INSERT INTO children (parent_id, child_login_id, password_hash, display_name, age, gender, profile_type, language, school_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    parentId, loginId, passwordHash, displayName, age, gender, profileType, language, schoolLevel, created_at,
  );
  return info.lastInsertRowid;
}

const update = (id, { displayName, age, gender, profileType, language, schoolLevel }) =>
  run(
    'UPDATE children SET display_name = ?, age = ?, gender = ?, profile_type = ?, language = ?, school_level = ? WHERE id = ?',
    displayName, age, gender, profileType, language, schoolLevel, id,
  );

const updatePassword = (id, passwordHash) =>
  run('UPDATE children SET password_hash = ? WHERE id = ?', passwordHash, id);

const deleteById = (id) => run('DELETE FROM children WHERE id = ?', id);
const deleteByParent = (parentId) => run('DELETE FROM children WHERE parent_id = ?', parentId);

module.exports = {
  findById, findByIdOwned, listByParent, findByLoginId, loginIdExists,
  listAllWithParentEmail, create, update, updatePassword, deleteById, deleteByParent,
};