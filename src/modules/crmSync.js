'use strict';

const axios = require('axios');
const { config } = require('../../config');
const { logger } = require('../utils/logger');

// ─── CRM Stage Constants ────────────────────────────────────────────────────

const STAGES = {
  NEW_LEAD: 'new_lead',
  QUALIFIED: 'qualified',
  OUTREACH_SENT: 'outreach_sent',
  CALL_SCHEDULED: 'call_scheduled',
  MEETING_BOOKED: 'meeting_booked',
  DISQUALIFIED: 'disqualified',
};

// ─── HubSpot ────────────────────────────────────────────────────────────────

const hubspotClient = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: {
    Authorization: `Bearer ${config.hubspot.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

/**
 * Create or update a HubSpot contact.
 * Uses upsert via email to avoid duplicates.
 *
 * @param {Object} lead          - Normalised lead
 * @param {Object} qualification - Qualification result
 * @param {string} stage         - Pipeline stage key from STAGES
 * @returns {Promise<Object>}    - HubSpot contact object
 */
async function syncToHubSpot(lead, qualification, stage = STAGES.NEW_LEAD) {
  logger.info(`[CRM/HubSpot] Syncing ${lead.email} — stage: ${stage}`);

  const properties = {
    firstname: lead.firstName,
    lastname: lead.lastName,
    email: lead.email,
    phone: lead.phone || '',
    company: lead.company || '',
    jobtitle: lead.jobTitle || '',
    industry: lead.industry || '',
    website: lead.website || '',
    // Custom properties — create these in HubSpot Settings > Properties
    lead_score: String(qualification.score),
    lead_tier: qualification.tier,
    lead_source: lead.source || 'webform',
    lead_message: lead.message || '',
    qualification_reasoning: qualification.reasoning || '',
    hs_lead_status: _mapHubSpotLeadStatus(stage),
  };

  // Try to create; if duplicate, update instead
  try {
    const createRes = await hubspotClient.post('/crm/v3/objects/contacts', {
      properties,
    });

    logger.info(`[CRM/HubSpot] Contact created — id: ${createRes.data.id}`);

    // Log engagement note
    await _createHubSpotNote(
      createRes.data.id,
      `Lead Engine: ${lead.email} qualified as ${qualification.tier.toUpperCase()} (score: ${qualification.score})\n${qualification.reasoning}`
    );

    return createRes.data;
  } catch (err) {
    if (err.response?.status === 409) {
      // Contact already exists — find and update
      const existingId = await _findHubSpotContact(lead.email);
      if (existingId) {
        return await _updateHubSpotContact(existingId, properties, lead, qualification);
      }
    }
    throw err;
  }
}

async function _findHubSpotContact(email) {
  const res = await hubspotClient.post('/crm/v3/objects/contacts/search', {
    filterGroups: [
      {
        filters: [
          { propertyName: 'email', operator: 'EQ', value: email },
        ],
      },
    ],
    limit: 1,
  });
  return res.data.results?.[0]?.id || null;
}

async function _updateHubSpotContact(contactId, properties, lead, qualification) {
  const res = await hubspotClient.patch(
    `/crm/v3/objects/contacts/${contactId}`,
    { properties }
  );
  logger.info(`[CRM/HubSpot] Contact updated — id: ${contactId}`);

  await _createHubSpotNote(
    contactId,
    `Lead Engine re-qualified: ${qualification.tier.toUpperCase()} (score: ${qualification.score})`
  );
  return res.data;
}

async function _createHubSpotNote(contactId, body) {
  try {
    await hubspotClient.post('/crm/v3/objects/notes', {
      properties: {
        hs_note_body: body,
        hs_timestamp: new Date().toISOString(),
      },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        },
      ],
    });
  } catch (noteErr) {
    logger.warn('[CRM/HubSpot] Failed to create note (non-fatal)', noteErr.message);
  }
}

/**
 * Update the deal/pipeline stage for a HubSpot contact.
 *
 * @param {string} contactId
 * @param {string} stage
 * @returns {Promise<void>}
 */
async function updateHubSpotStage(contactId, stage) {
  const stageId = config.hubspot.stages[_stageKeyToCamel(stage)];
  if (!stageId) {
    logger.warn(`[CRM/HubSpot] No HubSpot stage configured for: ${stage}`);
    return;
  }

  await hubspotClient.patch(`/crm/v3/objects/contacts/${contactId}`, {
    properties: { hs_lead_status: stageId },
  });

  logger.info(`[CRM/HubSpot] Stage updated → ${stage}`);
}

function _mapHubSpotLeadStatus(stage) {
  const map = {
    [STAGES.NEW_LEAD]: 'NEW',
    [STAGES.QUALIFIED]: 'IN_PROGRESS',
    [STAGES.OUTREACH_SENT]: 'IN_PROGRESS',
    [STAGES.CALL_SCHEDULED]: 'IN_PROGRESS',
    [STAGES.MEETING_BOOKED]: 'OPEN_DEAL',
    [STAGES.DISQUALIFIED]: 'UNQUALIFIED',
  };
  return map[stage] || 'NEW';
}

// ─── GoHighLevel ────────────────────────────────────────────────────────────

const ghlClient = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${config.ghl.apiKey}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  },
  timeout: 15000,
});

/**
 * Create or update a GoHighLevel contact.
 *
 * @param {Object} lead
 * @param {Object} qualification
 * @param {string} stage
 * @returns {Promise<Object>}
 */
async function syncToGoHighLevel(lead, qualification, stage = STAGES.NEW_LEAD) {
  logger.info(`[CRM/GHL] Syncing ${lead.email} — stage: ${stage}`);

  const payload = {
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    phone: lead.phone || '',
    companyName: lead.company || '',
    website: lead.website || '',
    source: lead.source || 'webform',
    locationId: config.ghl.locationId,
    customFields: [
      { key: 'lead_score', field_value: String(qualification.score) },
      { key: 'lead_tier', field_value: qualification.tier },
      { key: 'lead_message', field_value: lead.message || '' },
      { key: 'qualification_reasoning', field_value: qualification.reasoning || '' },
    ],
    tags: [`lead-engine`, `tier-${qualification.tier}`, `score-${qualification.score}`],
  };

  const response = await ghlClient.post('/contacts/upsert', payload);
  const contactId = response.data.contact?.id;

  logger.info(`[CRM/GHL] Contact upserted — id: ${contactId}`);

  // Add to pipeline opportunity
  if (contactId) {
    await _createGHLOpportunity(contactId, lead, qualification, stage);
  }

  return response.data;
}

async function _createGHLOpportunity(contactId, lead, qualification, stage) {
  const stageId = config.ghl.stages[_stageKeyToCamel(stage)] || config.ghl.stages.newLead;
  try {
    await ghlClient.post('/opportunities/', {
      pipelineId: config.ghl.pipelineId,
      locationId: config.ghl.locationId,
      name: `${lead.firstName} ${lead.lastName} — ${lead.company || 'Unknown Co'}`,
      pipelineStageId: stageId,
      status: 'open',
      contactId,
      monetaryValue: 0,
      assignedTo: '',
    });
    logger.info(`[CRM/GHL] Opportunity created for contact: ${contactId}`);
  } catch (err) {
    logger.warn('[CRM/GHL] Failed to create opportunity (non-fatal)', err.message);
  }
}

// ─── Unified Interface ───────────────────────────────────────────────────────

/**
 * Sync lead to whichever CRM is configured (hubspot | gohighlevel).
 *
 * @param {Object} lead
 * @param {Object} qualification
 * @param {string} stage
 * @returns {Promise<Object>}
 */
async function syncLead(lead, qualification, stage = STAGES.NEW_LEAD) {
  const provider = config.crm.provider;

  if (provider === 'hubspot') {
    return syncToHubSpot(lead, qualification, stage);
  } else if (provider === 'gohighlevel') {
    return syncToGoHighLevel(lead, qualification, stage);
  } else {
    throw new Error(`Unknown CRM provider: ${provider}. Set CRM_PROVIDER=hubspot or CRM_PROVIDER=gohighlevel`);
  }
}

/**
 * Map a STAGES constant to a camelCase config key.
 */
function _stageKeyToCamel(stage) {
  const map = {
    [STAGES.NEW_LEAD]: 'newLead',
    [STAGES.QUALIFIED]: 'qualified',
    [STAGES.OUTREACH_SENT]: 'outreachSent',
    [STAGES.CALL_SCHEDULED]: 'callScheduled',
    [STAGES.MEETING_BOOKED]: 'meetingBooked',
    [STAGES.DISQUALIFIED]: 'disqualified',
  };
  return map[stage] || 'newLead';
}

module.exports = { syncLead, syncToHubSpot, syncToGoHighLevel, STAGES };
