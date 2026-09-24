'use strict';

const express = require('express');
const c = require('../controllers/childController');
const { requireChild } = require('../middleware/auth');

const router = express.Router();
router.use(requireChild);

router.get('/', c.index);
router.get('/lessons/:id', c.lessonShow);
router.post('/lessons/:id/complete', c.complete);
router.get('/lessons/:id/static', c.staticPage);
router.post('/lessons/:id/booster', c.booster);
router.get('/lessons/:id/exam', c.examPage);
router.post('/lessons/:id/exam', c.examSubmit);

module.exports = router;