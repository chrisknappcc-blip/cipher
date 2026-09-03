// Azure Blob for gap search cache persistence
const AZURE_ACCOUNT   = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const AZURE_SAS_TOKEN = process.env.AZURE_STORAGE_SAS_TOKEN;
const AZURE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER || "crm-tokens";

function gapCacheBlobUrl() {
  const sas = (AZURE_SAS_TOKEN || "").startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/gap-cache.json${sas}`;
}
function botLogBlobUrl() {
  const sas = (AZURE_SAS_TOKEN || "").startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/bot-log.json${sas}`;
}
function meetingConfirmationsBlobUrl(userId) {
  const sas = (AZURE_SAS_TOKEN || "").startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/meeting-confirmations-${userId}.json${sas}`;
}
// Tracks which meeting IDs already got an auto-generated confirmation to-do.
// Lives in Cipher's own storage since we never write this flag back to HubSpot.
async function getConfirmedMeetingIds(userId) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return new Set();
  try {
    const res = await fetch(meetingConfirmationsBlobUrl(userId));
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set(data.confirmedIds || []);
  } catch { return new Set(); }
}
async function addConfirmedMeetingId(userId, meetingId, existingSet) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return;
  const updated = new Set(existingSet);
  updated.add(meetingId);
  try {
    await fetch(meetingConfirmationsBlobUrl(userId), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
      body: JSON.stringify({ confirmedIds: [...updated] }),
    });
  } catch (e) { console.error("[meeting-confirmations] write failed:", e.message); }
}

// Same pattern, for OOO follow-up to-dos — fires once per contact, not on every poll.
function oooFollowupsBlobUrl(userId) {
  const sas = (AZURE_SAS_TOKEN || "").startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/ooo-followups-${userId}.json${sas}`;
}
async function getConfirmedOooIds(userId) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return new Set();
  try {
    const res = await fetch(oooFollowupsBlobUrl(userId));
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set(data.confirmedIds || []);
  } catch { return new Set(); }
}
async function addConfirmedOooId(userId, contactId, existingSet) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return;
  const updated = new Set(existingSet);
  updated.add(contactId);
  try {
    await fetch(oooFollowupsBlobUrl(userId), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
      body: JSON.stringify({ confirmedIds: [...updated] }),
    });
  } catch (e) { console.error("[ooo-followups] write failed:", e.message); }
}

// Same pattern again, for sequence-finished follow-ups — fires once per
// enrollment when it hits FINISHED, prompting "decide what's next" instead
// of letting it go quiet with no signal at all. This matters more now that
// sequences are the primary outreach channel.
function sequenceFollowupsBlobUrl(userId) {
  const sas = (AZURE_SAS_TOKEN || "").startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/sequence-followups-${userId}.json${sas}`;
}
async function getConfirmedSequenceIds(userId) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return new Set();
  try {
    const res = await fetch(sequenceFollowupsBlobUrl(userId));
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set(data.confirmedIds || []);
  } catch { return new Set(); }
}
async function addConfirmedSequenceId(userId, enrollmentId, existingSet) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return;
  const updated = new Set(existingSet);
  updated.add(enrollmentId);
  try {
    await fetch(sequenceFollowupsBlobUrl(userId), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
      body: JSON.stringify({ confirmedIds: [...updated] }),
    });
  } catch (e) { console.error("[sequence-followups] write failed:", e.message); }
}
async function appendBotEntries(newBots) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN || !newBots.length) return;
  try {
    let existing = { entries: [] };
    const r = await fetch(botLogBlobUrl());
    if (r.ok) existing = await r.json().catch(() => ({ entries: [] }));
    const existingKeys = new Set((existing.entries || []).map(e => `${e.contactId}:${e.openedAt}`));
    const newEntries = newBots
      .filter(b => !existingKeys.has(`${b.contactId}:${b.openedAt}`))
      .map(b => ({
        id: `${b.contactId || "x"}-${Date.now()}`,
        detectedAt: new Date().toISOString(),
        contactId:  b.contactId || null,
        name:       b.contact?.name || b.contact?.firstName || "Unknown",
        email:      b.contact?.email || "",
        domain:     (b.contact?.email || "").includes("@") ? b.contact.email.split("@")[1].toLowerCase() : "",
        company:    b.contact?.company || b.contact?.associatedCompany || "",
        confidence: b.botCheck?.confidence || "unknown",
        reasons:    b.botCheck?.reasons   || [],
        numOpens:   b.numOpens || 1,
        openedAt:   b.openedAt || null,
        sentAt:     b.sentAt   || null,
        repName:    b.contact?.assignedBdr || b.contact?.ownerName || null,
      }));
    if (!newEntries.length) return;
    const merged  = { entries: [...(existing.entries || []), ...newEntries].slice(-2000) };
    const payload = JSON.stringify(merged);
    await fetch(botLogBlobUrl(), {
      method:  "PUT",
      headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob", "Content-Length": String(Buffer.byteLength(payload)) },
      body:    payload,
    });
  } catch { /* fail silently */ }
}
// netlify/functions/hubspot.js
// Routes:
//   GET  /hubspot/auth/connect            -> redirect to HubSpot OAuth
//   GET  /hubspot/auth/callback           -> exchange code, store tokens (no auth required)
//   GET  /hubspot/status                  -> check which services are connected
//   GET  /hubspot/owners                  -> list HubSpot owners (reps) for filter dropdown
//   GET  /hubspot/contacts                -> list contacts with custom property filters
//   GET  /hubspot/contacts/:id            -> single contact detail + engagements
//   GET  /hubspot/signals                 -> ranked intent signals with custom property filters
//   GET  /hubspot/signals/recent          -> last 15 min of email events for real-time polling
//   GET  /hubspot/feed/:contactId         -> full merged activity feed for a contact
//   GET  /hubspot/tasks                   -> smart task queue three sections
//   GET  /hubspot/gold                    -> Gold-tier companies + contacts
//   GET  /hubspot/activity                -> outbound + inbound activity counts
//   POST /hubspot/activity                -> log a note/call/meeting to a contact
//   GET  /hubspot/tabs                    -> dynamic tab registry for current user
//   POST /hubspot/tabs                    -> add or update a tab (admin only)
//   DELETE /hubspot/tabs/:id              -> remove a tab (admin only)
//   GET  /hubspot/tabs/preview            -> fetch page title from a URL for auto-naming
//
// Custom filter query params (all optional, stackable):
//   assigned_bdr=Chris+Knapp
//   territory=Northeast
//   priority_tier__bdr=GOLD+1-10
//   target_account__bdr_led_outreach=Chris+Knapp

import { withAuth } from "./utils/auth.js";
import { getTokens, setTokens, isTokenValid } from "./utils/tokenStore.js";
import { getTabsForUser, getAllTabsForUser, getRegistry, saveRegistry, getPersonalTabs, savePersonalTabs, slugify, fetchPageTitle } from "./utils/tabRegistry.js";
import { getTodos, addTodo, updateTodo, deleteTodo, bulkUpsertAutoDetected } from "./utils/todoStore.js";
import { buildRightNowQueue, needsConfirmationTask, buildConfirmationTodo } from "./utils/rightNowQueue.js";
import { mergeMeetings } from "./utils/meetingMerge.js";
import { getActivityLog, addActivityEntry, deleteActivityEntry } from "./utils/activityLog.js";

// Admin users -- comma-separated emails in ADMIN_EMAILS env var (preferred)
// or legacy ADMIN_USER_IDS with Netlify Identity UUIDs.
// e.g. ADMIN_EMAILS=cknapp@carecontinuity.com,chrisknappcc@gmail.com
const ADMIN_EMAILS   = new Set(
  (process.env.ADMIN_EMAILS   || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);
// Check admin by email (preferred) OR by UUID (legacy)
const isAdminUser = (u) => ADMIN_EMAILS.has((u?.email || "").toLowerCase()) || ADMIN_USER_IDS.has(u?.userId || "");

// ─── Team hierarchy — who can view whose Right Now Queue ───────────────────
// Separate from ADMIN_EMAILS on purpose: ADMIN_EMAILS gates other admin
// features and means "full access to everything." This is specifically
// about scoped visibility — a manager sees their own direct reports, not
// necessarily the whole company. TEAM_HIERARCHY env var is a JSON object:
//   { "chris@x.com": ["chiara@x.com", "abby@x.com"], "john@x.com": ["*"] }
// A report list containing "*" means "can see everyone." Editing this env
// var (no code change needed) is how new hires get added — e.g. when Abby
// and Harley actually join, add their emails to Chris's list.
let TEAM_HIERARCHY = {};
try {
  TEAM_HIERARCHY = JSON.parse(process.env.TEAM_HIERARCHY || "{}");
} catch (e) {
  console.error("[team-hierarchy] Failed to parse TEAM_HIERARCHY env var:", e.message);
}

function getTeamVisibility(requestingEmail) {
  const email = (requestingEmail || "").toLowerCase();
  const entry = Object.entries(TEAM_HIERARCHY).find(([mgr]) => mgr.toLowerCase() === email);
  if (!entry) return { canAccess: false, all: false, emails: new Set([email]) };
  const reports = (entry[1] || []).map(e => String(e).toLowerCase());
  if (reports.includes("*")) return { canAccess: true, all: true, emails: null };
  return { canAccess: true, all: false, emails: new Set([email, ...reports]) };
}

const HS_CLIENT_ID     = process.env.HUBSPOT_CLIENT_ID;
const HS_CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET;
const HS_REDIRECT_URI  = process.env.HUBSPOT_REDIRECT_URI;
const HS_API           = "https://api.hubapi.com";

// Trimmed from 13 scopes to these 8 (Aug/Sept 2026 audit) — every one
// removed was confirmed via direct code search to have zero actual API
// usage: automation (no Workflows API calls anywhere), content (the one
// exception checked carefully — a Marketing Email reporting feature did
// use it, deliberately removed along with the scope rather than kept,
// since that scope cluster also demands unrelated seat permissions like
// Blog Writer and Landing Pages that a new BDR's HubSpot seat is unlikely
// to have — a real, recurring signup-friction cost for an occasional-use
// reporting tab), e-commerce (no products/orders calls), and both
// marketing_events scopes (dead feature — the only remaining reference
// in the code is a comment noting it was removed for performance).
// crm.lists.read is kept even though nothing in Cipher's own code
// currently calls the Lists API — that one was a deliberate choice to
// leave room for a possible future list-based feature, not an oversight.
const HS_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "crm.objects.companies.read",   // required for gold accounts panel
  "timeline",
  "sales-email-read",
  "crm.lists.read",
  "oauth",
].join(" ");

// All custom properties to include in every contact fetch
// NOTE: priority_tier__bdr lives on the COMPANY object, not contacts.
// Do not add it here -- it will cause HubSpot to 400 on every contact search.
const CUSTOM_PROPS = [
  "assigned_bdr",
  "target_account__bdr_led_outreach",
  "territory",
];

// Standard contact properties always fetched
const BASE_CONTACT_PROPS = [
  "firstname", "lastname", "email", "company", "jobtitle", "phone", "associatedcompanyid",
  "hs_lead_status", "lifecyclestage", "hubspot_owner_id",
  "notes_last_contacted", "num_contacted_notes",
  "hs_last_sales_activity_timestamp",
  "hs_last_sales_activity_timestamp",
  // Marketing email timestamps (hs_email_* prefix)
  "hs_email_last_open_date",
  "hs_email_last_click_date",
  "hs_email_last_reply_date",
  "hs_email_last_send_date",
  "hs_email_last_email_name",        // name of last marketing email sent
  "primary_outreach_rep",                     // who is driving outreach (custom field, primary filter for To-Do)
  // Sales / 1:1 email timestamps (hs_sales_email_* prefix)
  "hs_sales_email_last_opened",      // last 1:1 sales email open date
  "hs_sales_email_last_clicked",     // last 1:1 sales email click date
  "hs_sales_email_last_replied",     // last 1:1 sales email reply date
  // Sequence enrollment -- note: hs_sequence_name does NOT exist on contacts.
  // hs_latest_sequence_enrolled stores a numeric sequence ID, not the name.
  // Name resolution requires a separate sequence enrollment lookup (fetchSequenceEnrollments).
  "hs_sequences_actively_enrolled_count",
  // Cipher's own sequence-tracking properties (workflow-driven, confirmed
  // reliable via direct spot-checks against real email content — unlike
  // the native hs_sales_email_last_replied, these correctly exclude OOO
  // auto-replies). cipher_sequence_last_open_date is a date+time property
  // added specifically to give this precise recency data, since the
  // opens/clicks/replies counts themselves are cumulative all-time totals
  // with no per-event history.
  "cipher_sequence_opens",
  "cipher_sequence_clicks",
  "cipher_sequence_replies",
  "cipher_sequence_sends",
  "cipher_sequence_last_open_date",
  "cipher_sequence_opens_current",
  "cipher_sequence_clicks_current",
  "cipher_sequence_replies_current",
  "cipher_sequence_sends_current",
  "hs_sequences_is_enrolled",
  "hs_latest_sequence_enrolled",     // numeric sequence ID of last enrollment
  "hs_latest_sequence_enrolled_date",
  ...CUSTOM_PROPS,
];


// ─── OAuth helpers ────────────────────────────────────────────────────────────

async function refreshHubSpotToken(userId, tokens) {
  const res = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     HS_CLIENT_ID,
      client_secret: HS_CLIENT_SECRET,
      refresh_token: tokens.hubspot.refresh_token,
    }),
  });
  if (!res.ok) throw new Error("HubSpot token refresh failed");
  const data = await res.json();
  const updated = {
    hubspot: {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || tokens.hubspot.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
    },
  };
  await setTokens(userId, updated);
  return updated.hubspot;
}

// ─── Outlook Calendar via Microsoft Graph ─────────────────────────────────────
// Fetches upcoming calendar events for users who have connected Outlook.
// Tokens are stored in Azure Blob at outlook-tokens-{userId}.json.
// Returns [] gracefully when not connected or on any error.
async function getOutlookCalendarEvents(userId, windowStart, windowEnd) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return [];
  const sas     = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
  const blobBase = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}`;

  // Load stored tokens
  let tokens = null;
  try {
    const r = await fetch(`${blobBase}/outlook-tokens-${userId}.json${sas}`);
    if (!r.ok) return [];
    tokens = await r.json();
  } catch { return []; }
  if (!tokens?.access_token) return [];

  // Refresh if expiring within 5 minutes
  if ((tokens.expires_at || 0) < Date.now() + 5 * 60 * 1000) {
    try {
      const r = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id:     process.env.MICROSOFT_CLIENT_ID     || "",
          client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
          refresh_token: tokens.refresh_token,
          grant_type:    "refresh_token",
        }).toString(),
      });
      if (!r.ok) throw new Error(`Refresh ${r.status}`);
      const t = await r.json();
      tokens = {
        access_token:  t.access_token,
        refresh_token: t.refresh_token || tokens.refresh_token,
        expires_at:    Date.now() + (t.expires_in || 3600) * 1000,
        scope:         t.scope,
      };
      await fetch(`${blobBase}/outlook-tokens-${userId}.json${sas}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
        body:    JSON.stringify(tokens),
      });
    } catch (e) {
      console.error("[calendar] token refresh failed:", e.message);
      return [];
    }
  }

  // Fetch calendarView — all events in window
  const url =
    `https://graph.microsoft.com/v1.0/me/calendarView` +
    `?startDateTime=${windowStart.toISOString()}` +
    `&endDateTime=${windowEnd.toISOString()}` +
    `&$select=id,subject,start,end,location,organizer,isCancelled,isOrganizer,responseStatus,attendees` +
    `&$orderby=start/dateTime` +
    `&$top=50`;

  try {
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Prefer:        `outlook.timezone="UTC"`,
      },
    });
    if (!r.ok) {
      console.error("[calendar] Graph calendarView error:", r.status, await r.text().catch(() => ""));
      return [];
    }
    const data = await r.json();
    return (data.value || []).filter(ev =>
      // Skip cancelled events and events the user declined
      !ev.isCancelled &&
      ev.responseStatus?.response !== "declined"
    );
  } catch (e) {
    console.error("[calendar] fetch failed:", e.message);
    return [];
  }
}
// ─── Outlook Sent Email → sentAt Enrichment ─────────────────────────────────
// For the current user's Outlook, fetch recently sent emails and build a map
// of recipientEmail → most recent sentAt. Used to enrich signals with accurate
// TTO for bot detection (sentAt from HubSpot contact properties is unreliable).
async function getOutlookSentAtMap(userId, since) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return {};
  const sas      = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
  const blobBase = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}`;

  let tokens = null;
  try {
    const r = await fetch(`${blobBase}/outlook-tokens-${userId}.json${sas}`);
    if (!r.ok) return {};
    tokens = await r.json();
  } catch { return {}; }
  if (!tokens?.access_token) return {};

  // Refresh if needed
  if ((tokens.expires_at || 0) < Date.now() + 5 * 60 * 1000) {
    try {
      const r = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id:     process.env.MICROSOFT_CLIENT_ID || "",
          client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
          refresh_token: tokens.refresh_token,
          grant_type:    "refresh_token",
        }).toString(),
      });
      if (!r.ok) throw new Error(`Refresh ${r.status}`);
      const t = await r.json();
      tokens = { access_token: t.access_token, refresh_token: t.refresh_token || tokens.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000 };
      await fetch(`${blobBase}/outlook-tokens-${userId}.json${sas}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
        body: JSON.stringify(tokens),
      });
    } catch (e) {
      console.error("[sentAt] token refresh failed:", e.message);
      return {};
    }
  }

  // Fetch 200 most recent sent items — $filter on sentDateTime requires special
  // Graph index support, so we just pull the latest batch and filter client-side.
  const sinceMs = since ? new Date(since).getTime() : Date.now() - 14 * 24 * 60 * 60 * 1000;
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/SentItems/messages` +
    `?$select=sentDateTime,toRecipients` +
    `&$top=200&$orderby=sentDateTime desc`;

  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!r.ok) return {};
    const data = await r.json();
    // Build map: recipientEmail (lowercased) → most recent sentAt
    const map = {};
    for (const msg of (data.value || [])) {
      const sent = msg.sentDateTime;
      if (!sent) continue;
      // Client-side date filter — skip items older than our window
      if (new Date(sent).getTime() < sinceMs) continue;
      for (const rec of (msg.toRecipients || [])) {
        const email = rec.emailAddress?.address?.toLowerCase().trim();
        if (!email) continue;
        if (!map[email] || new Date(sent) > new Date(map[email])) {
          map[email] = sent;
        }
      }
    }
    return map;
  } catch (e) {
    console.error("[sentAt] Graph fetch failed:", e.message);
    return {};
  }
}





async function getValidHubSpotToken(userId) {
  const tokens = await getTokens(userId);
  if (!tokens.hubspot?.access_token) {
    throw new ApiError("HubSpot not connected. Visit /hubspot/auth/connect", 403);
  }
  if (!isTokenValid(tokens.hubspot)) {
    return await refreshHubSpotToken(userId, tokens);
  }
  return tokens.hubspot;
}

// ─── HubSpot API helpers with 429 retry ──────────────────────────────────────
// Retries up to 3 times on rate limit (429), with exponential backoff.
// This makes individual requests resilient to transient rate limit spikes.

async function hsApiCall(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.status === 429 || (err.message && err.message.includes('429'));
      if (is429 && i < retries - 1) {
        const wait = 1000 * (i + 1); // 1s, 2s, 3s
        console.warn(`[hubspot] 429 rate limit, retry ${i+1}/${retries-1} in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function hsGet(userId, path, params = {}) {
  return hsApiCall(async () => {
    const token = await getValidHubSpotToken(userId);
    const url   = new URL(`${HS_API}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new ApiError(`HubSpot API error (${res.status}): ${err}`, res.status);
    }
    return res.json();
  });
}

async function hsPost(userId, path, body) {
  return hsApiCall(async () => {
    const token = await getValidHubSpotToken(userId);
    const res = await fetch(`${HS_API}${path}`, {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new ApiError(`HubSpot API error (${res.status}): ${err}`, res.status);
    }
    return res.json();
  });
}


// ─── Filter helpers ───────────────────────────────────────────────────────────
// Builds HubSpot search filter groups from query params.
// Filters stack (AND logic) -- each active filter adds to the group.

function buildCustomFilters(qp, baseFilters = []) {
  // assigned_bdr: comma-separated BDR names (contacts filtered by assigned_bdr property)
  // owner_id: comma-separated HubSpot owner IDs (contacts filtered by hubspot_owner_id)
  // When both are present, we use OR logic (multiple filterGroups in caller)
  // When only one is present, single filter
  const bdrVals = qp.assigned_bdr
    ? decodeURIComponent(qp.assigned_bdr).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const ownerVals = qp.owner_id
    ? String(qp.owner_id).split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const filters = [...baseFilters];

  // If we have both BDR names AND owner IDs, caller needs to handle OR logic
  // This function returns the BDR filter only -- owner filter returned separately
  if (bdrVals.length === 1) {
    filters.push({ propertyName: "assigned_bdr", operator: "EQ",  value:  bdrVals[0] });
  } else if (bdrVals.length > 1) {
    filters.push({ propertyName: "assigned_bdr", operator: "IN",  values: bdrVals   });
  }
  if (ownerVals.length === 1 && bdrVals.length === 0) {
    filters.push({ propertyName: "hubspot_owner_id", operator: "EQ",  value:  ownerVals[0] });
  } else if (ownerVals.length > 1 && bdrVals.length === 0) {
    filters.push({ propertyName: "hubspot_owner_id", operator: "IN",  values: ownerVals   });
  }

  // Other contact filters
  const OTHER_FILTERS = {
    territory:                       "territory",
    target_account__bdr_led_outreach:"target_account__bdr_led_outreach",
  };
  Object.entries(OTHER_FILTERS).forEach(([param, prop]) => {
    if (qp[param]) {
      const val = decodeURIComponent(qp[param]).trim();
      if (val) filters.push({ propertyName: prop, operator: "EQ", value: val });
    }
  });

  return filters;
}

// Builds filterGroups that handle OR between assigned_bdr and hubspot_owner_id
// Used when a mixed group (e.g. BDRs + VPs) is selected
function buildFilterGroups(qp, extraFilters = []) {
  const bdrVals = qp.assigned_bdr
    ? decodeURIComponent(qp.assigned_bdr).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const ownerVals = qp.owner_id
    ? String(qp.owner_id).split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const baseExtra = extraFilters.filter(f => f.propertyName !== "assigned_bdr" && f.propertyName !== "hubspot_owner_id");

  if (bdrVals.length > 0 && ownerVals.length > 0) {
    // OR: either assigned_bdr matches OR hubspot_owner_id matches
    const bdrFilter = bdrVals.length === 1
      ? { propertyName: "assigned_bdr", operator: "EQ", value: bdrVals[0] }
      : { propertyName: "assigned_bdr", operator: "IN", values: bdrVals };
    const ownerFilter = ownerVals.length === 1
      ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerVals[0] }
      : { propertyName: "hubspot_owner_id", operator: "IN", values: ownerVals };
    return [
      { filters: [...baseExtra, bdrFilter] },
      { filters: [...baseExtra, ownerFilter] },
    ];
  }
  // Single filter type
  return [{ filters: buildCustomFilters(qp, baseExtra) }];
}

// Normalize a contact record into a clean info object
function normalizeContact(c) {
  const p = c.properties || {};
  return {
    id:           c.id,
    name:         `${p.firstname || ""} ${p.lastname || ""}`.trim(),
    email:        p.email || "",
    company:      p.company || "",
    title:        p.jobtitle || "",
    phone:        p.phone || "",
    leadStatus:   p.hs_lead_status || "",
    lifecycle:    p.lifecyclestage || "",
    lastContacted:p.notes_last_contacted || null,
    numContacted: p.num_contacted_notes || "0",
    // Custom properties
    assignedBdr:         p.assigned_bdr || "",
    ownerId:             p.hubspot_owner_id || "",
    primaryOutreachRep:  p.primary_outreach_rep || "",
    sequenceOpens:       parseInt(p.cipher_sequence_opens, 10) || 0,
    sequenceClicks:      parseInt(p.cipher_sequence_clicks, 10) || 0,
    sequenceReplies:     parseInt(p.cipher_sequence_replies, 10) || 0,
    sequenceSends:       parseInt(p.cipher_sequence_sends, 10) || 0,
    sequenceLastOpenAt:  p.cipher_sequence_last_open_date || null,
    targetAccount:       p.target_account__bdr_led_outreach || "",
    territory:           p.territory || "",
    // priorityTier lives on Company object, not contact -- omitted here
    // Marketing email timestamps (hs_email_* -- marketing hub sends)
    lastEmailActivityDate: p.hs_last_sales_activity_timestamp || null,
    lastSalesActivityDate: p.hs_last_sales_activity_timestamp || null,
    lastOpenDate:          p.hs_email_last_open_date     || null,
    lastClickDate:         p.hs_email_last_click_date    || null,
    lastReplyDate:         p.hs_email_last_reply_date    || null,
    lastSendDate:          p.hs_email_last_send_date     || null,
    lastEmailName:         p.hs_email_last_email_name    || null,
    // Sales / 1:1 email timestamps (hs_sales_email_* -- sequences and manual sends)
    salesLastOpened:       p.hs_sales_email_last_opened  || null,
    salesLastClicked:      p.hs_sales_email_last_clicked || null,
    salesLastReplied:      p.hs_sales_email_last_replied || null,
    // Sequence enrollment (ID only -- name requires fetchSequenceEnrollments)
    sequenceId:            p.hs_latest_sequence_enrolled      || null,
    sequenceEnrolledDate:  p.hs_latest_sequence_enrolled_date || null,
    inSequence:            p.hs_sequences_is_enrolled === "true",
  };
}


// ─── Activity feed helpers ────────────────────────────────────────────────────

async function fetchEngagements(userId, contactId, limit = 50) {
  try {
    const data = await hsGet(
      userId,
      `/engagements/v1/engagements/associated/CONTACT/${contactId}/paged`,
      { limit }
    );
    return (data.results || []).map((eng) => ({
      source:        "engagement",
      id:            `eng-${eng.engagement?.id}`,
      type:          eng.engagement?.type || "UNKNOWN",
      timestamp:     eng.engagement?.createdAt || eng.engagement?.timestamp || null,
      subject:       eng.metadata?.subject || eng.metadata?.title || null,
      body:          stripHtml(eng.metadata?.body || eng.metadata?.text || null),
      numOpens:      eng.metadata?.numOpens      || 0,
      numClicks:     eng.metadata?.numClicks     || 0,
      replied:       eng.metadata?.replied       || false,
      filteredEvent: eng.metadata?.filteredEvent || false,
      sentAt:        eng.metadata?.sentAt        || null,
      openedAt:      eng.metadata?.openedAt      || null,
      contactId:     eng.associations?.contactIds?.[0] ?? null,
    }));
  } catch {
    return [];
  }
}

// ─── Last meeting lookup — checks both HubSpot and Outlook ─────────────────
// Neither source alone is reliable: a meeting logged in HubSpot might not
// exist there if it was only ever a calendar invite, and Outlook only shows
// meetings the current user personally attended. Checking both and taking
// whichever is more recent is the only way to get an accurate answer.
function findLastHubSpotMeeting(engagements) {
  const meetings = (engagements || []).filter(e => e.type === "MEETING" && e.timestamp);
  if (meetings.length === 0) return null;
  meetings.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const top = meetings[0];
  return { subject: top.subject || "Meeting", timestamp: top.timestamp, source: "hubspot" };
}

async function findLastOutlookMeeting(userId, emails) {
  if (!emails || emails.length === 0) return null;
  const emailSet = new Set(emails.filter(Boolean).map(e => e.toLowerCase()));
  if (emailSet.size === 0) return null;
  const windowStart = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(); // only past meetings count as "last meeting that occurred"
  const events = await getOutlookCalendarEvents(userId, windowStart, windowEnd).catch(() => []);
  const matched = events.filter(ev =>
    (ev.attendees || []).some(a => emailSet.has((a.emailAddress?.address || "").toLowerCase()))
  );
  if (matched.length === 0) return null;
  matched.sort((a, b) => new Date(b.start?.dateTime || 0) - new Date(a.start?.dateTime || 0));
  const top = matched[0];
  return {
    subject: top.subject || "Meeting",
    timestamp: top.start?.dateTime ? `${top.start.dateTime}Z` : null,
    source: "outlook",
  };
}

async function findLastMeeting(userId, engagements, emails) {
  const [fromHubSpot, fromOutlook] = await Promise.all([
    findLastHubSpotMeeting(engagements),
    findLastOutlookMeeting(userId, emails),
  ]);
  const candidates = [fromHubSpot, fromOutlook].filter(Boolean);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  return candidates[0];
}

async function fetchTimelineEvents(userId, contactId, limit = 50) {
  try {
    const data = await hsGet(
      userId,
      `/crm/v3/timeline/events`,
      { objectType: "CONTACT", objectId: contactId, limit }
    );
    return (data.results || []).map((ev) => ({
      source:    "timeline",
      id:        `tl-${ev.id}`,
      type:      "TIMELINE_EVENT",
      eventType: ev.eventTemplateId || ev.objectType || "unknown",
      timestamp: ev.createdAt || ev.occurredAt || null,
      subject:   ev.tokens?.subject    || ev.extraData?.subject     || null,
      body:      ev.tokens?.body       || ev.extraData?.description || null,
      tokens:    ev.tokens    || {},
      extraData: ev.extraData || {},
      contactId: null,
    }));
  } catch {
    return [];
  }
}

async function fetchSequenceEnrollments(userId, contactId) {
  try {
    const data = await hsGet(
      userId,
      `/crm/v3/objects/contacts/${contactId}/associations/SEQUENCE_ENROLLMENT`,
      { limit: 10 }
    );
    const enrollmentIds = (data.results || []).map((r) => r.id);
    if (enrollmentIds.length === 0) return [];

    const batch = await hsPost(
      userId,
      "/crm/v3/objects/sequence_enrollments/batch/read",
      {
        properties: [
          "hs_enrollment_state", "hs_sequence_id", "hs_sequence_name",
          "hs_current_step_order", "hs_enrolled_at", "hs_ended_at", "hs_finished_at",
        ],
        inputs: enrollmentIds.map((id) => ({ id })),
      }
    );

    return (batch.results || []).map((enr) => ({
      source:      "sequence",
      id:          `seq-${enr.id}`,
      type:        "SEQUENCE_ENROLLMENT",
      timestamp:   enr.properties?.hs_enrolled_at || null,
      subject:     enr.properties?.hs_sequence_name || "Sequence",
      body:        null,
      state:       enr.properties?.hs_enrollment_state   || null,
      currentStep: enr.properties?.hs_current_step_order || null,
      sequenceId:  enr.properties?.hs_sequence_id        || null,
      enrolledAt:  enr.properties?.hs_enrolled_at        || null,
      endedAt:     enr.properties?.hs_ended_at || enr.properties?.hs_finished_at || null,
      contactId:   null,
    }));
  } catch {
    return [];
  }
}

async function fetchLifecycleHistory(userId, contactId) {
  try {
    const data = await hsGet(
      userId,
      `/crm/v3/objects/contacts/${contactId}`,
      {
        properties:            "lifecyclestage,hs_lead_status",
        propertiesWithHistory: "lifecyclestage,hs_lead_status",
      }
    );

    const history = [];

    (data.propertiesWithHistory?.lifecyclestage || []).forEach((h) => {
      history.push({
        source:    "lifecycle",
        id:        `lc-${h.timestamp}-${h.value}`,
        type:      "LIFECYCLE_CHANGE",
        timestamp: h.timestamp,
        subject:   `Lifecycle stage: ${h.value}`,
        body:      null,
        value:     h.value,
        contactId: null,
      });
    });

    (data.propertiesWithHistory?.hs_lead_status || []).forEach((h) => {
      history.push({
        source:    "lifecycle",
        id:        `ls-${h.timestamp}-${h.value}`,
        type:      "LEAD_STATUS_CHANGE",
        timestamp: h.timestamp,
        subject:   `Lead status: ${h.value}`,
        body:      null,
        value:     h.value,
        contactId: null,
      });
    });

    return history;
  } catch {
    return [];
  }
}

function mergeFeed(engagements, timelineEvents, sequences, lifecycle) {
  const all  = [...engagements, ...timelineEvents, ...sequences, ...lifecycle];
  const seen = new Set();
  return all
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });
}

// Fetch per-recipient marketing email events
async function fetchMarketingEmailRecipientEvents(userId, since) {
  try {
    const data = await hsGet(userId, "/email/public/v1/events", {
      startTimestamp: since,
      limit: 200,
    });

    // Log first event to see all available fields for debugging
    if (data.events && data.events.length > 0) {
      console.log("[mkt-email] Sample event fields:", Object.keys(data.events[0]).join(", "));
      console.log("[mkt-email] Sample event:", JSON.stringify(data.events[0]).slice(0, 500));
    }

    return (data.events || [])
      .filter(ev => ["OPEN", "CLICK"].includes(ev.type))
      .map((ev) => ({
        source:         "marketing_email",
        id:             `mev-${ev.id || ev.created}`,
        type:           "MARKETING_EMAIL",
        eventType:      ev.type,
        timestamp:      ev.created || null,
        // emailCampaignGroupName is the actual campaign name when HubSpot populates it
        // emailCampaignId is the numeric send ID -- different from the email template ID
        subject:        ev.emailCampaignGroupName || ev.appName || null,
        campaignId:     ev.emailCampaignId ? String(ev.emailCampaignId) : null,
        body:           null,
        numOpens:       ev.type === "OPEN"  ? 1 : 0,
        numClicks:      ev.type === "CLICK" ? 1 : 0,
        replied:        false,
        filteredEvent:  ev.type === "OPEN" && ev.browser?.name === "unknown",
        sentAt:         null,
        openedAt:       ev.type === "OPEN"  ? ev.created : null,
        clickedAt:      ev.type === "CLICK" ? ev.created : null,
        contactId:      ev.contactId ? String(ev.contactId) : null,
        recipientEmail: ev.recipient || null,
        url:            ev.url || null,
      }));
  } catch (err) {
    console.error("Marketing email events fetch failed:", err.message);
    return [];
  }
}


// ─── Bot detection ────────────────────────────────────────────────────────────
// Bot/scanner opens have distinctive patterns -- we check multiple signals
// and assign confidence levels so we never filter out clicks or replies.
//
// Thresholds (based on industry research):
//   < 60 seconds to open  = almost certainly a security scanner (HIGH confidence)
//   < 5 minutes to open   = very likely a scanner (MEDIUM confidence)
//   Opens with no clicks  = soft signal (LOW confidence alone)
//   4+ opens, 0 clicks    = burst scan pattern (MEDIUM confidence)
//   Off-hours open        = soft signal (LOW confidence alone)

// ── OOO Detection ────────────────────────────────────────────────────────────
const OOO_SUBJECT_RE = /^(automatic reply|auto.?reply|autoreply|out of (the )?office|ooo\s*:|away from (the )?office|on vacation|on (annual |extended )?(leave|holiday)|not in (the )?office)/i;
const OOO_BODY_RE    = /(i('m| am) (currently )?(out|away|on vacation|on leave)|i('ll| will) (be )?(back|return)|out of (the )?office (until|on|from)|automatic(ally)? (reply|response)|will (return|be back) (on|by)|currently (unavailable|traveling|on leave)|on (maternity|paternity|medical|parental|bereavement) leave)/i;

// HubSpot note/email engagement bodies come back as raw HTML (e.g.
// `<div><p>Meeting notes...</p></div>`), not plain text. Every place that
// displays engagement body content needs this, or the UI shows literal
// "<div><p>" tags instead of the actual note. Regex-based rather than a DOM
// parser since this runs in a Node serverless function with no DOM
// available — good enough for HubSpot's fairly simple rich-text markup.
function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim() || null;
}

function isOooReply(subject, body) {
  if (OOO_SUBJECT_RE.test(subject || "")) return true;
  if (OOO_BODY_RE.test((body || "").slice(0, 1500))) return true;
  return false;
}

// ── Bounce / delivery-failure detection ──────────────────────────────────────
// HubSpot's own hs_email_last_reply_date / hs_sales_email_last_replied
// properties get set even when the "reply" is actually an automated bounce
// or delivery-failure notice — HubSpot doesn't distinguish these from real
// human replies on its own. Without this check, a bounced email reads as
// "they responded," which is exactly backwards for an enablement tool.
const BOUNCE_SUBJECT_RE = /^(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|delivery (has )?failed|message (could not be|was not) delivered|failure notice|undelivered mail|delivery incomplete|automatic reply.*undeliverable)/i;
const BOUNCE_BODY_RE    = /(mailer-daemon|postmaster@|the following recipient\(?s?\)? (could not|couldn't) be (reached|delivered)|your message (wasn't|was not) delivered|permanent failure|delivery (has )?failed|address (not found|rejected)|mailbox (unavailable|not found|full)|550 5\.\d\.\d)/i;

function isBounceReply(subject, body) {
  if (BOUNCE_SUBJECT_RE.test(subject || "")) return true;
  if (BOUNCE_BODY_RE.test((body || "").slice(0, 1500))) return true;
  return false;
}

// Single entry point for "is this actually a human reply, or something
// automated (OOO / bounce) that HubSpot's own reply-tracking can't tell
// apart from a real response." Every place in this file that treats a
// contact property or engagement as evidence of a genuine reply should run
// it through this first.
function isAutomatedReply(subject, body) {
  return isOooReply(subject, body) || isBounceReply(subject, body);
}

// Try to extract a return date phrase from OOO body (best-effort)
function parseOooReturnDate(body) {
  if (!body) return null;
  const text = body.slice(0, 1500);
  // Patterns like "I'll be back on July 15", "returning on Monday", "back in the office on X"
  const m = text.match(/(?:back|return(?:ing)?|available|in (?:the )?office)\s+(?:on|by|from)?\s*([A-Z][a-z]+ \d{1,2}(?:,?\s*\d{4})?|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*(?:,?\s*[A-Z][a-z]+ \d{1,2}(?:,?\s*\d{4})?)?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i);
  return m ? m[1].trim() : null;
}

function detectBot(item) {
  const reasons = [];

  // Normalize timestamps -- accept both ms numbers and ISO strings
  const toMs = (v) => {
    if (!v) return null;
    if (typeof v === "number") return v;
    const t = new Date(v).getTime();
    return isNaN(t) ? null : t;
  };

  const sentMs   = toMs(item.sentAt);
  const openedMs = toMs(item.openedAt);

  // 1. HubSpot's own bot filter flag (always high confidence)
  if (item.filteredEvent) {
    reasons.push("HubSpot flagged as bot/filtered event");
  }

  // 2. Time-to-open heuristics
  if (sentMs && openedMs && openedMs >= sentMs) {
    const secondsToOpen = (openedMs - sentMs) / 1000;
    if (secondsToOpen < 60) {
      // Under 60 seconds is almost always a security scanner
      reasons.push(`Opened ${secondsToOpen.toFixed(0)}s after send (scanner threshold: <60s)`);
    } else if (secondsToOpen < 300) {
      // Under 5 minutes is suspicious but lower confidence
      reasons.push(`Opened ${Math.round(secondsToOpen / 60)}m after send (suspicious: <5min)`);
    }
  }

  // 3. Opens with no clicks or reply (weak signal alone, strong combined)
  if (item.numOpens > 0 && item.numClicks === 0 && !item.replied) {
    reasons.push("Opened with no clicks or reply");
  }

  // 4. Burst pattern: only flag if opens came with suspicious TTO (scanner behavior)
  // numOpens > 1 on an engagement signal = accumulated genuine opens over time, NOT a bot
  // Realtime events always have numOpens === 1, so numOpens >= 4 only triggers on engagements
  // We intentionally skip this check — TTO checks above already catch true scanners
  // if (item.numOpens >= 4 && ...) { /* removed — false positives on repeated genuine openers */ }

  // 5. Off-hours open with no follow-on (weak signal)
  if (openedMs) {
    const hour = new Date(openedMs).getHours();
    if ((hour < 6 || hour > 22) && item.numClicks === 0 && !item.replied) {
      reasons.push("Opened outside business hours with no follow-on activity");
    }
  }

  // Confidence scoring:
  // Hard signals: HubSpot flag OR time-based (< 60s always hard, < 5min is medium)
  // Soft signals: everything else
  const hardSignals = reasons.filter(r =>
    r.includes("HubSpot flagged") || r.includes("scanner threshold")
  ).length;
  const medSignals = reasons.filter(r =>
    r.includes("suspicious") || r.includes("burst scan")
  ).length;
  const softSignals = reasons.length - hardSignals - medSignals;

  let confidence = "none";
  if (hardSignals >= 1)                          confidence = "high";
  else if (medSignals >= 1 || softSignals >= 2)  confidence = "medium";
  else if (softSignals === 1)                    confidence = "low";

  return { isBot: confidence === "high" || confidence === "medium", confidence, reasons };
}


// ─── Signal scoring ───────────────────────────────────────────────────────────

function scoreAllSignals(feedItems, includeBots = false) {
  const real = [];
  const bots = [];

  for (const item of feedItems) {
    let score = 0;
    let label = "";

    if ((item.source === "engagement" && item.type === "EMAIL") ||
         item.source === "marketing_email") {
      if (item.replied)            { score = 100; label = "Replied"; }
      else if (item.numClicks > 0) {
        score = 70 + item.numClicks * 5;
        label = `Clicked link${item.numClicks > 1 ? ` ${item.numClicks}x` : ""}`;
      }
      else if (item.numOpens > 0)  {
        // Tiered scoring for repeated opens — accumulated engagement opens are a strong signal
        if (item.numOpens >= 5) {
          score = 100 + Math.min((item.numOpens - 5) * 2, 20); // 5 opens = 100 (HP), caps at 120
        } else if (item.numOpens >= 3) {
          score = 80 + (item.numOpens - 3) * 5; // 3 = 80, 4 = 85
        } else {
          score = 40 + item.numOpens * 5; // 1 = 45, 2 = 50
        }
        label = `Opened${item.numOpens > 1 ? ` ${item.numOpens}×` : ""}`;
      }
      else continue;

      const botCheck = detectBot(item);
      const signal   = { ...item, score, label, botCheck };

      if (botCheck.isBot && item.numClicks === 0 && !item.replied) {
        bots.push(signal);
      } else {
        real.push(signal);
      }
      continue;
    }

    if (item.source === "sequence") {
      if (item.state === "FINISHED")    { score = 50; label = `Completed sequence: ${item.subject}`; }
      else if (item.state === "ACTIVE") { score = 20; label = `In sequence: ${item.subject} (step ${item.currentStep || "?"})`; }
      else continue;
      real.push({ ...item, score, label, botCheck: null });
      continue;
    }

    if (item.source === "lifecycle") {
      score = 45; label = item.subject;
      real.push({ ...item, score, label, botCheck: null });
      continue;
    }

    if (item.source === "timeline") {
      score = 15; label = item.subject || item.eventType || "Activity";
      real.push({ ...item, score, label, botCheck: null });
      continue;
    }

    if (item.source === "engagement") {
      // Only score actual engagement types -- never show raw type strings as subject
      const typeLabel = {
        CALL:    "Call logged",
        MEETING: "Meeting logged",
        NOTE:    "Note logged",
        TASK:    "Task",
      };
      label = typeLabel[item.type] || item.type;
      if (item.subject) label += `: ${item.subject}`;
      score = 25;
      real.push({ ...item, score, label, botCheck: null });
    }
  }

  real.sort((a, b) => b.score - a.score);
  bots.sort((a, b) => b.score - a.score);
  return { real, bots };
}


// ─── OAuth callback (no auth required) ───────────────────────────────────────

async function handleOAuthCallback(event) {
  const qp     = event.queryStringParameters || {};
  const code   = qp.code;
  const userId = qp.state;

  if (!code || !userId) return error(400, "Missing code or state");

  const res = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     HS_CLIENT_ID,
      client_secret: HS_CLIENT_SECRET,
      redirect_uri:  HS_REDIRECT_URI,
      code,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("HubSpot token exchange failed:", errText);
    return error(400, "Token exchange failed");
  }

  const data = await res.json();

  await setTokens(userId, {
    hubspot: {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
    },
  });

  return {
    statusCode: 302,
    headers: {
      Location:                      process.env.APP_URL + "?connected=hubspot",
      "Access-Control-Allow-Origin": "*",
    },
    body: "",
  };
}


async function computeTaskQueue(user, qp) {
    const days    = Math.min(parseInt(qp.days || "14", 10), 30);
    const now     = Date.now();
    const sinceISO    = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    const windowEnd   = new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
    const overdueFrom = new Date(now - 30  * 24 * 60 * 60 * 1000).toISOString(); // was 90 — stale auto-generated tasks don't need that long a tail

    const customFilters = buildCustomFilters(qp); // picks up assigned_bdr, territory etc.

    // ── Section 1: Replies awaiting response ───────────────────────────────
    // Logic: find contacts where a reply exists in the window AND no outbound
    // activity was sent AFTER the reply BY ANYONE (not just the selected rep).
    //
    // Owner-aware: fetch hubspot_owner_id on each contact. If the contact owner
    // (AE) sent activity after the reply, exclude it -- AE is handling it.
    // Selected rep filter (assigned_bdr) determines whose queue we're showing.

    // Build owner ID lookup from the known owner list for the portal
    const OWNER_NAME_TO_ID = {};
    try {
      const ownersData = await hsGet(user.userId, "/crm/v3/owners", { limit: 100 });
      for (const o of (ownersData.results || [])) {
        const name = `${o.firstName||""} ${o.lastName||""}`.trim();
        if (name) OWNER_NAME_TO_ID[name] = String(o.id);
      }
    } catch { /* use empty map */ }

    // assigned_bdr: comma-separated BDR names
    // owner_id: comma-separated owner IDs for non-BDR members
    const assignedBdrList = qp.assigned_bdr
      ? decodeURIComponent(qp.assigned_bdr).split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const ownerIdList = qp.owner_id
      ? String(qp.owner_id).split(',').map(s => s.trim()).filter(Boolean)
      : [];

    // All selected owner IDs (from both bdr names and direct owner_id param)
    const selectedOwnerIds = [
      ...assignedBdrList.map(name => OWNER_NAME_TO_ID[name]).filter(Boolean),
      ...ownerIdList,
    ];
    const selectedRepOwnerId = selectedOwnerIds.length === 1 ? selectedOwnerIds[0] : null;

    // Build filter groups for replies -- OR between assigned_bdr and hubspot_owner_id
    const replyFilterGroups = buildFilterGroups(qp).flatMap(g => [
      { filters: [{ propertyName: "hs_sales_email_last_replied", operator: "GTE", value: sinceISO }, ...g.filters] },
      { filters: [{ propertyName: "hs_email_last_reply_date",    operator: "GTE", value: sinceISO }, ...g.filters] },
    ]);

    const repliesData = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
      filterGroups: replyFilterGroups,
      properties: [
        ...BASE_CONTACT_PROPS,
        "hs_sales_email_last_replied",
        "hs_email_last_reply_date",
        "hs_last_sales_activity_timestamp",
        "hs_email_last_send_date",
        "notes_last_contacted",
        "hubspot_owner_id",
        "cipher_sequence_replies",
      ],
      sorts:  [{ propertyName: "hs_sales_email_last_replied", direction: "DESCENDING" }],
      limit:  200,
    }).catch(() => ({ results: [] }));

    // OOO/bounce detection now goes through the shared isAutomatedReply()
    // check (regex-based, covers both out-of-office AND bounce/delivery-
    // failure patterns) instead of a local substring list that only caught
    // OOO and missed bounces entirely.

    // Fetch incoming email subjects for reply contacts in one batch
    // so we can filter out OOO without N+1 queries
    const replyContactIds = (repliesData.results || []).map(c => c.id);
    let oooContactIds = new Set();
    let oooContactEmailDataFinal = {};
    // Contacts where an ACTUAL incoming email record exists in the window —
    // used to verify hs_sales_email_last_replied / hs_email_last_reply_date
    // before trusting them. These are HubSpot's own auto-computed contact
    // properties, and they can go stale or simply be wrong (a merged
    // contact inheriting an old value, a sync glitch, etc.) — trusting them
    // with zero corroboration means the queue can confidently show "replied
    // 74h ago" for a contact with no actual reply anywhere in their real
    // email history. This is populated below from a search that already
    // has to run anyway for OOO detection, so it's not an extra API call.
    let verifiedReplyContactIds = null;
    let realReplyByContact = {};
    if (replyContactIds.length > 0) {
      try {
        // Search for INCOMING_EMAIL engagements for these contacts with OOO-like subjects
        // We check all recent incoming emails for these contacts
        const incomingEmails = await hsPost(user.userId, "/crm/v3/objects/emails/search", {
          filterGroups: [{
            filters: [
              { propertyName: "hs_email_direction", operator: "EQ", value: "INCOMING_EMAIL" },
              { propertyName: "hs_timestamp", operator: "GTE", value: sinceISO },
            ]
          }],
          properties: ["hs_email_subject", "hs_email_text", "hs_timestamp"],
          sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
          limit: 200,
        }).catch(() => ({ results: [] }));

        // Verify reply claims: which contacts actually HAVE a real incoming
        // email in this window at all, regardless of OOO status. If a
        // contact's property says "replied" but no incoming email record
        // exists for them anywhere in the search results, that property is
        // not corroborated by anything retrievable — it shouldn't be
        // trusted at face value.
        try {
          const allIncomingIds = (incomingEmails.results || []).map(e => e.id);
          if (allIncomingIds.length > 0) {
            const allAssocData = await hsPost(user.userId, "/crm/v4/associations/emails/contacts/batch/read", {
              inputs: allIncomingIds.slice(0, 100).map(id => ({ id })),
            }).catch(() => ({ results: [] }));
            verifiedReplyContactIds = new Set();
            for (const r of (allAssocData.results || [])) {
              for (const assoc of (r.to || [])) {
                verifiedReplyContactIds.add(String(assoc.toObjectId));
              }
            }
          } else {
            verifiedReplyContactIds = new Set();
          }
        } catch { /* leave verifiedReplyContactIds null — skip verification rather than wrongly exclude everyone */ }

        // For contacts that ONLY have OOO replies (no real replies), mark as OOO
        // We do this by checking if subject starts with an OOO pattern
        // and cross-referencing with the reply contacts
        // Since we can't join easily, check subjects from results
        // and fetch associated contacts
        const oooEmailMap = {};
        const oooEmailIds = (incomingEmails.results || [])
          .filter(e => isAutomatedReply(e.properties?.hs_email_subject || "", e.properties?.hs_email_text || ""))
          .map(e => {
            oooEmailMap[e.id] = {
              subject:   e.properties?.hs_email_subject || null,
              body:      e.properties?.hs_email_text    || null,
              timestamp: e.properties?.hs_timestamp     || null,
            };
            return e.id;
          });

        if (oooEmailIds.length > 0) {
          // Get contact associations for OOO emails
          const assocData = await hsPost(user.userId, "/crm/v4/associations/emails/contacts/batch/read", {
            inputs: oooEmailIds.slice(0, 100).map(id => ({ id })),
          }).catch(() => ({ results: [] }));

          // Build set of contact IDs that have OOO emails
          const oooContactsWithOOO = new Set();
          const oooContactEmailData = {};
          for (const r of (assocData.results || [])) {
            const emailData = oooEmailMap[r.from?.id] || {};
            for (const assoc of (r.to || [])) {
              const cid = String(assoc.toObjectId);
              oooContactsWithOOO.add(cid);
              if (!oooContactEmailData[cid] || (emailData.timestamp > (oooContactEmailData[cid].timestamp||""))) {
                oooContactEmailData[cid] = emailData;
              }
            }
          }

          // Now fetch real (non-OOO, non-bounce) incoming emails for the same period
          const realEmails = await hsPost(user.userId, "/crm/v3/objects/emails/search", {
            filterGroups: [{
              filters: [
                { propertyName: "hs_email_direction", operator: "EQ", value: "INCOMING_EMAIL" },
                { propertyName: "hs_timestamp", operator: "GTE", value: sinceISO },
              ]
            }],
            properties: ["hs_email_subject", "hs_email_text", "hs_timestamp"],
            limit: 200,
          }).catch(() => ({ results: [] }));

          const realEmailMap = {};
          const realEmailIds = (realEmails.results || [])
            .filter(e => !isAutomatedReply(e.properties?.hs_email_subject || "", e.properties?.hs_email_text || ""))
            .map(e => {
              realEmailMap[e.id] = {
                subject:   e.properties?.hs_email_subject || null,
                timestamp: e.properties?.hs_timestamp     || null,
              };
              return e.id;
            });

          if (realEmailIds.length > 0) {
            const realAssocData = await hsPost(user.userId, "/crm/v4/associations/emails/contacts/batch/read", {
              inputs: realEmailIds.slice(0, 100).map(id => ({ id })),
            }).catch(() => ({ results: [] }));

            // Remove contacts from OOO list if they ALSO have a real reply,
            // AND track that real reply's own timestamp — this is the fix
            // for a specific, confirmed bug: hs_sales_email_last_replied
            // reflects whichever reply-like event happened LAST, even if
            // that's an OOO auto-response to something unrelated sent
            // AFTER a genuine older reply. A contact isn't excluded from
            // OOO status just because they have some real reply somewhere
            // in the window — but the score must use that real reply's
            // actual date, not the raw (possibly OOO-inflated) property.
            for (const r of (realAssocData.results || [])) {
              const emailData = realEmailMap[r.from?.id] || {};
              for (const assoc of (r.to || [])) {
                const cid = String(assoc.toObjectId);
                oooContactsWithOOO.delete(cid);
                if (!realReplyByContact[cid] || (emailData.timestamp > (realReplyByContact[cid].timestamp || ""))) {
                  realReplyByContact[cid] = emailData;
                }
              }
            }
          }

          oooContactIds         = oooContactsWithOOO;
          oooContactEmailDataFinal = oooContactEmailData;
        }
      } catch (e) {
        console.error("[tasks] OOO filter error:", e.message);
      }
    }

    // OOO replies — contacts that only sent OOO auto-replies
    const oooReplies = [...oooContactIds].map(cid => {
      const c = (repliesData.results || []).find(r => String(r.id) === cid);
      if (!c) return null;
      const p    = c.properties || {};
      const info = normalizeContact(c);
      const ed   = oooContactEmailDataFinal[cid] || {};
      const replyDate  = p.hs_sales_email_last_replied || p.hs_email_last_reply_date || null;
      const waitingHours = replyDate ? Math.round((Date.now() - new Date(replyDate).getTime()) / 3600000) : 0;
      return {
        contactId:    cid, contact: info, replyDate, waitingHours,
        subject:      ed.subject || null,
        oooReturnDate: parseOooReturnDate(ed.body || ed.subject || ""),
        replySource:  p.hs_sales_email_last_replied ? "sales" : "marketing",
      };
    }).filter(Boolean);

    const repliesAwaitingResponse = (repliesData.results || [])
      .map(c => {
        const p = c.properties || {};
        const salesReplyTs = p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0;
        const mktReplyTs   = p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0;
        let replyTs      = Math.max(salesReplyTs, mktReplyTs);
        if (replyTs === 0) return null;
        let replyDate = replyTs === salesReplyTs ? p.hs_sales_email_last_replied : p.hs_email_last_reply_date;
        let verifiedSubject = null;

        // If a real, verified reply exists for this contact, it wins over
        // the raw property — confirmed bug: the raw property reflects
        // whichever reply-like event happened LAST, which can be an OOO
        // auto-response to something sent well after a genuine older
        // reply. Using the raw property's date in that case massively
        // overstates urgency (a 9-day-old reply displayed as "3 hours
        // ago" because someone's auto-responder fired days later).
        const realReply = realReplyByContact[String(c.id)];
        if (realReply?.timestamp) {
          replyTs = new Date(realReply.timestamp).getTime();
          replyDate = realReply.timestamp;
          verifiedSubject = realReply.subject;
        }

        // Filter out contacts that only have OOO/auto-reply emails
        if (oooContactIds.has(String(c.id))) return null;

        // Filter out reply claims with no corroborating email record at
        // all. hs_sales_email_last_replied / hs_email_last_reply_date are
        // HubSpot's own auto-computed properties, and they can genuinely
        // go stale or wrong (e.g. after a contact merge) — if the property
        // says "replied" but no incoming email exists anywhere in the
        // window, that's not a real signal to act on.
        if (verifiedReplyContactIds !== null && !verifiedReplyContactIds.has(String(c.id))) return null;

        // Cross-check against cipher_sequence_replies — confirmed clean via
        // direct spot-checks against real email content (contacts with 2
        // and 9 recorded replies, zero OOO subjects found in either case).
        // This doesn't exclude anything on its own — it only covers
        // sequence-related replies, so a genuine reply to a non-sequence
        // 1:1 email would correctly show 0 here without being wrong. It's
        // a flag for lower confidence, not a hard filter.
        const sequenceReplyConfirmed = (parseInt(p.cipher_sequence_replies, 10) || 0) > 0;

        // Check if YOU manually responded after the reply
        const lastManualActivityTs = Math.max(
          p.notes_last_contacted ? new Date(p.notes_last_contacted).getTime() : 0,
        );

        // Only exclude if a manual activity (logged call, note, meeting) happened after reply
        if (lastManualActivityTs > replyTs) return null;

        // Get contact owner info
        const contactOwnerId   = p.hubspot_owner_id || null;
        const contactOwnerName = contactOwnerId
          ? Object.entries(OWNER_NAME_TO_ID).find(([, id]) => id === String(contactOwnerId))?.[0] || null
          : null;

        // For owner-based filtering (AEs): exclude contacts not owned by the selected rep.
        // Skip this check for BDR-name filtering — BDR contacts are owned by AEs, not Chris,
        // so hubspot_owner_id won't match. The assigned_bdr search filter already scoped correctly.
        if (ownerIdList.length > 0 && assignedBdrList.length === 0 && contactOwnerId && !selectedOwnerIds.includes(String(contactOwnerId))) {
          return null;
        }

        const info = normalizeContact(c);
        return {
          contactId:        c.id,
          contact:          info,
          replyDate,
          contactOwner:     contactOwnerName,
          isOwnedBySelected: selectedRepOwnerId ? String(contactOwnerId) === selectedRepOwnerId : false,
          lastOutboundDate: null, // lastActivityTs removed — manual activity no longer tracked here
          waitingHours:     Math.round((now - replyTs) / (1000 * 60 * 60)),
          subject:          verifiedSubject || p.hs_email_last_email_name || null,
          sequenceReplyConfirmed,
          url: `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
        };
      })
      .filter(Boolean)
      // Same interim precedence rule as Section 3 below: buildFilterGroups
      // ORs assigned_bdr with hubspot_owner_id, so a contact BDR'd to
      // someone else but owned by the current user would still match via
      // the owner branch. When assigned_bdr is set, it's authoritative.
      .filter(c => {
        if (assignedBdrList.length === 0) return true;
        const bdr = c.contact?.assignedBdr;
        return !bdr || assignedBdrList.includes(bdr);
      })
      .sort((a, b) => new Date(b.replyDate) - new Date(a.replyDate));

    // ── Section 2: Upcoming sequences (currently enrolled) ────────────────
    const seqFilterGroups = buildFilterGroups(qp, [
      { propertyName: "hs_sequences_is_enrolled", operator: "EQ", value: "true" },
    ]);
    const sequencesData = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
      filterGroups: seqFilterGroups,
      properties: BASE_CONTACT_PROPS,
      sorts:  [{ propertyName: "hs_latest_sequence_enrolled_date", direction: "ASCENDING" }],
      limit:  200,
    }).catch(() => ({ results: [] }));

    const upcomingSequences = (sequencesData.results || []).map(c => {
      const p    = c.properties || {};
      const info = normalizeContact(c);

      // Best signal state for this contact
      const salesReplyTs = p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0;
      const mktReplyTs   = p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0;
      const clickTs      = Math.max(
        p.hs_sales_email_last_clicked ? new Date(p.hs_sales_email_last_clicked).getTime() : 0,
        p.hs_email_last_click_date    ? new Date(p.hs_email_last_click_date).getTime()    : 0,
      );
      const openTs = Math.max(
        p.hs_sales_email_last_opened ? new Date(p.hs_sales_email_last_opened).getTime() : 0,
        p.hs_email_last_open_date    ? new Date(p.hs_email_last_open_date).getTime()    : 0,
      );
      const replyTs = Math.max(salesReplyTs, mktReplyTs);

      let signalLabel = "No recent activity";
      if (replyTs > 0) signalLabel = "Replied";
      else if (clickTs > 0) signalLabel = "Clicked link";
      else if (openTs  > 0) signalLabel = "Opened";

      return {
        contactId:        c.id,
        contact:          info,
        sequenceId:       p.hs_latest_sequence_enrolled      || null,
        sequenceLabel:    p.hs_latest_sequence_enrolled
          ? `Sequence #${p.hs_latest_sequence_enrolled}`
          : "Unknown sequence",
        enrolledDate:     p.hs_latest_sequence_enrolled_date || null,
        signal:           signalLabel,
        lastEmailName:    p.hs_email_last_email_name         || null,
        url: `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
      };
    })
    .filter(c => {
      if (assignedBdrList.length === 0) return true;
      const bdr = c.contact?.assignedBdr;
      return !bdr || assignedBdrList.includes(bdr);
    });

    // ── Section 3: Due tasks (HubSpot tasks with date window) ─────────────
    // Look up the current user's HubSpot owner ID for task filtering
    let ownerIdForTasks = user.ownerId || null;
    if (!ownerIdForTasks) {
      const me = await getMyHubSpotOwner(user.userId, user.email);
      ownerIdForTasks = me.id || null;
    }

    // If assigned_bdr filter is set, also look up that rep's owner ID
    const repName = qp.assigned_bdr ? decodeURIComponent(qp.assigned_bdr).trim() : null;
    let repOwnerId = ownerIdForTasks;
    if (repName) {
      try {
        const ownersData = await hsGet(user.userId, "/crm/v3/owners", { limit: 100 });
        const match = (ownersData.results || []).find(o =>
          `${o.firstName||""} ${o.lastName||""}`.trim() === repName
        );
        if (match?.id) repOwnerId = match.id;
      } catch { /* fall back to current user */ }
    }

    const taskOwnerFilter = repOwnerId
      ? [{ propertyName: "hubspot_owner_id", operator: "EQ", value: String(repOwnerId) }]
      : [];
    const [upcomingTasksData, overdueTasksData] = await Promise.all([
      hsPost(user.userId, "/crm/v3/objects/tasks/search", {
        filterGroups: [{
          filters: [
            ...taskOwnerFilter,
            { propertyName: "hs_task_status",   operator: "NOT_IN", values: ["COMPLETED", "DEFERRED"] },
            { propertyName: "hs_timestamp",     operator: "GTE",    value: new Date(now).toISOString() },
            { propertyName: "hs_timestamp",     operator: "LTE",    value: windowEnd },
          ],
        }],
        properties: ["hs_task_subject","hs_task_status","hs_task_type","hs_timestamp","hs_task_priority","hs_task_body","hubspot_owner_id"],
        sorts:  [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
        limit:  200,
      }).catch(() => ({ results: [] })),

      hsPost(user.userId, "/crm/v3/objects/tasks/search", {
        filterGroups: [{
          filters: [
            ...taskOwnerFilter,
            { propertyName: "hs_task_status",   operator: "NOT_IN", values: ["COMPLETED", "DEFERRED"] },
            { propertyName: "hs_timestamp",     operator: "GTE",    value: overdueFrom },
            { propertyName: "hs_timestamp",     operator: "LT",     value: new Date(now).toISOString() },
          ],
        }],
        properties: ["hs_task_subject","hs_task_status","hs_task_type","hs_timestamp","hs_task_priority","hs_task_body","hubspot_owner_id"],
        sorts:  [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
        limit:  200,
      }).catch(() => ({ results: [] })),
    ]);

    // Real batch association fetch — the associations param on the line
    // above never works (Search API confirmed to never return an
    // associations block, same issue already fixed for deals and
    // meetings elsewhere in this file). Every task was silently showing
    // with no contact/company attached because of this.
    const allTaskIds = [...(upcomingTasksData.results || []), ...(overdueTasksData.results || [])].map(t => t.id);
    const taskContactAssoc = await batchFetchAssociations(user.userId, "tasks", "contacts", allTaskIds);

    // ── Batch-fetch contacts associated with these tasks so the queue
    // can dedupe a task against other signals for the same contact ──────
    const taskContactIds = [...new Set(Object.values(taskContactAssoc).flat())];
    const taskContactMap = {};
    if (taskContactIds.length > 0) {
      try {
        const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
          properties: BASE_CONTACT_PROPS,
          inputs: taskContactIds.map(id => ({ id })),
        });
        (batch.results || []).forEach(c => { taskContactMap[c.id] = normalizeContact(c); });
      } catch { /* enrichment best-effort */ }
    }

    const normalizeTask = (t, overdue = false) => {
      const contactId = (taskContactAssoc[t.id] || [])[0] || null;
      return {
        id:       t.id,
        subject:  t.properties?.hs_task_subject  || "Untitled task",
        status:   t.properties?.hs_task_status   || "NOT_STARTED",
        type:     t.properties?.hs_task_type     || "TODO",
        dueDate:  t.properties?.hs_timestamp     || null,
        priority: t.properties?.hs_task_priority || "NONE",
        body:     t.properties?.hs_task_body     || null,
        overdue,
        contactId,
        contact: contactId ? (taskContactMap[contactId] || null) : null,
        url: `https://app.hubspot.com/tasks/39921549/view/all/task/${t.id}`,
      };
    };

    const dueTasks = [
      ...(overdueTasksData.results  || []).map(t => normalizeTask(t, true)),
      ...(upcomingTasksData.results || []).map(t => normalizeTask(t, false)),
    ]
      // The task query above only filters by hubspot_owner_id — it never
      // checks assigned_bdr at all. That's too permissive: an AE can be
      // the nominal account owner on a contact a BDR is actively working,
      // and this would pull that BDR's tasks into the AE's queue just
      // because of the ownership link. Interim rule until
      // primary_outreach_rep is live: when a contact HAS an assigned_bdr
      // value, that value is authoritative for whose task this is — an
      // owner-only match doesn't override it. A contact with no
      // assigned_bdr at all still matches on ownership alone, same as
      // before (covers inbound/direct-AE contacts with no BDR involved).
      .filter(t => {
        if (!repName) return true; // no rep scoping requested — leave as-is
        const bdr = t.contact?.assignedBdr;
        return !bdr || bdr === repName;
      });

    // ── Section 4: High sequence engagement (3+ opens on latest sequence) ─
    // Now built on cipher_sequence_opens_current — a new property that
    // resets to 0 on each fresh sequence enrollment (via a dedicated reset
    // workflow), unlike the original cipher_sequence_opens, which just
    // accumulates forever across every sequence a contact has ever been
    // in. Confirmed live and correct with real data: contacts enrolled in
    // a new sequence this week show current opens genuinely lower than
    // their lifetime total, proving the reset actually happened rather
    // than the two numbers just coincidentally matching.
    // This also means the recency gate from the previous version isn't
    // needed anymore — "3+ opens" now inherently means 3+ opens on
    // whatever sequence is most recent, not a stale count from months ago.
    const highEngagementFilterGroups = buildFilterGroups(qp, [
      { propertyName: "cipher_sequence_opens_current", operator: "GTE", value: "3" },
    ]);
    const highEngagementData = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
      filterGroups: highEngagementFilterGroups,
      properties: [...BASE_CONTACT_PROPS, "cipher_sequence_opens_current", "cipher_sequence_replies_current", "cipher_sequence_clicks_current", "cipher_sequence_opens", "cipher_sequence_last_open_date"],
      sorts: [{ propertyName: "cipher_sequence_last_open_date", direction: "DESCENDING" }],
      limit: 20,
    }).catch(() => ({ results: [] }));

    const highSequenceEngagement = (highEngagementData.results || [])
      .map(c => {
        const p = c.properties || {};
        const info = normalizeContact(c);
        const opens = parseInt(p.cipher_sequence_opens_current, 10) || 0;
        const lifetimeOpens = parseInt(p.cipher_sequence_opens, 10) || 0;
        return {
          id: `hiseq-${c.id}`,
          contactId: c.id,
          contact: info,
          opens,
          lifetimeOpens,
          replies: parseInt(p.cipher_sequence_replies_current, 10) || 0,
          clicks: parseInt(p.cipher_sequence_clicks_current, 10) || 0,
          lastOpenedAt: p.cipher_sequence_last_open_date || null,
          whyTag: `Opened ${opens} time${opens === 1 ? "" : "s"} on their latest sequence — no reply yet`,
          url: `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
        };
      })
      // Same assigned_bdr precedence rule as the other sections.
      .filter(c => {
        if (!repName) return true;
        const bdr = c.contact?.assignedBdr;
        return !bdr || bdr === repName;
      });

    return {
      repliesAwaitingResponse,
      oooReplies,
      upcomingSequences,
      dueTasks,
      highSequenceEngagement,
      meta: {
        days,
        counts: {
          repliesAwaitingResponse: repliesAwaitingResponse.length,
          upcomingSequences:       upcomingSequences.length,
          dueTasks:                dueTasks.length,
          overdueTasks:            (overdueTasksData.results || []).length,
        },
        filters: {
          assigned_bdr: qp.assigned_bdr || null,
          territory:    qp.territory    || null,
        },
      },
    };
}

export async function computeRightNowQueue(userId, qp = {}) {
    // ── Resolve whose queue this actually is, in HubSpot rep terms ────────
    // This is the real fix for a significant gap: computeTaskQueue only
    // filters by assigned_bdr/owner_id when the CALLER explicitly passes
    // those as query params — it never derived them from userId itself.
    // The live /right-now endpoint just forwarded whatever query string
    // came in (which never included these params from the frontend), and
    // /team/queue passed an empty qp entirely. The practical effect: every
    // person's "Right Now Queue" was actually showing portal-wide activity
    // and tasks, not their own — it looked fine for a single user testing
    // solo, but fell apart the moment a second person's queue was compared
    // against it, since both were really showing the same unfiltered data.
    const myOwner = await getMyHubSpotOwner(userId, null);
    const myOwnerId = myOwner.id;
    const myRepName = myOwner.id ? `${myOwner.firstName || ""} ${myOwner.lastName || ""}`.trim() : null;

    const scopedQp = {
      ...qp,
      assigned_bdr: qp.assigned_bdr || myRepName || undefined,
      owner_id: qp.owner_id || myOwnerId || undefined,
    };

    // Hard safety net: if identity resolution failed AND the caller didn't
    // explicitly supply their own scoping (qp.assigned_bdr/owner_id), do
    // NOT proceed with what would be an unscoped, portal-wide query. This
    // exact silent-fallthrough is what caused contacts belonging to other
    // reps to leak into someone else's queue. Failing to an empty queue is
    // safe; failing open to everyone's data is not.
    if (!scopedQp.assigned_bdr && !scopedQp.owner_id) {
      console.error(`[right-now] Could not resolve HubSpot identity for userId=${userId} — returning empty queue instead of an unscoped one.`);
      return [];
    }

    // ── Everything /tasks already knows how to compute ───────────────────
    const taskData = await computeTaskQueue({ userId }, scopedQp);

    // repliesAwaitingResponse already carries replyDate + contactId —
    // reshape into the exact signal shape scoreSignalForQueue expects so
    // it gets the same reply-aging treatment as a live signal would.
    const replySignals = (taskData.repliesAwaitingResponse || []).map(r => ({
      id: `reply-${r.contactId}`,
      type: "REPLY",
      timestamp: r.replyDate,
      score: 100,
      label: "Replied",
      contactId: r.contactId,
      contact: r.contact,
      sequenceReplyConfirmed: r.sequenceReplyConfirmed,
    }));

    // dueTasks map directly onto scoreTaskForQueue's expected shape —
    // contactId now comes from the task's HubSpot contact association,
    // so a task and a signal for the same person collapse into one line.
    const dueTasksForQueue = (taskData.dueTasks || []).map(t => ({
      id: t.id,
      dueDate: t.dueDate,
      contactId: t.contactId,
      contact: t.contact,
      subject: t.subject,
    }));

    // ── OOO follow-ups: fire a one-time to-do per contact, same
    // idempotency pattern as meeting confirmations, tracked in blob
    // since we never write this back to HubSpot ──────────────────────────
    const confirmedOooIds = await getConfirmedOooIds(userId);
    for (const ooo of (taskData.oooReplies || [])) {
      if (!confirmedOooIds.has(ooo.contactId)) {
        await addTodo(userId, {
          contactId: ooo.contactId,
          text: `Follow up with ${ooo.contact?.name || "contact"} — back from OOO${ooo.oooReturnDate ? ` around ${ooo.oooReturnDate}` : ""}`,
          autoDetected: true,
          priority: "HIGH",
          createdAt: new Date().toISOString(),
        });
        await addConfirmedOooId(userId, ooo.contactId, confirmedOooIds);
        confirmedOooIds.add(ooo.contactId);
      }
    }

    // ── Signals: same 15-minute realtime window as /signals/recent ──────
    const sinceMs = Date.now() - 15 * 60 * 1000;
    const eventsData = await hsGet(userId, "/email/public/v1/events", {
      startTimestamp: sinceMs,
      limit: 100,
    }).catch(() => ({ events: [] }));

    const rawEvents = (eventsData.events || [])
      .filter(ev => ["OPEN", "CLICK", "REPLY"].includes(ev.type));

    const eventContactIds = [...new Set(
      rawEvents.map(ev => ev.contactId ? String(ev.contactId) : null).filter(Boolean)
    )];

    // ── Meetings: HubSpot (last 3 days through next 14) ──────────────────
    // Everything meeting-related is wrapped in its own try/catch so a
    // failure here (bad data, an API hiccup, anything) can NEVER take down
    // the whole queue — signals, tasks, and todos must still return even if
    // meetings fail outright. This is a real lesson from this file: a bug
    // in meeting-handling has broken the entire Right Now Queue twice now,
    // and it should never have been able to do that in the first place.
    let myMeetings = [];
    let signals = [];
    let outlookSignals = [];
    try {
      const meetingWindowStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const meetingWindowEnd   = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      // Scope to the current user's own meetings. Reuses myOwnerId/myRepName
      // resolved once at the top of the function, instead of fetching
      // /owners/me a second time here.
      const meetingOwnerId = myOwnerId;
      const currentUserName = myRepName;

      // No owner filter here anymore — a meeting RECORD's own owner (often
      // whoever created/synced the calendar entry) is a different thing from
      // who the ACCOUNT actually belongs to. Filtering by meeting-owner was
      // both too strict (excluded genuine internal meetings the user attended
      // but didn't "own" in HubSpot) and wrong for account-based cases (a
      // meeting record can say "Joe" while the underlying contact is BDR-
      // assigned to someone else entirely). Real filtering happens below,
      // after matching each meeting to its contact.
      const meetData = await hsPost(userId, "/crm/v3/objects/meetings/search", {
        filterGroups: [{
          filters: [
            { propertyName: "hs_meeting_start_time", operator: "GTE", value: meetingWindowStart.toISOString() },
            { propertyName: "hs_meeting_start_time", operator: "LTE", value: meetingWindowEnd.toISOString() },
          ],
        }],
        properties: ["hs_meeting_title", "hs_meeting_start_time", "hs_meeting_end_time", "hubspot_owner_id", "hs_attendee_owner_ids"],
        limit: 100,
      }).catch(() => ({ results: [] }));

      const hsMeetingsRaw = meetData.results || [];
      // The Search API never returns an associations block (same confirmed
      // HubSpot limitation already fixed elsewhere for deals) — the old
      // `associations: ["contacts"]` param here was silently ignored, meaning
      // every HubSpot-logged meeting lost its contact link and showed with no
      // name/company attached. Real batch fetch instead.
      const meetingContactAssoc = await batchFetchAssociations(userId, "meetings", "contacts", hsMeetingsRaw.map(m => m.id));
      const meetingContactIds = [...new Set(Object.values(meetingContactAssoc).flat())];

      // ── Batch-fetch all contacts we need in one call (signals + meetings) ─
      const allContactIds = [...new Set([...eventContactIds, ...meetingContactIds])];
      const contactMap = {};
      const contactsByEmail = {};
      if (allContactIds.length > 0) {
        try {
          const batch = await hsPost(userId, "/crm/v3/objects/contacts/batch/read", {
            properties: BASE_CONTACT_PROPS,
            inputs: allContactIds.map(id => ({ id })),
          });
          (batch.results || []).forEach(c => {
            const info = normalizeContact(c);
            contactMap[c.id] = info;
            if (info.email) contactsByEmail[info.email.toLowerCase()] = info;
          });
        } catch { /* enrichment best-effort, same as /signals/recent */ }
      }

      // ── Build signals in the exact shape rightNowQueue.js expects ────────
      signals = rawEvents
        .map(ev => {
          const contactId = ev.contactId ? String(ev.contactId) : null;
          const contact = contactId ? (contactMap[contactId] || null) : null;
          const eventType = ev.type;
          let score = 0, label = "";
          if (eventType === "REPLY") {
            if (isAutomatedReply(ev.subject || null, null)) return null; // OOO or bounce, handled elsewhere (or not at all, for bounces)
            score = 100; label = "Replied";
          } else if (eventType === "CLICK") { score = 70; label = "Clicked link"; }
          else if (eventType === "OPEN")   { score = 40; label = "Opened"; }

          const botCheck = detectBot({
            filteredEvent: false, sentAt: null,
            openedAt: eventType === "OPEN" ? ev.created : null,
            numOpens: eventType === "OPEN" ? 1 : 0,
            numClicks: eventType === "CLICK" ? 1 : 0,
            replied: eventType === "REPLY",
          });
          if (botCheck.isBot && eventType === "OPEN") return null;

          return {
            id: `rt-${ev.id || ev.created}`,
            type: eventType,
            timestamp: ev.created || null,
            score, label, contactId, contact,
          };
        })
        .filter(Boolean)
        // This is the fix: signals had NO owner scoping at all before —
        // every rep's Right Now Queue was showing portal-wide activity
        // regardless of whose contacts they actually were. Keep only
        // signals for contacts that are actually this user's own (assigned
        // BDR, Primary Outreach Rep, or account owner). A signal whose
        // contact couldn't be matched to anyone is dropped rather than
        // shown — better to miss a rare edge case than leak someone
        // else's activity into the wrong person's queue.
        .filter(s => {
          const c = s.contact;
          if (!c) return false;
          return (
            (currentUserName && c.assignedBdr === currentUserName) ||
            (currentUserName && c.primaryOutreachRep === currentUserName) ||
            (meetingOwnerId && String(c.ownerId) === String(meetingOwnerId))
          );
        });

      // ── Attach contactId to each HubSpot meeting from its association ────
      const hsMeetings = hsMeetingsRaw.map(m => ({
        ...m,
        contactId: (meetingContactAssoc[m.id] || [])[0] || null,
      }));
      const hsMeetingMetaById = {};
      hsMeetingsRaw.forEach(m => {
        hsMeetingMetaById[m.id] = {
          ownerId: m.properties?.hubspot_owner_id || null,
          attendeeOwnerIds: String(m.properties?.hs_attendee_owner_ids || "").split(";").map(s => s.trim()).filter(Boolean),
        };
      });

      // ── Outlook meetings, same window ────────────────────────────────────
      const outlookEvents = await getOutlookCalendarEvents(userId, meetingWindowStart, meetingWindowEnd);

      // ── Outlook sent-email cross-reference ───────────────────────────────
      // Some outreach goes out through Outlook directly rather than HubSpot's
      // tracked send, which makes it invisible to HubSpot's own reply-awaiting
      // detection above. This pulls Outlook's sent-items (already fetched and
      // cached by outlook-emails.js) and flags anyone where the most recent
      // Outlook send is newer than any reply HubSpot knows about — i.e., a
      // real follow-up gap this app would otherwise miss entirely.
      outlookSignals = [];
      try {
        const outlookRes = await fetch(`${process.env.APP_URL}/api/outlook-emails?userId=${userId}&days=14`);
        if (outlookRes.ok) {
          const outlookData = await outlookRes.json();
          if (outlookData.connected) {
            for (const [email, sends] of Object.entries(outlookData.emails || {})) {
              const contact = contactsByEmail[email.toLowerCase()];
              if (!contact || !sends?.length) continue;
              const lastSend = sends.reduce((a, b) => new Date(a.sentAt) > new Date(b.sentAt) ? a : b);
              const lastKnownReply = contact.lastReplyDate ? new Date(contact.lastReplyDate) : null;
              if (!lastKnownReply || new Date(lastSend.sentAt) > lastKnownReply) {
                outlookSignals.push({
                  id: `outlook-sent-${contact.id}`,
                  contactId: contact.id,
                  contact,
                  subject: lastSend.subject,
                  sentAt: lastSend.sentAt,
                });
              }
            }
          }
        }
      } catch (e) { console.error("[right-now] Outlook cross-reference failed:", e.message); }

      // ── Merge, dedup, score ───────────────────────────────────────────────
      const mergedMeetings = mergeMeetings(hsMeetings, outlookEvents, contactMap, contactsByEmail);

      // Filter to meetings the current user actually scheduled or attends.
      // Deliberately NOT based on the matched contact's assigned_bdr/owner —
      // that field describes who's nominally responsible for the account,
      // which can be stale or simply not reflect who's really running a given
      // relationship (a colleague can be genuinely driving an account even
      // when a CRM field still lists someone else). Real participation is
      // the honest signal: did I schedule this meeting, or am I listed as
      // an attendee. Outlook events are trusted as-is — they only ever come
      // from the current user's own calendar via their own OAuth token, so
      // by definition they're already scoped to meetings involving them.
      myMeetings = mergedMeetings.filter(m => {
        if (m.source !== "hubspot") return true;
        const rawId = m.id.replace(/^hs-/, "");
        const meta = hsMeetingMetaById[rawId];
        if (!meta) return true; // no meta available — don't silently hide it
        if (meetingOwnerId && String(meta.ownerId) === String(meetingOwnerId)) return true;
        if (meetingOwnerId && meta.attendeeOwnerIds.includes(String(meetingOwnerId))) return true;
        return false;
      });
    } catch (err) {
      console.error("[right-now] Meetings section failed, continuing without meetings:", err.message);
      myMeetings = [];
    }

    // Sequence-completion detection (a sequence quietly finishing with no
    // next step decided) used to run inline here on every single page load
    // — up to 30 contacts, 2 real HubSpot calls each, meaning up to 60 API
    // round-trips before the queue could even return. That's the real
    // source of the 5-10 second delay on opening/refreshing the Now tab.
    // Moved to checkSequenceCompletions() below, run hourly from the
    // scheduler instead — the resulting todo can be a few minutes late
    // without costing anyone anything, unlike page-load speed.

    // ── Confirmation to-do: fire once per meeting, 3 days out ────────────
    const confirmedIds = await getConfirmedMeetingIds(userId);
    for (const meeting of myMeetings) {
      meeting.confirmationTaskCreated = confirmedIds.has(meeting.id);
      if (needsConfirmationTask(meeting)) {
        const todo = buildConfirmationTodo(meeting);
        await addTodo(userId, todo);
        await addConfirmedMeetingId(userId, meeting.id, confirmedIds);
        confirmedIds.add(meeting.id);
        meeting.confirmationTaskCreated = true;
      }
    }

    // ── To-dos ────────────────────────────────────────────────────────────
    const todos = await getTodos(userId);
    const highSequenceEngagement = taskData.highSequenceEngagement || [];

    const queue = buildRightNowQueue({
      signals: [
        ...signals,
        ...replySignals,
        ...outlookSignals.map(o => ({
          id: o.id,
          type: "SENT_NO_REPLY", // NOT "REPLY" — this is outbound (we sent, no response), scored/labeled accordingly
          timestamp: o.sentAt,
          score: 70, // slightly below a real inbound reply (100) — this is "we reached out", not "they responded"
          label: `Sent via Outlook: ${o.subject || "no subject"}`,
          contactId: o.contactId,
          contact: o.contact,
        })),
      ],
      tasks: dueTasksForQueue,
      todos,
      meetings: myMeetings.map(m => ({
        id: m.id,
        startTime: m.startTime,
        endTime: m.endTime,
        contactId: m.contactId,
        contact: m.contact,
        subject: m.subject,
      })),
    });

    // ── Enrich contacts with real company links and last-sequence info ────
    // normalizeContact's "company" field is a free-text property, not an
    // actual linked company record — there's no ID there to build a
    // HubSpot link from. This does one batch fetch for real company
    // associations across every contact referenced in the queue, plus one
    // batch fetch for each contact's most recent sequence enrollment.
    const queueContactIds = [...new Set([
      ...queue.map(item => item.contactId),
      ...highSequenceEngagement.map(item => item.contactId),
    ].filter(Boolean))];
    if (queueContactIds.length > 0) {
      try {
        const contactCompanyAssoc = await batchFetchAssociations(userId, "contacts", "companies", queueContactIds);
        const allCompanyIds = [...new Set(Object.values(contactCompanyAssoc).flat())];
        const companyNamesById = {};
        if (allCompanyIds.length > 0) {
          for (let i = 0; i < allCompanyIds.length; i += 100) {
            const chunk = allCompanyIds.slice(i, i + 100);
            const batch = await hsPost(userId, "/crm/v3/objects/companies/batch/read", {
              inputs: chunk.map(id => ({ id })),
              properties: ["name"],
            }).catch(() => ({ results: [] }));
            (batch.results || []).forEach(c => { companyNamesById[c.id] = c.properties?.name || null; });
          }
        }

        // Live owner lookup (not a hardcoded rep list) so this doesn't need
        // manual updates when new BDRs join — one call, cheap, already the
        // same pattern used elsewhere in this file.
        const ownersData = await hsGet(userId, "/crm/v3/owners", { limit: 100 }).catch(() => ({ results: [] }));
        const ownerNamesById = {};
        (ownersData.results || []).forEach(o => {
          ownerNamesById[String(o.id)] = `${o.firstName || ""} ${o.lastName || ""}`.trim();
        });

        const enrichContact = (item) => {
          if (!item.contactId || !item.contact) return;
          const companyId = (contactCompanyAssoc[item.contactId] || [])[0] || null;
          item.contact = {
            ...item.contact,
            companyId,
            companyName: companyId ? (companyNamesById[companyId] || item.contact.company) : (item.contact.company || null),
            contactUrl: `https://app.hubspot.com/contacts/39921549/record/0-1/${item.contactId}`,
            companyUrl: companyId ? `https://app.hubspot.com/contacts/39921549/record/0-2/${companyId}` : null,
            ownerName: item.contact.ownerId ? (ownerNamesById[String(item.contact.ownerId)] || null) : null,
          };
        };
        queue.forEach(enrichContact);
        highSequenceEngagement.forEach(enrichContact);
      } catch (err) {
        console.error("[right-now] Contact/company enrichment failed, continuing with unenriched contacts:", err.message);
      }
    }

    // Attached as a property on the array itself, not a change to the
    // return shape — every existing caller (the live endpoint, /team/queue,
    // /top5/regenerate, the scheduler) expects a plain array back and uses
    // array methods on it directly. An array is still an object in JS, so
    // this is fully backward compatible while still letting new code
    // (the /right-now endpoint) pick up the new section when it wants to.
    queue.highSequenceEngagement = highSequenceEngagement;
    return queue;
}

// Real batch associations fetch. HubSpot's Search API never returns an
// associations block no matter what's passed to it — confirmed HubSpot
// behavior, documented as still true as of 2025 — so associations always
// need this separate call after searching, never the search request itself.
// Sequence-completion detection — extracted out of the live /right-now
// path (see comment above) so this runs on the hourly scheduler instead of
// costing every single page load up to 60 API calls. Self-contained: pulls
// its own upcomingSequences via computeTaskQueue rather than requiring the
// caller to already have it.
// Shared with top5-scheduler.js and the on-demand POST /top5/regenerate
// endpoint below — moved here so there's one implementation, not two
// copies that could drift apart.
export async function rankTop5WithClaude(candidates) {
  const prompt = `You are helping a B2B sales rep decide what to work on right now. Below are their highest-scoring queue items (contact, company, why it's flagged, and a formula-based score). Pick the true top 5 most important items to work RIGHT NOW, considering things the raw score might miss — deal size or stage, relationship risk, how multiple weaker signals might combine, or an account about to go cold. Respond with ONLY a JSON array, no other text, in this exact shape:
[{"id": "the item's id field", "rank": 1, "rationale": "one sentence, under 20 words, explaining why this ranks here"}]

Candidates:
${JSON.stringify(candidates.map(c => ({ id: c.id, name: c.contact?.name, company: c.contact?.company, whyTag: c.whyTag, score: c.queueScore })), null, 2)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("").trim();
  const cleaned = text.replace(/^```json\s*|\s*```$/g, "");
  return JSON.parse(cleaned);
}

export async function checkSequenceCompletions(userId) {
  try {
    const taskData = await computeTaskQueue({ userId }, {});
    const enrolledContacts = (taskData.upcomingSequences || []).slice(0, 30);
    const enrollmentResults = await Promise.all(
      enrolledContacts.map(c => fetchSequenceEnrollments(userId, c.contactId).catch(() => []))
    );
    const confirmedSequenceIds = await getConfirmedSequenceIds(userId);
    for (let i = 0; i < enrollmentResults.length; i++) {
      const contact = enrolledContacts[i];
      for (const enr of enrollmentResults[i]) {
        if (enr.state === "FINISHED" && !confirmedSequenceIds.has(enr.id)) {
          await addTodo(userId, {
            contactId: contact.contactId,
            text: `Sequence "${enr.subject}" ended for ${contact.contact?.name || "contact"} — decide next step`,
            autoDetected: true,
            priority: "HIGH",
            createdAt: new Date().toISOString(),
          });
          await addConfirmedSequenceId(userId, enr.id, confirmedSequenceIds);
          confirmedSequenceIds.add(enr.id);
        }
      }
    }
  } catch (err) {
    console.error("[checkSequenceCompletions] failed:", err.message);
  }
}

// Reliable replacement for /crm/v3/owners/me, which returns a hard 400
// ("Unable to parse value for path parameter: ownerId") on this portal's
// token — confirmed via direct testing, not a guess. Every place that used
// to call /owners/me was silently failing (caught by a try/catch, leaving
// the resolved identity as null), which meant every rep-scoping check
// built on top of it was never actually being applied. Matches by email
// against the full owners list (a working endpoint) instead. email is
// optional — when the caller only has a plain userId (e.g. inside
// computeTaskQueue/computeRightNowQueue, which don't carry the full user
// object), this falls back to the active-user registry.
async function getMyHubSpotOwner(cipherUserId, cipherEmail) {
  const empty = { id: null, firstName: null, lastName: null, email: null };
  let email = cipherEmail || null;
  if (!email) {
    try {
      const profiles = await getActiveUserProfiles();
      email = profiles.find(p => p.userId === cipherUserId)?.email || null;
    } catch { /* leave email null */ }
  }
  if (!email) return empty;
  try {
    const ownersData = await hsGet(cipherUserId, "/crm/v3/owners", { limit: 100 });
    const match = (ownersData.results || []).find(o => (o.email || "").toLowerCase() === email.toLowerCase());
    return match || empty;
  } catch {
    return empty;
  }
}

async function batchFetchAssociations(userId, fromType, toType, ids) {
  if (ids.length === 0) return {};
  const result = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const data = await hsPost(userId, `/crm/v4/associations/${fromType}/${toType}/batch/read`, {
      inputs: chunk.map(id => ({ id })),
    }).catch(() => ({ results: [] }));
    (data.results || []).forEach(r => {
      result[r.from?.id] = (r.to || []).map(t => t.toObjectId);
    });
  }
  return result;
}

// ─── Active user registry ───────────────────────────────────────────────────
// The Top 5 scheduled function has no logged-in user, so it needs some way
// to know which userIds exist. Rather than a separate onboarding step, every
// authenticated request quietly registers its own userId here (best-effort,
// never blocks the response). Scheduler reads this list once per run.
function activeUsersBlobUrl() {
  const sas = (AZURE_SAS_TOKEN || "").startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/active-users.json${sas}`;
}
async function registerActiveUser(userId, email) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN || !userId) return;
  try {
    const res = await fetch(activeUsersBlobUrl());
    const data = res.ok ? await res.json() : { userIds: [], profiles: {} };
    const profiles = data.profiles || {};
    const alreadyKnown = (data.userIds || []).includes(userId);
    const emailChanged = email && profiles[userId]?.email !== email;
    if (alreadyKnown && !emailChanged) return; // nothing new to write
    const updated = [...new Set([...(data.userIds || []), userId])];
    if (email) profiles[userId] = { email };
    await fetch(activeUsersBlobUrl(), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
      body: JSON.stringify({ userIds: updated, profiles }),
    });
  } catch (e) { console.error("[active-users] registration failed:", e.message); }
}
export async function getActiveUserProfiles() {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return [];
  try {
    const res = await fetch(activeUsersBlobUrl());
    if (!res.ok) return [];
    const data = await res.json();
    return (data.userIds || []).map(userId => ({ userId, email: data.profiles?.[userId]?.email || null }));
  } catch { return []; }
}
export async function getActiveUserIds() {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return [];
  try {
    const res = await fetch(activeUsersBlobUrl());
    if (!res.ok) return [];
    const data = await res.json();
    return data.userIds || [];
  } catch { return []; }
}

// ─── Pipeline Review stage config ───────────────────────────────────────────
// IMPORTANT: verified empirically against real deal data, not assumed from
// pipeline/stage names. The pipeline names in this portal are counterintuitive
// relative to their actual stage content:
//   - "New Business Opportunity Pipeline" (679336808) actually holds the
//     EARLY-funnel/outreach stages (Target Identified -> Meeting Completed).
//   - "New Business Deal Pipeline" (678610513) actually holds the LATE-stage
//     opportunity stages (Qualified -> Contracting/Legal) — what most people
//     would intuitively call the "Opportunity" pipeline.
// Don't "fix" this to match what the names imply — it would silently put
// deals in the wrong bucket. This mapping matches what's actually in HubSpot.
const PIPELINE_STAGES = {
  "679336808": {
    label: "New Business Opportunity Pipeline",
    stages: [
      { id: "995708483",  label: "Target Identified" },
      { id: "995708484",  label: "Initial Outreach/Reengaged" },
      { id: "1284036410", label: "Email Opened/No Response" },
      { id: "1288757038", label: "Reengagement Needed" },
      { id: "995708485",  label: "Engaged" },
      { id: "995708486",  label: "Meeting Scheduled" },
      { id: "995708487",  label: "Meeting Completed" },
      { id: "995708488",  label: "Qualified (Deal Pipeline)" },
      { id: "995708489",  label: "Unengaged" },
      { id: "996311842",  label: "Trade Show Meeting Follow-Up" },
      { id: "1331037807", label: "Meeting Completed - Not A Fit" },
      { id: "1331034125", label: "Meeting Completed - Partnership Opportunity" },
    ],
    closedStages: ["1347324753"],
  },
  "678610513": {
    label: "New Business Deal Pipeline",
    stages: [
      { id: "995756094", label: "Qualified" },
      { id: "995756095", label: "Problem Solution Fit" },
      { id: "995756096", label: "Value Prop/Scoping" },
      { id: "995756097", label: "Pricing Proposal" },
      { id: "995756098", label: "IT/Technical Review" },
      { id: "995756099", label: "Contracting/Legal" },
      { id: "995750000", label: "Revisit" },
    ],
    closedStages: ["995749999", "995756100"],
  },
  "679502246": {
    label: "Expansion Deal Pipeline",
    stages: [
      { id: "995723921",  label: "Expansion Targets" },
      { id: "995723922",  label: "Engaged" },
      { id: "995723923",  label: "Value Prop/Scoping" },
      { id: "995723924",  label: "Pricing Proposal" },
      { id: "995723926",  label: "Procurement/Contracting" },
      { id: "1004627778", label: "Revist" },
    ],
    closedStages: ["995739776", "995723927"],
  },
};

// ─── Main router ──────────────────────────────────────────────────────────────

export const handler = async (event, context) => {
  const rawPath = (event.path || "")
    .replace("/.netlify/functions/hubspot", "")
    .replace("/api/hubspot", "");

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod === "GET" && rawPath === "/auth/callback") {
    return handleOAuthCallback(event);
  }

  return withAuth(async (event, context, user) => {
    registerActiveUser(user.userId, user.email); // best-effort, not awaited — never blocks the response
    const path   = rawPath;
    const method = event.httpMethod;

    // Parse query params from every possible Netlify source.
    // Log all sources so we can see what's actually available.
    const qpFromParams  = event.queryStringParameters || {};
    const qpFromMulti   = event.multiValueQueryStringParameters || {};
    const rawQuery      = event.rawQuery || "";
    const rawUrl        = event.rawUrl   || "";

    // Try rawQuery first (most reliable on Netlify), fall back to queryStringParameters
    let qp = {};
    if (rawQuery) {
      try {
        qp = Object.fromEntries(new URLSearchParams(rawQuery).entries());
      } catch { qp = {}; }
    }
    if (Object.keys(qp).length === 0 && rawUrl.includes("?")) {
      try {
        qp = Object.fromEntries(new URL(rawUrl).searchParams.entries());
      } catch { qp = {}; }
    }
    if (Object.keys(qp).length === 0) {
      qp = qpFromParams;
    }

    console.log(`[router] path=${path} rawQuery="${rawQuery}" qpKeys=${JSON.stringify(Object.keys(qp))} assigned_bdr="${qp.assigned_bdr || "(none)"}`);

    // ── OAuth: start connect ─────────────────────────────────────────────────
    if (method === "GET" && path === "/auth/connect") {
      const url = new URL("https://app.hubspot.com/oauth/authorize");
      url.searchParams.set("client_id",    HS_CLIENT_ID);
      url.searchParams.set("redirect_uri", HS_REDIRECT_URI);
      url.searchParams.set("scope",        HS_SCOPES);
      url.searchParams.set("state",        user.userId);
      return ok({ authUrl: url.toString() });
    }

    // ── Connection status ────────────────────────────────────────────────────
    if (method === "GET" && path === "/status") {
      const tokens = await getTokens(user.userId);
      return ok({
        hubspot:   !!tokens.hubspot?.access_token,
        microsoft: !!tokens.microsoft?.access_token,
      });
    }

    // ── Owners (reps) list ───────────────────────────────────────────────────
    // Returns all HubSpot users with their owner IDs for the filter dropdown.
    //
    // IMPORTANT for filter usage: the assigned_bdr contact property stores the
    // rep's display name as a plain string (e.g. "Chris Knapp"), NOT the numeric
    // owner ID. When filtering contacts by rep, pass filterValue (the name string)
    // as the assigned_bdr query param -- NOT the numeric id.
    //
    // Example: GET /hubspot/signals?assigned_bdr=Chris+Knapp  ✓
    //          GET /hubspot/signals?assigned_bdr=78304576     ✗ (will return 0 results)
    if (method === "GET" && path === "/owners") {
      const data = await hsGet(user.userId, "/crm/v3/owners", { limit: 100 });
      const owners = (data.results || []).map(o => ({
        id:          o.id,
        firstName:   o.firstName || "",
        lastName:    o.lastName  || "",
        email:       o.email     || "",
        name:        `${o.firstName || ""} ${o.lastName || ""}`.trim(),
        // filterValue is what to send as ?assigned_bdr= when filtering contacts.
        // It matches the string stored in the assigned_bdr contact property.
        filterValue: `${o.firstName || ""} ${o.lastName || ""}`.trim(),
      }));
      return ok({ owners });
    }

    // ── Contacts list (with custom property filters, paginated up to 500) ───────
    if (method === "GET" && path === "/contacts") {
      try {
        const baseFilters  = buildCustomFilters(qp);
        const filterGroups = buildFilterGroups(qp);
        // Always require firstname to exclude nameless records
        const nameFilter = { propertyName: "firstname", operator: "HAS_PROPERTY" };
        if (filterGroups.length > 0 && filterGroups[0].filters.length > 0) {
          filterGroups[0].filters.push(nameFilter);
        } else {
          filterGroups.push({ filters: [nameFilter] });
        }
        let contacts = [];

        if (filterGroups.length > 0 && filterGroups[0].filters.length > 0) {
          let after = undefined;
          while (contacts.length < 500) {
            const body = {
              filterGroups,
              properties:   BASE_CONTACT_PROPS,
              sorts:        [{ propertyName: "lastname", direction: "ASCENDING" }],
              limit:        100,
            };
            if (after) body.after = after;
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", body);
            contacts.push(...(data.results || []));
            if (!data.paging?.next?.after || (data.results || []).length < 100) break;
            after = data.paging.next.after;
          }
        } else {
          let after = undefined;
          while (contacts.length < 500) {
            const params = {
              limit:      100,
              properties: BASE_CONTACT_PROPS.join(","),
            };
            if (after) params.after = after;
            const data = await hsGet(user.userId, "/crm/v3/objects/contacts", params);
            contacts.push(...(data.results || []));
            if (!data.paging?.next?.after || (data.results || []).length < 100) break;
            after = data.paging.next.after;
          }
        }

        // Get accurate total count from HubSpot (not capped by our 500 fetch limit)
        let hsTotal = contacts.length;
        try {
          const countBody = { filterGroups: filterGroups.length > 0 && filterGroups[0].filters.length > 0 ? filterGroups : [{ filters: [] }], properties: ["hs_object_id"], limit: 1 };
          const countData = await hsPost(user.userId, "/crm/v3/objects/contacts/search", countBody);
          hsTotal = countData.total || contacts.length;
        } catch { /* fall through to contacts.length */ }
        return ok({ contacts, total: hsTotal });
      } catch (err) {
        console.error("[contacts] Error:", err.message);
        return error(500, `Contacts error: ${err.message}`);
      }
    }

    // ── Single contact ───────────────────────────────────────────────────────
    if (method === "GET" && path.startsWith("/contacts/")) {
      const id = path.split("/contacts/")[1];
      const [contact, engagements] = await Promise.all([
        hsGet(user.userId, `/crm/v3/objects/contacts/${id}`, {
          properties:   BASE_CONTACT_PROPS.join(","),
          associations: "deals,engagements",
        }),
        fetchEngagements(user.userId, id, 20),
      ]);
      const contactEmail = contact.properties?.email;
      const [lastMeeting, sequenceEnrollments] = await Promise.all([
        findLastMeeting(user.userId, engagements, [contactEmail]),
        fetchSequenceEnrollments(user.userId, id).catch(() => []),
      ]);
      const lastSequenceName = sequenceEnrollments.length > 0
        ? sequenceEnrollments.sort((a, b) => new Date(b.enrolledAt || 0) - new Date(a.enrolledAt || 0))[0].subject || null
        : null;
      return ok({ contact, engagements, lastMeeting, lastSequenceName });
    }

    // ── Full merged activity feed for a contact ──────────────────────────────
    if (method === "GET" && path.startsWith("/feed/") && path !== "/feed/team") {
      const contactId = path.split("/feed/")[1];
      const sources   = (qp.sources || "engagements,timeline,sequences,lifecycle").split(",");

      const [engagements, timelineEvents, sequences, lifecycle] = await Promise.all([
        sources.includes("engagements") ? fetchEngagements(user.userId, contactId)         : Promise.resolve([]),
        sources.includes("timeline")    ? fetchTimelineEvents(user.userId, contactId)      : Promise.resolve([]),
        sources.includes("sequences")   ? fetchSequenceEnrollments(user.userId, contactId) : Promise.resolve([]),
        sources.includes("lifecycle")   ? fetchLifecycleHistory(user.userId, contactId)    : Promise.resolve([]),
      ]);

      const feed       = mergeFeed(engagements, timelineEvents, sequences, lifecycle);
      const typeFilter = qp.types ? qp.types.split(",") : null;
      const filtered   = typeFilter ? feed.filter((item) => typeFilter.includes(item.type)) : feed;

      return ok({
        feed: filtered,
        meta: {
          total: filtered.length,
          bySource: {
            engagements:    engagements.length,
            timelineEvents: timelineEvents.length,
            sequences:      sequences.length,
            lifecycle:      lifecycle.length,
          },
        },
      });
    }

    // ── Task Queue (three smart sections) ────────────────────────────────────
    // Returns a unified smart task queue with three sections:
    //
    //   1. repliesAwaitingResponse -- contacts who replied to any email within the
    //      day window but have had no outbound activity logged since that reply.
    //      Detection: hs_sales_email_last_replied > hs_last_sales_activity_timestamp
    //               OR hs_email_last_reply_date   > hs_last_sales_activity_timestamp
    //      Filterable by assigned_bdr so each rep sees their own queue.
    //
    //   2. upcomingSequences -- contacts currently enrolled in a sequence
    //      (hs_sequences_is_enrolled = true), full contact card + sequence info.
    //      Sorted by sequence enrolled date ascending (oldest enrollment first).
    //
    //   3. dueTasks -- open HubSpot tasks within the day window + overdue tasks.
    //      Same as the previous /tasks implementation.
    //
    // Query params:
    //   days=7|14|21|30     (default: 14) -- applies to all three sections
    //   assigned_bdr=name   (optional)    -- filters replies and sequences by rep

    if (method === "GET" && path === "/tasks") {
      try {
        const data = await computeTaskQueue(user, qp);
        return ok(data);
      } catch (err) {
        console.error("[tasks] Error:", err.message);
        return error(500, `Tasks error: ${err.message}`);
      }
    }

    // ── Gold Accounts panel ───────────────────────────────────────────────────
    // Priority Tier - BDR lives on the COMPANY object, not contacts.
    // Actual enum values use dashes: "GOLD - 1-10", "GOLD - 11-20", etc.
    //
    // Strategy:
    //   1. Search companies where priority_tier__bdr is any GOLD value
    //   2. Filter by assigned_bdr on the company if provided
    //   3. Fetch associated contacts for each company (up to 3 per company)
    //   4. Merge company tier + signal data from associated contacts
    //
    // Query params:
    //   assigned_bdr=Chris+Knapp   (filters companies by their assigned BDR)
    //   limit=N                    (default: 100 companies, max: 200)
    if (method === "GET" && path === "/gold") {
      try {
        const limit = Math.min(parseInt(qp.limit || "100", 10), 200);

        // Actual enum values from HubSpot -- dashes between GOLD and range
        const GOLD_TIERS = [
          "GOLD - 1-10","GOLD - 11-20","GOLD - 21-30","GOLD - 31-40","GOLD - 41-50",
          "GOLD - 51-60","GOLD - 61-70","GOLD - 71-80","GOLD - 81-90","GOLD - 91-100",
        ];

        const companyFilters = [
          { propertyName: "priority_tier__bdr", operator: "IN", values: GOLD_TIERS },
        ];

        // Support owner_id filter for non-BDR reps
        const ownerIdFilter = qp.owner_id ? String(qp.owner_id).split(',').map(s => s.trim()).filter(Boolean) : [];
        if (qp.assigned_bdr) {
          companyFilters.push({
            propertyName: "assigned_bdr",
            operator:     qp.assigned_bdr.includes(',') ? "IN" : "EQ",
            ...(qp.assigned_bdr.includes(',')
              ? { values: qp.assigned_bdr.split(',').map(s => decodeURIComponent(s).trim()) }
              : { value:  decodeURIComponent(qp.assigned_bdr).trim() }),
          });
        }
        if (ownerIdFilter.length > 0 && !qp.assigned_bdr) {
          companyFilters.push({
            propertyName: "hubspot_owner_id",
            operator:     ownerIdFilter.length === 1 ? "EQ" : "IN",
            ...(ownerIdFilter.length === 1 ? { value: ownerIdFilter[0] } : { values: ownerIdFilter }),
          });
        }
        // Tier filter
        if (qp.tier) {
          const tierVals = qp.tier.split(',').map(s => decodeURIComponent(s).trim()).filter(Boolean);
          companyFilters[0] = { propertyName: "priority_tier__bdr", operator: "IN", values: tierVals };
        }

        // Paginate through Gold companies
        let goldCompanies = [];
        let after = undefined;
        while (goldCompanies.length < limit) {
          const body = {
            filterGroups: [{ filters: companyFilters }],
            properties: [
              "name", "domain", "industry", "city", "state", "assigned_bdr", "territory",
              "priority_tier__bdr", "target_account__bdr_led_outreach",
              "notes_last_contacted", "hs_last_sales_activity_timestamp",
              "hubspot_owner_id", "num_associated_contacts", "num_contacted_notes",
              "hs_last_logged_call_date", "hs_last_booked_meeting_date",
              "hs_last_logged_outgoing_email_date", "hs_lead_status",
            ],
            sorts:  [{ propertyName: "priority_tier__bdr", direction: "ASCENDING" }],
            limit:  100,
          };
          if (after) body.after = after;
          const data = await hsPost(user.userId, "/crm/v3/objects/companies/search", body);
          goldCompanies.push(...(data.results || []));
          if (!data.paging?.next?.after || (data.results || []).length < 100) break;
          after = data.paging.next.after;
        }

        if (goldCompanies.length === 0) {
          return ok({ accounts: [], meta: { total: 0, byTier: {}, filters: { assigned_bdr: qp.assigned_bdr || null } } });
        }

        // Fetch contacts for Gold accounts using two passes:
        // Pass 1: contacts WITH target_persona set (these are what the hierarchy map needs)
        // Pass 2: all other contacts up to a small limit for engagement/signal data
        // This ensures the hierarchy map always shows all tagged contacts regardless of total count
        // and returns all associated contact IDs -- 1 call instead of 68.
        // Then one batch contact read for all contact IDs -- 2 total API calls.
        const CONTACT_PROPS = [
          "firstname","lastname","email","jobtitle","company","assigned_bdr",
          "hs_email_last_open_date","hs_email_last_click_date",
          "hs_email_last_reply_date","hs_email_last_send_date","hs_email_last_email_name",
          "hs_sales_email_last_opened","hs_sales_email_last_clicked","hs_sales_email_last_replied",
          "notes_last_contacted","hs_persona","target_persona","hs_buying_role",
          "hs_sequences_is_enrolled","hs_lead_status",
        ];

        const bdrFilterValue = qp.assigned_bdr
          ? decodeURIComponent(qp.assigned_bdr).trim()
          : null;

        const contactsByCompany = {};
        try {
          // Step 1: batch fetch all associations for all Gold companies at once
          const companyIds = goldCompanies.map(c => c.id);
          const assocData  = await hsPost(user.userId, "/crm/v3/associations/companies/contacts/batch/read", {
            inputs: companyIds.map(id => ({ id })),
          });

          // Build map: companyId -> [contactId, ...]
          const companyContactIds = {};
          for (const result of (assocData.results || [])) {
            const companyId  = result.from?.id;
            // Keep all contact IDs — no arbitrary limit
            // Accounts with excessive contacts (e.g. from duplicate imports) will
            // batch-read up to 500 contacts; the sort below puts persona-tagged ones first
            const contactIds = (result.to || []).map(t => t.id).slice(0, 500);
            if (companyId && contactIds.length > 0) {
              companyContactIds[companyId] = contactIds;
            }
          }

          // Step 2: collect all unique contact IDs across all companies
          const allContactIds = [...new Set(Object.values(companyContactIds).flat())];
          if (allContactIds.length === 0) {
            console.log("[gold] no associated contacts found");
          } else {
            // Step 3: Batch read all contacts for this company batch
            const allContacts = {};
            for (let i = 0; i < allContactIds.length; i += 100) {
              const batchIds = allContactIds.slice(i, i + 100);
              const batchData = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
                properties: CONTACT_PROPS,
                inputs:     batchIds.map(id => ({ id })),
              }).catch(() => ({ results: [] }));
              for (const c of (batchData.results || [])) {
                allContacts[c.id] = c;
              }
              if (i + 100 < allContactIds.length) {
                await new Promise(r => setTimeout(r, 150));
              }
            }

            // Assign contacts back to companies, optionally filtering by BDR
            for (const [companyId, contactIds] of Object.entries(companyContactIds)) {
              const contacts = contactIds
                .map(id => allContacts[id])
                .filter(c => {
                  if (!c) return false;
                  if (bdrFilterValue) {
                    return c.properties?.assigned_bdr === bdrFilterValue;
                  }
                  return true;
                })
                // Sort: contacts with target_persona first, then by name
                .sort((a, b) => {
                  const aHas = !!(a.properties?.target_persona);
                  const bHas = !!(b.properties?.target_persona);
                  if (aHas && !bHas) return -1;
                  if (!aHas && bHas) return 1;
                  return 0;
                });
              if (contacts.length > 0) {
                contactsByCompany[companyId] = contacts;
              }
            }
            console.log(`[gold] matched contacts to ${Object.keys(contactsByCompany).length} of ${goldCompanies.length} companies`);
          }
        } catch (err) {
          console.error("[gold] contact fetch failed:", err.message);
          // Continue -- companies will show without contact detail
        }

        // Extract leading number from tier for numeric sort
        // "GOLD - 1-10" -> 1, "GOLD - 11-20" -> 11
        const tierRank = (tier) => {
          const match = (tier || "").match(/(\d+)/);
          return match ? parseInt(match[1], 10) : 999;
        };

        // Best signal across a company's contacts
        const companySignal = (contacts) => {
          let bestReplyTs = 0, bestClickTs = 0, bestOpenTs = 0;
          for (const c of contacts) {
            const p = c.properties || {};
            bestReplyTs = Math.max(bestReplyTs,
              p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0,
              p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0,
            );
            bestClickTs = Math.max(bestClickTs,
              p.hs_email_last_click_date    ? new Date(p.hs_email_last_click_date).getTime()    : 0,
              p.hs_sales_email_last_clicked ? new Date(p.hs_sales_email_last_clicked).getTime() : 0,
            );
            bestOpenTs = Math.max(bestOpenTs,
              p.hs_email_last_open_date    ? new Date(p.hs_email_last_open_date).getTime()    : 0,
              p.hs_sales_email_last_opened ? new Date(p.hs_sales_email_last_opened).getTime() : 0,
            );
          }
          if (bestReplyTs > 0) return { status:"replied", timestamp: new Date(bestReplyTs).toISOString(), label:"Replied" };
          if (bestClickTs > 0) return { status:"clicked", timestamp: new Date(bestClickTs).toISOString(), label:"Clicked" };
          if (bestOpenTs  > 0) return { status:"opened",  timestamp: new Date(bestOpenTs).toISOString(),  label:"Opened"  };
          return                      { status:"no_signal", timestamp: null, label:"No recent activity" };
        };

        const normalized = goldCompanies.map(company => {
          const p        = company.properties || {};
          const contacts = contactsByCompany[company.id] || [];
          const tier     = p.priority_tier__bdr || "";
          const signal   = companySignal(contacts);

          // Last sent: most recent send date across all contacts (no time window)
          let lastSentTs = 0, lastSentName = null, lastSentContact = null;
          for (const c of contacts) {
            const cp = c.properties || {};
            const ts = cp.hs_email_last_send_date ? new Date(cp.hs_email_last_send_date).getTime() : 0;
            if (ts > lastSentTs) {
              lastSentTs      = ts;
              lastSentName    = cp.hs_email_last_email_name || null;
              lastSentContact = `${cp.firstname||""} ${cp.lastname||""}`.trim();
            }
          }

          // Best engagement across all contacts (most recent reply > click > open)
          let lastEngagement = null;
          for (const c of contacts) {
            const cp = c.properties || {};
            const replyTs = Math.max(
              cp.hs_email_last_reply_date    ? new Date(cp.hs_email_last_reply_date).getTime()    : 0,
              cp.hs_sales_email_last_replied ? new Date(cp.hs_sales_email_last_replied).getTime() : 0,
            );
            const clickTs = Math.max(
              cp.hs_email_last_click_date    ? new Date(cp.hs_email_last_click_date).getTime()    : 0,
              cp.hs_sales_email_last_clicked ? new Date(cp.hs_sales_email_last_clicked).getTime() : 0,
            );
            const openTs = Math.max(
              cp.hs_email_last_open_date    ? new Date(cp.hs_email_last_open_date).getTime()    : 0,
              cp.hs_sales_email_last_opened ? new Date(cp.hs_sales_email_last_opened).getTime() : 0,
            );
            const contactName = `${cp.firstname||""} ${cp.lastname||""}`.trim();
            const best = replyTs > 0
              ? { type:"replied",  ts: replyTs,  label:"Replied",      date: new Date(replyTs).toISOString(),  contact: contactName }
              : clickTs > 0
              ? { type:"clicked",  ts: clickTs,  label:"Clicked link", date: new Date(clickTs).toISOString(),  contact: contactName }
              : openTs  > 0
              ? { type:"opened",   ts: openTs,   label:"Opened",       date: new Date(openTs).toISOString(),   contact: contactName }
              : null;
            if (best && (!lastEngagement || best.ts > lastEngagement.ts)) {
              lastEngagement = best;
            }
          }

          const allDates = [
            p.notes_last_contacted,
            p.hs_last_sales_activity_timestamp,
            lastSentTs > 0 ? new Date(lastSentTs).toISOString() : null,
            lastEngagement?.date,
          ].filter(Boolean).map(d => new Date(d).getTime());
          const lastActivityTs   = allDates.length > 0 ? Math.max(...allDates) : 0;
          const lastActivityDate = lastActivityTs > 0 ? new Date(lastActivityTs).toISOString() : null;

          // All 22 target personas from HubSpot -- each Gold account should have coverage
          const TARGET_PERSONAS = [
            { value:"Access/Patient Access",  label:"Access/Patient Access",  priority:"high" },
            { value:"Ambulatory/Urgent Care", label:"Ambulatory/Urgent Care", priority:"medium" },
            { value:"Business Development",   label:"Business Development",   priority:"medium" },
            { value:"Case Management",        label:"Case Management",        priority:"high" },
            { value:"Chief Clinical Officer", label:"Chief Clinical Officer", priority:"critical" },
            { value:"Clinical Operations",    label:"Clinical Operations",    priority:"high" },
            { value:"Emergency Department",   label:"Emergency Department",   priority:"medium" },
            { value:"Executive/Leadership",   label:"Executive/Leadership",   priority:"critical" },
            { value:"Finance",                label:"Finance",                priority:"high" },
            { value:"Innovation",             label:"Innovation",             priority:"medium" },
            { value:"Medical Group",          label:"Medical Group",          priority:"medium" },
            { value:"Medical",                label:"Medical Information",    priority:"medium" },
            { value:"Medical Officer",        label:"Medical Officer",        priority:"critical" },
            { value:"Nursing Officer",        label:"Nursing Officer",        priority:"critical" },
            { value:"Operating Officer",      label:"Operating Officer",      priority:"critical" },
            { value:"Patient Experience",     label:"Patient Experience",     priority:"high" },
            { value:"Physician Executive",    label:"Physician Executive",    priority:"critical" },
            { value:"Population Health",      label:"Population Health",      priority:"high" },
            { value:"Quality Officer",        label:"Quality Officer",        priority:"high" },
            { value:"Service Line",           label:"Service Line",           priority:"medium" },
            { value:"Strategy",               label:"Strategy",               priority:"high" },
            { value:"Value Based Care",       label:"Value Based Care",       priority:"high" },
          ];

          // Build persona coverage map: which personas are covered by contacts at this account
          const coveredPersonas = new Set(
            contacts
              .map(c => c.properties?.target_persona)
              .filter(Boolean)
              .flatMap(v => v.split(";").map(s => s.trim()))
          );

          // Gaps = personas with no contact assigned, sorted by priority
          const priorityOrder = { critical:0, high:1, medium:2 };
          const missingPersonas = TARGET_PERSONAS
            .filter(p => !coveredPersonas.has(p.value))
            .sort((a,b) => priorityOrder[a.priority] - priorityOrder[b.priority])
            .map(p => ({ value: p.value, label: p.label, priority: p.priority }));

          // Persona heatmap: for each persona, who is assigned and their engagement status
          const personaCoverage = TARGET_PERSONAS.map(persona => {
            const assigned = contacts.filter(c => {
              const val = c.properties?.target_persona || "";
              return val.split(";").map(s => s.trim()).includes(persona.value);
            });
            const hasReply = assigned.some(c =>
              c.properties?.hs_email_last_reply_date || c.properties?.hs_sales_email_last_replied
            );
            const hasSent = assigned.some(c => c.properties?.hs_email_last_send_date);
            return {
              persona: persona.value,
              label:   persona.label,
              priority: persona.priority,
              covered: assigned.length > 0,
              contacts: assigned.map(c => ({
                name:  `${c.properties?.firstname||""} ${c.properties?.lastname||""}`.trim(),
                title: c.properties?.jobtitle || "",
                replied: !!(c.properties?.hs_email_last_reply_date || c.properties?.hs_sales_email_last_replied),
                sent:    !!c.properties?.hs_email_last_send_date,
              })),
              engagement: assigned.length === 0 ? "none" : hasReply ? "replied" : hasSent ? "contacted" : "mapped",
            };
          });

          // Gap analysis: missing personas + engagement gaps
          const criticalGaps    = missingPersonas.filter(p => p.priority === "critical").length;
          const highGaps        = missingPersonas.filter(p => p.priority === "high").length;
          const personasWithNoEngagement = personaCoverage.filter(p => p.covered && p.engagement === "mapped").length;

          // Health score: 0-100
          let health = 0;
          const daysSinceActivity = lastActivityTs > 0
            ? Math.floor((Date.now() - lastActivityTs) / (1000 * 60 * 60 * 24))
            : 999;
          if (daysSinceActivity <= 7)  health += 35;
          else if (daysSinceActivity <= 14) health += 25;
          else if (daysSinceActivity <= 30) health += 15;
          else if (daysSinceActivity <= 60) health += 5;
          if (lastEngagement?.type === "replied") health += 30;
          else if (lastEngagement?.type === "clicked") health += 15;
          else if (lastEngagement?.type === "opened") health += 8;
          if (contacts.length >= 10) health += 15;
          else if (contacts.length >= 5) health += 10;
          else if (contacts.length >= 2) health += 5;
          if (p.hs_last_booked_meeting_date) health += 15;
          // Persona coverage bonus (up to 5 pts)
          const coveragePct = coveredPersonas.size / TARGET_PERSONAS.length;
          health += Math.round(coveragePct * 5);
          health = Math.min(100, health);

          const healthStatus = health >= 65 ? "active" : health >= 35 ? "attention" : health > 0 ? "risk" : "cold";

          return {
            id:              company.id,
            name:            p.name       || "",
            domain:          p.domain     || "",
            industry:        p.industry   || "",
            city:            p.city       || "",
            state:           p.state      || "",
            tier,
            tierRank:        tierRank(tier),
            assignedBdr:     p.assigned_bdr || "",
            ownerId:         p.hubspot_owner_id || "",
            territory:       p.territory    || "",
            leadStatus:      p.hs_lead_status || "",
            numContacts:     parseInt(p.num_associated_contacts || "0"),
            numNotes:        parseInt(p.num_contacted_notes || "0"),
            lastActivityDate,
            daysSinceActivity: daysSinceActivity < 999 ? daysSinceActivity : null,
            signal,
            health,
            healthStatus,
            missingPersonas:  missingPersonas.map(p => ({ value:p.value, label:p.label, priority:p.priority })),
            personaCoverage,
            criticalGaps,
            highGaps,
            personasWithNoEngagement,
            coveredPersonaCount: coveredPersonas.size,
            totalPersonas: TARGET_PERSONAS.length,
            lastBooked:      p.hs_last_booked_meeting_date || null,
            lastCall:        p.hs_last_logged_call_date || null,
            // Last send across all contacts
            lastSent: lastSentTs > 0 ? {
              date:    new Date(lastSentTs).toISOString(),
              subject: lastSentName,
              contact: lastSentContact,
            } : null,
            // Best engagement across all contacts (no time window)
            lastEngagement,
            contacts: contacts.map(c => {
              const cp = c.properties || {};
              return {
                id:           c.id,
                name:         `${cp.firstname||""} ${cp.lastname||""}`.trim(),
                title:        cp.jobtitle || "",
                email:        cp.email    || "",
                persona:      cp.target_persona || "",
                buyingRole:   cp.hs_buying_role || "",
                inSequence:   cp.hs_sequences_is_enrolled === "true",
                lastSent:     cp.hs_email_last_send_date || null,
                lastOpen:     cp.hs_email_last_open_date || cp.hs_sales_email_last_opened || null,
                lastReply:    cp.hs_email_last_reply_date || cp.hs_sales_email_last_replied || null,
                lastClick:    cp.hs_email_last_click_date || cp.hs_sales_email_last_clicked || null,
                emailName:    cp.hs_email_last_email_name || null,
                url:          `https://app.hubspot.com/contacts/39921549/record/0-1/${c.id}`,
              };
            }),
            url: `https://app.hubspot.com/contacts/39921549/record/0-2/${company.id}`,
          };
        });

        // Sort: tier rank ascending (GOLD - 1-10 first), then most recent activity
        normalized.sort((a, b) => {
          if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
          const dateA = a.lastActivityDate ? new Date(a.lastActivityDate).getTime() : 0;
          const dateB = b.lastActivityDate ? new Date(b.lastActivityDate).getTime() : 0;
          return dateB - dateA;
        });

        const byTier = {};
        normalized.forEach(c => { byTier[c.tier] = (byTier[c.tier] || 0) + 1; });

        // Aggregate portfolio stats
        const activeAccounts   = normalized.filter(a => a.healthStatus === "active").length;
        const atRiskAccounts   = normalized.filter(a => a.healthStatus === "risk" || a.healthStatus === "cold").length;
        const avgHealth        = normalized.length > 0 ? Math.round(normalized.reduce((s,a) => s + a.health, 0) / normalized.length) : 0;
        const withReplies      = normalized.filter(a => a.lastEngagement?.type === "replied").length;
        const noActivity30d    = normalized.filter(a => a.daysSinceActivity === null || a.daysSinceActivity > 30).length;
        const totalContacts    = normalized.reduce((s,a) => s + a.numContacts, 0);
        const totalCriticalGaps = normalized.reduce((s,a) => s + (a.criticalGaps||0), 0);
        const totalHighGaps     = normalized.reduce((s,a) => s + (a.highGaps||0), 0);
        const avgPersonaCoverage = normalized.length > 0
          ? Math.round(normalized.reduce((s,a) => s + (a.coveredPersonaCount||0), 0) / normalized.length)
          : 0;

        return ok({
          accounts: normalized,
          meta: {
            total: normalized.length,
            byTier,
            avgHealth,
            activeAccounts,
            atRiskAccounts,
            withReplies,
            noActivity30d,
            totalContacts,
            totalCriticalGaps,
            totalHighGaps,
            avgPersonaCoverage,
            totalPersonas: 22,
            filters: {
              assigned_bdr: qp.assigned_bdr || null,
              owner_id:     qp.owner_id     || null,
              tier:         qp.tier         || null,
            },
          },
        });
      } catch (err) {
        console.error("[gold] Error:", err.message);
        return error(500, `Gold accounts error: ${err.message}`);
      }
    }

    // ── Activity summary ──────────────────────────────────────────────────────
    // Returns outbound + inbound activity counts for a rolling date window.
    //
    // Query params:
    //   days=7|14|30|90         (default: 7)
    //   rep=Chris+Knapp|all     (default: "all" -- filter by assigned_bdr name, or all reps)
    //   include_owned=true      (optional -- also count contacts owned via hubspot_owner_id,
    //                            useful for AEs who want to see both BDR outreach + their own)
    //
    // Counts use assigned_bdr property (not hubspot_owner_id) because BDRs do outreach
    // on behalf of AEs. hubspot_owner_id typically maps to the AE, not the BDR.
    // Setting include_owned=true adds a second pass using hubspot_owner_id for AE views.
    if (method === "GET" && path === "/activity") {
      try {
        const days  = [7, 14, 30, 90].includes(parseInt(qp.days, 10))
          ? parseInt(qp.days, 10)
          : 7;
        const since    = Date.now() - days * 24 * 60 * 60 * 1000;
        const sinceISO = new Date(since).toISOString();
        const includeOwned = qp.include_owned === "true";
        const includeAEs   = qp.include_owned === "true"; // same param, also expands to AE reps

        // rep param: "all" = both BDRs, anything else = filter to that rep's assigned_bdr value
        const repFilter = qp.rep && qp.rep !== "all"
          ? decodeURIComponent(qp.rep).trim()
          : null;

        // Known BDR names -- these are the only values used in the assigned_bdr property.
        // We hardcode these rather than fetching all 25 HubSpot owners (most of which
        // have zero contacts with their name as assigned_bdr, causing 25x unnecessary API calls).
        const KNOWN_BDRS = ["Chris Knapp", "Chiara Pate", "Matt Valin", "Joseph Haine", "Tim Grisham", "Irene Wong", "Cole Hooper", "John Hansel"];
        const BDR_NAMES  = ["Chris Knapp", "Chiara Pate"]; // filter by assigned_bdr
        const OWNER_ID_MAP = {
          "Matt Valin":    "76104455",
          "Joseph Haine":  "55217954",
          "Tim Grisham":   "83862037",
          "Irene Wong":    "289209454",
          "Cole Hooper":   "85819247",
          "John Hansel":   "743772047",
        };
        // When "Include AE activity" is checked, expand targetReps to all reps
        const BDR_ONLY   = ["Chris Knapp", "Chiara Pate"];
        const targetReps = repFilter
          ? [repFilter]
          : includeAEs
            ? KNOWN_BDRS   // KNOWN_BDRS already includes all BDRs + AEs
            : BDR_ONLY;    // default: BDRs only

        // Count contacts with dateProp >= since, filtered by rep (assigned_bdr or owner_id)
        async function countForRep(dateProp, repName) {
          const ownerId = OWNER_ID_MAP[repName];
          const filter  = ownerId
            ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }
            : { propertyName: "assigned_bdr",     operator: "EQ", value: repName };
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: [{ filters: [
                filter,
                { propertyName: dateProp, operator: "GTE", value: sinceISO },
              ]}],
              properties: ["assigned_bdr"],
              limit: 1,
            });
            return data.total || 0;
          } catch (err) {
            console.error(`[activity] countForRep ${dateProp} ${repName}:`, err.message);
            return 0;
          }
        }

        // ── Email counts via engagement object (actual email rows, not contact-level dates) ──
        // sequence emails: hs_sequence_id HAS_PROPERTY + outgoing direction
        // individual emails: hs_sequence_id NOT_HAS_PROPERTY + outgoing direction
        async function countEmailsForRep(repName, sequenceOnly) {
          const ownerId = OWNER_ID_MAP[repName];
          const ownerFilter = ownerId
            ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }
            : null;
          const filters = [
            { propertyName: "hs_email_direction", operator: "EQ", value: "EMAIL" },
            { propertyName: "hs_timestamp", operator: "GTE", value: sinceISO },
            { propertyName: "hs_sequence_id", operator: sequenceOnly ? "HAS_PROPERTY" : "NOT_HAS_PROPERTY" },
          ];
          if (ownerFilter) filters.push(ownerFilter);
          try {
            const data = await hsPost(user.userId, "/crm/v3/objects/emails/search", {
              filterGroups: [{ filters }],
              properties: ["hs_timestamp"],
              limit: 1,
            });
            return data.total || 0;
          } catch (err) {
            console.error(`[activity] countEmailsForRep ${repName} seq=${sequenceOnly}:`, err.message);
            return 0;
          }
        }

        // Run counts SEQUENTIALLY per rep to stay within rate limits.
        const repResults = [];
        for (const repName of targetReps) {
          const seqEmails         = await countEmailsForRep(repName, true);
          await new Promise(r => setTimeout(r, 150));
          const indivEmails       = await countEmailsForRep(repName, false);
          await new Promise(r => setTimeout(r, 150));
          const emailsSent        = seqEmails + indivEmails;
          const sequencesStarted  = await countForRep("hs_latest_sequence_enrolled_date", repName);
          await new Promise(r => setTimeout(r, 150));
          // Replies + opens via engagement object — correctly scoped to this rep
          // avoids cross-rep contamination from contact-level date properties
          const ownerId_r   = OWNER_ID_MAP[repName];
          const repFilters  = [
            { propertyName: "hs_timestamp", operator: "GTE", value: sinceISO },
          ];
          if (ownerId_r) repFilters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId_r });
          const replyData = await hsPost(user.userId, "/crm/v3/objects/emails/search", {
            filterGroups: [{ filters: [...repFilters, { propertyName: "hs_email_direction", operator: "EQ", value: "INCOMING_EMAIL" }] }],
            properties: ["hs_timestamp"], limit: 1,
          }).catch(() => ({ total: 0 }));
          const replies = replyData.total || 0;
          await new Promise(r => setTimeout(r, 150));
          // hs_sales_email_last_opened tracks 1:1 sales email opens (vs marketing email open date)
          const opens = await countForRep("hs_sales_email_last_opened", repName);
          console.log(`[activity] rep=${repName} seqEmails=${seqEmails} indivEmails=${indivEmails} total=${emailsSent} sequences=${sequencesStarted} replies=${replies} opens=${opens}`);
          repResults.push({ repName, emailsSent, seqEmails, indivEmails, sequencesStarted, replies, opens });
          await new Promise(r => setTimeout(r, 200));
        }

        // Optional AE pass: also count by hubspot_owner_id
        let ownedCounts = { emailsSent:0, replies:0, clicks:0, opens:0 };
        if (includeOwned) {
          try {
            // Look up the current user's HubSpot owner ID
            const meData = await getMyHubSpotOwner(user.userId, user.email);
            if (meData?.id) {
              const [oSent, oReplies, oClicks, oOpens] = await Promise.all([
                countByOwnerId("hs_email_last_send_date",     meData.id),
                countByOwnerId("hs_sales_email_last_replied", meData.id),
                countByOwnerId("hs_sales_email_last_clicked", meData.id),
                countByOwnerId("hs_sales_email_last_opened",  meData.id),
              ]);
              ownedCounts = { emailsSent: oSent, replies: oReplies, clicks: oClicks, opens: oOpens };
            }
          } catch { /* fall through */ }
        }

        // Engagements: calls, notes via legacy API; meetings via CRM objects API
        // (Meetings are stored as CRM object type 0-47, not legacy MEETING engagements)
        const engTotals = { calls: 0, meetings: 0, notes: 0 };
        const engByRep  = {};
        let meetingDetails = [];  // declared here — accessible after the try/catch
        targetReps.forEach(r => { engByRep[r] = { calls:0, meetings:0, notes:0 }; });

        try {
          // Count calls + notes from legacy engagements
          let hasMore = true;
          let offset  = 0;
          while (hasMore && offset < 2000) {
            const engData = await hsGet(user.userId, "/engagements/v1/engagements/paged", {
              limit: 250, offset, since,
            }).catch(() => ({ results: [], hasMore: false }));

            for (const eng of (engData.results || [])) {
              const ts   = eng.engagement?.createdAt || 0;
              const type = eng.engagement?.type || "";
              if (ts < since) continue;
              const bucket = engByRep[repFilter || targetReps[0]] || (engByRep[targetReps[0]] = { calls:0, meetings:0, notes:0 });
              if (type === "CALL") { engTotals.calls++; bucket.calls++; }
              if (type === "NOTE") { engTotals.notes++; bucket.notes++; }
            }

            hasMore = engData.hasMore && (engData.results || []).length === 250;
            offset += (engData.results || []).length;
          }

          // Count meetings from CRM objects API (where modern HubSpot stores them).
          // Build owner ID list: use OWNER_ID_MAP + known BDR owner IDs for all target reps.
          const FULL_OWNER_ID_MAP = {
            ...OWNER_ID_MAP,
            "Chris Knapp":  "78304576",
            "Chiara Pate":  "87806380",
          };
          // Collect unique owner IDs for the current targetReps
          const meetingOwnerIds = [...new Set(
            targetReps.map(r => FULL_OWNER_ID_MAP[r]).filter(Boolean)
          )];
          if (meetingOwnerIds.length > 0) {
            const meetingFilterGroups = meetingOwnerIds.map(ownerId => ({
              filters: [
                { propertyName: "hubspot_owner_id",     operator: "EQ",  value: ownerId },
                { propertyName: "hs_meeting_start_time", operator: "GTE", value: sinceISO },
              ],
            }));
            const meetData = await hsPost(user.userId, "/crm/v3/objects/meetings/search", {
              filterGroups: meetingFilterGroups,
              properties: [
                "hs_meeting_title", "hs_meeting_start_time", "hs_meeting_end_time",
                "hubspot_owner_id", "hs_internal_meeting_notes",
              ],
              sorts: [{ propertyName: "hs_meeting_start_time", direction: "DESCENDING" }],
              limit: 50,
            }).catch(() => ({ results: [], total: 0 }));

            // Dedup Gong vs non-Gong: for each start time, prefer non-Gong.
            // If only a Gong record exists for that slot, include it (stripped of prefix).
            const allMeetResults = (meetData.results || [])
              .filter(m => !(m.properties?.hs_meeting_title || "").match(/\[Canceled\]|\bcanceled\b|\bcancelled\b/i))
              .sort((a, b) => {
                const aG = (a.properties?.hs_meeting_title || "").startsWith("[Gong]");
                const bG = (b.properties?.hs_meeting_title || "").startsWith("[Gong]");
                return aG - bG; // non-Gong first
              });
            const seenStartTimes = new Set();
            const rawMeetings = allMeetResults.filter(m => {
              const t = m.properties?.hs_meeting_start_time || m.id;
              if (seenStartTimes.has(t)) return false;
              seenStartTimes.add(t);
              return true;
            });

            // Count uses deduplicated rawMeetings length (not meetData.total which includes Gong dupes)
            const meetCount = rawMeetings.length;
            engTotals.meetings += meetCount;
            const bucket = engByRep[repFilter || targetReps[0]] || (engByRep[targetReps[0]] = { calls:0, meetings:0, notes:0 });
            bucket.meetings += meetCount;

            // Batch-fetch contact associations for meetings
            if (rawMeetings.length > 0) {
              const assocData = await hsPost(user.userId, "/crm/v4/associations/meetings/contacts/batch/read", {
                inputs: rawMeetings.slice(0, 50).map(m => ({ id: m.id })),
              }).catch(() => ({ results: [] }));

              const meetingToContacts = {};
              for (const r of (assocData.results || [])) {
                meetingToContacts[r.from?.id] = (r.to || []).map(t => t.toObjectId).slice(0, 5);
              }

              // Fetch contact names/companies
              const allContactIds = [...new Set(Object.values(meetingToContacts).flat())];
              const contactDetails = {};
              if (allContactIds.length > 0) {
                const cData = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
                  inputs: allContactIds.slice(0, 100).map(id => ({ id })),
                  properties: ["firstname", "lastname", "company"],
                }).catch(() => ({ results: [] }));
                for (const c of (cData.results || [])) {
                  const name = `${c.properties?.firstname||""} ${c.properties?.lastname||""}`.trim();
                  contactDetails[c.id] = { name, company: c.properties?.company || "" };
                }
              }

              for (const m of rawMeetings) {
                const p = m.properties || {};
                const contactIds = meetingToContacts[m.id] || [];
                const contacts = contactIds.map(id => contactDetails[id]).filter(Boolean);
                meetingDetails.push({
                  id:        m.id,
                  title:     p.hs_meeting_title || "Meeting",
                  startTime: p.hs_meeting_start_time || null,
                  endTime:   p.hs_meeting_end_time   || null,
                  ownerId:   p.hubspot_owner_id       || null,
                  contacts,
                  url: `https://app.hubspot.com/contacts/39921549/objects/0-47/views/all/list`,
                });
              }
            }
          }
        } catch { /* fall through */ }

        // Sum totals
        const totals = repResults.reduce((acc, r) => {
          acc.emailsSent       += r.emailsSent;
          acc.seqEmails        += r.seqEmails        || 0;
          acc.indivEmails      += r.indivEmails      || 0;
          acc.sequencesStarted += r.sequencesStarted || 0;
          acc.replies          += r.replies          || 0;
          acc.opens            += r.opens            || 0;
          return acc;
        }, { emailsSent:0, seqEmails:0, indivEmails:0, sequencesStarted:0, replies:0, opens:0 });

        const summary = {
          outbound: {
            emailsSent:       totals.emailsSent       + (includeOwned ? ownedCounts.emailsSent : 0),
            seqEmails:        totals.seqEmails        + (includeOwned ? ownedCounts.seqEmails   || 0 : 0),
            indivEmails:      totals.indivEmails      + (includeOwned ? ownedCounts.indivEmails || 0 : 0),
            sequencesStarted: totals.sequencesStarted,
            callsLogged:      engTotals.calls,
            meetingsLogged:   engTotals.meetings,
            notesLogged:      engTotals.notes,
          },
          inbound: {
            repliesReceived: totals.replies + (includeOwned ? ownedCounts.replies : 0),
            linksClicked:    totals.clicks  + (includeOwned ? ownedCounts.clicks  : 0),
            emailsOpened:    totals.opens   + (includeOwned ? ownedCounts.opens   : 0),
          },
        };

        // Per-rep breakdown
        const byRep = Object.fromEntries(repResults.map(r => [r.repName, {
          outbound: {
            emailsSent:       r.emailsSent,
            seqEmails:        r.seqEmails   || 0,
            indivEmails:      r.indivEmails || 0,
            sequencesStarted: r.sequencesStarted,
            callsLogged:      engByRep[r.repName]?.calls    || 0,
            meetingsLogged:   engByRep[r.repName]?.meetings || 0,
            notesLogged:      engByRep[r.repName]?.notes    || 0,
          },
          inbound: {
            repliesReceived: r.replies,
            linksClicked:    r.clicks,
            emailsOpened:    r.opens,
          },
        }]));

        return ok({
          summary,
          byRep: targetReps.length > 1 ? byRep : null,
          meetingDetails,
          meta: {
            days,
            rep:          repFilter || "all",
            since:        sinceISO,
            includeOwned,
            note: "Counts = unique contacts touched via assigned_bdr, not raw send volume.",
          },
        });

      } catch (err) {
        console.error("[activity] Error:", err.message);
        return error(500, `Activity error: ${err.message}`);
      }
    }

    // ── Real-time signals (last 15 minutes) ──────────────────────────────────
    // Lightweight polling endpoint. Fetches the last 15 min of email open/click
    // events from /email/public/v1/events. Safe at high volume because the time
    // window is tiny -- only events since the last poll, not the full history.
    //
    // The frontend calls this every 3 minutes and merges new signals into the feed.
    // Bot detection runs the same logic as /signals so new items are already scored.
    //
    // Query params:
    //   since=<ISO>   (optional -- override the 15-min window for a custom lookback)
    //   assigned_bdr= (optional -- filter to a specific rep after enrichment)
    if (method === "GET" && path === "/signals/recent") {
      try {
        const windowMs  = 15 * 60 * 1000; // 15 minutes
        const sinceMs   = qp.since
          ? new Date(qp.since).getTime()
          : Date.now() - windowMs;
        const sinceISO  = new Date(sinceMs).toISOString();
        const bdrFilter = qp.assigned_bdr
          ? decodeURIComponent(qp.assigned_bdr).trim()
          : null;

        // Fetch raw email events -- tiny window so no 504 risk
        const eventsData = await hsGet(user.userId, "/email/public/v1/events", {
          startTimestamp: sinceMs,
          limit: 100,
        }).catch(() => ({ events: [] }));

        const rawEvents = (eventsData.events || [])
          .filter(ev => ["OPEN","CLICK","REPLY"].includes(ev.type));

        if (rawEvents.length === 0) {
          return ok({ signals: [], meta: { since: sinceISO, count: 0 } });
        }

        // Enrich with contact data to apply assigned_bdr filter
        const contactIds = [...new Set(
          rawEvents.map(ev => ev.contactId ? String(ev.contactId) : null).filter(Boolean)
        )];

        const contactMap = {};
        if (contactIds.length > 0) {
          try {
            const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
              properties: BASE_CONTACT_PROPS,
              inputs:     contactIds.map(id => ({ id })),
            });
            (batch.results || []).forEach(c => {
              const info = normalizeContact(c);
              contactMap[c.id] = info;
            });
          } catch { /* enrichment best-effort */ }
        }

        const signals = rawEvents
          .map(ev => {
            const contactId = ev.contactId ? String(ev.contactId) : null;
            const contact   = contactId ? (contactMap[contactId] || null) : null;

            // Apply BDR filter if specified
            if (bdrFilter && contact?.assignedBdr !== bdrFilter) return null;

            const eventType = ev.type;
            let score = 0, label = "";
            if (eventType === "REPLY") {
              const automated = isAutomatedReply(ev.subject || null, null);
              if (automated) return null; // OOO or bounce — not a real reply, skip from live signals
              score = 100; label = "Replied";
            }
            else if (eventType === "CLICK") { score = 70;  label = "Clicked link"; }
            else if (eventType === "OPEN")  { score = 40;  label = "Opened"; }

            const botCheck = detectBot({
              filteredEvent: false,
              sentAt:    null, // raw events don't have sent timestamp
              openedAt:  eventType === "OPEN"  ? ev.created : null,
              numOpens:  eventType === "OPEN"  ? 1 : 0,
              numClicks: eventType === "CLICK" ? 1 : 0,
              replied:   eventType === "REPLY",
            });

            return {
              source:         "realtime_event",
              id:             `rt-${ev.id || ev.created}`,
              type:           eventType,
              emailSource:    "marketing",
              timestamp:      ev.created || null,
              score,
              label,
              contactId,
              contact,
              botCheck,
              isBot:          botCheck.isBot && eventType === "OPEN",
              subject:        ev.emailCampaignGroupName || ev.appName || null,
              campaignId:     ev.emailCampaignId ? String(ev.emailCampaignId) : null,
              openedAt:       eventType === "OPEN"  ? ev.created : null,
              clickedAt:      eventType === "CLICK" ? ev.created : null,
              repliedAt:      eventType === "REPLY" ? ev.created : null,
              sentAt:         null,
              url:            ev.url || null,
            };
          })
          .filter(Boolean)
          .filter(s => !s.isBot) // filter bots before sending to client
          .sort((a, b) => b.score - a.score || new Date(b.timestamp||0) - new Date(a.timestamp||0));

        return ok({
          signals,
          meta: {
            since:   sinceISO,
            count:   signals.length,
            rawCount: rawEvents.length,
          },
        });
      } catch (err) {
        console.error("[signals/recent] Error:", err.message);
        return error(500, `Recent signals error: ${err.message}`);
      }
    }

    if (method === "GET" && path === "/signals") {
      try {
      const hours       = Math.min(parseInt(qp.hours || "2880", 10), 2880);
      const since       = Date.now() - hours * 60 * 60 * 1000;
      const sinceISO    = new Date(since).toISOString();
      const includeBots = qp.includeBots === "true";

      // Tiered pagination for high-volume accuracy without blocking first render.
      // Frontend calls with offset=0 first (fast), then offset=100 in the background.
      // Each tier fetches 100 per prop * 5 props = up to 500 contacts before dedup.
      // Two tiers = up to 1,000 unique contacts total.
      //
      // Usage:
      //   GET /signals              -> tier 1 (offset 0, returns hasMore flag)
      //   GET /signals?offset=100   -> tier 2 (background fetch, merge into feed)
      const pageOffset  = Math.max(0, parseInt(qp.offset || "0", 10));
      const perPropLimit = 100; // per date-prop per page

      // Build filter groups -- use OR logic across multiple date properties
      // so we catch contacts active via marketing emails, sequences, AND 1:1 sales emails.
      // HubSpot sequences update hs_last_sales_activity_timestamp, not hs_last_sales_activity_timestamp.
      // Marketing emails update hs_email_last_send_date.
      // Sales / 1:1 emails update hs_sales_email_last_opened / clicked / replied.
      // We run one search per date property and merge results.
      const customFilters = buildCustomFilters(qp);
      const filterGroups  = buildFilterGroups(qp);

      const activityDateProps = [
        "hs_email_last_send_date",         // marketing + sequence sends
        "hs_email_last_open_date",         // marketing email opens
        "hs_email_last_click_date",        // marketing email clicks
        "hs_last_sales_activity_timestamp",// sequence steps, calls, meetings (valid property)
        "hs_sales_email_last_opened",      // 1:1 sales email opens
        "hs_sales_email_last_replied",     // 1:1 sales email replies
      ];

      // Run searches SEQUENTIALLY with 300ms gaps and automatic retry on 429.
      // 150ms was insufficient when concurrent routes (gold, contacts) fire simultaneously
      // and share the same HubSpot per-second rate limit bucket.
      const searchResults = [];
      for (const prop of activityDateProps) {
        const dateFilter = { propertyName: prop, operator: "GTE", value: sinceISO };
        // Build filterGroups: add date filter to each group from buildFilterGroups
        const fGroups = filterGroups.map(g => ({
          filters: [dateFilter, ...g.filters],
        }));
        let attempts = 0;
        while (attempts < 2) {
          try {
            const result = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: fGroups,
              properties: BASE_CONTACT_PROPS,
              sorts:      [{ propertyName: prop, direction: "DESCENDING" }],
              limit:      perPropLimit,
            });
            searchResults.push({ ...result, _prop: prop });
            console.log(`[signals] prop=${prop} returned=${(result.results||[]).length} total=${result.total||0} filters=${JSON.stringify(fGroups)}`);
            break;
          } catch (err) {
            attempts++;
            const is429 = err.message?.includes("429");
            if (is429 && attempts < 2) {
              console.log(`[signals] 429 on ${prop}, retrying after 1s...`);
              await new Promise(r => setTimeout(r, 1000));
            } else {
              console.error(`[signals] search failed for prop ${prop}:`, err.message);
              searchResults.push({ results: [], total: 0, _prop: prop });
              break;
            }
          }
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // Merge and deduplicate across all three searches
      const seenIds = new Set();
      const allContactResults = [];
      for (const result of searchResults) {
        for (const c of (result.results || [])) {
          if (!seenIds.has(c.id)) {
            seenIds.add(c.id);
            allContactResults.push(c);
          }
        }
      }

      // Sort merged results by most recent activity across all date props
      allContactResults.sort((a, b) => {
        const dateA = Math.max(
          new Date(a.properties?.hs_email_last_send_date           || 0).getTime(),
          new Date(a.properties?.hs_email_last_open_date           || 0).getTime(),
          new Date(a.properties?.hs_last_sales_activity_timestamp  || 0).getTime(),
          new Date(a.properties?.hs_sales_email_last_opened        || 0).getTime(),
          new Date(a.properties?.hs_sales_email_last_replied       || 0).getTime(),
        );
        const dateB = Math.max(
          new Date(b.properties?.hs_email_last_send_date           || 0).getTime(),
          new Date(b.properties?.hs_email_last_open_date           || 0).getTime(),
          new Date(b.properties?.hs_last_sales_activity_timestamp  || 0).getTime(),
          new Date(b.properties?.hs_sales_email_last_opened        || 0).getTime(),
          new Date(b.properties?.hs_sales_email_last_replied       || 0).getTime(),
        );
        return dateB - dateA;
      });

      const recentContactsData = { results: allContactResults };

      // Fetch engagement fallback only -- marketing email events API is too slow at volume
      // Contact property timestamps already capture marketing email activity reliably
      const engData = await hsGet(user.userId, "/engagements/v1/engagements/paged", {
        limit: 100,
        since,
      }).catch(() => ({ results: [] }));

      const marketingEventsData = []; // removed -- causes 504 at high volume

      // Build contact map with full normalized data including custom properties
      const contactMap = {};
      (recentContactsData.results || []).forEach(c => {
        const info = normalizeContact(c);
        contactMap[c.id] = info;
        if (info.email) contactMap[info.email] = info;
      });

      // Build signals from contact properties (covers both marketing and sales email types)
      let contactSignals = (recentContactsData.results || []).map(c => {
        const p    = c.properties || {};
        const info = contactMap[c.id];

        // Marketing email timestamps
        const mktReplyTs = p.hs_email_last_reply_date  ? new Date(p.hs_email_last_reply_date).getTime()  : 0;
        const mktClickTs = p.hs_email_last_click_date  ? new Date(p.hs_email_last_click_date).getTime()  : 0;
        const mktOpenTs  = p.hs_email_last_open_date   ? new Date(p.hs_email_last_open_date).getTime()   : 0;
        const mktSendTs  = p.hs_email_last_send_date   ? new Date(p.hs_email_last_send_date).getTime()   : 0;

        // Sales / 1:1 email timestamps
        const salesReplyTs  = p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0;
        const salesClickTs  = p.hs_sales_email_last_clicked ? new Date(p.hs_sales_email_last_clicked).getTime() : 0;
        const salesOpenTs   = p.hs_sales_email_last_opened  ? new Date(p.hs_sales_email_last_opened).getTime()  : 0;

        // Best signal across both email types (most recent wins)
        const replyTs = Math.max(mktReplyTs, salesReplyTs);
        const clickTs = Math.max(mktClickTs, salesClickTs);
        const openTs  = Math.max(mktOpenTs,  salesOpenTs);

        // Which source is driving the top signal?
        const replySource = replyTs > 0 ? (salesReplyTs >= mktReplyTs ? "sales" : "marketing") : null;
        const clickSource = clickTs > 0 ? (salesClickTs >= mktClickTs ? "sales" : "marketing") : null;
        const openSource  = openTs  > 0 ? (salesOpenTs  >= mktOpenTs  ? "sales" : "marketing") : null;

        let score = 0, label = "", primaryTs = null, eventType = "OPEN", emailSource = null;

        if (replyTs > 0 && replyTs >= since) {
          score = 100; label = "Replied"; eventType = "REPLY"; emailSource = replySource;
          primaryTs = replySource === "sales" ? p.hs_sales_email_last_replied : p.hs_email_last_reply_date;
        } else if (clickTs > 0 && clickTs >= since) {
          score = 70; label = "Clicked link"; eventType = "CLICK"; emailSource = clickSource;
          primaryTs = clickSource === "sales" ? p.hs_sales_email_last_clicked : p.hs_email_last_click_date;
        } else if (openTs > 0 && openTs >= since) {
          score = 40; label = "Opened"; eventType = "OPEN"; emailSource = openSource;
          primaryTs = openSource === "sales" ? p.hs_sales_email_last_opened : p.hs_email_last_open_date;
        } else {
          return null;
        }

        // Build unified event chain in chronological order across both email types
        const eventChain = [];
        if (mktSendTs > 0)    eventChain.push({ type:"SENT",       timestamp: p.hs_email_last_send_date,      label:"Sent (marketing)",   source:"marketing" });
        if (mktOpenTs > 0)    eventChain.push({ type:"OPENED",     timestamp: p.hs_email_last_open_date,      label:"Opened (marketing)", source:"marketing" });
        if (mktClickTs > 0)   eventChain.push({ type:"CLICKED",    timestamp: p.hs_email_last_click_date,     label:"Clicked (marketing)",source:"marketing" });
        if (mktReplyTs > 0)   eventChain.push({ type:"REPLIED",    timestamp: p.hs_email_last_reply_date,     label:"Replied (marketing)",source:"marketing" });
        if (salesOpenTs > 0)  eventChain.push({ type:"OPENED",     timestamp: p.hs_sales_email_last_opened,   label:"Opened (sales)",     source:"sales" });
        if (salesClickTs > 0) eventChain.push({ type:"CLICKED",    timestamp: p.hs_sales_email_last_clicked,  label:"Clicked (sales)",    source:"sales" });
        if (salesReplyTs > 0) eventChain.push({ type:"REPLIED",    timestamp: p.hs_sales_email_last_replied,  label:"Replied (sales)",    source:"sales" });
        eventChain.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
        // Bug fix: filter eventChain to only show events within the signals window
        // This prevents year-old clicks/opens appearing in the chain
        const sinceISO2 = new Date(since).toISOString();
        const recentChain = eventChain.filter(e => !e.timestamp || e.timestamp >= sinceISO2);
        // Keep at minimum the primary triggering event even if chain is empty
        if (recentChain.length === 0 && primaryTs) {
          recentChain.push({ type: eventType, timestamp: primaryTs, label: label, source: emailSource });
        }

        // Use whichever open/send timestamps are available for bot detection
        const botOpenTs = openSource === "sales" ? salesOpenTs : mktOpenTs;

        // Scanner rule: if open AND click both happen within 90 seconds of send,
        // it's almost certainly a security scanner regardless of event type.
        // (Gina/Nicole pattern: sent 1:27, opened 1:28, clicked 1:28 = scanner)
        const sendTs = mktSendTs || 0;
        const openClickGap = sendTs > 0 && botOpenTs > 0 && clickTs > 0
          ? Math.max(botOpenTs - sendTs, clickTs - sendTs) / 1000
          : null;
        const isScannerClick = openClickGap !== null && openClickGap < 90;

        // For contact-property signals, pass actual open timestamp so time-to-open
        // check fires. Keep numOpens: 0 to disable history-based burst checks.
        const botCheck = detectBot({
          filteredEvent: false,
          sentAt:    mktSendTs ? new Date(mktSendTs).toISOString() : null,
          openedAt:  botOpenTs ? new Date(botOpenTs).toISOString() : null,
          numOpens:  0,   // keep 0 to disable burst-pattern checks
          numClicks: clickTs > 0 ? 1 : 0,
          replied:   replyTs > 0,
        });

        // Mark as bot if: time-based scanner detected on opens, OR
        // open+click both within 90 seconds of send (scanner click pattern)
        const isBotSignal = (botCheck.isBot && eventType === "OPEN") ||
                            (isScannerClick && !replyTs);

        // Sequence subject: hs_sequence_name does not exist on contacts.
        // Show the email name for marketing sends; sequence ID is a fallback only.
        // Bug fix: never show raw sequence ID as subject
        // hs_email_last_email_name is the best we have — it captures the email name
        // for both marketing and sales emails. Sequence ID fallback is removed.
        const subjectLabel = p.hs_email_last_email_name || null;

        return {
          source:      "contact_activity",
          id:          `ca-${c.id}`,
          type:        eventType,
          emailSource,                   // "marketing" | "sales" -- which system drove this signal
          timestamp:   primaryTs,
          score,
          label,
          eventChain:  recentChain,
          contactId:   c.id,
          contact:     info,
          botCheck,
          isBot:       isBotSignal,
          subject:     subjectLabel,
          // sentAt: start null, will be enriched accurately by the email lookup below
          // Using contact-level hs_email_last_send_date is unreliable — it's unpaired
          sentAt: null,
          _fallbackSentAt: (() => {
            // Keep as fallback if enrichment fails
            const sendDate = p.hs_email_last_send_date || null;
            if (!sendDate || !primaryTs) return null;
            const sendMs  = new Date(sendDate).getTime();
            const eventMs = new Date(primaryTs).getTime();
            return sendMs <= eventMs ? sendDate : null;
          })(),
          // Only set open/click/reply timestamps from the actual triggering event
          // Contact-level all-time properties (hs_sales_email_last_opened etc) are
          // unpaired and would show stale dates — never use them here
          openedAt:    eventType === "OPEN"  ? primaryTs : null,
          clickedAt:   eventType === "CLICK" ? primaryTs : null,
          repliedAt:   eventType === "REPLY" ? primaryTs : null,
        };
      }).filter(Boolean);

      // Filter out OOO/bounce "replies" — hs_email_last_reply_date and
      // hs_sales_email_last_replied get set by HubSpot even when the
      // "reply" is an automated bounce or out-of-office responder, since
      // HubSpot's own tracking doesn't distinguish those from a genuine
      // human reply. Without this check, Live Signals would show an
      // auto-responder as if a real person had responded — the exact
      // problem this pass is fixing.
      const replySignalsToCheck = contactSignals.filter(s => s.type === "REPLY" && s.contactId);
      if (replySignalsToCheck.length > 0) {
        try {
          const incomingForCheck = await hsPost(user.userId, "/crm/v3/objects/emails/search", {
            filterGroups: [{
              filters: [
                { propertyName: "hs_email_direction", operator: "EQ", value: "INCOMING_EMAIL" },
                { propertyName: "hs_timestamp", operator: "GTE", value: new Date(since).toISOString() },
              ],
            }],
            properties: ["hs_email_subject", "hs_email_text", "hs_timestamp"],
            limit: 200,
          }).catch(() => ({ results: [] }));

          const automatedEmailIds = (incomingForCheck.results || [])
            .filter(e => isAutomatedReply(e.properties?.hs_email_subject || "", e.properties?.hs_email_text || ""))
            .map(e => e.id);

          if (automatedEmailIds.length > 0) {
            const assocData = await hsPost(user.userId, "/crm/v4/associations/emails/contacts/batch/read", {
              inputs: automatedEmailIds.slice(0, 100).map(id => ({ id })),
            }).catch(() => ({ results: [] }));

            const automatedContactIds = new Set();
            for (const r of (assocData.results || [])) {
              for (const assoc of (r.to || [])) {
                automatedContactIds.add(String(assoc.toObjectId));
              }
            }

            if (automatedContactIds.size > 0) {
              contactSignals = contactSignals.filter(
                s => !(s.type === "REPLY" && automatedContactIds.has(String(s.contactId)))
              );
            }
          }
        } catch (e) {
          console.error("[signals] automated-reply filter failed:", e.message);
        }
      }

      // Enrich company names for signals where contact.company is blank
      // Use associatedcompanyid to batch-fetch company names
      const missingCompany = contactSignals.filter(s => !s.contact?.company?.trim() && s.contactId);
      if (missingCompany.length > 0) {
        try {
          // Get unique company IDs from associatedcompanyid property
          const contactIds = missingCompany.map(s => s.contactId).filter(Boolean);
          const assocData  = await hsPost(user.userId, "/crm/v4/associations/contacts/companies/batch/read", {
            inputs: contactIds.slice(0, 100).map(id => ({ id })),
          }).catch(() => ({ results: [] }));

          // Build map: contactId → companyId
          const contactToCompany = {};
          for (const r of (assocData.results || [])) {
            if (r.to?.length > 0) contactToCompany[r.from?.id] = r.to[0].toObjectId;
          }

          // Batch fetch company names
          const companyIds = [...new Set(Object.values(contactToCompany))];
          if (companyIds.length > 0) {
            const companyData = await hsPost(user.userId, "/crm/v3/objects/companies/batch/read", {
              inputs:     companyIds.slice(0, 100).map(id => ({ id })),
              properties: ["name"],
            }).catch(() => ({ results: [] }));

            const companyNames = {};
            for (const c of (companyData.results || [])) {
              companyNames[c.id] = c.properties?.name || "";
            }

            // Apply company names back to signals
            for (const sig of contactSignals) {
              if (!sig.contact?.company?.trim() && sig.contactId) {
                const companyId = contactToCompany[String(sig.contactId)];
                if (companyId && companyNames[String(companyId)]) {
                  sig.contact = { ...sig.contact, company: companyNames[String(companyId)] };
                }
              }
            }
          }
        } catch { /* non-critical — signals still show without company name */ }
      }

      // Enrich sentAt for open signals using Outlook sent items (accurate TTO for bot detection).
      // This only applies for users with Outlook connected (gracefully returns {} otherwise).
      // We set sentAt for DISPLAY only if it validates (otherwise just use for bot detection).
      let outlookSentAtMap = {};
      try {
        outlookSentAtMap = await getOutlookSentAtMap(user.userId, sinceMs);
      } catch { /* optional enrichment, never fail signals */ }

      for (const sig of contactSignals) {
        const email = sig.contact?.email?.toLowerCase().trim();
        const outlookSent = email ? outlookSentAtMap[email] : null;

        if (outlookSent) {
          const outlookMs = new Date(outlookSent).getTime();
          const eventMs   = new Date(sig.openedAt || sig.repliedAt || sig.clickedAt || 0).getTime();
          if (outlookMs < eventMs && (eventMs - outlookMs) < 30 * 24 * 60 * 60 * 1000) {
            sig.sentAt = outlookSent;
          }
        }

        // Fallback: marketing signals only
        if (!sig.sentAt && sig._fallbackSentAt && sig.emailSource !== 'sales') {
          sig.sentAt = sig._fallbackSentAt;
        }
        delete sig._fallbackSentAt;

        // Re-run TTO bot check now that we have accurate sentAt from Outlook.
        // isBot was set earlier when sentAt was null — fix any misses.
        if (!sig.isBot && sig.sentAt && sig.openedAt && sig.eventType === "OPEN") {
          const tto = new Date(sig.openedAt).getTime() - new Date(sig.sentAt).getTime();
          if (tto >= 0 && tto < 60 * 1000) {  // opened < 1 minute after send
            sig.isBot = true;
            sig.botCheck = { isBot: true, confidence: "high", reasons: ["Opened < 1 min after send (Outlook)"] };
          }
        }
      }

      // Supplement with engagements not already covered by contact search
      // (e.g. calls, meetings, notes which don't affect hs_last_sales_activity_timestamp)
      const existingIds = new Set(contactSignals.map(s => s.contactId));

      // Back-fill open counts from engagement records into contact-based signals.
      // Contact-based signals have numOpens: 0 by default. If an engagement record
      // for the same contact has numOpens > 0 (e.g. 14 accumulated opens), we want
      // that count reflected so the signal scores and routes correctly.
      for (const eng of (engData.results || [])) {
        const cid      = String(eng.associations?.contactIds?.[0] ?? "");
        const engOpens = eng.metadata?.numOpens || 0;
        if (!cid || !existingIds.has(cid) || engOpens <= 0) continue;
        // Find the matching contact signal and update its numOpens if higher
        const existing = contactSignals.find(s => String(s.contactId) === cid);
        if (existing && engOpens > existing.numOpens) {
          existing.numOpens  = engOpens;
          existing.numClicks = existing.numClicks || eng.metadata?.numClicks || 0;
          existing.sentAt    = existing.sentAt    || eng.metadata?.sentAt    || null;
          existing.openedAt  = existing.openedAt  || eng.metadata?.openedAt  || null;
          // Re-score based on actual open count
          if (engOpens >= 5) {
            existing.score = 100 + Math.min((engOpens - 5) * 2, 20);
            existing.label = `Opened ${engOpens}×`;
          } else if (engOpens >= 3) {
            existing.score = 80 + (engOpens - 3) * 5;
            existing.label = `Opened ${engOpens}×`;
          }
          // Re-check bot status — many accumulated opens ≠ scanner behavior
          existing.isBot = false;
          existing.botCheck = { isBot: false, confidence: "none", reasons: ["Open count from engagement metadata — genuine repeated interest"] };
        }
      }

      const engItems = (engData.results || [])
        .filter(eng => {
          const cid  = String(eng.associations?.contactIds?.[0] ?? "");
          const ts   = eng.engagement?.createdAt || 0;
          // Strictly enforce date range on engagements
          return cid && !existingIds.has(cid) && ts >= since;
        })
        .map(eng => {
          const typeLabel = { CALL:"Call logged", MEETING:"Meeting logged", NOTE:"Note logged", TASK:"Task" };
          const engType   = eng.engagement?.type || "UNKNOWN";
          return {
            source:        "engagement",
            id:            `eng-${eng.engagement?.id}`,
            type:          engType,
            timestamp:     eng.engagement?.createdAt || null,
            // Fix: never show raw type as subject -- use clean labels
            subject:       eng.metadata?.subject || typeLabel[engType] || engType,
            numOpens:      eng.metadata?.numOpens  || 0,
            numClicks:     eng.metadata?.numClicks || 0,
            replied:       eng.metadata?.replied   || false,
            filteredEvent: eng.metadata?.filteredEvent || false,
            sentAt:        eng.metadata?.sentAt   || null,
            openedAt:      eng.metadata?.openedAt || null,
            contactId:     String(eng.associations?.contactIds?.[0] ?? ""),
            eventChain:    [],
          };
        });

      // Marketing events: only include if contact not already in results
      const mktItems = marketingEventsData.filter(ev => {
        const key = ev.contactId || ev.recipientEmail;
        return key && !existingIds.has(key);
      });

      const { real: engReal, bots: engBots } = scoreAllSignals([...engItems, ...mktItems], includeBots);

      // Enrich engagement/marketing signals with contact info
      // including custom properties via batch read
      const unknownIds = [...new Set(
        [...engReal, ...engBots].map(s => s.contactId).filter(id => id && !contactMap[id])
      )];
      if (unknownIds.length > 0) {
        try {
          const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
            properties: BASE_CONTACT_PROPS,
            inputs:     unknownIds.map(id => ({ id })),
          });
          (batch.results || []).forEach(c => {
            const info = normalizeContact(c);
            contactMap[c.id] = info;
            if (info.email) contactMap[info.email] = info;
          });
        } catch { /* fail silently */ }
      }

      // Also look up marketing event contacts by email
      const unknownEmails = [...new Set(
        mktItems.map(s => s.recipientEmail).filter(e => e && !contactMap[e])
      )];
      if (unknownEmails.length > 0) {
        try {
          const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
            properties: BASE_CONTACT_PROPS,
            idProperty: "email",
            inputs:     unknownEmails.map(e => ({ id: e })),
          });
          (batch.results || []).forEach(c => {
            const info = normalizeContact(c);
            contactMap[c.id] = info;
            if (info.email) contactMap[info.email] = info;
          });
        } catch { /* fail silently */ }
      }

      const enrich = s => ({
        ...s,
        contact: s.contact || contactMap[s.contactId] || contactMap[s.recipientEmail] || null,
      });

      const allReal = [
        ...contactSignals.filter(s => !s.isBot),
        ...engReal.map(enrich),
      ].sort((a,b) => b.score - a.score || new Date(b.timestamp||0) - new Date(a.timestamp||0));

      const allBots = [
        ...contactSignals.filter(s => s.isBot),
        ...engBots.map(enrich),
      ];

      // ── Organizational bot detection ─────────────────────────────────────────
      // Groups open signals by email domain and flags clusters where 2+ contacts
      // from the same domain have nearly identical time-to-open or opened at
      // nearly the same clock time -- a strong indicator of a corporate email
      // security gateway scanning all inbound mail.
      //
      // Domain-based matching is more reliable than company name matching
      // since domains are always exact (no typos or variations).
      // Window: 5 minutes on either metric.

      const openSignals = allReal.filter(s =>
        (s.type === "OPEN" || s.eventType === "OPEN") && !s.replied && !s.clickedAt
      );

      // Build map: emailDomain -> array of { s, tto, openedMs }
      const domainOpenMap = {};
      openSignals.forEach(s => {
        const email = s.contact?.email || "";
        const domain = email.includes("@") ? email.split("@")[1].toLowerCase().trim() : null;
        // Skip generic free email providers
        const freeDomains = ["gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","aol.com","protonmail.com"];
        if (!domain || freeDomains.includes(domain)) return;

        const sentMs   = s.sentAt   ? new Date(s.sentAt).getTime()   : null;
        const openedMs = s.openedAt ? new Date(s.openedAt).getTime() : null;
        // Only require openedMs — tto is optional (sentAt often null for sales emails)
        if (!openedMs) return;
        const tto = (sentMs && openedMs >= sentMs) ? openedMs - sentMs : null;
        if (!domainOpenMap[domain]) domainOpenMap[domain] = [];
        domainOpenMap[domain].push({ s, tto, openedMs, domain });
      });

      // Flag any domain where 2+ contacts opened within 5 minutes of each other
      // (by tto similarity OR by absolute open time)
      const orgBotContactIds = new Set();
      Object.entries(domainOpenMap).forEach(([domain, entries]) => {
        if (entries.length < 2) return;
        for (let i = 0; i < entries.length; i++) {
          for (let j = i + 1; j < entries.length; j++) {
            const ttoA = entries[i].tto, ttoB = entries[j].tto;
            const ttoSimilar    = ttoA !== null && ttoB !== null && Math.abs(ttoA - ttoB) <= 5 * 60 * 1000;
            const openedSimilar = Math.abs(entries[i].openedMs - entries[j].openedMs) <= 5 * 60 * 1000;
            if (ttoSimilar || openedSimilar) {
              orgBotContactIds.add(entries[i].s.contactId);
              orgBotContactIds.add(entries[j].s.contactId);
              console.log(`[org-bot] @${domain}: contacts ${entries[i].s.contactId} and ${entries[j].s.contactId} -- tto diff: ${Math.round(Math.abs(entries[i].tto - entries[j].tto)/1000)}s`);
            }
          }
        }
      });

      // Move org-bot signals to bots array
      const finalReal = [];
      const orgBots   = [];
      allReal.forEach(s => {
        const email  = s.contact?.email || "";
        const domain = email.includes("@") ? email.split("@")[1].toLowerCase().trim() : null;
        if (orgBotContactIds.has(s.contactId) &&
            (s.type === "OPEN" || s.eventType === "OPEN") &&
            !s.replied && !s.clickedAt) {
          orgBots.push({
            ...s,
            botCheck: {
              isBot:      true,
              confidence: "high",
              reasons:    [`Organizational scan: multiple @${domain || "same domain"} contacts opened within 5 minutes of each other`],
            },
          });
        } else {
          finalReal.push(s);
        }
      });

      // ── Deal-contact detection ──────────────────────────────────────────────
      // Fetch active deals closing soon or recently updated, tag contacts as deal-associated
      let dealContactMap = {};
      try {
        const now = Date.now();
        const in90Days = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const ago30Days = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const dealRes = await hsPost(user.userId, "/crm/v3/objects/deals/search", {
          filterGroups: [
            { filters: [
              { propertyName: "closedate", operator: "LTE", value: in90Days },
              { propertyName: "closedate", operator: "GTE", value: ago30Days },
              { propertyName: "hs_is_closed", operator: "NEQ", value: "true" },
            ]},
          ],
          properties: ["dealname", "dealstage", "pipeline", "amount", "closedate"],
          limit: 100,
        }).catch(() => null);
        const dealIds = (dealRes?.results || []).map(d => d.id);
        if (dealIds.length) {
          // Batch-fetch contact associations for all deals
          const assocRes = await hsPost(user.userId, `/crm/v3/associations/deals/contacts/batch/read`, {
            inputs: dealIds.map(id => ({ id })),
          }).catch(() => null);
          const dealById = {};
          (dealRes?.results || []).forEach(d => { dealById[d.id] = d.properties; });
          for (const row of (assocRes?.results || [])) {
            const dp = dealById[row.from?.id] || {};
            for (const assoc of (row.to || [])) {
              const cid = String(assoc.toObjectId);
              if (!dealContactMap[cid] || new Date(dp.closedate) < new Date(dealContactMap[cid].closedate)) {
                dealContactMap[cid] = {
                  dealName:   dp.dealname  || null,
                  dealStage:  dp.dealstage || null,
                  closeDate:  dp.closedate || null,
                  amount:     dp.amount    || null,
                };
              }
            }
          }
        }
      } catch { /* fail silently — deal context is additive */ }

      // Tag finalReal signals that belong to a deal contact
      for (const sig of finalReal) {
        const dc = sig.contactId ? dealContactMap[String(sig.contactId)] : null;
        if (dc) {
          sig.isDealContact = true;
          sig.dealContext   = dc;
          // Boost score to at least HP threshold for deal contacts
          if (sig.score < 100) sig.score = 100;
        }
      }

      const finalBots = [...allBots, ...orgBots];

      // Post-enrichment OOO filter: replies that arrived < 90s after send are almost
      // certainly auto-replies (OOO). sentAt/repliedAt are set during enrichment above.
      // These surface via the tasks/oooReplies path instead.
      const oooFiltered = finalReal.filter(s => {
        if ((s.eventType || s.type) !== "REPLY") return true;
        if (!s.sentAt || !s.repliedAt) return true;
        const gap = new Date(s.repliedAt).getTime() - new Date(s.sentAt).getTime();
        return gap > 90000; // keep only replies that took more than 90 seconds
      });
      // Replace finalReal with OOO-filtered version
      finalReal.length = 0;
      oooFiltered.forEach(s => finalReal.push(s));

      // hasMore: true if any of the per-prop searches returned a full page,
      // meaning there are likely more contacts beyond this offset.
      const anyFullPage = searchResults.some(r => (r.results || []).length === perPropLimit);

      console.log(`[signals] merged=${allContactResults.length} contactSignals=${contactSignals.length} finalReal=${finalReal.length} finalBots=${finalBots.length} filters=${JSON.stringify(customFilters)}`);

      const response = {
        signals: finalReal,
        meta: {
          total:             finalReal.length,
          suspectedBotCount: finalBots.length,
          hoursSearched:     hours,
          // Pagination
          offset:    pageOffset,
          nextOffset: pageOffset + perPropLimit,
          hasMore:   anyFullPage,
          activeFilters: {
            assigned_bdr:                    qp.assigned_bdr || null,
            territory:                       qp.territory    || null,
            priority_tier__bdr:              qp.priority_tier__bdr || null,
            target_account__bdr_led_outreach:qp.target_account__bdr_led_outreach || null,
          },
          botSummary: finalBots.length > 0
            ? `${finalBots.length} open event${finalBots.length > 1 ? "s" : ""} filtered as likely bot scan`
            : null,
          // Debug info -- remove once signals filter issue is resolved
          _debug: {
            searchCounts: searchResults.map((r, i) => ({
              prop:     activityDateProps[i],
              returned: (r.results || []).length,
              total:    r.total || 0,
            })),
            contactsAfterDedup:    allContactResults.length,
            contactSignalsBuilt:   contactSignals.length,
            afterBotFilter:        finalReal.length,
            botsFiltered:          finalBots.length,
            customFiltersApplied:  customFilters,
          },
        },
      };
      if (qp.showBots === "true") {
        response.suspectedBotSignals = finalBots.slice(0, 50);
      }
      // Fire-and-forget: persist any new bot detections to Azure Blob log
      if (finalBots.length > 0) {
        appendBotEntries(finalBots).catch(() => {});
      }
      return ok(response);
      } catch (err) {
        console.error("[signals] Error:", err.message, err.stack);
        return error(500, `Signals error: ${err.message}`);
      }
    }

    // ── Log activity ─────────────────────────────────────────────────────────
    if (method === "POST" && path === "/activity") {
      const body = JSON.parse(event.body || "{}");
      const { contactId, note, type = "NOTE" } = body;
      if (!contactId || !note) return error(400, "contactId and note are required");

      const activity = await hsPost(user.userId, "/engagements/v1/engagements", {
        engagement:   { active: true, type, timestamp: Date.now() },
        associations: { contactIds: [contactId] },
        metadata:     { body: note },
      });

      return ok({ success: true, engagementId: activity.engagement?.id });
    }

    // ── Tab registry ──────────────────────────────────────────────────────────
    //
    // GET /tabs -- returns tabs visible to the current user
    // POST /tabs -- create or update a tab (admin only)
    // DELETE /tabs/:id -- remove a tab (admin only)
    // GET /tabs/preview?url= -- fetch page <title> for auto-naming (admin only)

    // ── ACTIVITY LOG ────────────────────────────────────────────────────────────
    // GET    /activity-log          -- get entries (supports ?since=&until=&rep=)
    // POST   /activity-log          -- add a manual entry
    // DELETE /activity-log/:id      -- delete an entry

    if (method === "GET" && path === "/activity-log") {
      try {
        const entries = await getActivityLog(user.userId, {
          since: qp.since || null,
          until: qp.until || null,
          rep:   qp.rep   || null,
        });
        return ok({ entries });
      } catch (err) {
        console.error("[activity-log] GET error:", err.message);
        return error(500, `Activity log error: ${err.message}`);
      }
    }

    if (method === "POST" && path === "/activity-log") {
      try {
        const body = JSON.parse(event.body || "{}");
        if (!body.text?.trim()) return error(400, "text is required");
        // Get current user's name for rep field
        const me = await getMyHubSpotOwner(user.userId, user.email);
        const repName = `${me.firstName||""} ${me.lastName||""}`.trim();
        const entry = await addActivityEntry(user.userId, body, repName);
        return ok({ entry });
      } catch (err) {
        console.error("[activity-log] POST error:", err.message);
        return error(500, `Activity log error: ${err.message}`);
      }
    }

    if (method === "DELETE" && path.startsWith("/activity-log/")) {
      const entryId = path.split("/activity-log/")[1];
      if (!entryId) return error(400, "Entry ID required");
      try {
        await deleteActivityEntry(user.userId, entryId);
        return ok({ deleted: entryId });
      } catch (err) {
        console.error("[activity-log] DELETE error:", err.message);
        return error(500, `Activity log error: ${err.message}`);
      }
    }

    // ── TODO LIST ──────────────────────────────────────────────────────────────
    // GET    /todo        -- get all todos for user
    // POST   /todo        -- add a manual todo
    // POST   /todo/sync   -- pull auto-detected items from HubSpot
    // PATCH  /todo/:id    -- update (complete, edit)
    // DELETE /todo/:id    -- remove

    if (method === "GET" && path === "/todo") {
      try {
        let items = await getTodos(user.userId);
        // One-time live dedup: remove duplicate manual todos for the same contactId
        // (keeps the most recently-created one, since getTodos sorts manual items newest first)
        // Pass 1: manual item dedup — keep first (newest) per contactId
        const seenManualCids = new Set();
        items = items.filter(i => {
          if (!i.autoDetected && i.contactId) {
            if (seenManualCids.has(i.contactId)) { dirty = true; return false; }
            seenManualCids.add(i.contactId);
          }
          return true;
        });
        // Pass 2: drop auto-detected items already covered by a manual item
        items = items.filter(i => {
          if (i.autoDetected && i.contactId && seenManualCids.has(i.contactId)) {
            dirty = true;
            return false;
          }
          return true;
        });
        return ok({ items });
      } catch (err) {
        console.error("[todo] GET error:", err.message);
        return error(500, `Todo error: ${err.message}`);
      }
    }

    if (method === "POST" && path === "/todo") {
      try {
        const body = JSON.parse(event.body || "{}");
        if (!body.text?.trim()) return error(400, "text is required");
        const item = await addTodo(user.userId, body);
        return ok({ item });
      } catch (err) {
        console.error("[todo] POST error:", err.message);
        return error(500, `Todo error: ${err.message}`);
      }
    }

    if (method === "POST" && path === "/todo/sync") {
      // Priority order:
      // 1. Gold Account contacts needing reply or sequence follow-up
      // 2. Meetings (HubSpot only until Outlook is connected)
      // 3. Regular replies needing response
      // 4. Regular sequence follow-ups
      // All contact queries are filtered to the current user (by assigned_bdr OR hubspot_owner_id)
      try {
        const now      = Date.now();
        const today    = new Date().toISOString().slice(0, 10);
        const sinceISO = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
        const PORTAL   = "39921549";
        const GOLD_TIERS = [
          "GOLD - 1-10","GOLD - 11-20","GOLD - 21-30","GOLD - 31-40","GOLD - 41-50",
          "GOLD - 51-60","GOLD - 61-70","GOLD - 71-80","GOLD - 81-90","GOLD - 91-100",
        ];
        const autoItems = [];

        // ── Identify current user ─────────────────────────────────────────────
        // Look up the current user's HubSpot owner ID and name.
        // All contact queries filter by assigned_bdr OR hubspot_owner_id.
        const KNOWN_USER_MAP = {
          "cknapp@carecontinuity.com":  { name: "Chris Knapp",  ownerId: "78304576" },
          "chrisknappcc@gmail.com":      { name: "Chris Knapp",  ownerId: "78304576" },
          "cpate@carecontinuity.com":    { name: "Chiara Pate",  ownerId: "87806380" },
          "mvalin@carecontinuity.com":   { name: "Matt Valin",   ownerId: "76104455" },
          "jhansel@carecontinuity.com":  { name: "John Hansel",  ownerId: "743772047" },
        };
        let currentOwnerIds  = [];
        let currentOwnerName = null;
        // Primary: reliable owner lookup (was /crm/v3/owners/me, which
        // returns a hard 400 on this portal's token — confirmed, not a
        // guess. This endpoint already had a hardcoded fallback map below
        // for exactly this reason; that stays as extra redundancy.)
        try {
          const me = await getMyHubSpotOwner(user.userId, user.email);
          if (me?.id) {
            currentOwnerIds  = [String(me.id)];
            currentOwnerName = `${me.firstName||""} ${me.lastName||""}`.trim() || null;
            console.log(`[todo/sync] current user via HubSpot: ${currentOwnerName} (${me.id})`);
          }
        } catch (e) { console.error("[todo/sync] HubSpot owner lookup failed:", e.message); }
        // Fallback: match Netlify Identity email to known BDR map
        if (!currentOwnerName) {
          const userEmail = user?.email || user?.user_metadata?.email || "";
          const known = KNOWN_USER_MAP[userEmail.toLowerCase()];
          if (known) {
            currentOwnerName = known.name;
            currentOwnerIds  = [known.ownerId];
            console.log(`[todo/sync] current user via email fallback: ${currentOwnerName}`);
          }
        }

        // Build filter groups for contact queries.
        // Priority: primary_rep (custom field) → assigned_bdr (BDR) → hubspot_owner_id (AE/owner)
        // OR logic across all three so contacts are caught regardless of which field is set.
        const userContactFilters = () => {
          const groups = [];
          if (currentOwnerName) {
            // Primary: custom primary_rep field (who is driving the outreach)
            groups.push({ filters: [{ propertyName: "primary_outreach_rep", operator: "EQ", value: currentOwnerName }] });
            // Fallback 1: assigned_bdr (catches BDR-assigned contacts not yet updated)
            groups.push({ filters: [{ propertyName: "assigned_bdr", operator: "EQ", value: currentOwnerName }] });
          }
          if (currentOwnerIds.length) {
            // Fallback 2: hubspot_owner_id (catches AE-owned contacts not yet updated)
            groups.push({ filters: [{ propertyName: "hubspot_owner_id", operator: "EQ", value: currentOwnerIds[0] }] });
          }
          // If we have no identity at all, return empty filter (show nothing rather than everything)
          return groups.length > 0 ? groups : null;
        };

        // If we can't identify the user, bail out -- don't sync a generic list
        if (!currentOwnerName && !currentOwnerIds.length) {
          console.error("[todo/sync] could not identify current user, aborting sync");
          return ok({ items: await getTodos(user.userId), synced: 0 });
        }

        // ── 1. Gold Account contacts ──────────────────────────────────────────
        // Find contacts associated with Gold tier companies
        // that have unanswered replies or are in active sequences
        let goldContactIds = new Set();
        try {
          const goldCompanies = await hsPost(user.userId, "/crm/v3/objects/companies/search", {
            filterGroups: [{ filters: [
              { propertyName: "priority_tier__bdr", operator: "IN", values: GOLD_TIERS },
            ]}],
            properties: ["name","priority_tier__bdr"],
            limit: 200,
          });

          // Get contact IDs associated with Gold companies via batch associations
          const companyIds = (goldCompanies.results || []).map(c => c.id);
          if (companyIds.length > 0) {
            const assocData = await hsPost(user.userId, "/crm/v4/associations/companies/contacts/batch/read", {
              inputs: companyIds.slice(0, 100).map(id => ({ id })),
            });
            for (const result of (assocData.results || [])) {
              for (const assoc of (result.to || [])) {
                goldContactIds.add(assoc.toObjectId || assoc.id);
              }
            }
          }
        } catch (e) { console.error("[todo/sync] gold companies:", e.message); }

        // Gold replies needing response
        if (goldContactIds.size > 0) {
          try {
            // Combine user filter with reply date filter using OR on reply props
            const userGroups = userContactFilters();
            const replyFilterGroups = userGroups.flatMap(g => [
              { filters: [...g.filters, { propertyName: "hs_sales_email_last_replied", operator: "GTE", value: sinceISO }] },
              { filters: [...g.filters, { propertyName: "hs_email_last_reply_date",    operator: "GTE", value: sinceISO }] },
            ]);
            const goldReplies = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: replyFilterGroups,
              properties: ["firstname","lastname","company","hs_email_last_reply_date","hs_sales_email_last_replied","hs_last_sales_activity_timestamp","hs_email_last_send_date","notes_last_contacted","primary_outreach_rep"],
              sorts: [{ propertyName: "hs_sales_email_last_replied", direction: "DESCENDING" }],
              limit: 50,
            });
            for (const c of (goldReplies.results || [])) {
              if (!goldContactIds.has(String(c.id))) continue;
              const p = c.properties || {};
              const name = `${p.firstname||""} ${p.lastname||""}`.trim() || "Unknown";
              const replyTs = Math.max(
                p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0,
                p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0,
              );
              const activityTs = Math.max(
                p.hs_last_sales_activity_timestamp ? new Date(p.hs_last_sales_activity_timestamp).getTime() : 0,
                p.hs_email_last_send_date          ? new Date(p.hs_email_last_send_date).getTime()           : 0,
                p.notes_last_contacted             ? new Date(p.notes_last_contacted).getTime()              : 0,
              );
              if (replyTs > activityTs) {
                autoItems.push({
                  type: "reply", priority: "HIGH",
                  text: `⭐ Reply to ${name}`,
                  subtext: `Gold · ${p.company || ""}`.trim().replace(/·\s*$/, ""),
                  contactId: c.id,
                  hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL}/record/0-1/${c.id}`,
                  sourceId: `reply-${c.id}`, date: today,
                });
              }
            }
          } catch (e) { console.error("[todo/sync] gold replies:", e.message); }

          // Gold sequence follow-ups
          try {
            const userGroups = userContactFilters();
            const seqGroups  = userGroups.map(g => ({
              filters: [...g.filters, { propertyName: "hs_sequences_is_enrolled", operator: "EQ", value: "true" }],
            }));
            const goldSeqs = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups: seqGroups,
              properties: ["firstname","lastname","company","hs_latest_sequence_enrolled","hs_latest_sequence_enrolled_date"],
              limit: 50,
            });
            for (const c of (goldSeqs.results || [])) {
              if (!goldContactIds.has(String(c.id))) continue;
              const p = c.properties || {};
              const name = `${p.firstname||""} ${p.lastname||""}`.trim() || "Unknown";
              autoItems.push({
                type: "sequence", priority: "HIGH",
                text: `⭐ Follow up: ${name}`,
                subtext: `Gold · ${p.company || ""}`.trim().replace(/·\s*$/, ""),
                contactId: c.id,
                hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL}/record/0-1/${c.id}`,
                sourceId: `seq-${c.id}`, date: today,
              });
            }
          } catch (e) { console.error("[todo/sync] gold seqs:", e.message); }
        }

        // ── 2. Meetings — upcoming 30 days (HubSpot + Outlook calendar) ──────────
        try {
          const meetingWindowStart = new Date();
          const meetingWindowEnd   = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

          // Fetch HubSpot meetings and Outlook calendar in parallel
          const [meetings, outlookEvents] = await Promise.all([
            hsPost(user.userId, "/crm/v3/objects/meetings/search", {
            filterGroups: [{ filters: [
              { propertyName: "hs_meeting_start_time", operator: "GTE", value: meetingWindowStart.toISOString() },
              { propertyName: "hs_meeting_start_time", operator: "LTE", value: meetingWindowEnd.toISOString() },
            ]}],
            properties: ["hs_meeting_title","hs_meeting_start_time","hubspot_owner_id","hs_attendee_owner_ids"],
            sorts: [{ propertyName: "hs_meeting_start_time", direction: "ASCENDING" }],
            limit: 100,
          }).catch(() => ({ results: [] })),
            getOutlookCalendarEvents(user.userId, meetingWindowStart, meetingWindowEnd),
          ]);

          // Deduplicate: for meetings at the same start time, prefer non-Gong version.
          // Gong creates a duplicate [Gong] record for every synced call — skip those
          // if a non-Gong record already exists for that time slot.
          const seenMeetingTimes = new Set();
          const meetingsSorted = (meetings.results || []).sort((a, b) => {
            // non-Gong first so they win the dedup
            const aGong = (a.properties?.hs_meeting_title || "").startsWith("[Gong]");
            const bGong = (b.properties?.hs_meeting_title || "").startsWith("[Gong]");
            return aGong - bGong;
          });

          for (const m of meetingsSorted) {
            const p = m.properties || {};
            const title = p.hs_meeting_title || "";

            // Skip canceled meetings
            if (/\[canceled\]|\bcanceled\b|\bcancelled\b/i.test(title)) continue;

            // Skip Gong duplicates if non-Gong already claimed this time slot
            const isGong = title.startsWith("[Gong]");
            const timeKey = p.hs_meeting_start_time || m.id;
            if (isGong && seenMeetingTimes.has(timeKey)) continue;
            seenMeetingTimes.add(timeKey);

            // Ownership check: must own or be attendee (Gong sets hubspot_owner_id = AE)
            if (currentOwnerIds.length > 0) {
              const owner     = String(p.hubspot_owner_id || "");
              const attendees = String(p.hs_attendee_owner_ids || "").split(";").map(s => s.trim()).filter(Boolean);
              const isOwner   = currentOwnerIds.includes(owner);
              const isAttendee = attendees.some(id => currentOwnerIds.includes(id));
              if (!isOwner && !isAttendee) continue;
            }

            const startDate = p.hs_meeting_start_time ? new Date(p.hs_meeting_start_time) : null;
            const dateLabel = startDate
              ? startDate.toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" })
                + " at " + startDate.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" })
              : "";
            autoItems.push({
              type: "meeting", priority: 2,
              text: isGong ? title.replace(/^\[Gong\]\s*/i, "") : title,
              subtext: dateLabel,
              hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL}/objects/0-47/views/all/list`,
              sourceId: `meeting-${m.id}`, date: today,
              _startMs: startDate ? startDate.getTime() : 0,
            });
          }
          // ── Merge Outlook calendar events not already in HubSpot ──────────────
          // Dedup: skip Outlook events whose start time is within 3 minutes of a
          // HubSpot meeting already added (catches Calendly / Teams sync overlap).
          const hsStartTimes = new Set(
            autoItems
              .filter(i => i.type === "meeting" && i._startMs)
              .map(i => i._startMs)
          );

          for (const ev of (outlookEvents || [])) {
            const subject = (ev.subject || "").trim();
            if (!subject) continue;

            // Skip canceled / declined
            if (/\[canceled\]|\bcanceled\b|\bcancelled\b/i.test(subject)) continue;

            const startMs = ev.start?.dateTime ? new Date(ev.start.dateTime + (ev.start.dateTime.endsWith("Z") ? "" : "Z")).getTime() : 0;
            if (!startMs) continue;

            // Skip if a HubSpot meeting already covers this time slot (within 3 min)
            const alreadyCovered = [...hsStartTimes].some(t => Math.abs(t - startMs) < 3 * 60 * 1000);
            if (alreadyCovered) continue;

            // Skip all-day events (no meaningful end time within same day)
            if (ev.start?.dateTime === undefined && ev.start?.date) continue;

            hsStartTimes.add(startMs); // prevent Outlook dupes with itself

            const startDate = new Date(startMs);
            const dateLabel = startDate.toLocaleDateString("en-US", {
              timeZone: "America/New_York",
              weekday: "short", month: "short", day: "numeric",
            }) + " at " + startDate.toLocaleTimeString("en-US", {
              timeZone: "America/New_York",
              hour: "numeric", minute: "2-digit",
            });

            autoItems.push({
              type:       "meeting",
              priority:   2,
              text:       subject,
              subtext:    `📅 Outlook · ${dateLabel}`,
              hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL}/objects/0-47/views/all/list`,
              sourceId:   `outlook-cal-${ev.id}`,
              date:       today,
              _startMs:   startMs,
            });
          }

          // Clean up internal _startMs flag
          for (const item of autoItems) delete item._startMs;

        } catch (e) { console.error("[todo/sync] meetings:", e.message); }

        // ── 3. Regular replies needing response ───────────────────────────────
        try {
          const userGroups = userContactFilters();
          const replyFilterGroups = userGroups.flatMap(g => [
            { filters: [...g.filters, { propertyName: "hs_sales_email_last_replied", operator: "GTE", value: sinceISO }] },
            { filters: [...g.filters, { propertyName: "hs_email_last_reply_date",    operator: "GTE", value: sinceISO }] },
          ]);
          const replies = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
            filterGroups: replyFilterGroups,
            properties: ["firstname","lastname","company","hs_email_last_reply_date","hs_sales_email_last_replied","hs_last_sales_activity_timestamp","hs_email_last_send_date","notes_last_contacted","primary_outreach_rep"],
            sorts: [{ propertyName: "hs_sales_email_last_replied", direction: "DESCENDING" }],
            limit: 20,
          });
          const seenTodoContactIds = new Set(goldContactIds);
          for (const c of (replies.results || [])) {
            if (seenTodoContactIds.has(String(c.id))) continue; // already added above
            const p = c.properties || {};
            const name = `${p.firstname||""} ${p.lastname||""}`.trim() || "Unknown";
            const replyTs = Math.max(
              p.hs_sales_email_last_replied ? new Date(p.hs_sales_email_last_replied).getTime() : 0,
              p.hs_email_last_reply_date    ? new Date(p.hs_email_last_reply_date).getTime()    : 0,
            );
            const activityTs = Math.max(
              p.hs_last_sales_activity_timestamp ? new Date(p.hs_last_sales_activity_timestamp).getTime() : 0,
              p.hs_email_last_send_date          ? new Date(p.hs_email_last_send_date).getTime()           : 0,
              p.notes_last_contacted             ? new Date(p.notes_last_contacted).getTime()              : 0,
            );
            if (replyTs > activityTs) {
              autoItems.push({
                type: "reply", priority: 3,
                text: `Reply to ${name}`,
                subtext: p.company || "",
                contactId: c.id,
                hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL}/record/0-1/${c.id}`,
                sourceId: `reply-${c.id}`, date: today,
              });
              seenTodoContactIds.add(String(c.id));
            }
          }
        } catch (e) { console.error("[todo/sync] replies:", e.message); }

        // ── 4. Regular sequence follow-ups ────────────────────────────────────
        try {
          const userGroups = userContactFilters();
          const seqGroups  = userGroups.map(g => ({
            filters: [...g.filters, { propertyName: "hs_sequences_is_enrolled", operator: "EQ", value: "true" }],
          }));
          const seqs = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
            filterGroups: seqGroups,
            properties: ["firstname","lastname","company","hs_latest_sequence_enrolled_date"],
            sorts: [{ propertyName: "hs_latest_sequence_enrolled_date", direction: "DESCENDING" }],
            limit: 20,
          });
          for (const c of (seqs.results || [])) {
            if (seenTodoContactIds.has(String(c.id))) continue; // already added above
            const p = c.properties || {};
            const name = `${p.firstname||""} ${p.lastname||""}`.trim() || "Unknown";
            autoItems.push({
              type: "sequence", priority: 4,
              text: `Follow up: ${name}`,
              subtext: p.company || "",
              contactId: c.id,
              hubspotUrl: `https://app.hubspot.com/contacts/${PORTAL}/record/0-1/${c.id}`,
              sourceId: `seq-${c.id}`, date: today,
            });
          }
        } catch (e) { console.error("[todo/sync] seqs:", e.message); }

        // Sort by priority before upserting
        autoItems.sort((a, b) => {
          const pa = a.priority === "HIGH" ? 0 : (typeof a.priority === "number" ? a.priority : 9);
          const pb = b.priority === "HIGH" ? 0 : (typeof b.priority === "number" ? b.priority : 9);
          return pa - pb;
        });

        const items = await bulkUpsertAutoDetected(user.userId, autoItems);
        return ok({ items, synced: autoItems.length });
      } catch (err) {
        console.error("[todo] sync error:", err.message);
        return error(500, `Todo sync error: ${err.message}`);
      }
    }

    if (method === "PATCH" && path.startsWith("/todo/") && !path.includes("/sync")) {
      const todoId = path.split("/todo/")[1];
      if (!todoId) return error(400, "Todo ID required");
      try {
        const body    = JSON.parse(event.body || "{}");
        const allowed = ["completed","text","subtext","dueDate","priority"];
        const changes = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
        const item    = await updateTodo(user.userId, todoId, changes);
        return ok({ item });
      } catch (err) {
        console.error("[todo] PATCH error:", err.message);
        return error(500, `Todo error: ${err.message}`);
      }
    }

    if (method === "DELETE" && path.startsWith("/todo/")) {
      const todoId = path.split("/todo/")[1];
      if (!todoId) return error(400, "Todo ID required");
      try {
        await deleteTodo(user.userId, todoId);
        return ok({ deleted: todoId });
      } catch (err) {
        console.error("[todo] DELETE error:", err.message);
        return error(500, `Todo error: ${err.message}`);
      }
    }

    if (method === "GET" && path === "/tabs") {
      try {
        const tabs = await getAllTabsForUser(user.userId);
        return ok({ tabs, isAdmin: isAdminUser(user) });
      } catch (err) {
        console.error("[tabs] GET error:", err.message);
        return error(500, `Tabs error: ${err.message}`);
      }
    }

    if (method === "GET" && path === "/tabs/preview") {
      if (!isAdminUser(user)) return error(403, "Admin only");
      const url = qp.url ? decodeURIComponent(qp.url) : null;
      if (!url) return error(400, "url param required");
      try {
        const title = await fetchPageTitle(url);
        // Auto-generate a label: prefer page title, fall back to hostname
        let suggestedLabel = title;
        if (!suggestedLabel) {
          try { suggestedLabel = new URL(url).hostname.replace(/^www\./, ""); } catch { suggestedLabel = "New App"; }
        }
        return ok({ title, suggestedLabel });
      } catch (err) {
        return ok({ title: null, suggestedLabel: "New App" });
      }
    }

    if (method === "POST" && path === "/tabs") {
      try {
        const body = JSON.parse(event.body || "{}");
        console.log("[tabs] POST body:", JSON.stringify(body));
        const { url, label, badge, allowedUsers, enabled = true, type = "iframe" } = body;
        const isPersonal = body.personal === true;

        if (!url)   return error(400, "url is required");
        if (!label) return error(400, "label is required");
        if (!["iframe","link"].includes(type)) return error(400, "type must be iframe or link");
        try { new URL(url); } catch { return error(400, "Invalid URL"); }

        // Personal tabs: any user can create. Shared tabs: admin only.
        if (!isPersonal && !isAdminUser(user)) {
          return error(403, "Admin only for shared tabs");
        }

        const now = new Date().toISOString();
        const id  = body.id || slugify(label);
        const tab = {
          id,
          label:        label.trim().slice(0, 40),
          url:          url.trim(),
          type,
          enabled,
          allowedUsers: isPersonal ? [user.userId] : (allowedUsers || []),
          badge:        badge || null,
          addedBy:      user.userId,
          personal:     isPersonal,
          createdAt:    now,
          updatedAt:    now,
        };

        if (isPersonal) {
          console.log("[tabs] saving personal tab for user:", user.userId);
          const personal = await getPersonalTabs(user.userId);
          const existing = personal.findIndex(t => t.id === id);
          if (existing >= 0) {
            personal[existing] = { ...tab, createdAt: personal[existing].createdAt };
          } else {
            personal.push(tab);
          }
          await savePersonalTabs(user.userId, personal);
        } else {
          console.log("[tabs] saving shared tab, admin:", isAdminUser(user));
          const registry = await getRegistry();
          const existing = registry.findIndex(t => t.id === id);
          if (existing >= 0) {
            registry[existing] = { ...tab, createdAt: registry[existing].createdAt };
          } else {
            registry.push(tab);
          }
          await saveRegistry(registry);
        }

        return ok({ tab, action: "saved" });
      } catch (err) {
        console.error("[tabs] POST error:", err.message);
        return error(500, `Tab save error: ${err.message}`);
      }
    }

    if (method === "DELETE" && path.startsWith("/tabs/")) {
      const tabId     = path.split("/tabs/")[1];
      const isPersonal = qp.personal === "true";
      if (!tabId) return error(400, "Tab ID required");

      try {
        if (isPersonal) {
          // Any user can delete their own personal tabs
          const personal = await getPersonalTabs(user.userId);
          const filtered = personal.filter(t => t.id !== tabId);
          if (filtered.length === personal.length) return error(404, "Tab not found");
          await savePersonalTabs(user.userId, filtered);
          return ok({ deleted: tabId });
        } else {
          // Shared tabs: admin only
          if (!isAdminUser(user)) return error(403, "Admin only");
          const registry = await getRegistry();
          const filtered = registry.filter(t => t.id !== tabId);
          if (filtered.length === registry.length) return error(404, "Tab not found");
          await saveRegistry(filtered);
          return ok({ deleted: tabId });
        }
      } catch (err) {
        console.error("[tabs] DELETE error:", err.message);
        return error(500, `Tab delete error: ${err.message}`);
      }
    }


    // ── Reports ───────────────────────────────────────────────────────────────
    // Tabs: email_activity | marketing | sequences | deals
    // Params: section, period (today|week|month|quarter|6months|year|alltime), rep
    //
    // HubSpot deep links use portal 39921549.
    // Dashboard: https://app.hubspot.com/reports-dashboard/39921549/view/19874520
    if (method === "GET" && path === "/reports") {
      try {
        const section = qp.section || "email_activity";
        const period  = qp.period  || "month";
        const rep     = qp.rep && qp.rep !== "all" ? decodeURIComponent(qp.rep).trim() : null;

        const PORTAL    = "39921549";
        const HS_BASE   = "https://app.hubspot.com";
        const DASHBOARD = `${HS_BASE}/reports-dashboard/${PORTAL}/view/19874520`;
        const CONTACTS_LIST = `${HS_BASE}/contacts/${PORTAL}/objects/0-1/views/all/list`;
        const DEALS_LIST    = `${HS_BASE}/contacts/${PORTAL}/objects/0-3/views/all/list`;
        const SEQUENCES     = `${HS_BASE}/sequences/${PORTAL}`;
        const MKT_EMAIL     = `${HS_BASE}/email/${PORTAL}/manage`;

        const now = Date.now();
        // "Today" = since midnight Eastern Time (CarePathIQ/Cipher team is EST/EDT)
        // Netlify runs in UTC so we must apply Eastern offset manually
        // EDT = UTC-4 (Mar 2nd Sun to Nov 1st Sun), EST = UTC-5 otherwise
        const isEDT = (() => {
          const d = new Date();
          const yr = d.getUTCFullYear();
          // EDT starts 2nd Sunday of March, ends 1st Sunday of November
          const edtStart = new Date(yr, 2, 8 - new Date(yr, 2, 1).getDay()); // approx
          const edtEnd   = new Date(yr, 10, 1 - new Date(yr, 10, 1).getDay() + 7); // approx
          edtStart.setHours(2); edtEnd.setHours(2);
          return d >= edtStart && d < edtEnd;
        })();
        const etOffsetMs = (isEDT ? 4 : 5) * 3600000;
        const etNow      = now - etOffsetMs;
        const etMidnight = etNow - (etNow % 86400000);
        const todaySince = etMidnight + etOffsetMs; // convert back to UTC

        const PERIOD_MS = {
          today:    () => todaySince,
          week:     () => now - 7   * 86400000,
          month:    () => now - 30  * 86400000,
          quarter:  () => now - 90  * 86400000,
          "6months":() => now - 180 * 86400000,
          year:     () => now - 365 * 86400000,
          alltime:  () => null,
          custom:   () => qp.customFrom ? new Date(qp.customFrom).getTime() : now - 30 * 86400000,
        };
        const sinceMs  = (PERIOD_MS[period] ?? PERIOD_MS.month)();
        const untilMs  = (period === 'custom' && qp.customTo) ? new Date(qp.customTo).getTime() + 86400000 : null;
        const sinceISO = sinceMs ? new Date(sinceMs).toISOString() : null;
        const untilISO = untilMs ? new Date(untilMs).toISOString() : null;

        const KNOWN_BDRS = ["Chris Knapp", "Chiara Pate", "Matt Valin", "Joseph Haine", "Tim Grisham", "Irene Wong", "Cole Hooper", "John Hansel"];

        // Owner ID map — ALL reps including BDRs
        // Email engagement objects use hubspot_owner_id not assigned_bdr
        const REP_OWNER_ID_MAP = {
          "Chris Knapp":  "78304576",
          "Chiara Pate":  "87806380",
          "Matt Valin":   "76104455",
          "Joseph Haine": "55217954",
          "Tim Grisham":  "83862037",
          "Irene Wong":   "289209454",
          "Cole Hooper":  "85819247",
          "John Hansel":  "743772047",
        };

        // Build filter for a single rep -- uses hubspot_owner_id for AEs, assigned_bdr for BDRs
        const repFilter1 = (repName, dateProp, sinceVal) => {
          const ownerId = REP_OWNER_ID_MAP[repName];
          const repF = ownerId
            ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }
            : { propertyName: "assigned_bdr",     operator: "EQ", value: repName };
          const dateF = sinceVal
            ? { propertyName: dateProp, operator: "GTE", value: sinceVal }
            : { propertyName: dateProp, operator: "HAS_PROPERTY" };
          return [repF, dateF];
        };

        // OR across two date props for a single rep
        const repCountOr = (propA, propB, repName) => countC([
          { filters: repFilter1(repName, propA, sinceISO) },
          { filters: repFilter1(repName, propB, sinceISO) },
        ]);
        const repNames = rep
          ? rep.split(',').map(s => s.trim()).filter(Boolean)
          : [];
        const ownerIds = qp.owner_id
          ? String(qp.owner_id).split(',').map(s => s.trim()).filter(Boolean)
          : [];
        const targetReps = repNames.length > 0 ? repNames : KNOWN_BDRS;

        const bdrFilters = () => {
          if (repNames.length === 0 && ownerIds.length === 0) {
            return [{ propertyName: "assigned_bdr", operator: "IN", values: KNOWN_BDRS }];
          }
          if (repNames.length > 0 && ownerIds.length === 0) {
            return repNames.length === 1
              ? [{ propertyName: "assigned_bdr", operator: "EQ",  value:  repNames[0] }]
              : [{ propertyName: "assigned_bdr", operator: "IN",  values: repNames    }];
          }
          if (repNames.length === 0 && ownerIds.length > 0) {
            return ownerIds.length === 1
              ? [{ propertyName: "hubspot_owner_id", operator: "EQ",  value:  ownerIds[0] }]
              : [{ propertyName: "hubspot_owner_id", operator: "IN",  values: ownerIds    }];
          }
          // Both present -- return assigned_bdr filter (OR handled via filterGroups below)
          return repNames.length === 1
            ? [{ propertyName: "assigned_bdr", operator: "EQ", value: repNames[0] }]
            : [{ propertyName: "assigned_bdr", operator: "IN", values: repNames }];
        };

        // OR-aware filter groups for recent contacts fetch (handles mixed BDR + AE selections)
        const contactFilterGroups = (extraDateFilter) => {
          const dateF = extraDateFilter ? [extraDateFilter] : [];
          if (repNames.length === 0 && ownerIds.length === 0) {
            return [{ filters: [{ propertyName: "assigned_bdr", operator: "IN", values: KNOWN_BDRS }, ...dateF] }];
          }
          if (repNames.length > 0 && ownerIds.length === 0) {
            return [{ filters: [
              repNames.length === 1
                ? { propertyName: "assigned_bdr", operator: "EQ", value: repNames[0] }
                : { propertyName: "assigned_bdr", operator: "IN", values: repNames },
              ...dateF
            ]}];
          }
          if (repNames.length === 0 && ownerIds.length > 0) {
            return [{ filters: [
              ownerIds.length === 1
                ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerIds[0] }
                : { propertyName: "hubspot_owner_id", operator: "IN", values: ownerIds },
              ...dateF
            ]}];
          }
          // Both: OR logic via two filter groups
          return [
            { filters: [{ propertyName: "assigned_bdr", operator: repNames.length === 1 ? "EQ" : "IN", ...(repNames.length === 1 ? { value: repNames[0] } : { values: repNames }) }, ...dateF] },
            { filters: [{ propertyName: "hubspot_owner_id", operator: ownerIds.length === 1 ? "EQ" : "IN", ...(ownerIds.length === 1 ? { value: ownerIds[0] } : { values: ownerIds }) }, ...dateF] },
          ];
        };

        // Generic count helper
        const countC = async (filterGroups) => {
          try {
            const d = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
              filterGroups, properties: ["assigned_bdr","hubspot_owner_id"], limit: 1,
            });
            return d.total || 0;
          } catch (e) {
            console.error("[reports count]", e.message);
            return 0;
          }
        };

        // Count with single filterGroup
        const count1 = (filters) => countC([{ filters }]);

        // Count with OR across two date props (two filterGroups)
        const countOr = (propA, propB, extraFilters = []) => countC([
          { filters: [...extraFilters, { propertyName: propA, operator: sinceISO ? "GTE" : "HAS_PROPERTY", ...(sinceISO ? { value: sinceISO } : {}) }] },
          { filters: [...extraFilters, { propertyName: propB, operator: sinceISO ? "GTE" : "HAS_PROPERTY", ...(sinceISO ? { value: sinceISO } : {}) }] },
        ]);

        // Batch query: get accurate counts for ALL reps for a single metric.
        // Runs one count query per rep in parallel (uses limit:1 + total for accuracy).
        // Returns map of repName -> count.
        const BDR_NAMES_LIST    = ["Chris Knapp", "Chiara Pate"];
        const AE_OWNER_IDS_LIST = Object.values(REP_OWNER_ID_MAP);
        const ownerIdToRepName  = Object.fromEntries(Object.entries(REP_OWNER_ID_MAP).map(([n,id]) => [id, n]));
        const ALL_REPS          = KNOWN_BDRS;

        const countAllRepsForMetric = async (dateProp) => {
          const dateF = sinceISO
            ? { propertyName: dateProp, operator: "GTE", value: sinceISO }
            : { propertyName: dateProp, operator: "HAS_PROPERTY" };

          // Run one count query per rep in parallel -- limit:1 so we just get total
          const results = await Promise.all(ALL_REPS.map(async repName => {
            const ownerId = REP_OWNER_ID_MAP[repName];
            const repF = ownerId
              ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }
              : { propertyName: "assigned_bdr",     operator: "EQ", value: repName };
            try {
              const d = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
                filterGroups: [{ filters: [repF, dateF] }],
                properties: ["hs_object_id"], limit: 1,
              });
              return [repName, d.total || 0];
            } catch { return [repName, 0]; }
          }));

          return Object.fromEntries(results);
        };

        // Date filter for a property
        const df = (prop) => sinceISO
          ? [{ propertyName: prop, operator: "GTE", value: sinceISO }]
          : [{ propertyName: prop, operator: "HAS_PROPERTY" }];

        // Fetch contacts helper
        const fetchC = async (filterGroups, props, sortProp, limit = 100) => {
          try {
            const results = [];
            let after;
            while (results.length < limit) {
              const body = {
                filterGroups, properties: props,
                sorts: [{ propertyName: sortProp, direction: "DESCENDING" }],
                limit: Math.min(100, limit - results.length),
              };
              if (after) body.after = after;
              const d = await hsPost(user.userId, "/crm/v3/objects/contacts/search", body);
              results.push(...(d.results || []));
              if (!d.paging?.next?.after || (d.results||[]).length < 100) break;
              after = d.paging.next.after;
              await new Promise(r => setTimeout(r, 150));
            }
            console.log(`[reports fetchC] sortProp=${sortProp} returned=${results.length}`);
            return results;
          } catch (err) {
            console.error(`[reports fetchC] error: ${err.message}`);
            return [];
          }
        };

        // ── EMAIL ACTIVITY ────────────────────────────────────────────────────
        // Uses /email/public/v1/stats/by-event-type for SUM metrics matching
        // HubSpot's "Email Activity Results" report (sent, opens, clicks, replies).
        // Falls back to contact property counts if the stats API is unavailable.
        if (section === "email_activity") {
          const bdr = bdrFilters();

          // Run stats API attempt AND recent contacts fetch in parallel with rep counts
          const [emailStatsResult, recentContacts] = await Promise.all([
            // Try the email stats API -- returns SUM totals directly
            hsGet(user.userId, "/email/public/v1/stats/by-event-type",
              sinceISO ? { startTimestamp: sinceMs, endTimestamp: now } : {}
            ).then(d => { console.log("[reports email] stats API:", JSON.stringify(d).slice(0,200)); return d; })
              .catch(e => { console.log("[reports email] stats API unavailable:", e.message); return null; }),

            // Recent activity contacts (runs in parallel, not blocked by rep counts)
            fetchC(
              contactFilterGroups(sinceISO ? { propertyName: "hs_email_last_send_date", operator: "GTE", value: sinceISO } : { propertyName: "hs_email_last_send_date", operator: "HAS_PROPERTY" }),
              ["firstname","lastname","email","company","assigned_bdr",
               "hs_email_last_send_date","hs_email_last_email_name",
               "hs_email_last_open_date","hs_email_last_click_date",
               "hs_email_last_reply_date","hs_sales_email_last_replied"],
              "hs_email_last_send_date", 300
            ),
          ]);
          const emailStats = emailStatsResult;

          // ── Per-rep breakdown -- sequential with 300ms gaps to avoid 429s ────
          // Sent count: use v3 email engagement objects (accurate for sequences + 1:1)
          // hs_email_last_send_date only tracks marketing emails, not sequence emails
          const SALES_EMAIL_OWNER_MAP = { ...REP_OWNER_ID_MAP, "Chris Knapp":"78304576", "Chiara Pate":"87806380" };
          const sentCountsRaw = await Promise.all(targetReps.map(async repName => {
            const ownerId = SALES_EMAIL_OWNER_MAP[repName];
            if (!ownerId) return [repName, 0];
            const filters = [
              { propertyName: "hs_email_direction", operator: "EQ",  value: "EMAIL" },
              { propertyName: "hs_timestamp",       operator: "GTE", value: sinceISO },
              { propertyName: "hubspot_owner_id",   operator: "EQ",  value: ownerId },
            ];
            const d = await hsPost(user.userId, "/crm/v3/objects/emails/search", {
              filterGroups: [{ filters }], properties: ["hs_timestamp"], limit: 1,
            }).catch(() => ({ total: 0 }));
            return [repName, d.total || 0];
          }));
          const sentCounts = Object.fromEntries(sentCountsRaw);
          await new Promise(r => setTimeout(r, 300));
          const openCounts  = await countAllRepsForMetric("hs_email_last_open_date");
          await new Promise(r => setTimeout(r, 300));
          const clickCounts = await countAllRepsForMetric("hs_email_last_click_date");
          await new Promise(r => setTimeout(r, 300));
          const replyCounts = await countAllRepsForMetric("hs_email_last_reply_date");
          await new Promise(r => setTimeout(r, 300));
          const seqCounts   = await countAllRepsForMetric("hs_latest_sequence_enrolled_date");

          const repData = targetReps.map(repName => {
            const sent    = sentCounts[repName]  || 0;
            const opens   = openCounts[repName]  || 0;
            const clicks  = clickCounts[repName] || 0;
            const replies = replyCounts[repName] || 0;
            const seqs    = seqCounts[repName]   || 0;
            return {
              rep: repName, sent, opens, clicks, replies, sequences: seqs,
              openRate:  sent > 0 ? +((opens   / sent) * 100).toFixed(1) : 0,
              clickRate: sent > 0 ? +((clicks  / sent) * 100).toFixed(1) : 0,
              replyRate: sent > 0 ? +((replies / sent) * 100).toFixed(1) : 0,
            };
          });


          // Team totals -- use stats API if available, otherwise sum rep data
          let T;
          if (emailStats && (emailStats.sent || emailStats.SENT)) {
            const s = emailStats;
            const totalSent    = s.sent    || s.SENT    || 0;
            const totalOpens   = s.open    || s.OPEN    || s.opens   || 0;
            const totalClicks  = s.click   || s.CLICK   || s.clicks  || 0;
            const totalReplies = s.reply   || s.REPLY   || s.replies || 0;
            T = {
              sent: totalSent, opens: totalOpens, clicks: totalClicks, replies: totalReplies,
              sequences: repData.reduce((a,r) => a + r.sequences, 0),
              openRate:  totalSent > 0 ? +((totalOpens   / totalSent) * 100).toFixed(1) : 0,
              clickRate: totalSent > 0 ? +((totalClicks  / totalSent) * 100).toFixed(1) : 0,
              replyRate: totalSent > 0 ? +((totalReplies / totalSent) * 100).toFixed(1) : 0,
              source: "stats_api",
            };
          } else {
            // Fall back to summing rep data (unique contacts, not raw event counts)
            T = repData.reduce((a, r) => ({
              sent:      a.sent      + r.sent,
              opens:     a.opens     + r.opens,
              clicks:    a.clicks    + r.clicks,
              replies:   a.replies   + r.replies,
              sequences: a.sequences + r.sequences,
            }), { sent:0, opens:0, clicks:0, replies:0, sequences:0 });
            T.openRate  = T.sent > 0 ? +((T.opens   / T.sent) * 100).toFixed(1) : 0;
            T.clickRate = T.sent > 0 ? +((T.clicks  / T.sent) * 100).toFixed(1) : 0;
            T.replyRate = T.sent > 0 ? +((T.replies / T.sent) * 100).toFixed(1) : 0;
            T.source    = "contact_properties";
          }

          return ok({
            section: "email_activity", period, rep: rep || "all",
            totals: T,
            byRep: repData,
            links: { dashboard: DASHBOARD, contacts: CONTACTS_LIST },
            recent: recentContacts.map(c => {
              const p = c.properties || {};
              const replyDate = p.hs_email_last_reply_date || p.hs_sales_email_last_replied || null;
              return {
                id: c.id, name: `${p.firstname||""} ${p.lastname||""}`.trim(),
                company: p.company || "", bdr: p.assigned_bdr || "",
                sent: p.hs_email_last_send_date || null,
                opened: p.hs_email_last_open_date || null,
                clicked: p.hs_email_last_click_date || null,
                replied: replyDate,
                emailName: p.hs_email_last_email_name || null,
                url: `${HS_BASE}/contacts/${PORTAL}/record/0-1/${c.id}`,
              };
            }),
          });
        }

        // ── MARKETING ─────────────────────────────────────────────────────────
        // Deliberately disabled — the `content` scope this depended on
        // (/marketing/v3/emails) was removed in the Aug/Sept 2026 HubSpot
        // permission audit. That scope also demanded unrelated HubSpot
        // seat permissions (Blog Writer, Landing Pages, Design Tools,
        // Knowledge Base, URL Redirects) that a new BDR's seat is unlikely
        // to have — a real, recurring signup-friction cost for a reporting
        // tab that was only used occasionally. The tradeoff was decided
        // deliberately in favor of frictionless onboarding: view Marketing
        // Email stats directly in HubSpot's own reporting instead.
        // The original implementation below is left in place, commented
        // out, in case this scope is ever reinstated and this is wanted
        // back — it was working code, not abandoned code.
        if (section === "marketing") {
          return ok({
            section: "marketing",
            disabled: true,
            message: "Marketing Email reporting was intentionally disabled to keep HubSpot sign-in permissions minimal. View Marketing Email stats directly in HubSpot's own reporting instead.",
            emails: [],
          });
        }
        if (false) {

          // Owner ID → user ID map (same for Chris; may differ for others)
          // We match on createdById which equals userId in HubSpot
          // Maps owner ID → HubSpot user ID for marketing email author filtering
          const OWNER_TO_USER = {
            "78304576":  "78304576",  // Chris Knapp
            "87806380":  "87806380",  // Chiara Pate
            "76104455":  "76104455",  // Matt Valin
            "55217954":  "55217954",  // Joseph Haine
            "83862037":  "83862037",  // Tim Grisham
            "289209454": "289209454", // Irene Wong
            "85819247":  "85819247",  // Cole Hooper
            "743772047": "743772047", // John Hansel
          };
          const NAME_TO_OWNER = {
            "Chris Knapp":   "78304576",
            "Chiara Pate":   "87806380",
            "Matt Valin":    "76104455",
            "Joseph Haine":  "55217954",
            "Tim Grisham":   "83862037",
            "Irene Wong":    "289209454",
            "Cole Hooper":   "85819247",
            "John Hansel":   "743772047",
          };
          const repUserId = rep ? (OWNER_TO_USER[NAME_TO_OWNER[rep] || ""] || rep) : null;

          // Step 1: Fetch email list
          let allEmails = [];
          try {
            let after, fetched = 0;
            while (fetched < 200) {
              // Don't filter by state -- try fetching all and filter client-side
              // The v3 API state values are: DRAFT, SCHEDULED, PROCESSING, SENT, PUBLISHED, ARCHIVED
              const params = { limit: 50 };
              if (after) params.after = after;
              const d = await hsGet(user.userId, "/marketing/v3/emails", params);
              allEmails.push(...(d.results || []));
              fetched += (d.results || []).length;
              if (!d.paging?.next?.after || (d.results||[]).length < 50) break;
              after = d.paging.next.after;
            }
            console.log(`[reports mkt] fetched ${allEmails.length} sent emails`);
            if (allEmails.length > 0) {
              const s = allEmails[0];
              console.log("[reports mkt] sample fields:", Object.keys(s).join(", "));
              console.log("[reports mkt] sample:", JSON.stringify(s).slice(0,400));
            }
          } catch (e) {
            console.error("[reports mkt] email list error:", e.message);
          }

          // Filter to sent emails only, within period
          const SENT_STATES = ["SENT", "PUBLISHED"];
          const inPeriod = allEmails.filter(e => {
            // Only include sent/published emails
            if (e.state && !SENT_STATES.includes(e.state)) return false;
            const ts = e.publishDate || e.scheduledAt || e.sendDate || e.updatedAt || e.createdAt;
            if (sinceMs && ts && new Date(ts).getTime() < sinceMs) return false;
            return true;
          });
          console.log(`[reports mkt] ${inPeriod.length} sent emails in period (of ${allEmails.length} total)`);

          // Rep filter -- try createdById, authorId, userId, createdBy
          const inPeriodFiltered = repUserId
            ? inPeriod.filter(e => {
                const ids = [
                  String(e.createdById || ""),
                  String(e.authorId    || ""),
                  String(e.userId      || ""),
                  String(e.createdBy   || ""),
                  String(e.ownerId     || ""),
                ].filter(Boolean);
                return ids.some(id => id === repUserId);
              })
            : inPeriod;

          console.log(`[reports mkt] ${inPeriodFiltered.length} emails in period${rep ? ' for '+rep : ''}`);

          // Step 3: Fetch statistics via /email/public/v1/campaigns/{campaignId}
          // The /marketing/v3/emails/{id}/statistics endpoint returns 404 -- stats
          // live on the email campaign object. Each email has allEmailCampaignIds;
          // we use the first one to get send/open/click/reply counts.
          let totalSent = 0, totalOpened = 0, totalClicked = 0, totalReplied = 0;
          const campaigns = [];

          const emailsToStat = inPeriodFiltered.slice(0, 30);
          const statsResults = await Promise.all(
            emailsToStat.map(async e => {
              const campaignId = (e.allEmailCampaignIds || [])[0];
              if (!campaignId) return null;
              return hsGet(user.userId, `/email/public/v1/campaigns/${campaignId}`, {})
                .then(r => {
                  if (emailsToStat.indexOf(e) === 0) {
                    console.log("[reports mkt] campaign stats:", JSON.stringify(r).slice(0, 400));
                  }
                  return r;
                })
                .catch(err => {
                  if (emailsToStat.indexOf(e) === 0) {
                    console.error(`[reports mkt] campaign stats error:`, err.message);
                  }
                  return null;
                });
            })
          );

          for (let i = 0; i < emailsToStat.length; i++) {
            const e = emailsToStat[i];
            const stats = statsResults[i];

            // /email/public/v1/campaigns/{id} returns:
            // { counters: { sent, open, click, reply, unsubscribed, bounce, hardbounce, softbounce } }
            const counters = stats?.counters || {};

            const sent         = Number(counters.sent          || counters.delivered    || 0);
            const opened       = Number(counters.open          || counters.opens         || 0);
            const clicked      = Number(counters.click         || counters.clicks        || 0);
            const replied      = Number(counters.reply         || counters.replies       || 0);
            const unsubscribed = Number(counters.unsubscribed  || counters.unsubscribe   || 0);
            const hardbounced  = Number(counters.hardbounce    || counters.hardbounced   || 0);
            const softbounced  = Number(counters.softbounce    || counters.softbounced   || 0);
            const bounced      = Number(counters.bounce        || 0) || hardbounced + softbounced;

            totalSent    += sent;
            totalOpened  += opened;
            totalClicked += clicked;
            totalReplied += replied;

            campaigns.push({
              name:        e.name || e.subject || "Untitled",
              sent, opened, clicked, replied, unsubscribed, bounced, hardbounced, softbounced,
              openRate:        sent > 0 ? +((opened       / sent) * 100).toFixed(1) : 0,
              clickRate:       sent > 0 ? +((clicked      / sent) * 100).toFixed(1) : 0,
              replyRate:       sent > 0 ? +((replied      / sent) * 100).toFixed(1) : 0,
              unsubscribeRate: sent > 0 ? +((unsubscribed / sent) * 100).toFixed(1) : 0,
              bounceRate:      sent > 0 ? +((bounced      / sent) * 100).toFixed(1) : 0,
              publishDate: e.publishDate || e.publishedAt || e.scheduledAt || null,
              publishedBy: e.publishedByName || null,
              url: `${HS_BASE}/email/${PORTAL}/details/${e.id}/performance`,
            });
          }

          campaigns.sort((a, b) => {
            const tsA = a.publishDate ? new Date(a.publishDate).getTime() : 0;
            const tsB = b.publishDate ? new Date(b.publishDate).getTime() : 0;
            return tsB - tsA || b.sent - a.sent;
          });

          const openRate  = totalSent > 0 ? +((totalOpened  / totalSent) * 100).toFixed(1) : 0;
          const clickRate = totalSent > 0 ? +((totalClicked / totalSent) * 100).toFixed(1) : 0;
          const replyRate = totalSent > 0 ? +((totalReplied / totalSent) * 100).toFixed(1) : 0;

          // Per-rep breakdown
          const repData = [];
          for (const repName of targetReps) {
            const rUserId = OWNER_TO_USER[NAME_TO_OWNER[repName] || ""] || "";
            const repEmails = rUserId
              ? inPeriod.filter(e => [
                  String(e.createdById || ""), String(e.authorId || ""),
                  String(e.userId || ""), String(e.createdBy || ""),
                ].some(id => id === rUserId))
              : [];
            let rSent = 0, rOpened = 0, rClicked = 0, rReplied = 0;
            for (let i = 0; i < emailsToStat.length; i++) {
              const e = emailsToStat[i];
              if (!repEmails.find(re => re.id === e.id)) continue;
              const counters = statsResults[i]?.counters || {};
              rSent    += Number(counters.sent   || counters.delivered || 0);
              rOpened  += Number(counters.open   || counters.opens     || 0);
              rClicked += Number(counters.click  || counters.clicks    || 0);
              rReplied += Number(counters.reply  || counters.replies   || 0);
            }
            repData.push({
              rep: repName, emailCount: repEmails.length,
              reached: rSent, opened: rOpened, clicked: rClicked, replied: rReplied,
              openRate:  rSent > 0 ? +((rOpened  / rSent) * 100).toFixed(1) : 0,
              clickRate: rSent > 0 ? +((rClicked / rSent) * 100).toFixed(1) : 0,
              replyRate: rSent > 0 ? +((rReplied / rSent) * 100).toFixed(1) : 0,
            });
          }

          // Only use fallback if we couldn't fetch ANY emails at all
          const usedFallback = allEmails.length === 0;
          let totals;
          if (usedFallback) {
            const [fbReached, fbOpened, fbClicked, fbReplied] = await Promise.all([
              countC(contactFilterGroups(sinceISO ? { propertyName: "hs_email_last_send_date",  operator: "GTE", value: sinceISO } : { propertyName: "hs_email_last_send_date",  operator: "HAS_PROPERTY" })),
              countC(contactFilterGroups(sinceISO ? { propertyName: "hs_email_last_open_date",  operator: "GTE", value: sinceISO } : { propertyName: "hs_email_last_open_date",  operator: "HAS_PROPERTY" })),
              countC(contactFilterGroups(sinceISO ? { propertyName: "hs_email_last_click_date", operator: "GTE", value: sinceISO } : { propertyName: "hs_email_last_click_date", operator: "HAS_PROPERTY" })),
              countC(contactFilterGroups(sinceISO ? { propertyName: "hs_email_last_reply_date", operator: "GTE", value: sinceISO } : { propertyName: "hs_email_last_reply_date", operator: "HAS_PROPERTY" })),
            ]);
            totals = {
              totalReached: fbReached, totalOpened: fbOpened,
              totalClicked: fbClicked, totalReplied: fbReplied,
              openRate:  fbReached > 0 ? +((fbOpened  / fbReached) * 100).toFixed(1) : 0,
              clickRate: fbReached > 0 ? +((fbClicked / fbReached) * 100).toFixed(1) : 0,
              replyRate: fbReached > 0 ? +((fbReplied / fbReached) * 100).toFixed(1) : 0,
            };
          } else {
            totals = { totalReached: totalSent, totalOpened, totalClicked, totalReplied, openRate, clickRate, replyRate };
          }

          return ok({
            section: "marketing", period, rep: rep || "all",
            totals,
            byRep: repData,
            campaigns,
            usedFallback,
            links: { dashboard: DASHBOARD, manage: MKT_EMAIL },
          });
        }

        // ── SEQUENCES ─────────────────────────────────────────────────────────
        // Shows: Enrollment count, clicks, opens, replies, unsubscribes, bounces
        // matching HubSpot's "Sequence Enrollments - Sales Team" report.
        if (section === "sequences") {
          const seqActiveF = { propertyName: "hs_sequences_is_enrolled", operator: "EQ", value: "true" };
          const isEveryoneFilter = repNames.length === 0 && ownerIds.length === 0;

          // Single source of truth: fetch all enrolled contacts for the period
          // KPI bar, byRep, and bySequence all derive from this one contact set
          // so they will always be consistent regardless of period or rep filter
          const seqContactGroups = isEveryoneFilter
            ? [{ filters: sinceISO
                ? [{ propertyName: "hs_latest_sequence_enrolled_date", operator: "GTE", value: sinceISO }]
                : [seqActiveF] }]
            : contactFilterGroups(sinceISO
                ? { propertyName: "hs_latest_sequence_enrolled_date", operator: "GTE", value: sinceISO }
                : null);

          // Get accurate total count first (limit:1 + total — not capped)
          const seqCountData = await hsPost(user.userId, "/crm/v3/objects/contacts/search", {
            filterGroups: seqContactGroups,
            properties: ["assigned_bdr"],
            limit: 1,
          }).catch(() => ({ total: 0 }));
          const enrolled = seqCountData.total || 0;

          // Fetch up to 500 for breakdown detail (byRep, bySequence, opens/clicks/replies)
          // The KPI total uses the accurate count above
          const allSeqContacts = await fetchC(
            seqContactGroups,
            ["assigned_bdr","hubspot_owner_id","hs_latest_sequence_enrolled",
             "hs_latest_sequence_enrolled_date","hs_email_last_reply_date",
             "hs_sales_email_last_replied","hs_email_last_open_date",
             "hs_email_last_click_date"],
            "hs_latest_sequence_enrolled_date",
            500
          );

          // Opens/clicks/replies are ratios from the sample — scale to full enrolled count
          const sampleSize = allSeqContacts.length || 1;
          const sampleOpened  = allSeqContacts.filter(c => c.properties?.hs_email_last_open_date).length;
          const sampleClicked = allSeqContacts.filter(c => c.properties?.hs_email_last_click_date).length;
          const sampleReplied = allSeqContacts.filter(c =>
            c.properties?.hs_email_last_reply_date || c.properties?.hs_sales_email_last_replied
          ).length;
          // Scale to full population
          const seqOpened  = Math.round((sampleOpened  / sampleSize) * enrolled);
          const seqClicked = Math.round((sampleClicked / sampleSize) * enrolled);
          const seqReplied = Math.round((sampleReplied / sampleSize) * enrolled);

          const replyRate = enrolled > 0 ? +((seqReplied / enrolled) * 100).toFixed(1) : 0;
          const openRate  = enrolled > 0 ? +((seqOpened  / enrolled) * 100).toFixed(1) : 0;
          const clickRate = enrolled > 0 ? +((seqClicked / enrolled) * 100).toFixed(1) : 0;

          // Per-rep: tally from same contact set
          const repData = [];
          for (const repName of targetReps) {
            const ownerId = REP_OWNER_ID_MAP[repName];
            const repContacts = allSeqContacts.filter(c => ownerId
              ? c.properties?.hubspot_owner_id === ownerId
              : c.properties?.assigned_bdr === repName
            );
            const rEnrolled = repContacts.length;
            const rOpened   = repContacts.filter(c => c.properties?.hs_email_last_open_date).length;
            const rClicked  = repContacts.filter(c => c.properties?.hs_email_last_click_date).length;
            const rReplied  = repContacts.filter(c =>
              c.properties?.hs_email_last_reply_date || c.properties?.hs_sales_email_last_replied
            ).length;
            repData.push({
              rep: repName, enrolled: rEnrolled, replied: rReplied, opened: rOpened, clicked: rClicked,
              replyRate: rEnrolled > 0 ? +((rReplied / rEnrolled) * 100).toFixed(1) : 0,
              openRate:  rEnrolled > 0 ? +((rOpened  / rEnrolled) * 100).toFixed(1) : 0,
              clickRate: rEnrolled > 0 ? +((rClicked / rEnrolled) * 100).toFixed(1) : 0,
            });
          }

          // Per-sequence breakdown — reuse allSeqContacts (already fetched above)
          const bySequence = {};
          // Reuse allSeqContacts — no second fetch needed
          try {
            for (const c of allSeqContacts) {
              const p = c.properties || {};
              const seqId = p.hs_latest_sequence_enrolled || "Unknown";
              if (!bySequence[seqId]) bySequence[seqId] = { sequenceId: seqId, enrolled:0, replied:0, opened:0, clicked:0 };
              bySequence[seqId].enrolled++;
              if (p.hs_email_last_reply_date || p.hs_sales_email_last_replied) bySequence[seqId].replied++;
              if (p.hs_email_last_open_date)  bySequence[seqId].opened++;
              if (p.hs_email_last_click_date) bySequence[seqId].clicked++;
            }
          } catch (e) { console.error("[reports sequences]", e.message); }

          // Resolve sequence names
          const seqIds = [...new Set(Object.keys(bySequence))].filter(id => id !== "Unknown");
          const seqNames = {};
          if (seqIds.length > 0) {
            try {
              // sequence_enrollments has hs_sequence_name — use it to resolve IDs to names
              // Search for one enrollment per sequence ID to get the name
              const enrollSearch = await hsPost(user.userId, "/crm/v3/objects/sequence_enrollments/search", {
                filterGroups: seqIds.slice(0, 50).map(id => ({
                  filters: [{ propertyName: "hs_sequence_id", operator: "EQ", value: id }]
                })),
                properties: ["hs_sequence_id", "hs_sequence_name"],
                limit: 50,
              });
              for (const enr of (enrollSearch.results || [])) {
                const seqId   = enr.properties?.hs_sequence_id;
                const seqName = enr.properties?.hs_sequence_name;
                if (seqId && seqName && !seqNames[seqId]) {
                  seqNames[seqId] = seqName;
                }
              }
              console.log(`[sequences] resolved ${Object.keys(seqNames).length}/${seqIds.length} sequence names`);
            } catch (e) {
              console.log("[reports] sequence name lookup failed:", e.message);
            }
          }

          const sequences = Object.values(bySequence).map(s => ({
            ...s,
            sequenceName: seqNames[s.sequenceId] || `Sequence #${s.sequenceId}`,
            sequenceUrl:  `https://app.hubspot.com/sequences/${PORTAL}/sequence/${s.sequenceId}`,
            replyRate: s.enrolled > 0 ? +((s.replied / s.enrolled) * 100).toFixed(1) : 0,
            openRate:  s.enrolled > 0 ? +((s.opened  / s.enrolled) * 100).toFixed(1) : 0,
            clickRate: s.enrolled > 0 ? +((s.clicked / s.enrolled) * 100).toFixed(1) : 0,
          })).sort((a,b) => b.enrolled - a.enrolled).slice(0, 30);

          // Compliance counts -- opted out and bounced contacts (OR across bdr/owner)
          const [optedOut, bounced, badAddress] = await Promise.all([
            countC(contactFilterGroups({ propertyName: "hs_email_optout",      operator: "EQ", value: "true" })),
            countC(contactFilterGroups({ propertyName: "hs_email_bounce",      operator: "EQ", value: "true" })),
            countC(contactFilterGroups({ propertyName: "hs_email_bad_address", operator: "EQ", value: "true" })),
          ]);

          // Fetch meetings for reps in this period (same logic as team_activity)
          const seqMeetingCountByRep = {};
          const seqMeetingDetails = [];
          targetReps.forEach(r => { seqMeetingCountByRep[r] = 0; });
          try {
            const SEQ_OWNER_MAP = { ...REP_OWNER_ID_MAP, "Chris Knapp":"78304576", "Chiara Pate":"87806380" };
            const seqMeetOwnerIds = [...new Set(targetReps.map(r => SEQ_OWNER_MAP[r]).filter(Boolean))];
            if (seqMeetOwnerIds.length > 0 && sinceISO) {
              const mData = await hsPost(user.userId, "/crm/v3/objects/meetings/search", {
                filterGroups: seqMeetOwnerIds.map(id => ({ filters: [
                  { propertyName: "hubspot_owner_id",      operator: "EQ",  value: id },
                  { propertyName: "hs_meeting_start_time", operator: "GTE", value: sinceISO },
                ]})),
                properties: ["hs_meeting_title","hs_meeting_start_time","hubspot_owner_id"],
                sorts: [{ propertyName: "hs_meeting_start_time", direction: "DESCENDING" }],
                limit: 100,
              }).catch(() => ({ results: [] }));
              const ownerToRep = Object.fromEntries(Object.entries(SEQ_OWNER_MAP).map(([n,id]) => [id, n]));
              const seenT = new Set();
              const deduped = (mData.results || [])
                .filter(m => !(m.properties?.hs_meeting_title||'').match(/\[Canceled\]|\bcanceled\b|\bcancelled\b/i))
                .sort((a,b) => ((a.properties?.hs_meeting_title||'').startsWith('[Gong]')?1:0) - ((b.properties?.hs_meeting_title||'').startsWith('[Gong]')?1:0))
                .filter(m => { const t = m.properties?.hs_meeting_start_time||m.id; if (seenT.has(t)) return false; seenT.add(t); return true; });
              for (const m of deduped) {
                const repName = ownerToRep[m.properties?.hubspot_owner_id];
                if (repName) {
                  seqMeetingCountByRep[repName] = (seqMeetingCountByRep[repName]||0) + 1;
                  seqMeetingDetails.push({
                    title: (m.properties?.hs_meeting_title||'Meeting').replace(/^\[Gong\]\s*/i,''),
                    date:  m.properties?.hs_meeting_start_time || null,
                    ownerName: repName,
                  });
                }
              }
            }
          } catch { /* silently skip */ }

          // Add meetings to repData
          const repDataWithMeetings = repData.map(r => ({
            ...r,
            meetings: seqMeetingCountByRep[r.rep] || 0,
          }));

          return ok({
            section: "sequences", period, rep: rep || "all",
            totals: {
              enrolled, replied: seqReplied, opened: seqOpened, clicked: seqClicked,
              replyRate, openRate, clickRate,
              meetings: Object.values(seqMeetingCountByRep).reduce((a,b)=>a+b, 0),
            },
            compliance: { optedOut, bounced, badAddress },
            byRep: repDataWithMeetings,
            meetingDetails: seqMeetingDetails,
            sequences,
            links: { dashboard: DASHBOARD, sequences: SEQUENCES },
          });
        }

        // ── DEALS ─────────────────────────────────────────────────────────────
        if (section === "deals") {
          const ownerFilter = qp.owner ? [{ propertyName: "hubspot_owner_id", operator: "EQ", value: qp.owner }] : [];
          const dateFilters = sinceISO ? [{ propertyName: "createdate", operator: "GTE", value: sinceISO }] : [];

          const PIPELINES = {
            "679336808": "New Business Opportunity",
            "679502246": "Expansion Deal",
            "678610513": "New Business Deal",
          };
          const STAGES = {
            "995708483": { label:"Target Identified",              pipeline:"679336808", won:false, lost:false },
            "995708484": { label:"Initial Outreach/Reengaged",     pipeline:"679336808", won:false, lost:false },
            "1284036410":{ label:"Email Opened/No Response",       pipeline:"679336808", won:false, lost:false },
            "1288757038":{ label:"Reengagement Needed",            pipeline:"679336808", won:false, lost:false },
            "995708485": { label:"Engaged",                        pipeline:"679336808", won:false, lost:false },
            "995708486": { label:"Meeting Scheduled",              pipeline:"679336808", won:false, lost:false },
            "995708487": { label:"Meeting Completed",              pipeline:"679336808", won:false, lost:false },
            "995708488": { label:"Qualified",                      pipeline:"679336808", won:false, lost:false },
            "995708489": { label:"Unengaged",                      pipeline:"679336808", won:false, lost:false },
            "996311842": { label:"Trade Show Follow-Up",           pipeline:"679336808", won:false, lost:false },
            "1331037807":{ label:"Meeting Completed - Not A Fit",  pipeline:"679336808", won:false, lost:false },
            "1331034125":{ label:"Meeting Completed - Partnership", pipeline:"679336808", won:false, lost:false },
            "1347324753":{ label:"Closed/Lost",                    pipeline:"679336808", won:false, lost:true  },
            "995723921": { label:"Expansion Targets",              pipeline:"679502246", won:false, lost:false },
            "995723922": { label:"Engaged",                        pipeline:"679502246", won:false, lost:false },
            "995723923": { label:"Value Prop/Scoping",             pipeline:"679502246", won:false, lost:false },
            "995723924": { label:"Pricing Proposal",               pipeline:"679502246", won:false, lost:false },
            "995723926": { label:"Procurement/Contracting",        pipeline:"679502246", won:false, lost:false },
            "995723927": { label:"Closed Lost",                    pipeline:"679502246", won:false, lost:true  },
            "995739776": { label:"Closed Won",                     pipeline:"679502246", won:true,  lost:false },
            "1004627778":{ label:"Revisit",                        pipeline:"679502246", won:false, lost:false },
            "995756094": { label:"Qualified",                      pipeline:"678610513", won:false, lost:false },
            "995756095": { label:"Problem Solution Fit",           pipeline:"678610513", won:false, lost:false },
            "995756096": { label:"Value Prop/Scoping",             pipeline:"678610513", won:false, lost:false },
            "995756097": { label:"Pricing Proposal",               pipeline:"678610513", won:false, lost:false },
            "995756098": { label:"IT/Technical Review",            pipeline:"678610513", won:false, lost:false },
            "995756099": { label:"Contracting/Legal",              pipeline:"678610513", won:false, lost:false },
            "995756100": { label:"Closed - Lost",                  pipeline:"678610513", won:false, lost:true  },
            "995749999": { label:"Closed - Won",                   pipeline:"678610513", won:true,  lost:false },
            "995750000": { label:"Revisit",                        pipeline:"678610513", won:false, lost:false },
          };

          // Fetch all deals in period
          let allDeals = [], after;
          while (allDeals.length < 1000) {
            const body = {
              filterGroups: [{ filters: [...ownerFilter, ...dateFilters] }],
              properties: ["dealname","dealstage","pipeline","amount","closedate","createdate","hubspot_owner_id","hs_projected_amount","closed_lost_reason"],
              sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
              limit: 100,
            };
            if (after) body.after = after;
            const d = await hsPost(user.userId, "/crm/v3/objects/deals/search", body).catch(() => ({ results:[] }));
            allDeals.push(...(d.results || []));
            if (!d.paging?.next?.after || (d.results||[]).length < 100) break;
            after = d.paging.next.after;
            await new Promise(r => setTimeout(r, 150));
          }

          let totalValue=0, totalWeighted=0, wonCount=0, wonValue=0, lostCount=0, lostValue=0;
          const byStage={}, byPipeline={}, lostReasons={}, closedDays=[];

          for (const deal of allDeals) {
            const p = deal.properties || {};
            const amt = parseFloat(p.amount||0);
            const wt  = parseFloat(p.hs_projected_amount||0);
            const stage = STAGES[p.dealstage] || {};
            const pipeId = p.pipeline || "";

            totalValue    += amt;
            totalWeighted += wt;

            if (!byPipeline[pipeId]) byPipeline[pipeId] = { label: PIPELINES[pipeId]||pipeId, count:0, value:0, weighted:0 };
            byPipeline[pipeId].count++;
            byPipeline[pipeId].value    += amt;
            byPipeline[pipeId].weighted += wt;

            const sk = p.dealstage||"unknown";
            if (!byStage[sk]) byStage[sk] = { label: stage.label||sk, pipeline: PIPELINES[pipeId]||pipeId, count:0, value:0, won:stage.won||false, lost:stage.lost||false };
            byStage[sk].count++;
            byStage[sk].value += amt;

            if (stage.won)  { wonCount++;  wonValue  += amt; if (p.createdate && p.closedate) closedDays.push(Math.round((new Date(p.closedate)-new Date(p.createdate))/(86400000))); }
            if (stage.lost) { lostCount++; lostValue += amt; const r = p.closed_lost_reason||"No reason"; lostReasons[r]=(lostReasons[r]||0)+1; }
          }

          const winRate    = (wonCount+lostCount) > 0 ? +(wonCount/(wonCount+lostCount)*100).toFixed(1) : 0;
          const avgVelocity= closedDays.length > 0 ? Math.round(closedDays.reduce((a,b)=>a+b,0)/closedDays.length) : null;
          const avgDealSize= wonCount > 0 ? Math.round(wonValue/wonCount) : 0;

          return ok({
            section: "deals", period, owner: qp.owner || null,
            totals: { total: allDeals.length, totalValue, totalWeighted, wonCount, wonValue, lostCount, lostValue, winRate, avgVelocity, avgDealSize },
            byPipeline: Object.entries(byPipeline).map(([pipeId, p]) => ({
              ...p,
              pipelineId: pipeId,
              // HubSpot deal board filtered by pipeline
              url: `${HS_BASE}/contacts/${PORTAL}/deals/board/view/all?pipelineId=${pipeId}`,
            })).sort((a,b)=>b.count-a.count),
            byStage:    Object.values(byStage).sort((a,b)=>b.count-a.count),
            lostReasons: Object.entries(lostReasons).map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count),
            recentDeals: allDeals.slice(0,200).map(deal => {
              const p = deal.properties||{};
              const stage = STAGES[p.dealstage]||{};
              return {
                id: deal.id, name: p.dealname||"", stage: stage.label||p.dealstage||"",
                pipeline: PIPELINES[p.pipeline]||p.pipeline||"",
                amount: parseFloat(p.amount||0), weighted: parseFloat(p.hs_projected_amount||0),
                closeDate: p.closedate||null, createDate: p.createdate||null,
                ownerId: p.hubspot_owner_id||null, lostReason: p.closed_lost_reason||null,
                isWon: stage.won||false, isLost: stage.lost||false,
                url: `${HS_BASE}/contacts/${PORTAL}/record/0-3/${deal.id}`,
              };
            }),
            links: { dashboard: DASHBOARD, deals: DEALS_LIST },
          });
        }

        // ── TEAM ACTIVITY ─────────────────────────────────────────────────────
        if (section === "team_activity") {
          // Email counts via engagement object (accurate, not contact-level dates)
          async function countEmailsTA(ownerId, assignedBdr, sequenceOnly) {
            const filters = [
              { propertyName: "hs_email_direction", operator: "EQ",  value: "EMAIL" },
              { propertyName: "hs_timestamp",       operator: "GTE", value: sinceISO },
              { propertyName: "hs_sequence_id",     operator: sequenceOnly ? "HAS_PROPERTY" : "NOT_HAS_PROPERTY" },
            ];
            if (ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId });
            try {
              const d = await hsPost(user.userId, "/crm/v3/objects/emails/search", {
                filterGroups: [{ filters }], properties: ["hs_timestamp"], limit: 1,
              });
              return d.total || 0;
            } catch { return 0; }
          }

          // Opens/clicks still via contact-level (no per-email tracking on engagements)
          const openCounts  = await countAllRepsForMetric("hs_email_last_open_date");
          await new Promise(r => setTimeout(r, 300));
          const clickCounts = await countAllRepsForMetric("hs_email_last_click_date");
          await new Promise(r => setTimeout(r, 300));
          const seqCounts   = await countAllRepsForMetric("hs_latest_sequence_enrolled_date");

          // Per-rep email + reply counts in parallel
          const repCounts = {};
          await Promise.all(targetReps.map(async repName => {
            const ownerId = REP_OWNER_ID_MAP[repName];
            const bdr     = !ownerId ? repName : null;
            const replyFilters = [
              { propertyName: "hs_email_direction", operator: "EQ",  value: "INCOMING_EMAIL" },
              { propertyName: "hs_timestamp",       operator: "GTE", value: sinceISO },
            ];
            if (ownerId) replyFilters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId });
            const [seqEmails, indivEmails, replyData] = await Promise.all([
              countEmailsTA(ownerId, bdr, true),
              countEmailsTA(ownerId, bdr, false),
              hsPost(user.userId, "/crm/v3/objects/emails/search", {
                filterGroups: [{ filters: replyFilters }], properties: ["hs_timestamp"], limit: 1,
              }).catch(() => ({ total: 0 })),
            ]);
            repCounts[repName] = {
              seqEmails, indivEmails,
              sent:    seqEmails + indivEmails,
              replies: replyData.total || 0,
            };
          }));

          // Fetch completed To-Do items and manual activity log entries
          const todos = await getTodos(user.userId);
          const completedTodos = todos.filter(t => t.completed &&
            (!sinceISO || (t.completedAt && t.completedAt >= sinceISO))
          );
          const logEntries = await getActivityLog(user.userId, {
            since: sinceISO || null,
            rep: repNames.length === 1 ? repNames[0] : (ownerIds.length === 0 && repNames.length === 0 ? null : undefined),
          });

          // Fetch meetings via CRM v3 (same logic as /activity endpoint)
          const meetingCountByRep = {};
          const meetingDetailsByRep = {};
          targetReps.forEach(r => { meetingCountByRep[r] = 0; meetingDetailsByRep[r] = []; });
          try {
            const FULL_OWNER_ID_MAP_TA = { ...REP_OWNER_ID_MAP, "Chris Knapp":"78304576", "Chiara Pate":"87806380" };
            const meetingOwnerIds = [...new Set(targetReps.map(r => FULL_OWNER_ID_MAP_TA[r]).filter(Boolean))];
            if (meetingOwnerIds.length > 0) {
              const meetData = await hsPost(user.userId, "/crm/v3/objects/meetings/search", {
                filterGroups: meetingOwnerIds.map(ownerId => ({ filters: [
                  { propertyName: "hubspot_owner_id",      operator: "EQ",  value: ownerId },
                  { propertyName: "hs_meeting_start_time", operator: "GTE", value: sinceISO },
                ]})),
                properties: ["hs_meeting_title","hs_meeting_start_time","hubspot_owner_id"],
                sorts: [{ propertyName: "hs_meeting_start_time", direction: "DESCENDING" }],
                limit: 100,
              }).catch(() => ({ results: [] }));

              const ownerIdToRep = Object.fromEntries(
                Object.entries(FULL_OWNER_ID_MAP_TA).map(([name,id]) => [id, name])
              );

              // Dedup Gong duplicates
              const seenTimes = new Set();
              const deduped = (meetData.results || [])
                .filter(m => !(m.properties?.hs_meeting_title||'').match(/\[Canceled\]|canceled|cancelled/i))
                .sort((a,b) => {
                  const aG = (a.properties?.hs_meeting_title||'').startsWith('[Gong]');
                  const bG = (b.properties?.hs_meeting_title||'').startsWith('[Gong]');
                  return aG - bG;
                })
                .filter(m => {
                  const t = m.properties?.hs_meeting_start_time || m.id;
                  if (seenTimes.has(t)) return false;
                  seenTimes.add(t); return true;
                });

              for (const m of deduped) {
                const ownerId = m.properties?.hubspot_owner_id;
                const repName = ownerIdToRep[ownerId];
                if (repName && meetingCountByRep[repName] !== undefined) {
                  meetingCountByRep[repName]++;
                  meetingDetailsByRep[repName].push({
                    title: (m.properties?.hs_meeting_title||'Meeting').replace(/^\[Gong\]\s*/i,''),
                    date:  m.properties?.hs_meeting_start_time || null,
                    ownerName: repName,
                  });
                }
              }
            }
          } catch { /* meetings are additive — silently skip on error */ }

          const repData = targetReps.map(repName => {
            const c       = repCounts[repName] || {};
            const sent    = c.sent    || 0;
            const seqE    = c.seqEmails   || 0;
            const indivE  = c.indivEmails || 0;
            const opens   = openCounts[repName]  || 0;
            const clicks  = clickCounts[repName] || 0;
            const replies = c.replies || 0;
            const seqs    = seqCounts[repName]   || 0;
            const meetings = meetingCountByRep[repName] || 0;
            return {
              rep: repName, sent, seqEmails: seqE, indivEmails: indivE,
              opens, clicks, replies, sequences: seqs, meetings,
              openRate:  sent > 0 ? +((opens   / sent) * 100).toFixed(1) : 0,
              clickRate: sent > 0 ? +((clicks  / sent) * 100).toFixed(1) : 0,
              replyRate: sent > 0 ? +((replies / sent) * 100).toFixed(1) : 0,
              seqOpenRate:  seqs > 0 ? +((opens   / seqs) * 100).toFixed(1) : 0,
              seqReplyRate: seqs > 0 ? +((replies / seqs) * 100).toFixed(1) : 0,
              meetingDetails: meetingDetailsByRep[repName] || [],
            };
          });

          const totals = repData.reduce((acc, r) => ({
            sent:        acc.sent        + r.sent,
            seqEmails:   acc.seqEmails   + r.seqEmails,
            indivEmails: acc.indivEmails + r.indivEmails,
            opens:       acc.opens       + r.opens,
            clicks:      acc.clicks      + r.clicks,
            replies:     acc.replies     + r.replies,
            sequences:   acc.sequences   + r.sequences,
            meetings:    acc.meetings    + r.meetings,
          }), { sent:0, seqEmails:0, indivEmails:0, opens:0, clicks:0, replies:0, sequences:0, meetings:0 });

          const allMeetingDetails = repData.flatMap(r => r.meetingDetails || [])
            .sort((a,b) => new Date(b.date||0) - new Date(a.date||0));

          return ok({
            section: "team_activity", period,
            totals: {
              ...totals,
              openRate:     totals.sent  > 0 ? +((totals.opens   / totals.sent)  * 100).toFixed(1) : 0,
              clickRate:    totals.sent  > 0 ? +((totals.clicks  / totals.sent)  * 100).toFixed(1) : 0,
              replyRate:    totals.sent  > 0 ? +((totals.replies / totals.sent)  * 100).toFixed(1) : 0,
              seqOpenRate:  totals.sequences > 0 ? +((totals.opens   / totals.sequences) * 100).toFixed(1) : 0,
              seqReplyRate: totals.sequences > 0 ? +((totals.replies / totals.sequences) * 100).toFixed(1) : 0,
              completedTodos: completedTodos.length,
              manualEntries:  logEntries.length,
            },
            byRep: repData,
            meetingDetails: allMeetingDetails,
            completedTodos: completedTodos.slice(0, 100),
            activityLog: logEntries.slice(0, 200),
          });
        }

        // ── GOLD ACTIVITY ─────────────────────────────────────────────────────
        // Activity specifically on Gold tier contacts, sliced by rep and by account
        if (section === "gold_activity") {
          const GOLD_TIERS = [
            "GOLD - 1-10","GOLD - 11-20","GOLD - 21-30","GOLD - 31-40","GOLD - 41-50",
            "GOLD - 51-60","GOLD - 61-70","GOLD - 71-80","GOLD - 81-90","GOLD - 91-100",
          ];

          // Fetch Gold companies with all activity fields in ONE query
          const goldCompanies = await hsPost(user.userId, "/crm/v3/objects/companies/search", {
            filterGroups: [{ filters: [
              { propertyName: "priority_tier__bdr", operator: "IN", values: GOLD_TIERS },
              ...(sinceISO ? [{ propertyName: "notes_last_updated", operator: "GTE", value: sinceISO }] : []),
            ]}],
            properties: [
              "name","priority_tier__bdr","assigned_bdr","hubspot_owner_id",
              "notes_last_contacted","notes_last_updated","num_contacted_notes",
              "hs_last_logged_call_date","hs_last_booked_meeting_date",
              "hs_last_logged_outgoing_email_date","hs_lastmodifieddate",
            ],
            sorts: [{ propertyName: "notes_last_updated", direction: "DESCENDING" }],
            limit: 200,
          }).catch(() => ({ results: [] }));

          // Also fetch ALL gold companies for the total count (without date filter)
          const allGoldCompanies = sinceISO ? await hsPost(user.userId, "/crm/v3/objects/companies/search", {
            filterGroups: [{ filters: [{ propertyName: "priority_tier__bdr", operator: "IN", values: GOLD_TIERS }] }],
            properties: ["name","priority_tier__bdr","assigned_bdr","hubspot_owner_id","notes_last_contacted","notes_last_updated"],
            sorts: [{ propertyName: "priority_tier__bdr", direction: "ASCENDING" }],
            limit: 200,
          }).catch(() => ({ results: [] })) : goldCompanies;

          const activeResults  = goldCompanies.results || [];
          const allResults     = allGoldCompanies.results || [];

          // Build per-rep activity breakdown from company-level fields
          const repActivity = {};
          const ALL_REP_IDS = { ...REP_OWNER_ID_MAP, "Chris Knapp":"78304576", "Chiara Pate":"87806380" };
          ALL_REPS.forEach(r => { repActivity[r] = { rep:r, accounts:0, calls:0, meetings:0, emails:0, notes:0 } });

          for (const co of activeResults) {
            const p = co.properties || {};
            const bdr = p.assigned_bdr || "";
            const ownerId = p.hubspot_owner_id || "";
            const ownerIdToName = Object.fromEntries(Object.entries(REP_OWNER_ID_MAP).map(([n,id])=>[id,n]));
            const repName = bdr || ownerIdToName[ownerId] || null;
            if (repName && repActivity[repName]) {
              repActivity[repName].accounts++;
              if (p.hs_last_logged_call_date && (!sinceISO || p.hs_last_logged_call_date >= sinceISO)) repActivity[repName].calls++;
              if (p.hs_last_booked_meeting_date && (!sinceISO || p.hs_last_booked_meeting_date >= sinceISO)) repActivity[repName].meetings++;
              if (p.hs_last_logged_outgoing_email_date && (!sinceISO || p.hs_last_logged_outgoing_email_date >= sinceISO)) repActivity[repName].emails++;
              repActivity[repName].notes += parseInt(p.num_contacted_notes || "0");
            }
          }

          // Per-account activity rows sorted by most recent
          const byAccount = activeResults.map(co => {
            const p = co.properties || {};
            return {
              companyId:    co.id,
              name:         p.name || "",
              tier:         p.priority_tier__bdr || "",
              assignedBdr:  p.assigned_bdr || "",
              url:          `https://app.hubspot.com/contacts/39921549/record/0-2/${co.id}`,
              lastActivity: p.notes_last_updated || p.notes_last_contacted || null,
              lastCall:     p.hs_last_logged_call_date || null,
              lastMeeting:  p.hs_last_booked_meeting_date || null,
              lastEmail:    p.hs_last_logged_outgoing_email_date || null,
              noteCount:    parseInt(p.num_contacted_notes || "0"),
            };
          });

          const totals = {
            accountsTouched:   activeResults.length,
            totalAccounts:     allResults.length,
            totalCalls:        Object.values(repActivity).reduce((s,r) => s+r.calls, 0),
            totalMeetings:     Object.values(repActivity).reduce((s,r) => s+r.meetings, 0),
            totalEmails:       Object.values(repActivity).reduce((s,r) => s+r.emails, 0),
            totalNotes:        Object.values(repActivity).reduce((s,r) => s+r.notes, 0),
          };

          return ok({
            section: "gold_activity", period,
            totals,
            byRep:    Object.values(repActivity).filter(r => r.accounts > 0),
            byAccount,
          });
        }

        // ── WEEKLY RECAP ──────────────────────────────────────────────────────
        if (section === "weekly_recap") {
          // ── Email counts via engagement object ──
          // seq emails:   hs_sequence_id HAS_PROPERTY + outgoing + timestamp >= since
          // indiv emails: hs_sequence_id NOT_HAS_PROPERTY + outgoing + timestamp >= since
          async function countEmailsByType(ownerId, assignedBdr, sequenceOnly) {
            const ownerFilter  = ownerId   ? { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId } : null;
            
            const baseFilters  = [
              { propertyName: "hs_email_direction", operator: "EQ",  value: "EMAIL" },
              { propertyName: "hs_timestamp",       operator: "GTE", value: sinceISO },
              { propertyName: "hs_sequence_id",     operator: sequenceOnly ? "HAS_PROPERTY" : "NOT_HAS_PROPERTY" },
            ];
            if (untilISO) baseFilters.push({ propertyName: "hs_timestamp", operator: "LTE", value: untilISO });
            if (ownerFilter)  baseFilters.push(ownerFilter);
            try {
              const d = await hsPost(user.userId, "/crm/v3/objects/emails/search", {
                filterGroups: [{ filters: baseFilters }],
                properties: ["hs_timestamp"],
                limit: 1,
              });
              return d.total || 0;
            } catch { return 0; }
          }

          // Opens and replies still via contact-level props (no per-email open tracking on engagements)
          const openCounts  = await countAllRepsForMetric("hs_email_last_open_date");
          await new Promise(r => setTimeout(r, 300));
          const seqCounts   = await countAllRepsForMetric("hs_latest_sequence_enrolled_date");

          // Build per-rep counts using engagement object for email sent AND replies
          // Replies via INCOMING_EMAIL engagement — correctly scoped per rep, no cross-rep bleed
          const repEmailCounts = {};
          // Run all rep email counts in parallel to save time (avoid Netlify 26s timeout)
          await Promise.all(targetReps.map(async repName => {
            const ownerId     = REP_OWNER_ID_MAP[repName];
            const assignedBdr = !ownerId ? repName : null;

            // Run seq, indiv, and reply counts in parallel per rep
            const replyFilters = [
              { propertyName: "hs_email_direction", operator: "EQ",  value: "INCOMING_EMAIL" },
              { propertyName: "hs_timestamp",       operator: "GTE", value: sinceISO },
            ];
            if (untilISO) replyFilters.push({ propertyName: "hs_timestamp", operator: "LTE", value: untilISO });
            if (ownerId)  replyFilters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId });

            const RECAP_OWNER_MAP = { ...REP_OWNER_ID_MAP, "Chris Knapp": "78304576", "Chiara Pate": "87806380" };
            const repOwnerId = RECAP_OWNER_MAP[repName];

            const meetingFilters = [];
            if (repOwnerId) meetingFilters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: repOwnerId });
            if (sinceISO)   meetingFilters.push({ propertyName: "hs_meeting_start_time", operator: "GTE", value: sinceISO });
            if (untilISO)   meetingFilters.push({ propertyName: "hs_meeting_start_time", operator: "LTE", value: untilISO || new Date().toISOString() });

            const [seqEmails, indivEmails, replyData, meetData] = await Promise.all([
              countEmailsByType(ownerId, assignedBdr, true),
              countEmailsByType(ownerId, assignedBdr, false),
              hsPost(user.userId, "/crm/v3/objects/emails/search", {
                filterGroups: [{ filters: replyFilters }],
                properties: ["hs_timestamp"], limit: 1,
              }).catch(() => ({ total: 0 })),
              meetingFilters.length > 0
                ? hsPost(user.userId, "/crm/v3/objects/meetings/search", {
                    filterGroups: [{ filters: meetingFilters }],
                    properties: ["hs_meeting_title", "hs_meeting_start_time"],
                    sorts: [{ propertyName: "hs_meeting_start_time", direction: "DESCENDING" }],
                    limit: 50,
                  }).catch(() => ({ results: [], total: 0 }))
                : Promise.resolve({ results: [], total: 0 }),
            ]);

            // Dedup Gong pairs in meeting results
            const meetSeenTimes = new Set();
            const meetDetails = (meetData.results || [])
              .filter(m => !(m.properties?.hs_meeting_title || "").match(/\[Canceled\]|\bcanceled\b/i))
              .sort((a, b) => {
                const aG = (a.properties?.hs_meeting_title||"").startsWith("[Gong]");
                return aG ? 1 : -1;
              })
              .filter(m => {
                const t = m.properties?.hs_meeting_start_time || m.id;
                if (meetSeenTimes.has(t)) return false;
                meetSeenTimes.add(t);
                return true;
              })
              .map(m => ({
                title: (m.properties?.hs_meeting_title || "Meeting").replace(/^\[Gong\]\s*/i, ""),
                date:  m.properties?.hs_meeting_start_time || null,
              }));

            console.log(`[weekly_recap] ${repName}: seq=${seqEmails} indiv=${indivEmails} replies=${replyData.total||0} meetings=${meetDetails.length}`);
            repEmailCounts[repName] = {
              seqEmails, indivEmails,
              total:   seqEmails + indivEmails,
              replies: replyData.total || 0,
              meetings: meetDetails.length,
              meetingDetails: meetDetails,
            };
          }));

          const byRep = targetReps.map(repName => ({
            rep:            repName,
            sent:           repEmailCounts[repName]?.total          || 0,
            seqEmails:      repEmailCounts[repName]?.seqEmails       || 0,
            indivEmails:    repEmailCounts[repName]?.indivEmails     || 0,
            opens:          openCounts[repName]                      || 0,
            replies:        repEmailCounts[repName]?.replies         || 0,
            sequences:      seqCounts[repName]                       || 0,
            meetings:       repEmailCounts[repName]?.meetings        || 0,
            meetingDetails: repEmailCounts[repName]?.meetingDetails  || [],
          }));

          // Completed To-Do items for the period
          const todos = await getTodos(user.userId);
          const completedTodos = todos.filter(t =>
            t.completed && t.completedAt &&
            (!sinceISO || t.completedAt >= sinceISO) &&
            (!untilISO || t.completedAt <= untilISO)
          );

          // Manual activity log entries for the period
          const logEntries = await getActivityLog(user.userId, {
            since: sinceISO || null,
            until: untilISO || null,
          });

          const totals = byRep.reduce((acc, r) => ({
            sent:        acc.sent        + r.sent,
            seqEmails:   acc.seqEmails   + (r.seqEmails   || 0),
            indivEmails: acc.indivEmails + (r.indivEmails || 0),
            opens:       acc.opens       + r.opens,
            replies:     acc.replies     + r.replies,
            sequences:   acc.sequences   + r.sequences,
            meetings:    acc.meetings    + (r.meetings    || 0),
          }), { sent:0, seqEmails:0, indivEmails:0, opens:0, replies:0, sequences:0, meetings:0 });
          const allMeetingDetails = byRep.flatMap(r => r.meetingDetails || [])
            .sort((a, b) => new Date(b.date||0) - new Date(a.date||0));

          return ok({
            section: "weekly_recap",
            period,
            periodLabel: sinceISO
              ? `${new Date(sinceISO).toLocaleDateString("en-US",{month:"short",day:"numeric"})} – ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}`
              : "All time",
            totals: {
              ...totals,
              openRate:       totals.sent > 0 ? +((totals.opens   / totals.sent) * 100).toFixed(1) : 0,
              replyRate:      totals.sent > 0 ? +((totals.replies / totals.sent) * 100).toFixed(1) : 0,
              completedTodos: completedTodos.length,
              manualEntries:  logEntries.length,
              meetings:       totals.meetings,
            },
            byRep,
            meetingDetails: allMeetingDetails,
            completedTodos,
            activityLog: logEntries,
          });
        }

        // ── GOLD WORK LOG ─────────────────────────────────────────────────────
        // Shows work done on Gold accounts this period:
        // - Engagements logged (calls, meetings, notes, emails)
        // - Contact data filled in (personas, job titles, buying roles)
        // - Missing data gaps still remaining per account
        if (section === "gold_work_log") {
          const GOLD_TIERS = [
            "GOLD - 1-10","GOLD - 11-20","GOLD - 21-30","GOLD - 31-40","GOLD - 41-50",
            "GOLD - 51-60","GOLD - 61-70","GOLD - 71-80","GOLD - 81-90","GOLD - 91-100",
          ];

          // Single query: ALL Gold companies with all activity + data quality fields
          // Sorted by most recently modified so most-worked accounts appear first
          const goldCompanies = await hsPost(user.userId, "/crm/v3/objects/companies/search", {
            filterGroups: [{ filters: [
              { propertyName: "priority_tier__bdr", operator: "IN", values: GOLD_TIERS },
            ]}],
            properties: [
              "name","priority_tier__bdr","assigned_bdr","hubspot_owner_id",
              "hs_lastmodifieddate","hs_updated_by_user_id",
              "notes_last_contacted","notes_last_updated",
              "num_contacted_notes","num_associated_contacts",
              "hs_last_logged_call_date","hs_last_booked_meeting_date",
              "hs_last_logged_outgoing_email_date",
              "num_associated_deals","hs_num_contacts_with_buying_roles",
              "hs_num_decision_makers",
            ],
            sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
            limit: 200,
          }).catch(() => ({ results: [] }));

          const companies = goldCompanies.results || [];

          // Build per-account work log from company-level fields only (no per-company API loops)
          // "Work done" = any company record modified in the period, which captures:
          //   - Notes added, calls logged, meetings booked, emails logged
          //   - Contact data updated (persona assigned, job title filled, buying role set)
          //   - Company record itself updated (research, domain, industry etc.)
          const ownerIdToName = Object.fromEntries(Object.entries(REP_OWNER_ID_MAP).map(([n,id])=>[id,n]));
          const USER_ID_TO_NAME = {
            "78304576": "Chris Knapp", "87806380": "Chiara Pate",
            "76104455": "Matt Valin",  "55217954": "Joseph Haine",
            "83862037": "Tim Grisham", "289209454":"Irene Wong",
            "85819247": "Cole Hooper", "743772047":"John Hansel",
          };

          const accounts = companies.map(co => {
            const p = co.properties || {};
            const lastModified = p.hs_lastmodifieddate || null;
            const lastActivity = p.notes_last_updated  || null;
            const lastContacted= p.notes_last_contacted|| null;
            const lastCall     = p.hs_last_logged_call_date || null;
            const lastMeeting  = p.hs_last_booked_meeting_date || null;
            const lastEmail    = p.hs_last_logged_outgoing_email_date || null;

            // Was this account worked on in the period?
            const workedInPeriod = sinceISO ? (
              (lastModified  && lastModified  >= sinceISO) ||
              (lastActivity  && lastActivity  >= sinceISO) ||
              (lastContacted && lastContacted >= sinceISO)
            ) : true;

            // Activity types logged this period
            const activities = [];
            if (lastCall    && (!sinceISO || lastCall    >= sinceISO)) activities.push({ type:'Call',    date:lastCall });
            if (lastMeeting && (!sinceISO || lastMeeting >= sinceISO)) activities.push({ type:'Meeting', date:lastMeeting });
            if (lastEmail   && (!sinceISO || lastEmail   >= sinceISO)) activities.push({ type:'Email',   date:lastEmail });
            if (lastActivity&& (!sinceISO || lastActivity>= sinceISO)) activities.push({ type:'Note/Touch', date:lastActivity });
            activities.sort((a,b) => new Date(b.date) - new Date(a.date));

            const repName = p.assigned_bdr || ownerIdToName[p.hubspot_owner_id] || "";
            const updatedBy = USER_ID_TO_NAME[p.hs_updated_by_user_id] || `User ${p.hs_updated_by_user_id || 'unknown'}`;

            return {
              companyId:     co.id,
              name:          p.name || "",
              tier:          p.priority_tier__bdr || "",
              rep:           repName,
              url:           `https://app.hubspot.com/contacts/${PORTAL}/record/0-2/${co.id}`,
              workedInPeriod,
              lastModified,
              lastActivity,
              lastContacted,
              lastCall,
              lastMeeting,
              lastEmail,
              updatedBy,
              noteCount:     parseInt(p.num_contacted_notes  || "0"),
              contactCount:  parseInt(p.num_associated_contacts || "0"),
              buyingRoles:   parseInt(p.hs_num_contacts_with_buying_roles || "0"),
              decisionMakers:parseInt(p.hs_num_decision_makers || "0"),
              deals:         parseInt(p.num_associated_deals || "0"),
              activities,
            };
          });

          const worked    = accounts.filter(a => a.workedInPeriod);
          const notWorked = accounts.filter(a => !a.workedInPeriod);

          // Summary
          const totalCalls    = accounts.filter(a => a.lastCall    && (!sinceISO || a.lastCall    >= sinceISO)).length;
          const totalMeetings = accounts.filter(a => a.lastMeeting && (!sinceISO || a.lastMeeting >= sinceISO)).length;
          const totalEmails   = accounts.filter(a => a.lastEmail   && (!sinceISO || a.lastEmail   >= sinceISO)).length;

          // Per-rep summary
          const repMap = {};
          worked.forEach(a => {
            if (!a.rep) return;
            if (!repMap[a.rep]) repMap[a.rep] = { rep:a.rep, accounts:0, calls:0, meetings:0, emails:0, notes:0 };
            repMap[a.rep].accounts++;
            if (a.lastCall    && (!sinceISO || a.lastCall    >= sinceISO)) repMap[a.rep].calls++;
            if (a.lastMeeting && (!sinceISO || a.lastMeeting >= sinceISO)) repMap[a.rep].meetings++;
            if (a.lastEmail   && (!sinceISO || a.lastEmail   >= sinceISO)) repMap[a.rep].emails++;
            repMap[a.rep].notes += a.noteCount;
          });

          return ok({
            section: "gold_work_log", period,
            periodLabel: sinceISO
              ? `${new Date(sinceISO).toLocaleDateString("en-US",{month:"short",day:"numeric"})} – ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}`
              : "All time",
            summary: {
              totalAccounts:  companies.length,
              workedThisPeriod: worked.length,
              notWorked:      notWorked.length,
              totalCalls,
              totalMeetings,
              totalEmails,
            },
            byRep:    Object.values(repMap).sort((a,b) => b.accounts - a.accounts),
            accounts: worked,
            notWorked: notWorked.slice(0, 30),
          });
        }

        return error(400, `Unknown report section: ${section}`);

      } catch (err) {
        console.error("[reports] Error:", err.message);
        return error(500, `Reports error: ${err.message}`);
      }
    }

    // ── Primary Outreach Rep Sync ─────────────────────────────────────────────
    // ── Primary Outreach Rep Sync — REMOVED ────────────────────────────────
    // The /sync-primary-rep and /sync-company-rep endpoints that used to live
    // here were removed (not just disabled) along with the HubSpot scope
    // cleanup — this bulk sync tool needed crm.objects.companies.write, which
    // was never actually granted, meaning its company-writing half was
    // already silently broken. Primary Outreach Rep assignment is being
    // handled manually for now. If a permanent, automated solution is wanted
    // later, that's a HubSpot-side build (a workflow reacting to activity,
    // not something this app needs to own) — a fully-built version of that
    // approach already exists from earlier work and can be revisited.

    // ── Org Intel: lookup company contacts for Contact Intelligence panel ─────────
    if (method === "GET" && path === "/org-intel-contacts") {
      try {
        const orgName = qp.orgName || "";
        const domain  = qp.domain  || "";
        if (!orgName) return ok({ contacts: [] });

        // Search HubSpot for the company by name
        const compSearch = await hsPost(user.userId, "/crm/v3/objects/companies/search", {
          filterGroups: [{ filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: orgName }] }],
          properties:   ["name", "domain"],
          limit:        1,
        }).catch(() => ({ results: [] }));

        const company = compSearch.results?.[0];
        if (!company) return ok({ contacts: [], companyFound: false });

        // Get contacts associated with this company
        const assocData = await hsPost(user.userId, "/crm/v4/associations/companies/contacts/batch/read", {
          inputs: [{ id: company.id }],
        }).catch(() => ({ results: [] }));

        const contactIds = (assocData.results?.[0]?.to || []).map(t => String(t.toObjectId)).slice(0, 100);
        if (contactIds.length === 0) return ok({ contacts: [], companyFound: true, companyName: company.properties?.name });

        const contactData = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
          inputs:     contactIds.map(id => ({ id })),
          properties: ["firstname", "lastname", "jobtitle", "email", "target_persona"],
        }).catch(() => ({ results: [] }));

        const contacts = (contactData.results || []).map(c => ({
          id:            c.id,
          name:          [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(" "),
          title:         c.properties?.jobtitle  || "",
          email:         c.properties?.email     || "",
          target_persona: c.properties?.target_persona || "",
        })).filter(c => c.name);

        return ok({ contacts, companyFound: true, companyName: company.properties?.name, companyId: company.id });
      } catch (err) {
        return ok({ contacts: [], error: err.message });
      }
    }

    // ── Gold Account Persona Gaps ────────────────────────────────────────────────
    // GET /hubspot/gold-gaps?companyId=123       — single account
    // GET /hubspot/gold-gaps?batch=true          — all Gold accounts
    if (method === "GET" && path === "/gold-gaps") {
      try {
        const ALL_PERSONAS = [
          "Access/Patient Access","Ambulatory/Urgent Care","Business Development",
          "Case Management","Clinical Operations","Emergency Department",
          "Executive/Leadership","Finance","Innovation","Medical Group",
          "Medical Information","Chief Clinical Officer","Medical Officer",
          "Nursing Officer","Operating Officer","Patient Experience",
          "Physician Executive","Population Health","Quality Officer",
          "Service Line","Strategy","Value Based Care",
        ];

        const GOLD_TIERS = [
          "GOLD - 1-10","GOLD - 11-20","GOLD - 21-30","GOLD - 31-40","GOLD - 41-50",
          "GOLD - 51-60","GOLD - 61-70","GOLD - 71-80","GOLD - 81-90","GOLD - 91-100",
        ];

        const companyId = qp.companyId || null;
        const batch     = qp.batch === "true";

        // Fetch companies to check
        let companies = [];
        if (companyId) {
          const c = await hsGet(user.userId, `/crm/v3/objects/companies/${companyId}`, {
            properties: "name,priority_tier__bdr,assigned_bdr,domain",
          });
          companies = [c];
        } else if (batch) {
          const data = await hsPost(user.userId, "/crm/v3/objects/companies/search", {
            filterGroups: [{ filters: [{ propertyName: "priority_tier__bdr", operator: "IN", values: GOLD_TIERS }] }],
            properties:   ["name", "priority_tier__bdr", "assigned_bdr", "domain"],
            sorts:        [{ propertyName: "priority_tier__bdr", direction: "ASCENDING" }],
            limit:        100,
          });
          companies = data.results || [];
        } else {
          return error(400, "Provide companyId or batch=true");
        }

        // For each company, get contacts + their personas
        const results = [];
        for (const company of companies) {
          const p = company.properties || {};

          // Get all contacts for this company
          const assocData = await hsPost(user.userId, "/crm/v4/associations/companies/contacts/batch/read", {
            inputs: [{ id: company.id }],
          }).catch(() => ({ results: [] }));

          const contactIds = (assocData.results?.[0]?.to || []).map(r => String(r.toObjectId));

          let coveredPersonas = new Set();
          let contacts = [];

          if (contactIds.length > 0) {
            const contactData = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
              inputs:     contactIds.slice(0, 100).map(id => ({ id })),
              properties: ["firstname", "lastname", "jobtitle", "target_persona", "email"],
            }).catch(() => ({ results: [] }));

            contacts = (contactData.results || []).map(c => ({
              id:       c.id,
              name:     `${c.properties?.firstname || ""} ${c.properties?.lastname || ""}`.trim(),
              title:    c.properties?.jobtitle     || "",
              persona:  c.properties?.target_persona || null,
              email:    c.properties?.email        || "",
            }));

            coveredPersonas = new Set(contacts.filter(c => c.persona).map(c => c.persona));
          }

          const missingPersonas = ALL_PERSONAS.filter(p => !coveredPersonas.has(p));
          const coveredList     = ALL_PERSONAS.filter(p =>  coveredPersonas.has(p));

          results.push({
            companyId:       company.id,
            companyName:     p.name || "",
            domain:          p.domain || "",
            tier:            p.priority_tier__bdr || "",
            assignedBdr:     p.assigned_bdr || "",
            totalContacts:   contacts.length,
            coveredPersonas: coveredList,
            missingPersonas,
            coveragePercent: Math.round((coveredList.length / ALL_PERSONAS.length) * 100),
            contacts,
          });

          await new Promise(r => setTimeout(r, 100));
        }

        // Sort by most gaps first
        results.sort((a, b) => b.missingPersonas.length - a.missingPersonas.length);

        return ok({ results, totalCompanies: results.length });

      } catch (err) {
        console.error("[gold-gaps] error:", err.message);
        return error(500, `Gold gaps error: ${err.message}`);
      }
    }

    // ── Gap Search Cache ──────────────────────────────────────────────────────────
    // GET  /hubspot/gap-cache  — read cached gap results from Azure Blob
    // POST /hubspot/gap-cache  — write gap results to Azure Blob
    if (path === "/gap-cache") {
      try {
        if (method === "GET") {
          if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ gapState: {}, gapLastRun: {} });
          const res = await fetch(gapCacheBlobUrl());
          if (res.status === 404) return ok({ gapState: {}, gapLastRun: {} });
          if (!res.ok) return ok({ gapState: {}, gapLastRun: {} });
          const data = await res.json();
          return ok(data);
        }
        if (method === "POST") {
          if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ saved: false });
          const body = JSON.parse(event.body || "{}");
          const payload = JSON.stringify({ gapState: body.gapState || {}, gapLastRun: body.gapLastRun || {} });
          const res = await fetch(gapCacheBlobUrl(), {
            method: "PUT",
            headers: {
              "Content-Type":    "application/json",
              "x-ms-blob-type":  "BlockBlob",
              "Content-Length":  String(Buffer.byteLength(payload)),
            },
            body: payload,
          });
          return ok({ saved: res.ok });
        }
      } catch (err) {
        return ok({ gapState: {}, gapLastRun: {}, error: err.message });
      }
    }

    // GET  /hubspot/bot-log  — read bot detection log from Azure Blob
    // DELETE /hubspot/bot-log — clear the log
    if (path === "/bot-log") {
      try {
        if (method === "GET") {
          if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ entries: [] });
          const res = await fetch(botLogBlobUrl());
          if (res.status === 404) return ok({ entries: [] });
          if (!res.ok) return ok({ entries: [] });
          const data = await res.json().catch(() => ({ entries: [] }));
          return ok(data);
        }
        if (method === "DELETE") {
          if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ cleared: false });
          const payload = JSON.stringify({ entries: [] });
          const res = await fetch(botLogBlobUrl(), {
            method: "PUT",
            headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob", "Content-Length": String(Buffer.byteLength(payload)) },
            body:   payload,
          });
          return ok({ cleared: res.ok });
        }
      } catch (err) {
        return ok({ entries: [], error: err.message });
      }
    }

    // GET /right-now — the Right Now Queue: merges live signals, replies
    // awaiting response, due/overdue tasks, OOO follow-ups, upcoming
    // meetings (HubSpot + Outlook, deduped), and to-dos into one ranked list.
    //
    // Reuses computeTaskQueue — the exact same logic /tasks already runs —
    // so replies-awaiting-response and due tasks can't drift out of sync
    // between the two views.

    if (method === "GET" && path === "/right-now") {
      try {
        const queue = await computeRightNowQueue(user.userId, qp);
        return ok({ queue, highSequenceEngagement: queue.highSequenceEngagement || [] });
      } catch (err) {
        console.error("[right-now] Error:", err.message);
        return error(500, `Right now error: ${err.message}`);
      }
    }

    // GET /meetings-tracker — dedicated Meetings tab data.
    // Pulls HubSpot + Outlook meetings across a wide window (past 30 days
    // through next 30 days, so overdue/completed/scheduled are all visible
    // in one place), classifies each by status, resolves who organized it
    // and who attended (from both sources, as requested), and separately
    // correlates each meeting against Gong-generated recap notes.
    //
    // The Gong correlation is real, not a placeholder: confirmed via direct
    // data checks that Gong's own HubSpot integration auto-logs a Note
    // (not a Meeting-object field) containing both the recording link and
    // an AI-written recap, associated with the same contact the meeting
    // was with. There's no direct foreign key from a meeting to its Gong
    // note, so this matches them by shared contact + note timestamp within
    // a few hours of the meeting's start time — the best available signal,
    // not a guaranteed-exact link.
    if (method === "GET" && path === "/meetings-tracker") {
      try {
        const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const windowEnd   = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const repFilter = qp.repFilter || null; // optional: filter to one rep's meetings

        // ── HubSpot meetings ──────────────────────────────────────────────
        const meetData = await hsPost(user.userId, "/crm/v3/objects/meetings/search", {
          filterGroups: [{
            filters: [
              { propertyName: "hs_meeting_start_time", operator: "GTE", value: windowStart.toISOString() },
              { propertyName: "hs_meeting_start_time", operator: "LTE", value: windowEnd.toISOString() },
            ],
          }],
          properties: [
            "hs_meeting_title", "hs_meeting_start_time", "hs_meeting_end_time",
            "hs_meeting_outcome", "hubspot_owner_id", "hs_created_by_user_id",
            "hs_internal_meeting_notes",
          ],
          sorts: [{ propertyName: "hs_meeting_start_time", direction: "DESCENDING" }],
          limit: 100,
        }).catch(() => ({ results: [] }));

        const hsMeetingsRaw = (meetData.results || []).filter(m =>
          !String(m.properties?.hs_meeting_title || "").trim().startsWith("[Gong]")
        );

        // Search API never returns associations (same confirmed HubSpot
        // limitation fixed elsewhere in this file for deals/tasks) — batch
        // fetch contact associations separately.
        const meetingIds = hsMeetingsRaw.map(m => m.id);
        const meetingContactAssoc = await batchFetchAssociations(user.userId, "meetings", "contacts", meetingIds);

        // Also need ALL contacts per meeting (attendees), not just the first
        // — meetings/contacts is typically one-to-few, so this is fine at
        // this volume.
        const allContactIds = [...new Set(Object.values(meetingContactAssoc).flat())];
        const contactMap = {};
        for (let i = 0; i < allContactIds.length; i += 100) {
          const chunk = allContactIds.slice(i, i + 100);
          const batch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
            inputs: chunk.map(id => ({ id })),
            properties: BASE_CONTACT_PROPS,
          }).catch(() => ({ results: [] }));
          (batch.results || []).forEach(c => { contactMap[c.id] = normalizeContact(c); });
        }
        const contactsByEmail = {};
        Object.values(contactMap).forEach(c => { if (c.email) contactsByEmail[c.email.toLowerCase()] = c; });

        // Live owner lookup for organizer name resolution.
        const ownersData = await hsGet(user.userId, "/crm/v3/owners", { limit: 100 }).catch(() => ({ results: [] }));
        const ownerNamesById = {};
        (ownersData.results || []).forEach(o => {
          ownerNamesById[String(o.id)] = `${o.firstName || ""} ${o.lastName || ""}`.trim();
        });

        const hsMeetings = hsMeetingsRaw.map(m => {
          const p = m.properties || {};
          const attendeeContactIds = meetingContactAssoc[m.id] || [];
          const now = Date.now();
          const startMs = p.hs_meeting_start_time ? new Date(p.hs_meeting_start_time).getTime() : null;
          const outcome = p.hs_meeting_outcome || null;

          // Status: Scheduled (future) / Completed (marked complete,
          // regardless of when) / Overdue (start time has passed with no
          // completion outcome recorded — the specific gap being tracked).
          let status;
          if (outcome === "COMPLETED") status = "completed";
          else if (startMs && startMs > now) status = "scheduled";
          else status = "overdue";

          const organizerId = p.hubspot_owner_id || p.hs_created_by_user_id || null;

          return {
            id: `hs-${m.id}`,
            source: "hubspot",
            subject: p.hs_meeting_title || "Meeting",
            startTime: p.hs_meeting_start_time || null,
            endTime: p.hs_meeting_end_time || null,
            status,
            outcome,
            organizerId,
            organizerName: organizerId ? (ownerNamesById[String(organizerId)] || null) : null,
            attendees: attendeeContactIds.map(cid => contactMap[cid]).filter(Boolean),
            internalNotes: p.hs_internal_meeting_notes || null,
            url: `https://app.hubspot.com/contacts/39921549/record/0-47/${m.id}`,
          };
        });

        // ── Outlook meetings, same window ────────────────────────────────
        const outlookEvents = await getOutlookCalendarEvents(user.userId, windowStart, windowEnd);
        const olMeetings = (outlookEvents || [])
          .filter(ev => !String(ev.subject || "").trim().startsWith("[Gong]"))
          .map(ev => {
            const attendeeEmails = (ev.attendees || []).map(a => a.emailAddress?.address?.toLowerCase()).filter(Boolean);
            const matchedAttendees = attendeeEmails.map(e => contactsByEmail[e]).filter(Boolean);
            const startMs = ev.start?.dateTime ? new Date(`${ev.start.dateTime}Z`).getTime() : null;
            const status = startMs && startMs > Date.now() ? "scheduled" : "overdue"; // Outlook has no "completed" outcome concept
            return {
              id: `ol-${ev.id}`,
              source: "outlook",
              subject: ev.subject || "Meeting",
              startTime: ev.start?.dateTime ? `${ev.start.dateTime}Z` : null,
              endTime: ev.end?.dateTime ? `${ev.end.dateTime}Z` : null,
              status,
              outcome: null,
              organizerId: null,
              organizerName: ev.organizer?.emailAddress?.name || null,
              attendees: matchedAttendees,
              // Outlook response status per attendee — the richer signal
              // requested alongside HubSpot's own attendee associations.
              attendeeResponses: (ev.attendees || []).map(a => ({
                email: a.emailAddress?.address || null,
                name: a.emailAddress?.name || null,
                response: a.status?.response || "none", // accepted / declined / tentativelyAccepted / none
              })),
              internalNotes: null,
              url: null,
            };
          });

        // ── Dedup: same logic as mergeMeetings (shared contact + overlapping
        // time), kept local rather than reusing the shared util directly,
        // since this endpoint needs extra fields (outcome, organizer) that
        // the shared normalizer intentionally doesn't carry for the Now tab.
        const OVERLAP_TOLERANCE_MIN = 15;
        const toMs = iso => iso ? new Date(iso).getTime() : null;
        const overlaps = (aStart, aEnd, bStart, bEnd) => {
          if (aStart == null || bStart == null) return false;
          const tol = OVERLAP_TOLERANCE_MIN * 60 * 1000;
          return aStart - tol <= (bEnd ?? bStart) && bStart - tol <= (aEnd ?? aStart);
        };
        const merged = [...hsMeetings];
        for (const ol of olMeetings) {
          const olContactEmails = (ol.attendees || []).map(a => a.email?.toLowerCase()).filter(Boolean);
          const dupe = hsMeetings.find(hs => {
            const hsContactEmails = (hs.attendees || []).map(a => a.email?.toLowerCase()).filter(Boolean);
            const sharedContact = hsContactEmails.some(e => olContactEmails.includes(e));
            return sharedContact && overlaps(toMs(hs.startTime), toMs(hs.endTime), toMs(ol.startTime), toMs(ol.endTime));
          });
          if (!dupe) merged.push(ol);
        }

        // ── Gong note correlation ────────────────────────────────────────
        // Batch fetch, not per-meeting — collect every contact tied to any
        // meeting in this window, then one search for gong.io notes across
        // all of them, then match in memory. Avoids an N+1 pattern that
        // already caused real performance problems elsewhere in this file.
        const meetingContactIdsForGong = [...new Set(
          merged.flatMap(m => (m.attendees || []).map(a => a.id)).filter(Boolean)
        )];
        let gongNotesByContact = {};
        if (meetingContactIdsForGong.length > 0) {
          for (let i = 0; i < meetingContactIdsForGong.length; i += 100) {
            const chunk = meetingContactIdsForGong.slice(i, i + 100);
            const notesData = await hsPost(user.userId, "/crm/v3/objects/notes/search", {
              filterGroups: [{
                filters: [{ operator: "CONTAINS_TOKEN", propertyName: "hs_note_body", value: "gong.io" }],
              }],
              properties: ["hs_note_body", "hs_body_preview", "hs_timestamp"],
              limit: 100,
              associations: [], // Search API ignores this anyway (confirmed elsewhere) — associations pulled separately below
            }).catch(() => ({ results: [] }));
            const noteIds = (notesData.results || []).map(n => n.id);
            const noteContactAssoc = await batchFetchAssociations(user.userId, "notes", "contacts", noteIds);
            (notesData.results || []).forEach(n => {
              const linkedContacts = noteContactAssoc[n.id] || [];
              const relevantContacts = linkedContacts.filter(cid => chunk.includes(cid));
              if (relevantContacts.length === 0) return;
              const urlMatch = (n.properties?.hs_body_preview || "").match(/https:\/\/[^\s]*gong\.io[^\s]*/);
              const gongUrl = urlMatch ? urlMatch[0] : null;
              if (!gongUrl) return;
              relevantContacts.forEach(cid => {
                if (!gongNotesByContact[cid]) gongNotesByContact[cid] = [];
                gongNotesByContact[cid].push({
                  timestamp: n.properties?.hs_timestamp,
                  recap: n.properties?.hs_body_preview || null,
                  gongUrl,
                });
              });
            });
          }
        }

        // Attach best-matching Gong note to each meeting: same contact,
        // note timestamp within 6 hours of the meeting's start time.
        const GONG_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;
        merged.forEach(m => {
          const startMs = toMs(m.startTime);
          if (!startMs) return;
          let best = null, bestDelta = Infinity;
          (m.attendees || []).forEach(a => {
            (gongNotesByContact[a.id] || []).forEach(note => {
              const noteMs = toMs(note.timestamp);
              if (noteMs == null) return;
              const delta = Math.abs(noteMs - startMs);
              if (delta <= GONG_MATCH_WINDOW_MS && delta < bestDelta) { best = note; bestDelta = delta; }
            });
          });
          if (best) { m.gongUrl = best.gongUrl; m.gongRecap = best.recap; }
        });

        // ── Optional rep filter (applied last, after merge/correlation) ──
        let result = merged;
        if (repFilter) {
          result = result.filter(m =>
            m.organizerName === repFilter ||
            (m.attendees || []).some(a => a.assignedBdr === repFilter || a.primaryOutreachRep === repFilter)
          );
        }

        result.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));

        return ok({
          meetings: result,
          counts: {
            scheduled: result.filter(m => m.status === "scheduled").length,
            completed: result.filter(m => m.status === "completed").length,
            overdue:   result.filter(m => m.status === "overdue").length,
            withGongRecap: result.filter(m => m.gongUrl).length,
          },
        });
      } catch (err) {
        console.error("[meetings-tracker] Error:", err.message);
        return error(500, `Meetings tracker error: ${err.message}`);
      }
    }

    // GET /top5 — read the cached Top 5 picks from the last scheduled run
    // (8am / 1pm ET). This never calls Claude itself; the scheduler writes
    // this blob, this route just reads it.
    if (method === "GET" && path === "/top5") {
      try {
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ picks: [], generatedAt: null });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/top5-${user.userId}.json${sas}`;
        const res = await fetch(url);
        if (!res.ok) return ok({ picks: [], generatedAt: null });
        const data = await res.json();
        return ok(data);
      } catch (err) {
        return ok({ picks: [], generatedAt: null, error: err.message });
      }
    }

    // POST /top5/regenerate — on-demand refresh, bypassing the hourly
    // cache. Same ranking logic the scheduler uses, just triggered by a
    // person instead of the clock. Useful for verifying a fix actually
    // worked right now instead of waiting up to an hour for the next
    // scheduled run to overwrite the cached picks.
    if (method === "POST" && path === "/top5/regenerate") {
      try {
        const queue = await computeRightNowQueue(user.userId, {});

        let pinnedIds = new Set();
        if (AZURE_ACCOUNT && AZURE_SAS_TOKEN) {
          const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
          const pinnedUrl = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/pinned-${user.userId}.json${sas}`;
          const pinnedRes = await fetch(pinnedUrl).catch(() => null);
          if (pinnedRes?.ok) {
            const pinnedData = await pinnedRes.json();
            pinnedIds = new Set(pinnedData.pinnedIds || []);
          }
        }

        const candidates = queue.filter(item => !pinnedIds.has(item.id)).slice(0, 20);
        const picks = candidates.length > 0 ? await rankTop5WithClaude(candidates) : [];
        const body = { picks, generatedAt: new Date().toISOString(), slot: "manual" };

        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok(body);
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/top5-${user.userId}.json${sas}`;
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
          body: JSON.stringify(body),
        });
        return ok(body);
      } catch (err) {
        return error(500, `Top 5 regenerate error: ${err.message}`);
      }
    }

    // POST /pin   { itemId }  — rep pins something to the top of their Top 5,
    //   instantly, independent of the twice-daily AI refresh.
    // DELETE /pin/{itemId}    — unpin.
    // Stored per-user so pins survive a page reload.
    // GET /pin — read the current pinned item ids, so the frontend can
    // restore pin state on page load instead of only ever seeing pins
    // created in the current session.
    // GET /dismissed — read the persisted list of dismissed queue items
    // (signals/tasks/meetings that were checked off but have no real
    // "complete" concept on the backend). This is what makes the Done /
    // Completed Items view survive a page reload instead of resetting
    // every session.
    if (method === "GET" && path === "/dismissed") {
      try {
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ items: [] });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/dismissed-${user.userId}.json${sas}`;
        const res = await fetch(url);
        if (!res.ok) return ok({ items: [] });
        const data = await res.json();
        return ok({ items: data.items || [] });
      } catch (err) {
        return ok({ items: [], error: err.message });
      }
    }

    // POST /dismissed  { id, name, company, whyTag, source } — records a
    // dismissed item permanently. Capped at the most recent 200 so this
    // blob doesn't grow forever.
    if (method === "POST" && path === "/dismissed") {
      try {
        const body = JSON.parse(event.body || "{}");
        if (!body.id) return error(400, "id is required");
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ saved: false });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/dismissed-${user.userId}.json${sas}`;
        const res = await fetch(url);
        const data = res.ok ? await res.json() : { items: [] };
        const entry = {
          id: body.id,
          name: body.name || "Untitled",
          company: body.company || null,
          whyTag: body.whyTag || null,
          source: body.source || null,
          dismissedAt: new Date().toISOString(),
        };
        const updated = [entry, ...(data.items || []).filter(i => i.id !== body.id)].slice(0, 200);
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
          body: JSON.stringify({ items: updated }),
        });
        return ok({ saved: true, items: updated });
      } catch (err) {
        return error(500, `Dismiss error: ${err.message}`);
      }
    }

    if (method === "GET" && path === "/pin") {
      try {
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ pinnedIds: [] });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/pinned-${user.userId}.json${sas}`;
        const res = await fetch(url);
        if (!res.ok) return ok({ pinnedIds: [] });
        const data = await res.json();
        return ok({ pinnedIds: data.pinnedIds || [] });
      } catch (err) {
        return ok({ pinnedIds: [], error: err.message });
      }
    }

    if (method === "POST" && path === "/pin") {
      try {
        const body = JSON.parse(event.body || "{}");
        if (!body.itemId) return error(400, "itemId is required");
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ pinned: false });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/pinned-${user.userId}.json${sas}`;
        const res = await fetch(url);
        const data = res.ok ? await res.json() : { pinnedIds: [] };
        const updated = [...new Set([...(data.pinnedIds || []), body.itemId])];
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
          body: JSON.stringify({ pinnedIds: updated }),
        });
        return ok({ pinned: true, pinnedIds: updated });
      } catch (err) {
        return error(500, `Pin error: ${err.message}`);
      }
    }
    if (method === "DELETE" && path.startsWith("/pin/")) {
      try {
        const itemId = decodeURIComponent(path.replace("/pin/", ""));
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ pinned: false });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/pinned-${user.userId}.json${sas}`;
        const res = await fetch(url);
        const data = res.ok ? await res.json() : { pinnedIds: [] };
        const updated = (data.pinnedIds || []).filter(id => id !== itemId);
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
          body: JSON.stringify({ pinnedIds: updated }),
        });
        return ok({ pinned: false, pinnedIds: updated });
      } catch (err) {
        return error(500, `Unpin error: ${err.message}`);
      }
    }

    // GET /team/queue?userId=X — scoped view of another rep's actual queue.
    // "Scoped" means: a manager can only view people in their own
    // TEAM_HIERARCHY entry (or everyone, if their entry is ["*"]) — not
    // blanket admin access. The normal /right-now always operates on the
    // calling user's own token, so this is a separate, explicitly gated
    // path rather than adding a userId override to the regular endpoint.
    if (method === "GET" && path === "/team/queue") {
      const visibility = getTeamVisibility(user.email);
      if (!visibility.canAccess && !isAdminUser(user)) return error(403, "You don't have access to view other reps' queues");
      try {
        const targetUserId = qp.userId;
        if (!targetUserId) return error(400, "userId is required");
        if (!visibility.all && !isAdminUser(user)) {
          const profiles = await getActiveUserProfiles();
          const targetEmail = (profiles.find(p => p.userId === targetUserId)?.email || "").toLowerCase();
          if (!visibility.emails.has(targetEmail)) return error(403, "That person isn't on your team");
        }
        const queue = await computeRightNowQueue(targetUserId, {});
        return ok({ queue });
      } catch (err) {
        return error(500, `Team queue error: ${err.message}`);
      }
    }

    // GET /team — manager roster: every known user's queue depth, oldest
    // unactioned item, and today's completion count. Scoped the same way
    // as /team/queue above — shows only the requester's own team, unless
    // their TEAM_HIERARCHY entry is ["*"] or they're a full admin.
    if (method === "GET" && path === "/team") {
      const visibility = getTeamVisibility(user.email);
      if (!visibility.canAccess && !isAdminUser(user)) return error(403, "You don't have access to the team view");
      try {
        let profiles = await getActiveUserProfiles();
        if (!visibility.all && !isAdminUser(user)) {
          profiles = profiles.filter(p => visibility.emails.has((p.email || "").toLowerCase()));
        }
        // Exclude yourself — you're already "(me)" in the switcher, showing
        // up a second time as your own literal email is just confusing,
        // and worse, selecting it puts the app into read-only mode against
        // your own account since viewingUserId being non-null is what
        // triggers that, regardless of whose id it actually is.
        profiles = profiles.filter(p => (p.email || "").toLowerCase() !== (user.email || "").toLowerCase());
        const roster = await Promise.all(profiles.map(async (p) => {
          try {
            const queue = await computeRightNowQueue(p.userId, {});
            const todos = await getTodos(p.userId);
            const completedToday = todos.filter(t => {
              if (!t.completed || !t.completedAt) return false;
              return new Date(t.completedAt).toDateString() === new Date().toDateString();
            }).length;
            const oldestTimestamp = queue
              .map(item => item.raw?.timestamp || item.raw?.createdAt || item.raw?.sentAt || null)
              .filter(Boolean)
              .sort((a, b) => new Date(a) - new Date(b))[0];
            const oldestHours = oldestTimestamp ? Math.round((Date.now() - new Date(oldestTimestamp).getTime()) / 3600000) : null;
            return {
              userId: p.userId,
              email: p.email,
              queueCount: queue.length,
              oldestHours,
              completedToday,
            };
          } catch (e) {
            return { userId: p.userId, email: p.email, error: e.message };
          }
        }));
        return ok({ roster });
      } catch (err) {
        return error(500, `Team error: ${err.message}`);
      }
    }

    // POST /team/push  { targetUserId, text, contactId? }  — manager pushes
    // a task directly into a rep's Right Now queue, tagged so the rep can
    // see it came from a manager, not the formula or their own pin. Scoped
    // the same way — can only push to someone within your own visibility.
    if (method === "POST" && path === "/team/push") {
      const visibility = getTeamVisibility(user.email);
      if (!visibility.canAccess && !isAdminUser(user)) return error(403, "You don't have access to push to other reps");
      try {
        const body = JSON.parse(event.body || "{}");
        if (!body.targetUserId || !body.text?.trim()) return error(400, "targetUserId and text are required");
        if (!visibility.all && !isAdminUser(user)) {
          const profiles = await getActiveUserProfiles();
          const targetEmail = (profiles.find(p => p.userId === body.targetUserId)?.email || "").toLowerCase();
          if (!visibility.emails.has(targetEmail)) return error(403, "That person isn't on your team");
        }
        const managerName = user.email || "Manager";
        const item = await addTodo(body.targetUserId, {
          text: body.text.trim(),
          contactId: body.contactId || null,
          autoDetected: false,
          priority: "HIGH",
          assignedBy: managerName,
        });
        return ok({ item });
      } catch (err) {
        return error(500, `Push error: ${err.message}`);
      }
    }

    // GET /pipeline-review/config — the stage config, so the frontend has
    // one source of truth instead of duplicating the pipeline/stage list.
    if (method === "GET" && path === "/pipeline-review/config") {
      return ok({ pipelines: PIPELINE_STAGES });
    }

    // GET /pipeline-review?pipeline=X&ownerId=Y — open deals for one
    // pipeline at a time (matches walking the team through one pipeline,
    // then the next, in the actual meeting), whole team by default,
    // optionally narrowed to one owner.
    // Shared enrichment: owner names, company data, and — critically for
    // last-contact accuracy — associated CONTACT activity too, not just the
    // deal and its company. A meeting or call is very often logged against
    // a specific contact without ever being tagged to the deal, so checking
    // only the deal (or even deal+company) still misses real activity.
    async function enrichAndFormatDeals(userId, deals) {
      const ownerIds = [...new Set(deals.map(d => d.properties?.hubspot_owner_id).filter(Boolean))];
      const ownersById = {};
      if (ownerIds.length > 0) {
        const ownersData = await hsGet(userId, "/crm/v3/owners", { limit: 100 }).catch(() => ({ results: [] }));
        (ownersData.results || []).forEach(o => {
          ownersById[String(o.id)] = `${o.firstName || ""} ${o.lastName || ""}`.trim();
        });
      }

      const companyIds = deals.map(d => d.associations?.companies?.results?.[0]?.id).filter(Boolean);
      const companiesById = {};
      if (companyIds.length > 0) {
        const companyData = await hsPost(userId, "/crm/v3/objects/companies/batch/read", {
          inputs: [...new Set(companyIds)].slice(0, 100).map(id => ({ id })),
          properties: ["name", "notes_last_updated"],
        }).catch(() => ({ results: [] }));
        (companyData.results || []).forEach(c => {
          companiesById[c.id] = { name: c.properties?.name || null, lastContact: c.properties?.notes_last_updated || null };
        });
      }

      // All associated contacts across all deals, chunked into batches of 100
      // (HubSpot batch/read's practical cap).
      const allContactIds = [...new Set(
        deals.flatMap(d => (d.associations?.contacts?.results || []).map(c => c.id))
      )];
      const contactsById = {};
      for (let i = 0; i < allContactIds.length; i += 100) {
        const chunk = allContactIds.slice(i, i + 100);
        const contactData = await hsPost(userId, "/crm/v3/objects/contacts/batch/read", {
          inputs: chunk.map(id => ({ id })),
          properties: ["notes_last_updated"],
        }).catch(() => ({ results: [] }));
        (contactData.results || []).forEach(c => {
          contactsById[c.id] = c.properties?.notes_last_updated || null;
        });
      }

      return deals.map(d => {
        const companyId = d.associations?.companies?.results?.[0]?.id;
        const company = companiesById[companyId] || {};
        const contactIds = (d.associations?.contacts?.results || []).map(c => c.id);
        const contactLastContacts = contactIds.map(id => contactsById[id]).filter(Boolean);

        // Take the most recent across deal, company, AND all associated
        // contacts — any one of these can hold the real "last touched"
        // date depending on where whoever logged the activity happened to
        // tag it, and HubSpot doesn't roll these up to each other.
        const dealLastContact = d.properties?.notes_last_updated || null;
        const companyLastContact = company.lastContact || null;
        const candidates = [
          { at: dealLastContact, source: "deal" },
          { at: companyLastContact, source: "company" },
          ...contactLastContacts.map(at => ({ at, source: "contact" })),
        ].filter(c => c.at);
        candidates.sort((a, b) => new Date(b.at) - new Date(a.at));
        const winner = candidates[0] || { at: null, source: null };

        const pipelineId = d.properties?.pipeline;
        const stageId = d.properties?.dealstage;
        const stageLabel = PIPELINE_STAGES[pipelineId]?.stages.find(s => s.id === stageId)?.label || null;

        return {
          id: d.id,
          name: d.properties?.dealname || "Untitled deal",
          pipelineId,
          pipelineLabel: PIPELINE_STAGES[pipelineId]?.label || null,
          stageId,
          stageLabel,
          amount: d.properties?.amount || null,
          nextStep: d.properties?.hs_next_step || null,
          currentStatus: d.properties?.current_status || null,
          ownerId: d.properties?.hubspot_owner_id || null,
          ownerName: ownersById[String(d.properties?.hubspot_owner_id)] || null,
          companyName: company.name || null,
          companyId: companyId || null,
          hubspotDealUrl: `https://app.hubspot.com/contacts/39921549/record/0-3/${d.id}`,
          hubspotCompanyUrl: companyId ? `https://app.hubspot.com/contacts/39921549/record/0-2/${companyId}` : null,
          lastModified: d.properties?.hs_lastmodifieddate || null,
          lastContact: winner.at,
          lastContactSource: winner.source,
          activityCount: d.properties?.num_notes ? Number(d.properties.num_notes) : 0,
          closeDate: d.properties?.closedate || null,
        };
      });
    }

    const DEAL_SEARCH_PROPERTIES = ["dealname", "dealstage", "pipeline", "amount", "hs_next_step", "current_status", "hubspot_owner_id", "hs_lastmodifieddate", "closedate", "notes_last_updated", "num_notes"];

    // GET /pipeline-review?company=X — search across ALL THREE pipelines at
    // once for a specific company, since a company's deals can and do span
    // more than one pipeline (new business + expansion, for instance).
    if (method === "GET" && path === "/pipeline-review" && qp.company) {
      try {
        const companySearch = await hsPost(user.userId, "/crm/v3/objects/companies/search", {
          filterGroups: [{ filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: qp.company }] }],
          properties: ["name"],
          limit: 20,
        }).catch(() => ({ results: [] }));

        const matchedCompanyIds = (companySearch.results || []).map(c => c.id);
        if (matchedCompanyIds.length === 0) {
          return ok({ companyQuery: qp.company, deals: [] });
        }

        // Get each matched company's associated deal IDs, then batch-read those deals.
        const dealIdSets = await Promise.all(
          matchedCompanyIds.map(id =>
            hsGet(user.userId, `/crm/v4/objects/companies/${id}/associations/deals`, {}).catch(() => ({ results: [] }))
          )
        );
        // Track which company each deal actually belongs to, since a search
        // can match multiple companies (e.g. several "Loma Linda" records) —
        // deals must not all get attributed to whichever company happened
        // to be first in the list.
        const dealToCompanyId = {};
        matchedCompanyIds.forEach((companyId, idx) => {
          (dealIdSets[idx]?.results || []).forEach(a => {
            dealToCompanyId[a.toObjectId || a.id] = companyId;
          });
        });
        const dealIds = Object.keys(dealToCompanyId);
        if (dealIds.length === 0) {
          return ok({ companyQuery: qp.company, deals: [] });
        }

        const dealBatch = await hsPost(user.userId, "/crm/v3/objects/deals/batch/read", {
          inputs: dealIds.slice(0, 200).map(id => ({ id })),
          properties: DEAL_SEARCH_PROPERTIES,
        }).catch(() => ({ results: [] }));

        // batch/read doesn't return associations — fetch those separately.
        // Company is already known per-deal from the earlier lookup; contacts
        // need a real fetch, now via the same batch helper used in pipeline
        // mode instead of one GET call per deal.
        const companyModeContactAssoc = await batchFetchAssociations(user.userId, "deals", "contacts", (dealBatch.results || []).map(d => d.id));
        const dealsWithAssoc = (dealBatch.results || []).map(d => ({
          ...d,
          associations: {
            companies: { results: dealToCompanyId[d.id] ? [{ id: dealToCompanyId[d.id] }] : [] },
            contacts: { results: (companyModeContactAssoc[d.id] || []).map(id => ({ id })) },
          },
        }));

        // Exclude closed deals across whichever pipeline each one belongs to.
        const openDeals = dealsWithAssoc.filter(d => {
          const pipelineId = d.properties?.pipeline;
          const closedStages = PIPELINE_STAGES[pipelineId]?.closedStages || [];
          return !closedStages.includes(d.properties?.dealstage);
        });

        const formatted = await enrichAndFormatDeals(user.userId, openDeals);
        return ok({ companyQuery: qp.company, deals: formatted });
      } catch (err) {
        return error(500, `Pipeline review company search error: ${err.message}`);
      }
    }

    if (method === "GET" && path === "/pipeline-review") {
      try {
        const pipelineId = qp.pipeline;
        if (!pipelineId || !PIPELINE_STAGES[pipelineId]) {
          return error(400, `pipeline is required and must be one of: ${Object.keys(PIPELINE_STAGES).join(", ")}`);
        }
        const config = PIPELINE_STAGES[pipelineId];
        const filters = [
          { propertyName: "pipeline", operator: "EQ", value: pipelineId },
          { propertyName: "dealstage", operator: "NOT_IN", values: config.closedStages },
        ];
        if (qp.ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: qp.ownerId });

        // Paginate through ALL open deals rather than capping at one page of
        // 200 sorted by last-modified. That cap was the actual bug behind
        // "near-term deals missing" — a stalled deal that hasn't been
        // touched recently but has an urgent close date would never even
        // be fetched, so no client-side sort could ever surface it. Capped
        // at 1000 total as a sane safety limit, well above any real
        // pipeline's open-deal count.
        let deals = [];
        let after = undefined;
        for (let page = 0; page < 5; page++) {
          const pageData = await hsPost(user.userId, "/crm/v3/objects/deals/search", {
            filterGroups: [{ filters }],
            properties: DEAL_SEARCH_PROPERTIES,
            sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
            limit: 200,
            ...(after ? { after } : {}),
          }).catch(() => ({ results: [] }));
          deals = deals.concat(pageData.results || []);
          after = pageData.paging?.next?.after;
          if (!after) break;
        }

        const dealIds = deals.map(d => d.id);

        const [companyAssoc, contactAssoc] = await Promise.all([
          batchFetchAssociations(user.userId, "deals", "companies", dealIds),
          batchFetchAssociations(user.userId, "deals", "contacts", dealIds),
        ]);

        const dealsWithAssoc = deals.map(d => ({
          ...d,
          associations: {
            companies: { results: (companyAssoc[d.id] || []).map(id => ({ id })) },
            contacts: { results: (contactAssoc[d.id] || []).map(id => ({ id })) },
          },
        }));

        const formatted = await enrichAndFormatDeals(user.userId, dealsWithAssoc);

        return ok({ pipeline: { id: pipelineId, label: config.label }, stages: config.stages, deals: formatted });
      } catch (err) {
        return error(500, `Pipeline review error: ${err.message}`);
      }
    }

    // GET /pipeline-review/deal/:id — recap detail for one deal: recent
    // notes/calls/meetings so a presenter has real talking points, not
    // just the stage and next-step property.
    if (method === "GET" && path.startsWith("/pipeline-review/deal/")) {
      try {
        const dealId = path.replace("/pipeline-review/deal/", "");
        const engagementsData = await hsGet(user.userId, `/engagements/v1/engagements/associated/DEAL/${dealId}/paged`, { limit: 20 }).catch(() => ({ results: [] }));

        const allEngagements = (engagementsData.results || []).map(eng => {
          const type = eng.engagement?.type || "UNKNOWN";
          return {
            type,
            timestamp: eng.engagement?.timestamp ? new Date(eng.engagement.timestamp).toISOString() : null,
            body: stripHtml(eng.metadata?.body || eng.metadata?.text || null),
            // Meetings get a guaranteed "Meeting" fallback so one can never
            // be silently excluded below purely for lacking notes or a
            // title — that's exactly what caused Last Meeting and Recent
            // Activity to show different dates for the same deal.
            subject: eng.metadata?.subject || eng.metadata?.title || (type === "MEETING" ? "Meeting" : null),
          };
        });

        const recap = allEngagements
          .filter(e => e.body || e.subject)
          .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
          .slice(0, 5);

        // Need the deal's contact emails to check Outlook — a deal has no
        // direct "attendee" concept, so this goes through its contacts.
        const contactAssoc = await batchFetchAssociations(user.userId, "deals", "contacts", [dealId]);
        const contactIds = contactAssoc[dealId] || [];
        let contactEmails = [];
        if (contactIds.length > 0) {
          const contactBatch = await hsPost(user.userId, "/crm/v3/objects/contacts/batch/read", {
            inputs: contactIds.slice(0, 20).map(id => ({ id })),
            properties: ["email"],
          }).catch(() => ({ results: [] }));
          contactEmails = (contactBatch.results || []).map(c => c.properties?.email).filter(Boolean);
        }

        const lastMeeting = await findLastMeeting(user.userId, allEngagements, contactEmails);

        return ok({ recap, lastMeeting });
      } catch (err) {
        return error(500, `Deal recap error: ${err.message}`);
      }
    }

    // GET /pipeline-review/discussed — which deal IDs are marked discussed
    // in the current meeting session. Persisted (not just client state) so
    // a page reload mid-meeting doesn't lose progress, but explicitly reset
    // via the endpoint below rather than auto-expiring — a facilitator
    // should control when a new meeting cycle starts, not a timer guessing.
    // GET/POST /pipeline-review/focus — "Focus Deal" flags. Deliberately
    // SHARED across all users (no userId in the blob key), unlike
    // "discussed" above which is per-presenter. Someone curates this list
    // before the meeting and everyone needs to see the same curated set.
    if (method === "GET" && path === "/pipeline-review/focus") {
      try {
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ dealIds: [] });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/pipeline-focus-deals.json${sas}`;
        const res = await fetch(url);
        if (!res.ok) return ok({ dealIds: [] });
        const data = await res.json();
        return ok({ dealIds: data.dealIds || [] });
      } catch (err) {
        return ok({ dealIds: [], error: err.message });
      }
    }

    if (method === "POST" && path === "/pipeline-review/focus") {
      try {
        const body = JSON.parse(event.body || "{}");
        if (!body.dealId) return error(400, "dealId is required");
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ dealIds: [] });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/pipeline-focus-deals.json${sas}`;
        const res = await fetch(url);
        const data = res.ok ? await res.json() : { dealIds: [] };
        const current = new Set(data.dealIds || []);
        body.focus ? current.add(body.dealId) : current.delete(body.dealId);
        const updated = [...current];
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
          body: JSON.stringify({ dealIds: updated }),
        });
        return ok({ dealIds: updated });
      } catch (err) {
        return error(500, `Focus error: ${err.message}`);
      }
    }

    if (method === "GET" && path === "/pipeline-review/discussed") {
      try {
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ dealIds: [] });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/pipeline-discussed-${user.userId}.json${sas}`;
        const res = await fetch(url);
        if (!res.ok) return ok({ dealIds: [] });
        const data = await res.json();
        return ok({ dealIds: data.dealIds || [] });
      } catch (err) {
        return ok({ dealIds: [], error: err.message });
      }
    }

    // POST /pipeline-review/discussed  { dealId, discussed: true|false }
    if (method === "POST" && path === "/pipeline-review/discussed") {
      try {
        const body = JSON.parse(event.body || "{}");
        if (!body.dealId) return error(400, "dealId is required");
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ dealIds: [] });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/pipeline-discussed-${user.userId}.json${sas}`;
        const res = await fetch(url);
        const data = res.ok ? await res.json() : { dealIds: [] };
        const current = new Set(data.dealIds || []);
        body.discussed ? current.add(body.dealId) : current.delete(body.dealId);
        const updated = [...current];
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
          body: JSON.stringify({ dealIds: updated }),
        });
        return ok({ dealIds: updated });
      } catch (err) {
        return error(500, `Discussed error: ${err.message}`);
      }
    }

    // POST /pipeline-review/discussed/reset — clear all discussed flags,
    // for starting the next bi-weekly meeting cycle clean.
    if (method === "POST" && path === "/pipeline-review/discussed/reset") {
      try {
        if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return ok({ dealIds: [] });
        const sas = AZURE_SAS_TOKEN.startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
        const url = `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/pipeline-discussed-${user.userId}.json${sas}`;
        await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
          body: JSON.stringify({ dealIds: [] }),
        });
        return ok({ dealIds: [] });
      } catch (err) {
        return error(500, `Reset error: ${err.message}`);
      }
    }

    // TEMPORARY diagnostic — GET /whoami. Confirmed: /crm/v3/owners/me
    // returns a hard 400 on this portal's token ("Unable to parse value
    // for path parameter: ownerId") — that's the root cause of cross-user
    // leakage in the queue, not a filter-logic bug. Shows both the broken
    // endpoint's raw behavior and the new reliable (email-match) method's
    // result, so this stays useful for confirming the fix actually works.
    // Safe to remove once confirmed working.
    if (method === "GET" && path === "/whoami") {
      let brokenEndpointResult = null;
      try {
        const meData = await hsGet(user.userId, "/crm/v3/owners/me", {});
        brokenEndpointResult = { ok: true, data: meData };
      } catch (err) {
        brokenEndpointResult = { ok: false, error: err.message };
      }
      const reliable = await getMyHubSpotOwner(user.userId, user.email);
      return ok({
        cipherUserId: user.userId,
        cipherEmail: user.email || null,
        ownersMeEndpoint: brokenEndpointResult,
        reliableMethod: reliable,
      });
    }

    return error(404, "Route not found");

  })(event, context);
};


// ─── Response helpers ─────────────────────────────────────────────────────────

function ok(data) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(data),
  };
}

function error(status, message) {
  return {
    statusCode: status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({ error: message }),
  };
}

class ApiError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}
