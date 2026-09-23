'use strict';

require('dotenv').config();

/**
 * Centralised config loader.
 * All modules import from here — never from process.env directly.
 */
const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    webhookSecret: process.env.WEBHOOK_SECRET,
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS, 10) || 800,
  },

  vapi: {
    apiKey: process.env.VAPI_API_KEY,
    assistantId: process.env.VAPI_ASSISTANT_ID,
    callDelayMinutes: parseInt(process.env.VAPI_CALL_DELAY_MINUTES, 10) || 15,
    fromPhoneNumber: process.env.VAPI_FROM_PHONE_NUMBER,
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    gmail: {
      senderAddress: process.env.GMAIL_SENDER_ADDRESS,
      senderName: process.env.GMAIL_SENDER_NAME,
    },
    calendar: {
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      meetingDurationMinutes: parseInt(process.env.CALENDAR_MEETING_DURATION_MINUTES, 10) || 30,
    },
    bookingPageUrl: process.env.BOOKING_PAGE_URL,
  },

  hubspot: {
    apiKey: process.env.HUBSPOT_API_KEY,
    pipelineId: process.env.HUBSPOT_PIPELINE_ID || 'default',
    stages: {
      newLead: process.env.HUBSPOT_STAGE_NEW_LEAD,
      qualified: process.env.HUBSPOT_STAGE_QUALIFIED,
      outreachSent: process.env.HUBSPOT_STAGE_OUTREACH_SENT,
      callScheduled: process.env.HUBSPOT_STAGE_CALL_SCHEDULED,
      meetingBooked: process.env.HUBSPOT_STAGE_MEETING_BOOKED,
      disqualified: process.env.HUBSPOT_STAGE_DISQUALIFIED,
    },
  },

  ghl: {
    apiKey: process.env.GHL_API_KEY,
    locationId: process.env.GHL_LOCATION_ID,
    pipelineId: process.env.GHL_PIPELINE_ID,
    stages: {
      newLead: process.env.GHL_STAGE_NEW_LEAD,
      qualified: process.env.GHL_STAGE_QUALIFIED,
      outreachSent: process.env.GHL_STAGE_OUTREACH_SENT,
      callScheduled: process.env.GHL_STAGE_CALL_SCHEDULED,
      meetingBooked: process.env.GHL_STAGE_MEETING_BOOKED,
      disqualified: process.env.GHL_STAGE_DISQUALIFIED,
    },
  },

  crm: {
    provider: process.env.CRM_PROVIDER || 'hubspot', // 'hubspot' | 'gohighlevel'
  },

  n8n: {
    baseUrl: process.env.N8N_BASE_URL,
    webhookPath: process.env.N8N_WEBHOOK_PATH || '/webhook/lead-intake',
    apiKey: process.env.N8N_API_KEY,
  },

  qualification: {
    hotThreshold: parseInt(process.env.QUALIFICATION_HOT_THRESHOLD, 10) || 80,
    warmThreshold: parseInt(process.env.QUALIFICATION_WARM_THRESHOLD, 10) || 50,
  },

  company: {
    name: process.env.COMPANY_NAME || 'Your Company',
    website: process.env.COMPANY_WEBSITE || 'https://yourcompany.com',
    valueProp: process.env.COMPANY_VALUE_PROP || '',
    targetIndustries: (process.env.TARGET_INDUSTRIES || '').split(',').map((s) => s.trim()),
  },
};

/**
 * Validate that critical keys are present at startup.
 */
function validateConfig() {
  const required = [
    ['openai.apiKey', config.openai.apiKey],
    ['google.clientId', config.google.clientId],
    ['google.clientSecret', config.google.clientSecret],
    ['google.refreshToken', config.google.refreshToken],
    ['google.gmail.senderAddress', config.google.gmail.senderAddress],
  ];

  const missing = required.filter(([, val]) => !val).map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  ${missing.join('\n  ')}\n\nCopy .env.example to .env and fill in the missing values.`
    );
  }
}

module.exports = { config, validateConfig };
