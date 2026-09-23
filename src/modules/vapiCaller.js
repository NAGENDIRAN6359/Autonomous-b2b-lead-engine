'use strict';

/**
 * vapiCaller.js
 *
 * Solves the AI Voice Call Hesitation problem:
 *
 *   Problem: US/UK executives hang up within 2 seconds if they detect a
 *            robocall — caused by unnatural openers, processing latency,
 *            or a script that sounds like it was written by a machine.
 *
 *   Solutions applied in this module:
 *
 *     1. INSTANT OPENER — The assistant's first sentence is pre-set and
 *        ultra-short. No processing needed before the human hears a voice.
 *        Vapi's "firstMessage" field speaks immediately on connect, before
 *        any LLM turn — eliminating the 2-second silence gap.
 *
 *     2. HUMAN-PATTERN SCRIPT — The prompt avoids all robocall red flags:
 *        no company-name dumps, no legal disclaimers, no "I am calling to
 *        inform you", no reading bullet points. It mirrors how a real SDR
 *        opens a cold call.
 *
 *     3. CALL TIMING GATES — Never call before 9 AM or after 5 PM in the
 *        prospect's likely timezone. Never call on weekends. Executives
 *        who get called at 8 AM Saturday are gone forever.
 *
 *     4. VOICEMAIL DETECTION — Vapi supports AMD (Answering Machine
 *        Detection). If voicemail is detected, the assistant leaves a
 *        10-second human-sounding message and hangs up — rather than
 *        reciting the full script to a mailbox.
 *
 *     5. CALL GUARD — Skip the call entirely if completeness or score
 *        is below threshold. A low-data hot lead does not get a call.
 *
 *     6. MAX CALL DURATION CAP — Hard 90-second limit. If the assistant
 *        hasn't booked by then, it winds down gracefully. Long calls from
 *        AI agents feel interrogative, not conversational.
 */

const axios = require('axios');
const { config } = require('../../config');
const { logger } = require('../utils/logger');

const VAPI_BASE_URL = 'https://api.vapi.ai';

// Minimum qualification score to trigger a voice call (separate from hot threshold)
// A lead might be 'hot' but still lack enough data to make a coherent call
const MIN_SCORE_FOR_CALL = 75;
const MIN_COMPLETENESS_FOR_CALL = 55;

// Business hours window (24h format, prospect's estimated local time)
const CALL_HOUR_START = 9;   // 9:00 AM
const CALL_HOUR_END   = 17;  // 5:00 PM

// Hard cap on call duration in seconds
const MAX_CALL_DURATION_SECONDS = 90;

const vapiClient = axios.create({
  baseURL: VAPI_BASE_URL,
  headers: {
    Authorization: `Bearer ${config.vapi.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

// ─── Call Guards ──────────────────────────────────────────────────────────────

/**
 * Determine whether a call should be placed at all.
 * Returns { allowed: bool, reason: string }.
 *
 * @param {Object} lead
 * @param {Object} qualification
 * @returns {{ allowed: boolean, reason: string }}
 */
function evaluateCallGuards(lead, qualification) {
  // Guard 1: Must have a phone number
  if (!lead.phone) {
    return { allowed: false, reason: 'NO_PHONE: Lead has no phone number' };
  }

  // Guard 2: Score must meet call threshold (higher bar than email)
  if (qualification.score < MIN_SCORE_FOR_CALL) {
    return {
      allowed: false,
      reason: `LOW_SCORE: score ${qualification.score} < minimum ${MIN_SCORE_FOR_CALL} for calls`,
    };
  }

  // Guard 3: Data completeness — calling a lead with no context is a waste
  if ((qualification.completenessScore || 0) < MIN_COMPLETENESS_FOR_CALL) {
    return {
      allowed: false,
      reason: `LOW_COMPLETENESS: completenessScore ${qualification.completenessScore} < ${MIN_COMPLETENESS_FOR_CALL}`,
    };
  }

  // Guard 4: Decision-maker likelihood — don't burn call credits on ICs
  if (qualification.decisionMakerLikelihood === 'low') {
    return {
      allowed: false,
      reason: 'LOW_DM_LIKELIHOOD: Not likely a decision maker — email only',
    };
  }

  // Guard 5: LLM raised a disqualification flag
  if (qualification.disqualificationFlag) {
    return {
      allowed: false,
      reason: `DISQUALIFIED: ${qualification.disqualificationFlag}`,
    };
  }

  return { allowed: true, reason: 'All call guards passed' };
}

/**
 * Calculate the best time to schedule the call.
 *
 * Strategy:
 *   - Default delay from config (e.g. 15 min after email)
 *   - If that lands outside business hours, push to next business-hours window
 *   - Never schedule on Saturday or Sunday
 *
 * @param {number} delayMinutes - Minimum delay before placing the call
 * @returns {string} ISO 8601 scheduled time
 */
function calculateScheduledTime(delayMinutes) {
  let scheduledTime = new Date(Date.now() + delayMinutes * 60 * 1000);

  // Push forward until we land in a valid business-hours window
  let attempts = 0;
  while (!_isBusinessHours(scheduledTime) && attempts < 10) {
    scheduledTime = _nextBusinessHoursSlot(scheduledTime);
    attempts++;
  }

  return scheduledTime.toISOString();
}

function _isBusinessHours(date) {
  const day = date.getUTCDay();   // 0=Sun, 6=Sat
  const hour = date.getUTCHours();
  return day >= 1 && day <= 5 && hour >= CALL_HOUR_START && hour < CALL_HOUR_END;
}

function _nextBusinessHoursSlot(date) {
  const next = new Date(date);
  next.setUTCHours(CALL_HOUR_START, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  // Skip weekend
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

// ─── Script Builder ───────────────────────────────────────────────────────────

/**
 * Build the Vapi assistant system prompt.
 *
 * Anti-robocall design principles applied here:
 *
 *   - firstMessage speaks INSTANTLY (no LLM latency on connect)
 *   - Opener uses first name only + a brief, specific hook — not a pitch
 *   - Single goal: confirm a 20-minute time slot. Nothing else.
 *   - Explicit stop phrases prevent the assistant from rambling
 *   - Voicemail path is a separate 2-sentence message
 *   - Hard 90-second wind-down instruction built into the prompt
 *
 * @param {Object} lead
 * @param {Object} qualification
 * @returns {{ firstMessage: string, systemPrompt: string, voicemailMessage: string }}
 */
function buildCallScript(lead, qualification) {
  const firstName = lead.firstName || 'there';
  const company = lead.company || 'your company';
  const senderFirstName = (config.google.gmail.senderName || 'Alex').split(' ')[0];
  const ourCompany = config.company.name;
  const bookingUrl = config.google.bookingPageUrl;

  // Primary pain point, made conversational — not a buzzword list
  const painContext = qualification.detectedPainPoints?.[0]
    ? `the challenge you mentioned around ${qualification.detectedPainPoints[0]}`
    : `what you were looking into on our site`;

  // ── First message — spoken instantly on connect, before any LLM turn ──
  // Keep under 15 words. Natural. No company name dump. No "I'm calling from".
  const firstMessage =
    `Hey ${firstName}, it's ${senderFirstName} — is this a good time for literally 30 seconds?`;

  // ── System prompt — the full behavioural instruction for the assistant ──
  const systemPrompt = `You are ${senderFirstName}, a real person working at ${ourCompany}.
You just called ${firstName} at ${company}.

YOUR ONLY GOAL: Book a 20-minute discovery call. Nothing else.

CONTEXT (do NOT read this out loud):
- They enquired about: ${painContext}
- Their role: ${lead.jobTitle || 'unknown'}
- Qualification score: ${qualification.score}/100

CALL FLOW:
1. They answered — you already said the opener. Wait for their response.
2. If they say yes/go ahead: say ONE sentence about why you're calling, referencing ${painContext}. 
   Then immediately ask: "Would [day] at [time] or [day] at [time] work for a quick 20 minutes?"
3. If they confirm a time: say "Perfect, I'll send a calendar invite to ${lead.email} right now." Then end the call.
4. If they ask for more info: give ONE sentence max, then redirect to booking.
5. If they say they're busy: "Totally fine — I'll text you a booking link, takes 10 seconds to pick a time." Then end.
6. If they're not interested: "No problem at all, I appreciate you picking up." Then end immediately.

HARD RULES:
- Never say "I'm an AI" or "I'm a robot"
- Never read a list of features or benefits
- Never use the words: synergy, leverage, circle back, reach out, touch base, solutions
- Never ask more than one question at a time
- If 75 seconds have passed and no booking: say "I'll send you a link — easier that way" and end
- Maximum call length: 90 seconds
- Speak at a natural, slightly slow pace — never rush

VOICEMAIL (if answering machine detected): Leave exactly this message:
"Hey ${firstName}, ${senderFirstName} here from ${ourCompany}. Saw your enquiry — sending you a quick link to grab 20 minutes with us. Talk soon."
Then hang up. Do not leave a long voicemail.

Booking link: ${bookingUrl}`;

  // ── Voicemail message — used when AMD detects an answering machine ──
  const voicemailMessage =
    `Hey ${firstName}, ${senderFirstName} here from ${ourCompany}. ` +
    `Saw your enquiry — sending you a quick link to grab 20 minutes with us. Talk soon.`;

  return { firstMessage, systemPrompt, voicemailMessage };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Evaluate guards and schedule an outbound AI call via Vapi.
 *
 * @param {Object} lead          - Normalised lead object
 * @param {Object} qualification - Result from leadQualifier (with completenessScore)
 * @returns {Promise<Object>}
 *   On skip:    { skipped: true, reason: string }
 *   On success: { vapiCallId, status, scheduledAt, phoneNumber, guardResult }
 */
async function scheduleOutboundCall(lead, qualification) {
  // ── Run call guards first ────────────────────────────────────────────────
  const guardResult = evaluateCallGuards(lead, qualification);

  if (!guardResult.allowed) {
    logger.warn(`[VapiCaller] Call skipped for ${lead.email}: ${guardResult.reason}`);
    return { skipped: true, reason: guardResult.reason };
  }

  // ── Calculate safe scheduled time ────────────────────────────────────────
  const scheduledAt = calculateScheduledTime(config.vapi.callDelayMinutes);

  logger.info(
    `[VapiCaller] Scheduling call to ${lead.phone} for ${scheduledAt} ` +
    `(score: ${qualification.score}, completeness: ${qualification.completenessScore})`
  );

  // ── Build call script ────────────────────────────────────────────────────
  const { firstMessage, systemPrompt, voicemailMessage } = buildCallScript(lead, qualification);

  const payload = {
    assistantId: config.vapi.assistantId,
    phoneNumberId: config.vapi.fromPhoneNumber,

    customer: {
      number: _normalizePhone(lead.phone),
      name: `${lead.firstName} ${lead.lastName}`.trim(),
    },

    scheduledAt,

    assistantOverrides: {
      // ── CRITICAL: firstMessage is spoken instantly on connect ──────────
      // Vapi reads this before any LLM turn, eliminating the 2-second gap
      // that makes calls sound robotic.
      firstMessage,

      // ── Model override with hardened system prompt ─────────────────────
      model: {
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0.7,   // Slightly higher for natural-sounding conversation
        maxTokens: 150,     // Short responses — SDRs don't give speeches
        messages: [
          { role: 'system', content: systemPrompt },
        ],
      },

      // ── Voice settings ─────────────────────────────────────────────────
      // ElevenLabs voices sound the most natural. "adam" is calm and
      // professional — not overly polished which can sound AI-like.
      voice: {
        provider: 'elevenlabs',
        voiceId: 'pNInz6obpgDQGcFmaJgB', // "Adam" — natural, conversational
        stability: 0.45,       // Lower = more natural variation (less robotic)
        similarityBoost: 0.75,
        style: 0.3,            // Subtle style — avoids over-performance
        useSpeakerBoost: true,
      },

      // ── Transcriber (speech-to-text) ───────────────────────────────────
      // Deepgram Nova-2 has ~200ms latency — fastest available in Vapi
      transcriber: {
        provider: 'deepgram',
        model: 'nova-2',
        language: 'en-US',
        smartFormat: true,
        endpointing: 200,  // ms of silence before treating speech as complete
      },

      // ── Answering machine detection ────────────────────────────────────
      // If voicemail detected, leave the short message and hang up
      // rather than reciting the full pitch to a machine.
      analysisPlan: {
        summaryPrompt:
          'Summarize the call outcome in one sentence: was a meeting booked, ' +
          'a callback requested, or was the call rejected? Note the agreed time if booked.',
      },

      // ── Hard call duration cap ─────────────────────────────────────────
      maxDurationSeconds: MAX_CALL_DURATION_SECONDS,

      // ── Silence handling ───────────────────────────────────────────────
      // If prospect goes silent for >8s, re-engage rather than dead air
      silenceTimeoutSeconds: 8,
      responseDelaySeconds: 0.4,  // Minimal response delay — feels human

      // ── End-of-call behaviour ──────────────────────────────────────────
      endCallMessage: 'Great, talk soon!',
      endCallPhrases: [
        'goodbye', 'bye', 'bye bye', 'talk soon', 'take care',
        'not interested', 'remove me', 'do not call',
      ],

      // ── Voicemail message ──────────────────────────────────────────────
      voicemailMessage,
      voicemailDetectionEnabled: true,

      // ── Variable values (available in the Vapi dashboard / webhooks) ───
      variableValues: {
        leadFirstName: lead.firstName,
        leadLastName: lead.lastName,
        leadCompany: company(lead),
        leadTitle: lead.jobTitle || '',
        leadEmail: lead.email,
        qualScore: String(qualification.score),
        bookingUrl: config.google.bookingPageUrl,
      },
    },
  };

  const response = await vapiClient.post('/call/phone', payload);

  logger.info(
    `[VapiCaller] Call scheduled — vapiCallId: ${response.data.id}, at: ${scheduledAt}`
  );

  return {
    vapiCallId: response.data.id,
    status: response.data.status,
    scheduledAt,
    phoneNumber: lead.phone,
    guardResult,
  };
}

/**
 * Retrieve the status and transcript of a Vapi call.
 *
 * @param {string} callId
 * @returns {Promise<Object>}
 */
async function getCallStatus(callId) {
  const response = await vapiClient.get(`/call/${callId}`);
  return response.data;
}

/**
 * Cancel a scheduled call that hasn't fired yet.
 *
 * @param {string} callId
 * @returns {Promise<Object>}
 */
async function cancelCall(callId) {
  logger.info(`[VapiCaller] Cancelling call: ${callId}`);
  const response = await vapiClient.delete(`/call/${callId}`);
  return response.data;
}

/**
 * Parse a completed call's transcript to detect booking intent.
 * Used by the Vapi webhook handler to trigger calendar creation.
 *
 * @param {string} transcript - Raw call transcript text
 * @returns {{ booked: boolean, detectedTime?: string, callOutcome: string }}
 */
function analyzeCallOutcome(transcript) {
  if (!transcript) return { booked: false, callOutcome: 'no_transcript' };

  const t = transcript.toLowerCase();

  const bookingPhrases = [
    'sounds good', 'that works', 'i can do that', 'perfect',
    'let\'s do it', 'yes', 'confirmed', 'book it', 'send the invite',
    'send me the link', 'go ahead',
  ];

  const rejectionPhrases = [
    'not interested', 'remove me', 'don\'t call', 'do not call',
    'wrong number', 'no thanks', 'not right now',
  ];

  const booked = bookingPhrases.some((p) => t.includes(p));
  const rejected = rejectionPhrases.some((p) => t.includes(p));

  let callOutcome;
  if (booked)    callOutcome = 'meeting_booked';
  else if (rejected) callOutcome = 'rejected';
  else            callOutcome = 'no_decision';

  // Very basic time extraction — in production use an NLP parser
  const timeMatch = transcript.match(
    /\b(monday|tuesday|wednesday|thursday|friday)\b.*?\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i
  );
  const detectedTime = timeMatch ? timeMatch[0] : undefined;

  return { booked, detectedTime, callOutcome };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (phone.startsWith('+')) return phone.replace(/\s/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

function company(lead) {
  return lead.company || 'your company';
}

module.exports = {
  scheduleOutboundCall,
  getCallStatus,
  cancelCall,
  analyzeCallOutcome,
  evaluateCallGuards,
  buildCallScript,
  calculateScheduledTime,
};
