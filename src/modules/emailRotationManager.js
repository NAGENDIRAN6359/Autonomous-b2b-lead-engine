'use strict';

/**
 * emailRotationManager.js
 *
 * Solves the Email Deliverability Trap:
 *
 *   Problem: Sending bulk AI-generated outreach from a primary domain
 *            triggers spam filters at Google and Microsoft within days.
 *
 *   Solution:
 *     1. Maintain a pool of secondary "sender" accounts across multiple
 *        lookalike domains (e.g. company-hq.com, companyteam.com).
 *     2. Track daily send count per account and enforce per-account limits.
 *     3. Follow a warmup schedule — new accounts start at low volume and
 *        ramp up by ~20% per day over 4–6 weeks.
 *     4. Monitor bounce/complaint rates per sender and automatically
 *        suspend any account that exceeds safe thresholds.
 *     5. Auto-rotate to the next healthy sender when the current one
 *        hits its daily limit or is suspended.
 *
 * Storage: sender state is persisted to a JSON file on disk.
 * In production, swap _loadState / _saveState for a database call.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { logger } = require('../utils/logger');

// ─── Configuration ───────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, '..', '..', 'config', 'sender-state.json');

/**
 * Warmup schedule: { day: maxDailySends }
 * Follows established best practice — start low, add ~30% per step.
 * Days are counted from account.warmupStartDate.
 */
const WARMUP_SCHEDULE = [
  { upToDay: 2,  limit: 5   },
  { upToDay: 5,  limit: 10  },
  { upToDay: 8,  limit: 20  },
  { upToDay: 12, limit: 40  },
  { upToDay: 17, limit: 70  },
  { upToDay: 23, limit: 110 },
  { upToDay: 30, limit: 150 },
  { upToDay: 40, limit: 200 },
  { upToDay: Infinity, limit: 250 },  // Fully warmed up
];

// An account with bounce rate above this is auto-suspended
const MAX_BOUNCE_RATE = 0.05;   // 5%
// An account with spam complaint rate above this is auto-suspended
const MAX_COMPLAINT_RATE = 0.001; // 0.1%

// ─── State Management ────────────────────────────────────────────────────────

function _loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    logger.warn('[EmailRotation] Could not load sender state, starting fresh', { err: err.message });
  }
  return { senders: [] };
}

function _saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.error('[EmailRotation] Failed to save sender state', { err: err.message });
  }
}

// ─── Warmup Limit Calculator ─────────────────────────────────────────────────

/**
 * Return the daily send limit for a sender based on how many days it has
 * been warming up.
 *
 * @param {string} warmupStartDate - ISO date string of when warmup began
 * @returns {number} max emails today
 */
function _getDailyLimit(warmupStartDate) {
  if (!warmupStartDate) return WARMUP_SCHEDULE[WARMUP_SCHEDULE.length - 1].limit;

  const start = new Date(warmupStartDate).getTime();
  const now = Date.now();
  const daysSinceStart = Math.floor((now - start) / (1000 * 60 * 60 * 24));

  const entry = WARMUP_SCHEDULE.find((s) => daysSinceStart <= s.upToDay);
  return entry ? entry.limit : WARMUP_SCHEDULE[WARMUP_SCHEDULE.length - 1].limit;
}

/**
 * Get the warmup phase label for logging / reporting.
 *
 * @param {string} warmupStartDate
 * @returns {string}
 */
function _getWarmupPhase(warmupStartDate) {
  if (!warmupStartDate) return 'fully-warmed';
  const start = new Date(warmupStartDate).getTime();
  const days = Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24));
  if (days >= 40) return 'fully-warmed';
  if (days >= 23) return 'mature';
  if (days >= 8)  return 'mid-warmup';
  return 'early-warmup';
}

// ─── Sender Pool Management ──────────────────────────────────────────────────

/**
 * Register a new sender account in the pool.
 *
 * Call this once per account when setting it up. The account starts warming
 * up from today — it won't be eligible for high-volume sends until matured.
 *
 * @param {Object} sender
 * @param {string} sender.id            - Unique ID (e.g. "sales-1")
 * @param {string} sender.email         - From address (e.g. "alex@company-hq.com")
 * @param {string} sender.displayName   - From name (e.g. "Alex from Company")
 * @param {string} sender.domain        - Sending domain (e.g. "company-hq.com")
 * @param {string} sender.refreshToken  - Google OAuth refresh token for this account
 * @param {string} [sender.warmupStartDate] - ISO date; defaults to today
 * @returns {Object} updated state
 */
function registerSender(sender) {
  const state = _loadState();

  const existing = state.senders.find((s) => s.id === sender.id);
  if (existing) {
    logger.warn(`[EmailRotation] Sender ${sender.id} already registered — skipping`);
    return state;
  }

  state.senders.push({
    id: sender.id,
    email: sender.email,
    displayName: sender.displayName,
    domain: sender.domain,
    refreshToken: sender.refreshToken,
    warmupStartDate: sender.warmupStartDate || new Date().toISOString().split('T')[0],
    status: 'active',        // 'active' | 'suspended' | 'retired'
    dailySentToday: 0,
    dailySentDate: null,     // ISO date string of last send
    totalSent: 0,
    bounceCount: 0,
    complaintCount: 0,
    lastUsedAt: null,
  });

  _saveState(state);
  logger.info(`[EmailRotation] Sender registered: ${sender.email} (warmup from ${sender.warmupStartDate || 'today'})`);
  return state;
}

/**
 * Return all registered senders with their current health status.
 *
 * @returns {Array<Object>}
 */
function listSenders() {
  const state = _loadState();
  return state.senders.map((s) => ({
    id: s.id,
    email: s.email,
    domain: s.domain,
    status: s.status,
    warmupPhase: _getWarmupPhase(s.warmupStartDate),
    dailyLimit: _getDailyLimit(s.warmupStartDate),
    dailySentToday: _getDailySentToday(s),
    totalSent: s.totalSent,
    bounceRate: s.totalSent > 0 ? (s.bounceCount / s.totalSent).toFixed(4) : '0.0000',
    complaintRate: s.totalSent > 0 ? (s.complaintCount / s.totalSent).toFixed(5) : '0.00000',
  }));
}

// ─── Sender Selection ─────────────────────────────────────────────────────────

/**
 * Pick the best available sender from the pool for the next outreach.
 *
 * Selection rules (in priority order):
 *   1. Must be 'active' and not suspended
 *   2. Must have remaining capacity for today
 *   3. Prefer fully-warmed senders over warming ones
 *   4. Among equal warmup tier, prefer the one used least recently
 *      (round-robin to spread reputation load)
 *
 * @returns {{ sender: Object, dailyLimit: number, remaining: number } | null}
 */
function selectSender() {
  const state = _loadState();
  const today = _todayISO();

  const candidates = state.senders
    .filter((s) => s.status === 'active')
    .map((s) => {
      const dailyLimit = _getDailyLimit(s.warmupStartDate);
      const sentToday = s.dailySentDate === today ? s.dailySentToday : 0;
      const remaining = dailyLimit - sentToday;
      const warmupDays = s.warmupStartDate
        ? Math.floor((Date.now() - new Date(s.warmupStartDate).getTime()) / 86400000)
        : 999;
      return { sender: s, dailyLimit, sentToday, remaining, warmupDays };
    })
    .filter((c) => c.remaining > 0)
    // Sort: most warmed first, then least recently used
    .sort((a, b) => {
      if (b.warmupDays !== a.warmupDays) return b.warmupDays - a.warmupDays;
      const aLast = a.sender.lastUsedAt ? new Date(a.sender.lastUsedAt).getTime() : 0;
      const bLast = b.sender.lastUsedAt ? new Date(b.sender.lastUsedAt).getTime() : 0;
      return aLast - bLast;
    });

  if (candidates.length === 0) {
    logger.error('[EmailRotation] No available senders — all at daily limit or suspended');
    return null;
  }

  const chosen = candidates[0];
  logger.info(
    `[EmailRotation] Selected sender: ${chosen.sender.email} ` +
    `(${chosen.sentToday}/${chosen.dailyLimit} today, phase: ${_getWarmupPhase(chosen.sender.warmupStartDate)})`
  );

  return { sender: chosen.sender, dailyLimit: chosen.dailyLimit, remaining: chosen.remaining };
}

// ─── Send Tracking ───────────────────────────────────────────────────────────

/**
 * Record a successful send for a sender.
 * Called after each email is dispatched.
 *
 * @param {string} senderId
 */
function recordSend(senderId) {
  const state = _loadState();
  const sender = state.senders.find((s) => s.id === senderId);
  if (!sender) return;

  const today = _todayISO();
  if (sender.dailySentDate !== today) {
    sender.dailySentToday = 0;
    sender.dailySentDate = today;
  }

  sender.dailySentToday += 1;
  sender.totalSent += 1;
  sender.lastUsedAt = new Date().toISOString();

  _saveState(state);
}

/**
 * Record a bounce or complaint event.
 * Automatically suspends the sender if thresholds are exceeded.
 *
 * @param {string} senderId
 * @param {'bounce' | 'complaint'} eventType
 */
function recordDeliverabilityEvent(senderId, eventType) {
  const state = _loadState();
  const sender = state.senders.find((s) => s.id === senderId);
  if (!sender) return;

  if (eventType === 'bounce') sender.bounceCount += 1;
  if (eventType === 'complaint') sender.complaintCount += 1;

  const bounceRate = sender.totalSent > 0 ? sender.bounceCount / sender.totalSent : 0;
  const complaintRate = sender.totalSent > 0 ? sender.complaintCount / sender.totalSent : 0;

  if (bounceRate > MAX_BOUNCE_RATE || complaintRate > MAX_COMPLAINT_RATE) {
    sender.status = 'suspended';
    logger.error(
      `[EmailRotation] Sender ${sender.email} AUTO-SUSPENDED — ` +
      `bounce: ${(bounceRate * 100).toFixed(2)}%, complaint: ${(complaintRate * 100).toFixed(3)}%`
    );
  }

  _saveState(state);
}

/**
 * Manually update a sender's status.
 *
 * @param {string} senderId
 * @param {'active' | 'suspended' | 'retired'} status
 */
function setSenderStatus(senderId, status) {
  const state = _loadState();
  const sender = state.senders.find((s) => s.id === senderId);
  if (!sender) throw new Error(`Sender not found: ${senderId}`);
  sender.status = status;
  _saveState(state);
  logger.info(`[EmailRotation] Sender ${sender.email} status → ${status}`);
}

// ─── Gmail Send via Rotation ─────────────────────────────────────────────────

/**
 * Send an email using the next available sender from the pool.
 *
 * This is the main public function — replaces the single-account sendEmail()
 * in emailDrafter.js with a rotation-aware version.
 *
 * @param {string} toEmail  - Recipient address
 * @param {string} toName   - Recipient display name
 * @param {Object} draft    - { subject, body, previewText }
 * @returns {Promise<{ messageId: string, sentFrom: string, senderId: string }>}
 */
async function sendWithRotation(toEmail, toName, draft) {
  const selection = selectSender();

  if (!selection) {
    throw new Error(
      'Email send failed: no senders available. All accounts are at daily limit or suspended. ' +
      'Add more sender accounts or wait until tomorrow.'
    );
  }

  const { sender } = selection;

  logger.info(
    `[EmailRotation] Sending to ${toEmail} via ${sender.email} ` +
    `(warmup phase: ${_getWarmupPhase(sender.warmupStartDate)})`
  );

  try {
    const messageId = await _sendViaGmail(sender, toEmail, toName, draft);
    recordSend(sender.id);

    return {
      messageId,
      sentFrom: sender.email,
      senderDisplayName: sender.displayName,
      senderId: sender.id,
    };
  } catch (err) {
    // If send fails due to auth/quota, mark for inspection but don't auto-suspend
    logger.error(`[EmailRotation] Send failed via ${sender.email}`, { error: err.message });
    throw err;
  }
}

/**
 * Internal: send via Gmail API using a specific sender's OAuth credentials.
 *
 * @param {Object} sender  - Sender record with refreshToken
 * @param {string} toEmail
 * @param {string} toName
 * @param {Object} draft
 * @returns {Promise<string>} Gmail message ID
 */
async function _sendViaGmail(sender, toEmail, toName, draft) {
  const { config } = require('../../config');

  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  auth.setCredentials({ refresh_token: sender.refreshToken });

  const gmail = google.gmail({ version: 'v1', auth });

  const fromHeader = `${sender.displayName} <${sender.email}>`;
  const toHeader = toName ? `${toName} <${toEmail}>` : toEmail;

  // Unsubscribe header — important for deliverability + CAN-SPAM compliance
  const unsubscribeUrl = `${config.company.website}/unsubscribe?email=${encodeURIComponent(toEmail)}`;

  const rawMessage = [
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
    `Subject: ${draft.subject}`,
    `List-Unsubscribe: <${unsubscribeUrl}>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
    '',
    draft.body,
  ].join('\r\n');

  const encodedMessage = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  });

  return result.data.id;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _todayISO() {
  return new Date().toISOString().split('T')[0];
}

function _getDailySentToday(sender) {
  const today = _todayISO();
  return sender.dailySentDate === today ? sender.dailySentToday : 0;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  registerSender,
  listSenders,
  selectSender,
  sendWithRotation,
  recordSend,
  recordDeliverabilityEvent,
  setSenderStatus,
  WARMUP_SCHEDULE,
};
