'use strict';

/**
 * emailDrafter.js
 *
 * Responsibilities:
 *   1. Draft hyper-personalized hot/warm emails via GPT-4o
 *   2. Send via the rotation manager (NOT a single Gmail account)
 *
 * The sendEmail() function now delegates entirely to emailRotationManager
 * .sendWithRotation(), which handles:
 *   - Sender pool selection (warmup-aware, round-robin)
 *   - Per-account daily send limits
 *   - Bounce/complaint rate monitoring
 *   - CAN-SPAM List-Unsubscribe headers
 *   - Automatic suspension of unhealthy senders
 */

const OpenAI = require('openai');
const { config } = require('../../config');
const { logger } = require('../utils/logger');
const { sendWithRotation } = require('./emailRotationManager');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// ─── OpenAI Email Drafting ──────────────────────────────────────────────────

const HOT_EMAIL_SYSTEM_PROMPT = `You are an expert B2B sales copywriter who writes emails that convert.
Your emails are:
- Hyper-personalized to the prospect's specific situation
- Concise (under 180 words in the body)
- Conversational and human — NOT templated or salesy
- Reference specific pain points from their inquiry
- Have a single, clear CTA to book a call

Return ONLY valid JSON. No markdown fences. No explanation.
Required keys:
{
  "subject": "string (compelling, < 60 chars, no clickbait)",
  "body": "string (plain text, use \\n for line breaks)",
  "previewText": "string (first 90 chars shown in inbox preview)"
}`;

const WARM_EMAIL_SYSTEM_PROMPT = `You are a helpful B2B consultant writing a value-add nurture email.
Your emails are:
- Educational and helpful, not sales-focused
- Acknowledge their specific challenge without pressure
- Share one genuinely useful insight or resource
- End with a soft, low-friction CTA (reply with questions)

Return ONLY valid JSON. No markdown fences. No explanation.
Required keys:
{
  "subject": "string",
  "body": "string (plain text, use \\n for line breaks)",
  "previewText": "string (max 90 chars)"
}`;

/**
 * Draft a personalized outreach email for a hot lead.
 *
 * @param {Object} lead - Normalised lead data
 * @param {Object} qualification - Result from leadQualifier
 * @returns {Promise<{subject: string, body: string, previewText: string}>}
 */
async function draftHotEmail(lead, qualification) {
  logger.info(`[EmailDrafter] Drafting hot email for ${lead.email}`);

  const prompt = `Write a personalized sales outreach email for this hot lead:

Prospect: ${lead.firstName} ${lead.lastName}
Title: ${lead.jobTitle || 'Decision Maker'} at ${lead.company}
Industry: ${lead.industry || 'Not specified'}
Their inquiry: "${lead.message}"
Detected pain points: ${qualification.detectedPainPoints.join(', ') || 'Not specified'}
Company signals: ${qualification.companySignals.join(', ') || 'None'}
Decision-maker likelihood: ${qualification.decisionMakerLikelihood}

Sender: ${config.company.name} — ${config.company.valueProp}
CTA link: ${config.google.bookingPageUrl}
Sign off with a first name only — do not hardcode a specific name, use "the team at ${config.company.name}" if unsure.

Write the email now. Return JSON only.`;

  return await _callOpenAIForEmail(HOT_EMAIL_SYSTEM_PROMPT, prompt, 'hot');
}

/**
 * Draft a nurture email for a warm lead.
 *
 * @param {Object} lead - Normalised lead data
 * @param {Object} qualification - Result from leadQualifier
 * @returns {Promise<{subject: string, body: string, previewText: string}>}
 */
async function draftWarmEmail(lead, qualification) {
  logger.info(`[EmailDrafter] Drafting warm nurture email for ${lead.email}`);

  const prompt = `Write a helpful nurture email for this warm lead:

Prospect: ${lead.firstName}, ${lead.jobTitle || 'Professional'} at ${lead.company}
Detected pain points: ${qualification.detectedPainPoints.join(', ') || 'general business challenges'}
Qualification reasoning: ${qualification.reasoning}

Sender: ${config.company.name}
Our value: ${config.company.valueProp}
Sign off with first name only — do not hardcode a specific name, use "the team at ${config.company.name}" if unsure.

Return JSON only.`;

  return await _callOpenAIForEmail(WARM_EMAIL_SYSTEM_PROMPT, prompt, 'warm');
}

/**
 * Internal helper — calls OpenAI and parses the JSON email draft.
 */
async function _callOpenAIForEmail(systemPrompt, userPrompt, tier) {
  const response = await openai.chat.completions.create({
    model: config.openai.model,
    temperature: tier === 'hot' ? 0.75 : 0.65,
    max_tokens: config.openai.maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

  let draft;
  try {
    draft = JSON.parse(cleaned);
  } catch (err) {
    logger.error('[EmailDrafter] Failed to parse email JSON', { raw });
    throw new Error(`LLM returned non-JSON email draft: ${raw}`);
  }

  return {
    subject: draft.subject || 'Following up on your inquiry',
    body: draft.body || '',
    previewText: draft.previewText || '',
  };
}

// ─── Email Sending via Rotation Manager ─────────────────────────────────────

/**
 * Send a drafted email using the rotation manager.
 *
 * The rotation manager selects the best available sender from the pool,
 * respects warmup limits, adds CAN-SPAM headers, and records the send.
 * If all senders are at their daily limit, this throws with a clear message.
 *
 * @param {string} toEmail - Recipient email address
 * @param {string} toName  - Recipient display name
 * @param {Object} draft   - { subject, body, previewText }
 * @returns {Promise<{ messageId: string, sentFrom: string, senderId: string }>}
 */
async function sendEmail(toEmail, toName, draft) {
  logger.info(`[EmailDrafter] Sending "${draft.subject}" to ${toEmail}`);
  const result = await sendWithRotation(toEmail, toName, draft);
  logger.info(
    `[EmailDrafter] Sent via ${result.sentFrom} — messageId: ${result.messageId}`
  );
  return result;
}

module.exports = { draftHotEmail, draftWarmEmail, sendEmail };
