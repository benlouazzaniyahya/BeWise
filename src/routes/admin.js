'use strict';

const express = require('express');
const c = require('../controllers/adminController');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/', c.dashboard);
router.post('/users', c.createUser);
router.post('/users/:id/delete', c.deleteUser);
router.post('/children/:id/delete', c.deleteChild);

module.exports = router;