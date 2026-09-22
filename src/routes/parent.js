'use strict';

const express = require('express');
const c = require('../controllers/parentController');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('parent'));

router.get('/', c.index);
router.get('/children/new', c.childNew);
router.post('/children', c.childCreate);
router.get('/children/:id', c.childShow);
router.get('/children/:id/edit', c.childEdit);
router.post('/children/:id', c.childUpdate);
router.post('/children/:id/reset-password', c.childResetPassword);
router.post('/children/:id/delete', c.childDelete);

module.exports = router;