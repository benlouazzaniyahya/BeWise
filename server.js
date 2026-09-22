'use strict';

require('dotenv').config();

const PORT = process.env.PORT || 3000;
const app = require('./src/app');

app.listen(PORT, () => {
  console.log(`Bewize running →  http://localhost:${PORT}`);
  console.log(`AI mode:      ${process.env.ANTHROPIC_API_KEY ? 'Anthropic API' : 'OFFLINE demo generator (set ANTHROPIC_API_KEY for live AI)'}`);
  console.log(`Google OAuth: ${process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? 'configured' : 'not configured'}`);
  console.log(`Seed data:    run "npm run seed" if the DB is empty.`);
});