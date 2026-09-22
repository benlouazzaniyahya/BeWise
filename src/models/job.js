'use strict';

const { all, get, run } = require('../db');

const create = (lessonId, jobType, payloadJson) => {
  const info = run(
    'INSERT INTO gen_jobs (lesson_id, job_type, payload, status, created_at) VALUES (?, ?, ?, ?, ?)',
    lessonId, jobType, payloadJson, 'pending', new Date().toISOString(),
  );
  return info.lastInsertRowid;
};

const findById = (id) => get('SELECT * FROM gen_jobs WHERE id = ?', id);
const listByLesson = (lessonId, limit = 8) =>
  all('SELECT * FROM gen_jobs WHERE lesson_id = ? ORDER BY id DESC LIMIT ?', lessonId, limit);
const countActiveByLesson = (lessonId) =>
  get("SELECT COUNT(*) AS n FROM gen_jobs WHERE lesson_id = ? AND status IN ('pending','running')", lessonId).n;

const setRunning = (id) => run('UPDATE gen_jobs SET status = ? WHERE id = ?', 'running', id);
const setDone = (id, result) => run('UPDATE gen_jobs SET status = ?, result = ?, error = NULL WHERE id = ?', 'done', result, id);
const setFailed = (id, error) => run('UPDATE gen_jobs SET status = ?, error = ? WHERE id = ?', 'failed', error, id);

// Requeue jobs that died mid-run (e.g. server restart).
const sweepStale = () =>
  run("UPDATE gen_jobs SET status = 'pending' WHERE status = 'running' AND created_at < datetime('now', '-2 minutes')");

module.exports = { create, findById, listByLesson, countActiveByLesson, setRunning, setDone, setFailed, sweepStale };