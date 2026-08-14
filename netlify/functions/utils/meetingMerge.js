// netlify/functions/utils/meetingMerge.js
// NEW FILE — path from repo root: netlify/functions/utils/meetingMerge.js
//
// HubSpot meetings (from /crm/v3/objects/meetings/search) and Outlook calendar
// events (from getOutlookCalendarEvents in hubspot.js) don't share a reliable
// common ID unless HubSpot's own native Outlook sync created the record — and
// Cipher's Graph connection is separate from that. So this dedupes on
// attendee email + overlapping time window instead, and prefers the HubSpot
// version when both exist because that's where deal/persona context lives.
//
// Gong-titled meetings are excluded up front — same rule already used
// elsewhere in Cipher (exclude [Gong]-prefixed titles from a rep's own view).

const OVERLAP_TOLERANCE_MIN = 15; // minutes of slack when matching the same meeting across sources

function isGongTitle(title) {
  return !!title && title.trim().startsWith("[Gong]");
}

function toMs(iso) {
  return iso ? new Date(iso).getTime() : null;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  if (aStart == null || bStart == null) return false;
  const tol = OVERLAP_TOLERANCE_MIN * 60 * 1000;
  return aStart - tol <= (bEnd ?? bStart) && bStart - tol <= (aEnd ?? aStart);
}

// Normalizes a HubSpot meeting (from meetings/search results) into a common shape.
function normalizeHubSpotMeeting(m, contactMap) {
  const p = m.properties || {};
  if (isGongTitle(p.hs_meeting_title)) return null;
  const contactId = m.contactId || null; // caller attaches this from association batch-read
  return {
    id: `hs-${m.id}`,
    source: "hubspot",
    subject: p.hs_meeting_title || "Meeting",
    startTime: p.hs_meeting_start_time || null,
    endTime: p.hs_meeting_end_time || null,
    contactId,
    contact: contactId ? contactMap[contactId] || null : null,
    contactEmail: contactMap[contactId]?.email || null,
    confirmationTaskCreated: m.confirmationTaskCreated || false,
  };
}

// Normalizes an Outlook calendarView event into the same common shape.
// Requires "attendees" to be included in the Graph $select — see note in
// getOutlookCalendarEvents; add it if it's not already there.
function normalizeOutlookEvent(ev, contactsByEmail) {
  const attendeeEmails = (ev.attendees || [])
    .map(a => a.emailAddress?.address?.toLowerCase())
    .filter(Boolean);
  const matchedEmail = attendeeEmails.find(e => contactsByEmail[e]);
  const contact = matchedEmail ? contactsByEmail[matchedEmail] : null;
  return {
    id: `ol-${ev.id}`,
    source: "outlook",
    subject: ev.subject || "Meeting",
    startTime: ev.start?.dateTime ? `${ev.start.dateTime}Z` : null,
    endTime: ev.end?.dateTime ? `${ev.end.dateTime}Z` : null,
    contactId: contact?.id || null,
    contact: contact || null,
    contactEmail: matchedEmail || null,
    confirmationTaskCreated: false,
  };
}

// hsMeetings: raw results from /crm/v3/objects/meetings/search, each needs a
//   .contactId attached by the caller (via association batch-read) before this runs.
// outlookEvents: raw results from getOutlookCalendarEvents.
// contactMap: { [contactId]: normalizedContact } — same shape used elsewhere in hubspot.js.
// contactsByEmail: { [lowercased email]: normalizedContact } — build once from contactMap.
export function mergeMeetings(hsMeetings = [], outlookEvents = [], contactMap = {}, contactsByEmail = {}) {
  const hsNormalized = hsMeetings.map(m => normalizeHubSpotMeeting(m, contactMap)).filter(Boolean);
  const olNormalized = outlookEvents.map(ev => normalizeOutlookEvent(ev, contactsByEmail));

  const merged = [...hsNormalized];

  for (const ol of olNormalized) {
    const dupe = hsNormalized.find(hs =>
      hs.contactEmail && ol.contactEmail && hs.contactEmail === ol.contactEmail &&
      overlaps(toMs(hs.startTime), toMs(hs.endTime), toMs(ol.startTime), toMs(ol.endTime))
    );
    if (!dupe) merged.push(ol); // not logged in HubSpot yet — keep the Outlook version
  }

  return merged;
}
