'use strict';

// Google OAuth for parents (Sign in with Google).
// Exchanges the authorization code for a profile, no personal data stored
// beyond the google id + email.

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const configured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

const redirectUri = () => `${BASE_URL}/auth/google/callback`;

function authorizationUrl() {
  const cid = process.env.GOOGLE_CLIENT_ID;
  return (
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=' + encodeURIComponent(cid)
    + '&redirect_uri=' + encodeURIComponent(redirectUri())
    + '&response_type=code&scope=' + encodeURIComponent('openid email profile')
    + '&prompt=select_account'
  );
}

async function fetchGoogleUser(code) {
  const tokenResp = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }).toString(),
    { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
  );
  const userInfo = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenResp.data.access_token}` },
  });
  return {
    googleId: userInfo.data.id,
    email: String(userInfo.data.email || '').toLowerCase(),
  };
}

module.exports = { configured, redirectUri, authorizationUrl, fetchGoogleUser };