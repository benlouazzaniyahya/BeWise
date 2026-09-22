'use strict';

const bcrypt = require('bcryptjs');
const { User, Child, Stats } = require('../models');
const { transaction } = require('../db');
const { tFor } = require('../i18n');

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function dashboard(req, res) {
  const t = tFor(res.locals.lang);
  const users = User.listAll();
  const children = Child.listAllWithParentEmail();
  const stats = Stats.overview();
  res.render('admin/index', { page: 'admin', titleKey: 'admin.title', users, children, stats: stats || {}, t });
}

function createUser(req, res) {
  const t = tFor(res.locals.lang);
  const role = req.body.role === 'teacher' ? 'teacher' : 'parent';
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!VALID_EMAIL.test(email) || password.length < 6) {
    req.flash('error', t('common.error'));
    return res.redirect('/admin');
  }
  if (User.findByEmail(email)) {
    req.flash('error', t('auth.signupFailedEmail'));
    return res.redirect('/admin');
  }
  User.create({ role, email, passwordHash: bcrypt.hashSync(password, 10), language: res.locals.lang, created_at: new Date().toISOString() });
  req.flash('success', t('admin.createdUser'));
  res.redirect('/admin');
}

function deleteUser(req, res) {
  const t = tFor(res.locals.lang);
  const target = User.findById(Number(req.params.id));
  if (!target || target.role === 'admin') return res.redirect('/admin');
  transaction(() => {
    if (target.role === 'parent') Child.deleteByParent(target.id);
    User.deleteById(target.id);
  });
  req.flash('success', t('admin.deletedUser'));
  res.redirect('/admin');
}

function deleteChild(req, res) {
  const t = tFor(res.locals.lang);
  Child.deleteById(Number(req.params.id));
  req.flash('success', t('admin.deletedChild'));
  res.redirect('/admin');
}

module.exports = { dashboard, createUser, deleteUser, deleteChild };