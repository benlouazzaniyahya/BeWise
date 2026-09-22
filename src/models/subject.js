'use strict';

const { all, get } = require('../db');

const list = () => all('SELECT * FROM subjects ORDER BY id ASC');
const findById = (id) => get('SELECT * FROM subjects WHERE id = ?', id);
const listWithLessonCounts = () =>
  all(
    `SELECT s.*, (SELECT COUNT(*) FROM lessons l WHERE l.subject_id = s.id) AS lesson_count
     FROM subjects s ORDER BY s.id ASC`,
  );

// The language a subject's content should be generated in.
const defaultLanguage = (name) => ({ arabic: 'ar', french: 'fr', english: 'en', math: 'en' })[name] || 'en';

module.exports = { list, findById, listWithLessonCounts, defaultLanguage };