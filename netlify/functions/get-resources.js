// netlify/functions/get-resources.js
// NEW FILE — path from repo root: netlify/functions/get-resources.js
//
// Read-only access to the SAME content library the Onboarding tool
// authors into (Azure Blob container "onboarding-cc"). This is
// deliberately a thin, separate function rather than folded into
// hubspot.js — this data has nothing to do with HubSpot/CRM data, and
// keeping it separate matches the pattern already used for other
// standalone concerns in this repo (top5-scheduler.js,
// primary-outreach-rep-webhook.js).
//
// Resolution order is copied EXACTLY from the Onboarding tool's own
// get-content.js (team -> managerId -> track -> shared) — this is the
// real, verified logic pulled directly from that codebase, not
// reconstructed from a description. Read-only: this never writes back to
// the blob, so there's no risk of the two apps racing on the same file.
//
// managerId is mapped to the logged-in Cipher user's own email. In
// Onboarding, a manager's email is where most real content actually
// lives (per that team's own documentation) — so a rep viewing Resources
// in Cipher sees their own authored content first, falling through to
// track-wide and shared defaults exactly the way a new hire would in
// Onboarding.

import { withAuth } from "./utils/auth.js";

const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const SAS = process.env.AZURE_STORAGE_SAS_TOKEN;
// Separate container from Cipher's own data — same Azure account and SAS
// token Cipher already uses elsewhere, just pointed at Onboarding's
// container. Matches the default in Onboarding's own azureBlob.js.
const CONTAINER = process.env.AZURE_ONBOARDING_CONTAINER || "onboarding-cc";

const TITLES = {
  "gong-library": "Insightful Gong Recordings",
  "app-walkthroughs": "Tools We Use",
  intranet: "Valuable Links",
};

function blobUrl(blobName) {
  return `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${encodeURIComponent(blobName)}?${SAS}`;
}

async function readJson(blobName, fallback = null) {
  const res = await fetch(blobUrl(blobName));
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error(`Azure read failed for ${blobName}: ${res.status}`);
  return res.json();
}

export const handler = async (event, context) => {
  return withAuth(async (event, context, user) => {
    if (!ACCOUNT || !SAS) {
      return { statusCode: 500, body: JSON.stringify({ error: "Azure storage not configured" }) };
    }

    const qp = event.queryStringParameters || {};
    const section = qp.section;
    if (!section || !TITLES[section]) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `section must be one of: ${Object.keys(TITLES).join(", ")}` }),
      };
    }

    // track/team have no equivalent in Cipher today — a person can be
    // passed in via query param if that ever changes, but for now this
    // only resolves through managerId (the viewer's own email) and the
    // shared fallback. Still written as the full 4-tier chain so behavior
    // stays identical to Onboarding if track/team scoping is added later.
    const track = qp.track || "bdr";
    const team = qp.team || null;
    const managerId = user.email;

    try {
      const hasContent = (d) => d && Array.isArray(d.blocks) && d.blocks.length > 0;
      let data = null;
      if (team) {
        const teamData = await readJson(`content/team:${team}/${section}.json`, null);
        if (hasContent(teamData)) data = teamData;
      }
      if (!data && managerId) {
        const managerData = await readJson(`content/${managerId}/${section}.json`, null);
        if (hasContent(managerData)) data = managerData;
      }
      if (!data) {
        const trackData = await readJson(`content/${track}/${section}.json`, null);
        if (hasContent(trackData)) data = trackData;
      }
      if (!data) data = await readJson(`content/shared/${section}.json`, null);

      const result = data || { title: TITLES[section], blocks: [] };
      if (!result.title) result.title = TITLES[section];
      return { statusCode: 200, body: JSON.stringify(result) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  })(event, context);
};
