'use strict';

/**
 * leadQualifier.js
 *
 * Solves the LLM Hallucination in Qualification problem:
 *
 *   Problem: An LLM can hallucinate and score a student, job-seeker, or
 *            bot submission as a high-value lead, wasting money on Vapi
 *            calls and damaging sender reputation with irrelevant emails.
 *
 *   Solution — three-layer defence:
 *
 *     Layer 1 — Pre-LLM Hard Gates (synchronous, zero API cost)
 *       Reject leads that fail objective, deterministic checks before
 *       the LLM ever runs. Examples: free email domains, missing company,
 *       job-seeker keywords, bot-like submissions.
 *
 *     Layer 2 — Structured LLM Output with response_format: json_object
 *       Force the model into JSON mode (OpenAI guaranteed JSON output).
 *       The response schema is validated field-by-field after parsing —
 *       any missing or out-of-range field triggers a disqualification,
 *       not a crash.
 *
 *     Layer 3 — Post-LLM Consistency Checks
 *       Override the LLM's tier if the numeric score contradicts it.
 *       Apply mandatory score penalties for known weak signals.
 *       Require a minimum data completeness score before allowing 'hot'.
 */

const OpenAI = require('openai');
const { config } = require('../../config');
const { logger } = require('../utils/logger');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// ─── Layer 1: Hard Gate Definitions ─────────────────────────────────────────

/**
 * Free/consumer email providers — not B2B.
 * A company email is one of the strongest ICP signals.
 */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com',
  'proton.me', 'tutanota.com', 'zohomail.com', 'yandex.com', 'mail.com',
  'gmx.com', 'gmx.net', 'inbox.com',
]);

/**
 * Keywords in name/message that strongly indicate a job-seeker,
 * student, or non-buyer. Case-insensitive substring matches.
 */
const JOB_SEEKER_SIGNALS = [
  'looking for a job', 'job application', 'resume', 'cv attached',
  'open to work', 'seeking employment', 'internship', 'fresher',
  'entry level', 'apply for position', 'job opportunity',
  'i am a student', 'university project', 'college project',
  'final year project', 'thesis', 'dissertation', 'research paper',
];

/**
 * Known spam/bot patterns in email addresses.
 */
const BOT_EMAIL_PATTERNS = [
  /^test@/, /^admin@/, /^info@/, /^noreply@/, /^no-reply@/,
  /^spam@/, /^fake@/, /^example@/, /^\d{5,}@/,
  /[+]{1}[^@]+@/,           // plus-aliased disposable emails
];

/**
 * Minimum message length (characters) to pass the gate.
 * A 3-word message like "need help please" cannot be meaningfully qualified.
 */
const MIN_MESSAGE_LENGTH = 20;

// ─── Pre-LLM Gate Runner ─────────────────────────────────────────────────────

/**
 * Run all hard gates against a lead.
 * Returns immediately on the first failure — cheap and fast.
 *
 * @param {Object} lead - Normalised lead object
 * @returns {{ passed: boolean, reason?: string, penalty?: number }}
 *   passed  — true if the lead clears all hard gates
 *   reason  — human-readable explanation if failed
 *   penalty — score penalty to apply (for soft signals that don't fully block)
 */
function runHardGates(lead) {
  const emailDomain = (lead.email || '').split('@')[1]?.toLowerCase() || '';
  const messageLower = (lead.message || '').toLowerCase();
  const nameLower = `${lead.firstName} ${lead.lastName}`.toLowerCase();

  // Gate 1: Valid email required
  if (!lead.email || !emailDomain) {
    return { passed: false, reason: 'GATE_NO_EMAIL: No valid email address provided' };
  }

  // Gate 2: Bot/disposable email patterns
  for (const pattern of BOT_EMAIL_PATTERNS) {
    if (pattern.test(lead.email)) {
      return { passed: false, reason: `GATE_BOT_EMAIL: Email matches bot pattern ${pattern}` };
    }
  }

  // Gate 3: Job-seeker / student keyword detection
  const jobSignal = JOB_SEEKER_SIGNALS.find(
    (kw) => messageLower.includes(kw) || nameLower.includes(kw)
  );
  if (jobSignal) {
    return {
      passed: false,
      reason: `GATE_JOB_SEEKER: Job-seeker signal detected — "${jobSignal}"`,
    };
  }

  // Gate 4: Message too short to meaningfully qualify
  if ((lead.message || '').trim().length < MIN_MESSAGE_LENGTH) {
    // Soft gate — don't hard-block but flag for LLM with penalty
    logger.warn(`[LeadQualifier] Short message for ${lead.email} — LLM will penalise`);
    return { passed: true, penalty: 15, reason: 'SOFT_SHORT_MESSAGE' };
  }

  // Gate 5: Free email domain — significant red flag but not a hard block
  // (Some SMB owners use Gmail — we soft-penalise rather than reject outright)
  if (FREE_EMAIL_DOMAINS.has(emailDomain)) {
    logger.warn(`[LeadQualifier] Free email domain for ${lead.email} — applying penalty`);
    return { passed: true, penalty: 20, reason: 'SOFT_FREE_EMAIL_DOMAIN' };
  }

  return { passed: true, penalty: 0 };
}

// ─── Layer 2: Structured LLM Prompt ─────────────────────────────────────────

const QUALIFICATION_SYSTEM_PROMPT = `You are a strict B2B sales qualification analyst.
Your job is to determine whether a lead is a genuine B2B buyer — not a student, job-seeker, competitor, or bot.

SCORING (total = 100 points):
- companySize     0–25: signals of real business scale (employees, revenue cues, domain)
- budgetIndicators 0–25: explicit budget mention, or company scale implying budget
- decisionMakerSeniority 0–20: C-suite/VP/Director = 18-20, Manager = 10-14, IC/unknown = 0-7
- industryFit     0–15: match against provided target verticals (exact = 15, adjacent = 8, miss = 0)
- urgencySignals  0–15: clear timeline or pain ("we need this by Q4") = 15, vague = 5, none = 0

MANDATORY DISQUALIFICATION (set score=0, tier="cold") if any of these are true:
- The message reads like a job application, CV, or academic project
- The person has no apparent company or business context
- The "company" field is a personal name or is blank
- The message is a generic greeting with no business context

DATA COMPLETENESS — you must assess and return a completenessScore (0–100):
- Each of these present and non-trivial: company(+20), jobTitle(+20), companySize(+15), message(+25), phone(+10), website(+10)

TIER MAPPING:
- score 80–100 AND completenessScore >= 60: "hot"
- score 50–79 OR (score 80-100 AND completenessScore < 60): "warm"
- score 0–49: "cold"

Return ONLY a valid JSON object. No markdown. No prose.
{
  "score": <integer 0-100>,
  "tier": "hot" | "warm" | "cold",
  "completenessScore": <integer 0-100>,
  "reasoning": "<max 100 words — cite specific signals you used>",
  "detectedPainPoints": ["<string>"],
  "companySignals": ["<string>"],
  "decisionMakerLikelihood": "high" | "medium" | "low",
  "recommendedAction": "<string>",
  "disqualificationFlag": false | "<reason string if disqualified>",
  "scoringBreakdown": {
    "companySize": <0-25>,
    "budgetIndicators": <0-25>,
    "decisionMakerSeniority": <0-20>,
    "industryFit": <0-15>,
    "urgencySignals": <0-15>
  }
}`;

// ─── Layer 3: Schema Validator ────────────────────────────────────────────────

/**
 * Validate the LLM's JSON output field by field.
 * Returns a sanitised object — never throws on bad LLM output.
 *
 * @param {Object} raw - Parsed JSON from LLM
 * @returns {{ valid: boolean, data?: Object, errors: string[] }}
 */
function _validateLLMSchema(raw) {
  const errors = [];

  // score: must be integer 0–100
  if (typeof raw.score !== 'number' || raw.score < 0 || raw.score > 100) {
    errors.push(`score out of range: ${raw.score}`);
    raw.score = 0;
  } else {
    raw.score = Math.round(raw.score);
  }

  // tier: must be one of three exact values
  if (!['hot', 'warm', 'cold'].includes(raw.tier)) {
    errors.push(`invalid tier: ${raw.tier}`);
    raw.tier = 'cold';
  }

  // completenessScore: must be 0–100
  if (typeof raw.completenessScore !== 'number' || raw.completenessScore < 0) {
    errors.push(`missing or invalid completenessScore`);
    raw.completenessScore = 0;
  }
  raw.completenessScore = Math.min(100, Math.round(raw.completenessScore));

  // reasoning: must be a non-empty string
  if (typeof raw.reasoning !== 'string' || !raw.reasoning.trim()) {
    errors.push('missing reasoning');
    raw.reasoning = 'No reasoning provided by model';
  }

  // arrays: coerce to array if wrong type
  raw.detectedPainPoints = Array.isArray(raw.detectedPainPoints) ? raw.detectedPainPoints : [];
  raw.companySignals = Array.isArray(raw.companySignals) ? raw.companySignals : [];

  // decisionMakerLikelihood
  if (!['high', 'medium', 'low'].includes(raw.decisionMakerLikelihood)) {
    raw.decisionMakerLikelihood = 'low';
  }

  // scoringBreakdown: validate individual sub-scores sum ≤ 100
  const bd = raw.scoringBreakdown || {};
  const subScoreTotal =
    (bd.companySize || 0) +
    (bd.budgetIndicators || 0) +
    (bd.decisionMakerSeniority || 0) +
    (bd.industryFit || 0) +
    (bd.urgencySignals || 0);

  if (subScoreTotal > 100) {
    errors.push(`scoringBreakdown sub-scores sum to ${subScoreTotal} > 100 — clamping`);
    // Proportionally scale down
    const factor = 100 / subScoreTotal;
    for (const k of Object.keys(bd)) {
      bd[k] = Math.round(bd[k] * factor);
    }
  }

  raw.scoringBreakdown = bd;
  raw.disqualificationFlag = raw.disqualificationFlag || false;
  raw.recommendedAction = raw.recommendedAction || '';

  return {
    valid: errors.length === 0,
    data: raw,
    errors,
  };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Qualify a lead with three-layer hallucination protection.
 *
 * @param {Object} lead - Normalised lead object
 * @returns {Promise<Object>} qualification result
 *
 * The returned object always includes:
 *   score              {number}   0-100
 *   tier               {string}   hot | warm | cold
 *   completenessScore  {number}   0-100 (data quality signal)
 *   gateResult         {Object}   { passed, reason, penalty }
 *   disqualificationFlag  {false|string}
 *   reasoning, detectedPainPoints, companySignals, decisionMakerLikelihood,
 *   recommendedAction, scoringBreakdown, schemaErrors, qualifiedAt
 */
async function qualifyLead(lead) {
  logger.info(`[LeadQualifier] Starting qualification for: ${lead.email}`);

  // ── Layer 1: Hard gates ───────────────────────────────────────────────────
  const gateResult = runHardGates(lead);

  if (!gateResult.passed) {
    logger.warn(`[LeadQualifier] Hard gate FAILED for ${lead.email}: ${gateResult.reason}`);
    return {
      score: 0,
      tier: 'cold',
      completenessScore: 0,
      gateResult,
      disqualificationFlag: gateResult.reason,
      reasoning: `Automatically disqualified before LLM: ${gateResult.reason}`,
      detectedPainPoints: [],
      companySignals: [],
      decisionMakerLikelihood: 'low',
      recommendedAction: 'Do not contact. Add to suppression list.',
      scoringBreakdown: {},
      schemaErrors: [],
      qualifiedAt: new Date().toISOString(),
    };
  }

  // ── Layer 2: LLM qualification with JSON mode ─────────────────────────────
  const userPrompt = buildQualificationPrompt(lead, gateResult);

  let rawContent;
  try {
    const response = await openai.chat.completions.create({
      model: config.openai.model,
      temperature: 0.1,       // Low temperature for analytical consistency
      max_tokens: 600,
      response_format: { type: 'json_object' }, // Guaranteed JSON — no markdown fences
      messages: [
        { role: 'system', content: QUALIFICATION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    rawContent = response.choices[0].message.content.trim();
  } catch (apiErr) {
    logger.error('[LeadQualifier] OpenAI API error', { error: apiErr.message });
    throw new Error(`Qualification API call failed: ${apiErr.message}`);
  }

  // ── Parse — response_format: json_object guarantees valid JSON ───────────
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (parseErr) {
    // Should not happen with json_object mode, but handle defensively
    logger.error('[LeadQualifier] JSON parse failed despite json_object mode', { rawContent });
    throw new Error(`LLM returned unparseable output: ${rawContent.slice(0, 200)}`);
  }

  // ── Layer 3: Schema validation ────────────────────────────────────────────
  const { data, errors: schemaErrors } = _validateLLMSchema(parsed);

  if (schemaErrors.length > 0) {
    logger.warn(`[LeadQualifier] Schema errors for ${lead.email}`, { schemaErrors });
  }

  // ── Apply gate penalties to the LLM score ────────────────────────────────
  const penalty = gateResult.penalty || 0;
  let score = Math.max(0, data.score - penalty);

  // Hard cap: cannot be 'hot' if completeness is too low
  // (prevents hallucination of a hot lead from sparse data)
  const MIN_COMPLETENESS_FOR_HOT = 60;
  if (score >= config.qualification.hotThreshold && data.completenessScore < MIN_COMPLETENESS_FOR_HOT) {
    logger.warn(
      `[LeadQualifier] Downgrading ${lead.email} from hot→warm: ` +
      `completenessScore ${data.completenessScore} < ${MIN_COMPLETENESS_FOR_HOT}`
    );
    score = config.qualification.warmThreshold; // Cap at bottom of warm range
  }

  // ── Deterministic tier enforcement (code beats LLM) ──────────────────────
  let tier;
  if (score >= config.qualification.hotThreshold) {
    tier = 'hot';
  } else if (score >= config.qualification.warmThreshold) {
    tier = 'warm';
  } else {
    tier = 'cold';
  }

  // If LLM raised a disqualification flag, always override to cold
  if (data.disqualificationFlag) {
    tier = 'cold';
    score = Math.min(score, 30);
    logger.warn(
      `[LeadQualifier] LLM disqualification flag for ${lead.email}: ${data.disqualificationFlag}`
    );
  }

  const result = {
    score,
    tier,
    completenessScore: data.completenessScore,
    gateResult,
    disqualificationFlag: data.disqualificationFlag,
    reasoning: data.reasoning,
    detectedPainPoints: data.detectedPainPoints,
    companySignals: data.companySignals,
    decisionMakerLikelihood: data.decisionMakerLikelihood,
    recommendedAction: data.recommendedAction,
    scoringBreakdown: data.scoringBreakdown,
    schemaErrors,
    penaltyApplied: penalty,
    qualifiedAt: new Date().toISOString(),
  };

  logger.info(
    `[LeadQualifier] ${lead.email} → score: ${score} (penalty: -${penalty}), ` +
    `tier: ${tier}, completeness: ${data.completenessScore}, ` +
    `dm-likelihood: ${data.decisionMakerLikelihood}`
  );

  return result;
}

/**
 * Build the user-side prompt for the LLM, including gate context
 * so it has full picture of any soft signals detected.
 *
 * @param {Object} lead
 * @param {Object} gateResult
 * @returns {string}
 */
function buildQualificationPrompt(lead, gateResult) {
  const lines = [
    'Qualify this B2B lead:',
    '',
    `Name: ${lead.firstName} ${lead.lastName}`,
    `Email: ${lead.email}`,
    `Company: ${lead.company || 'NOT PROVIDED'}`,
    `Job Title: ${lead.jobTitle || 'NOT PROVIDED'}`,
    `Company Size: ${lead.companySize || 'NOT PROVIDED'}`,
    `Budget: ${lead.budget || 'NOT MENTIONED'}`,
    `Industry: ${lead.industry || 'NOT PROVIDED'}`,
    `Website: ${lead.website || 'NOT PROVIDED'}`,
    `Phone: ${lead.phone ? 'PROVIDED' : 'NOT PROVIDED'}`,
    '',
    'Message / Inquiry:',
    `"${lead.message || 'NO MESSAGE PROVIDED'}"`,
    '',
    `Target Industries: ${config.company.targetIndustries.join(', ')}`,
    `Our Value Proposition: ${config.company.valueProp}`,
  ];

  // Include any soft-gate signals so LLM can factor them in
  if (gateResult.reason) {
    lines.push('');
    lines.push(`Pre-screening note: ${gateResult.reason}`);
    if (gateResult.penalty) {
      lines.push(`A score penalty of ${gateResult.penalty} points will be applied post-analysis.`);
    }
  }

  return lines.join('\n');
}

module.exports = { qualifyLead, runHardGates, buildQualificationPrompt };
