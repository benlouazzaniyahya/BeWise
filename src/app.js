'use strict';

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

require('./db'); // ensure schema exists

const {
  COOKIE_SECRET,
  setLocals,
  setChildLocals,
  ensureLang,
  flashMiddleware,
  clearFlash,
} = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teacher');
const apiRoutes = require('./routes/api');
const parentRoutes = require('./routes/parent');
const childRoutes = require('./routes/child');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use('/assets', express.static(path.join(__dirname, '..', 'public')));

app.use(cookieParser(COOKIE_SECRET));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(flashMiddleware);
app.use(setLocals);
app.use(setChildLocals);
app.use(ensureLang);

app.use(authRoutes);
app.use('/admin', adminRoutes);
app.use('/teacher', teacherRoutes);
app.use('/api', apiRoutes);
app.use('/parent', parentRoutes);
app.use('/child', childRoutes);

// generic 404
app.use((req, res) => {
  res.status(404).render('error', { titleKey: 'common.notFound', messageKey: 'common.notFound', code: 404 });
});

// error handler
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.locals.flash = { type: 'error', message: String(err.message || 'Error') };
  res.status(500).render('error', { titleKey: 'common.error', messageKey: 'common.error', code: 500 });
});

app.use(clearFlash);

module.exports = app;