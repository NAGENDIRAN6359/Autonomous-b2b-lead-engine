'use strict';

const express = require('express');
const router = express.Router();
const { config } = require('../../config');
const { logger } = require('../utils/logger');
const { validateLeadPayload, verifyWebhookSignature } = require('../utils/validate');
const { qualifyLead } = require('../modules/leadQualifier');
const { draftHotEmail, draftWarmEmail, sendEmail } = require('../modules/emailDrafter');
const { scheduleOutboundCall } = require('../modules/vapiCaller');
const { syncLead, STAGES } = require('../modules/crmSync');

// Note: express.json() with rawBody capture is registered at the app level in index.js.
// This router relies on req.rawBody already being populated when it receives requests.

// ─── POST /webhooks/lead — Main lead intake endpoint ────────────────────────

/**
 * Accepts lead submissions from:
 *   - Webflow form webhooks
 *   - WordPress (WPForms / Gravity Forms) webhooks
 *   - Direct API POST (from n8n, Make.com, or any HTTP node)
 *
 * Query params:
 *   ?source=webflow | wordpress | direct
 *
 * Headers:
 *   x-webhook-signature: sha256=<hmac> (optional but recommended)
 *   x-webflow-signature: <hmac>        (Webflow specific)
 */
router.post('/lead', async (req, res) => {
  const startTime = Date.now();
  const source = req.query.source || req.body?._source || 'direct';

  // ── 1. Signature verification (skip if no secret configured) ──────────────
  if (config.server.webhookSecret) {
    const sig =
      req.headers['x-webhook-signature'] ||
      req.headers['x-webflow-signature'] ||
      req.headers['x-wp-signature'] ||
      '';

    const isValid = verifyWebhookSignature(
      req.rawBody || Buffer.from(JSON.stringify(req.body)),
      sig,
      config.server.webhookSecret
    );

    if (!isValid && sig) {
      logger.warn('[Webhook] Invalid signature — rejecting request', {
        ip: req.ip,
        source,
      });
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  }

  // ── 2. Acknowledge immediately (async processing below) ───────────────────
  res.status(202).json({ status: 'accepted', message: 'Lead received and processing' });

  // ── 3. Validate & normalize payload ───────────────────────────────────────
  const rawBody = _extractLeadBody(req.body, source);
  const { valid, lead, errors } = validateLeadPayload({ ...rawBody, _source: source });

  if (!valid) {
    logger.warn('[Webhook] Invalid lead payload', { errors, source });
    return; // Response already sent
  }

  logger.info(`[Webhook] New lead received: ${lead.email} from ${source}`);

  // ── 4. Run full pipeline asynchronously ───────────────────────────────────
  try {
    await _runLeadPipeline(lead);
  } catch (err) {
    logger.error('[Webhook] Pipeline error', {
      email: lead.email,
      error: err.message,
      stack: err.stack,
    });
  }

  const elapsed = Date.now() - startTime;
  logger.info(`[Webhook] Pipeline completed in ${elapsed}ms for ${lead.email}`);
});

// ─── POST /webhooks/vapi-callback — Vapi call outcome ───────────────────────

/**
 * Receives Vapi webhook events (call completed, booking confirmed, etc.)
 * Configure this URL in your Vapi dashboard under Assistant > Webhooks.
 */
router.post('/vapi-callback', async (req, res) => {
  const event = req.body;
  logger.info('[Webhook/Vapi] Call event received', {
    type: event.type,
    callId: event.call?.id,
  });

  res.status(200).json({ received: true });

  try {
    if (event.type === 'end-of-call-report') {
      const transcript = event.transcript || '';
      const callId = event.call?.id;
      const customerPhone = event.call?.customer?.number;

      logger.info(`[Webhook/Vapi] Call ended — callId: ${callId}`, {
        duration: event.call?.endedAt,
      });

      // Check if booking was confirmed in the transcript
      const bookingConfirmed =
        /book|confirm|schedule|yes|sounds good/i.test(transcript);

      if (bookingConfirmed) {
        logger.info(`[Webhook/Vapi] Booking intent detected in call transcript`);
        // Additional booking creation logic can be triggered here
        // e.g., call createBooking() with extracted time slot
      }
    }
  } catch (err) {
    logger.error('[Webhook/Vapi] Callback processing error', { error: err.message });
  }
});

// ─── POST /webhooks/calendar-callback — Booking confirmed ───────────────────

/**
 * Called by Calendly or a custom booking page when a meeting is confirmed.
 * Updates the CRM stage to MEETING_BOOKED.
 */
router.post('/calendar-callback', async (req, res) => {
  const event = req.body;
  logger.info('[Webhook/Calendar] Booking confirmed', { event: event.event_type });

  res.status(200).json({ received: true });

  try {
    const email =
      event.payload?.email ||
      event.invitee?.email ||
      event.email;

    if (email) {
      logger.info(`[Webhook/Calendar] Meeting booked for ${email}`);
      // CRM stage update — lead object reconstructed from email
      // In production: look up lead from DB by email
    }
  } catch (err) {
    logger.error('[Webhook/Calendar] Callback error', { error: err.message });
  }
});

// ─── GET /webhooks/health — Health check ────────────────────────────────────

router.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'B2B Lead Nurturing Engine',
    timestamp: new Date().toISOString(),
  });
});

// ─── Pipeline Orchestrator ───────────────────────────────────────────────────

/**
 * Full lead processing pipeline:
 *   qualify → CRM sync → email → (if hot) Vapi call
 *
 * @param {Object} lead - Validated, normalised lead
 */
async function _runLeadPipeline(lead) {
  // Step 1: Qualify the lead
  const qualification = await qualifyLead(lead);
  logger.info(
    `[Pipeline] ${lead.email} — tier: ${qualification.tier}, score: ${qualification.score}`
  );

  // Step 2: Sync to CRM as new lead
  let crmRecord;
  try {
    crmRecord = await syncLead(lead, qualification, STAGES.NEW_LEAD);
    logger.info(`[Pipeline] CRM synced for ${lead.email}`);
  } catch (crmErr) {
    logger.warn('[Pipeline] CRM sync failed (non-fatal)', { error: crmErr.message });
  }

  // Step 3: Branch by tier
  if (qualification.tier === 'cold') {
    logger.info(`[Pipeline] Cold lead ${lead.email} — added to nurture sequence`);
    if (crmRecord) {
      try {
        await syncLead(lead, qualification, STAGES.DISQUALIFIED);
      } catch (_) {}
    }
    return;
  }

  // Step 4: Draft and send email
  let emailDraft;
  try {
    if (qualification.tier === 'hot') {
      emailDraft = await draftHotEmail(lead, qualification);
    } else {
      emailDraft = await draftWarmEmail(lead, qualification);
    }

    await sendEmail(
      lead.email,
      `${lead.firstName} ${lead.lastName}`.trim(),
      emailDraft
    );

    logger.info(`[Pipeline] Email sent to ${lead.email} — "${emailDraft.subject}"`);

    // Update CRM stage
    try {
      await syncLead(lead, qualification, STAGES.OUTREACH_SENT);
    } catch (_) {}
  } catch (emailErr) {
    logger.error('[Pipeline] Email send failed', { error: emailErr.message });
  }

  // Step 5: Schedule Vapi call for hot leads only
  if (qualification.tier === 'hot') {
    try {
      const callResult = await scheduleOutboundCall(lead, qualification);
      if (!callResult.skipped) {
        logger.info(`[Pipeline] Vapi call scheduled — id: ${callResult.vapiCallId}`);
        try {
          await syncLead(lead, qualification, STAGES.CALL_SCHEDULED);
        } catch (_) {}
      }
    } catch (vapiErr) {
      logger.error('[Pipeline] Vapi call scheduling failed', { error: vapiErr.message });
    }
  }
}

// ─── Source-specific payload extraction ─────────────────────────────────────

/**
 * Extract the actual lead fields from source-specific payload wrappers.
 *
 * Webflow wraps form data in `data` or `formData`.
 * WordPress/WPForms may wrap in `fields` or send flat.
 */
function _extractLeadBody(body, source) {
  if (!body) return {};

  // Webflow: { "site": {...}, "data": { "email": "...", ... } }
  if (source === 'webflow' && body.data) return body.data;
  if (body.formData) return body.formData;

  // WPForms: { "fields": { "1": { "value": "..." }, ... } }
  if (source === 'wordpress' && body.fields && typeof body.fields === 'object') {
    const flat = {};
    const fieldMap = {
      email: ['email', 'e-mail'],
      name: ['name', 'full name', 'full_name'],
      phone: ['phone', 'phone number', 'mobile'],
      company: ['company', 'company name', 'organization'],
      message: ['message', 'inquiry', 'how can we help'],
    };

    for (const field of Object.values(body.fields)) {
      const label = (field.label || '').toLowerCase();
      for (const [key, aliases] of Object.entries(fieldMap)) {
        if (aliases.some((a) => label.includes(a))) {
          flat[key] = field.value || '';
        }
      }
    }
    return flat;
  }

  // Direct / n8n / Make.com — body is already flat
  return body;
}

module.exports = router;
