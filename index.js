'use strict';

// Load env vars before anything else
require('dotenv').config();

const express = require('express');
const { config, validateConfig } = require('./config');
const { logger } = require('./src/utils/logger');
const leadWebhook = require('./src/webhooks/leadWebhook');

// ─── Startup Validation ──────────────────────────────────────────────────────

try {
  validateConfig();
} catch (err) {
  console.error('\n[STARTUP ERROR]', err.message, '\n');
  process.exit(1);
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

// Trust proxy headers (important when behind nginx / n8n reverse proxy)
app.set('trust proxy', 1);

// Parse JSON bodies globally, capturing raw bytes for HMAC signature verification.
// The raw buffer is stored on req.rawBody for use in the webhook signature check.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check at root
app.get('/', (_req, res) => {
  res.json({
    service: 'B2B Lead Nurturing & Booking Engine',
    version: process.env.npm_package_version || '1.0.0',
    status: 'running',
    crm: config.crm.provider,
    timestamp: new Date().toISOString(),
  });
});

// All webhook routes
app.use('/webhooks', leadWebhook);

// Google OAuth callback (used once to obtain refresh token)
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  const { google } = require('googleapis');
  const oauth2Client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.send(`
      <h2>Google OAuth Success</h2>
      <p>Add this refresh token to your <code>.env</code> file as <code>GOOGLE_REFRESH_TOKEN</code>:</p>
      <pre style="background:#f4f4f4;padding:12px;border-radius:6px">${tokens.refresh_token || '(no refresh token — ensure access_type=offline was set)'}</pre>
      <p>Then restart the server.</p>
    `);
  } catch (err) {
    logger.error('[OAuth] Token exchange failed', { error: err.message });
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// OAuth initiation helper (visit in browser to get tokens)
app.get('/auth/google', (_req, res) => {
  const { google } = require('googleapis');
  const oauth2Client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',
    ],
  });
  res.redirect(authUrl);
});

// ─── 404 & Error handlers ────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  logger.error('[Server] Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = config.server.port;

app.listen(PORT, () => {
  logger.info(`[Server] B2B Lead Engine running on http://localhost:${PORT}`);
  logger.info(`[Server] CRM provider: ${config.crm.provider}`);
  logger.info(`[Server] Webhook endpoint: POST http://localhost:${PORT}/webhooks/lead`);
  logger.info(`[Server] Health check:     GET  http://localhost:${PORT}/webhooks/health`);
  if (!config.google.refreshToken) {
    logger.warn(`[Server] No GOOGLE_REFRESH_TOKEN set — visit http://localhost:${PORT}/auth/google to authorize`);
  }
});

module.exports = app;
