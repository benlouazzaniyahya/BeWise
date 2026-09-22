'use strict';

const { get } = require('../db');

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

module.exports = { overview };