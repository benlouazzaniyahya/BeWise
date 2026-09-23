'use strict';

const express = require('express');
const c = require('../controllers/teacherController');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('teacher'));

router.get('/subjects', c.subjectsPage);

router.get('/', c.lessonsList);
router.get('/lessons/new', c.lessonNew);
router.post('/lessons', c.lessonCreate);
router.get('/lessons/:id', c.lessonShow);
router.get('/lessons/:id/edit', c.lessonEdit);
router.post('/lessons/:id', c.lessonUpdate);
router.post('/lessons/:id/generate', c.lessonGenerate);
router.post('/lessons/:id/generate-triple', c.lessonGenerateTriple);

router.get('/lessons/:id/triple-preview', c.triplePreview);
router.post('/lessons/:id/triple-approve', c.tripleApprove);
router.post('/lessons/:id/triple-regenerate', c.tripleRegenerate);

router.get('/games/:id/preview', c.gamePreview);
router.post('/games/:id/approve', c.gameApprove);
router.post('/games/:id/reject', c.gameReject);
router.post('/games/:id/fix', c.gameFix);
router.post('/games/:id/regenerate', c.gameRegenerate);

module.exports = router;