'use strict';

/**
 * Input validation helpers for incoming webhook payloads.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate and sanitize a raw lead payload from any source.
 * Returns { valid: true, lead } or { valid: false, errors: [] }
 *
 * @param {Object} raw - Raw request body
 * @returns {{ valid: boolean, lead?: Object, errors?: string[] }}
 */
function validateLeadPayload(raw) {
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Payload must be a JSON object'] };
  }

  // Resolve email from common field names
  const email = (
    raw.email || raw.Email || raw.EMAIL || ''
  ).toString().trim().toLowerCase();

  if (!email) {
    errors.push('email is required');
  } else if (!EMAIL_REGEX.test(email)) {
    errors.push(`Invalid email format: "${email}"`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Normalise the lead — accept any common field naming convention
  const lead = {
    firstName:   _pick(raw, ['first_name', 'firstName', 'fname']) || _splitName(raw)[0],
    lastName:    _pick(raw, ['last_name', 'lastName', 'lname'])   || _splitName(raw)[1],
    email,
    phone:       _pick(raw, ['phone', 'Phone', 'phone_number', 'phoneNumber', 'mobile']) || '',
    company:     _pick(raw, ['company', 'Company', 'company_name', 'companyName', 'organization']) || '',
    jobTitle:    _pick(raw, ['job_title', 'jobTitle', 'title', 'role', 'position']) || '',
    companySize: _pick(raw, ['company_size', 'companySize', 'employees', 'team_size']) || '',
    budget:      _pick(raw, ['budget', 'Budget', 'monthly_budget', 'annual_budget']) || '',
    industry:    _pick(raw, ['industry', 'Industry', 'sector', 'vertical']) || '',
    message:     _pick(raw, ['message', 'Message', 'inquiry', 'how_can_we_help', 'notes', 'description']) || '',
    website:     _pick(raw, ['website', 'Website', 'company_website', 'url']) || '',
    source:      _pick(raw, ['source', '_source', 'lead_source', 'utm_source']) || 'webform',
    submittedAt: new Date().toISOString(),
  };

  // Sanitize strings — strip HTML tags and limit length
  for (const key of Object.keys(lead)) {
    if (typeof lead[key] === 'string') {
      lead[key] = _sanitize(lead[key]);
    }
  }

  return { valid: true, lead };
}

/**
 * Verify an HMAC-SHA256 webhook signature.
 * Used to validate Webflow and WordPress webhook authenticity.
 *
 * @param {string|Buffer} rawBody   - Raw request body bytes
 * @param {string}        signature - x-webhook-signature header value
 * @param {string}        secret    - Shared webhook secret from .env
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;

  const crypto = require('crypto');

  // Support both "sha256=..." and bare hex formats
  const expectedPrefix = 'sha256=';
  const sigHex = signature.startsWith(expectedPrefix)
    ? signature.slice(expectedPrefix.length)
    : signature;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sigHex, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _pick(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return String(obj[key]).trim();
    }
  }
  return '';
}

function _splitName(raw) {
  const fullName = _pick(raw, ['name', 'full_name', 'fullName', 'Name']) || '';
  const parts = fullName.trim().split(/\s+/);
  return [parts[0] || '', parts.slice(1).join(' ') || ''];
}

function _sanitize(str) {
  return str
    .replace(/<[^>]*>/g, '')   // strip HTML
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // strip control chars
    .trim()
    .slice(0, 2000);           // hard cap
}

module.exports = { validateLeadPayload, verifyWebhookSignature };
