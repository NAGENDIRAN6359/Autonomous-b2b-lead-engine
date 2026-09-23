'use strict';

const { google } = require('googleapis');
const { config } = require('../../config');
const { logger } = require('../utils/logger');

/**
 * Build and return an authenticated Google API OAuth2 client.
 */
function _buildAuth() {
  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  auth.setCredentials({ refresh_token: config.google.refreshToken });
  return auth;
}

/**
 * Create a Google Calendar event to reserve a meeting slot.
 *
 * Called automatically when a Vapi call confirms a time, or when the
 * booking page webhook fires after a prospect self-schedules.
 *
 * @param {Object} lead         - Normalised lead object
 * @param {string} startTimeISO - ISO 8601 start time (e.g. "2026-09-23T14:00:00Z")
 * @param {Object} [options]    - Optional overrides
 * @param {string} [options.durationMinutes] - Meeting duration (defaults to config)
 * @param {string} [options.meetingTitle]    - Custom event title
 * @param {string} [options.notes]           - Additional notes for the event body
 * @returns {Promise<Object>} Google Calendar event resource
 */
async function createBooking(lead, startTimeISO, options = {}) {
  const durationMinutes =
    options.durationMinutes || config.google.calendar.meetingDurationMinutes;

  const startTime = new Date(startTimeISO);
  const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

  const title =
    options.meetingTitle ||
    `Discovery Call: ${lead.firstName} ${lead.lastName} × ${config.company.name}`;

  logger.info(
    `[CalendarBooking] Creating event "${title}" at ${startTimeISO} for ${lead.email}`
  );

  const auth = _buildAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const event = {
    summary: title,
    description: _buildEventDescription(lead, options.notes),
    start: {
      dateTime: startTime.toISOString(),
      timeZone: 'UTC',
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: 'UTC',
    },
    attendees: [
      // Prospect
      { email: lead.email, displayName: `${lead.firstName} ${lead.lastName}` },
      // Host (sender)
      { email: config.google.gmail.senderAddress, displayName: config.google.gmail.senderName },
    ],
    // Automatically send invite emails to all attendees
    sendUpdates: 'all',
    // Google Meet link
    conferenceData: {
      createRequest: {
        requestId: `booking-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },  // 24h before
        { method: 'popup', minutes: 30 },         // 30min before
      ],
    },
  };

  const createdEvent = await calendar.events.insert({
    calendarId: config.google.calendar.calendarId,
    requestBody: event,
    conferenceDataVersion: 1,
    sendNotifications: true,
  });

  const meetLink = createdEvent.data?.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === 'video'
  )?.uri || null;

  logger.info(
    `[CalendarBooking] Event created — id: ${createdEvent.data.id}, meet: ${meetLink}`
  );

  return {
    eventId: createdEvent.data.id,
    htmlLink: createdEvent.data.htmlLink,
    meetLink,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    title,
    attendees: createdEvent.data.attendees || [],
  };
}

/**
 * Fetch available free slots on the host calendar within a date range.
 *
 * Uses the Google Calendar Freebusy API to check existing commitments,
 * then returns open windows aligned to CALENDAR_MEETING_DURATION_MINUTES.
 *
 * @param {string} startISO     - Range start (ISO 8601)
 * @param {string} endISO       - Range end (ISO 8601)
 * @param {number} [slotCount]  - Max number of slots to return (default: 5)
 * @returns {Promise<Array<{start: string, end: string}>>}
 */
async function getAvailableSlots(startISO, endISO, slotCount = 5) {
  logger.info(`[CalendarBooking] Fetching free slots between ${startISO} and ${endISO}`);

  const auth = _buildAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const freeBusyResponse = await calendar.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      timeZone: 'UTC',
      items: [{ id: config.google.calendar.calendarId }],
    },
  });

  const busyPeriods =
    freeBusyResponse.data.calendars[config.google.calendar.calendarId]?.busy || [];

  const durationMs = config.google.calendar.meetingDurationMinutes * 60 * 1000;
  const slots = [];

  // Walk through the range in 30-min increments, skip busy windows
  let cursor = new Date(startISO).getTime();
  const rangeEnd = new Date(endISO).getTime();

  while (cursor + durationMs <= rangeEnd && slots.length < slotCount) {
    const slotStart = cursor;
    const slotEnd = cursor + durationMs;

    const isConflict = busyPeriods.some((busy) => {
      const busyStart = new Date(busy.start).getTime();
      const busyEnd = new Date(busy.end).getTime();
      return slotStart < busyEnd && slotEnd > busyStart;
    });

    if (!isConflict) {
      const startDate = new Date(slotStart);
      const hour = startDate.getUTCHours();
      // Only offer business hours (9am–5pm UTC)
      if (hour >= 9 && hour < 17) {
        slots.push({
          start: new Date(slotStart).toISOString(),
          end: new Date(slotEnd).toISOString(),
        });
      }
    }

    cursor += 30 * 60 * 1000; // advance 30 min
  }

  logger.info(`[CalendarBooking] Found ${slots.length} available slots`);
  return slots;
}

/**
 * Cancel an existing Google Calendar event and notify attendees.
 *
 * @param {string} eventId - Google Calendar event ID
 * @returns {Promise<void>}
 */
async function cancelBooking(eventId) {
  logger.info(`[CalendarBooking] Cancelling event: ${eventId}`);
  const auth = _buildAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.events.delete({
    calendarId: config.google.calendar.calendarId,
    eventId,
    sendUpdates: 'all',
  });

  logger.info(`[CalendarBooking] Event ${eventId} cancelled`);
}

/**
 * Build a descriptive event body with lead context.
 */
function _buildEventDescription(lead, additionalNotes) {
  const lines = [
    `Discovery Call — ${config.company.name}`,
    '',
    `Prospect: ${lead.firstName} ${lead.lastName}`,
    `Company: ${lead.company || 'N/A'}`,
    `Title: ${lead.jobTitle || 'N/A'}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone || 'N/A'}`,
    '',
    `Original Inquiry:`,
    lead.message ? `"${lead.message}"` : 'N/A',
  ];

  if (additionalNotes) {
    lines.push('', 'Notes:', additionalNotes);
  }

  lines.push('', `Booked via ${config.company.name} Lead Engine`);
  return lines.join('\n');
}

module.exports = { createBooking, getAvailableSlots, cancelBooking };
