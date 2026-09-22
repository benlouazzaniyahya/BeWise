'use strict';

const { all, get, run } = require('../db');

const findByEmail = (email) => get('SELECT * FROM users WHERE email = ?', email);
const findByGoogleId = (googleId) => get('SELECT * FROM users WHERE google_id = ?', googleId);
const findById = (id) => get('SELECT * FROM users WHERE id = ?', id);

function create({ role, email, passwordHash = null, googleId = null, language, created_at }) {
  const info = run(
    'INSERT INTO users (role, email, password_hash, google_id, language, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    role, email || null, passwordHash, googleId, language, created_at,
  );
  return info.lastInsertRowid;
}

const updateLanguage = (id, lang) => run('UPDATE users SET language = ? WHERE id = ?', lang, id);
const setGoogleId = (id, googleId) => run('UPDATE users SET google_id = ? WHERE id = ?', googleId, id);
const listAll = () => all('SELECT * FROM users ORDER BY role, id DESC');
const countByRole = (role) => get('SELECT COUNT(*) AS n FROM users WHERE role = ?', role).n;
const deleteById = (id) => run('DELETE FROM users WHERE id = ?', id);

module.exports = { findByEmail, findByGoogleId, findById, create, updateLanguage, setGoogleId, listAll, countByRole, deleteById };