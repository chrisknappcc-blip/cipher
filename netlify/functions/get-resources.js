// netlify/functions/get-resources.js
// REPLACE — path from repo root: netlify/functions/get-resources.js
//
// Read-only access to the SAME content library the Onboarding tool
// authors into (Azure Blob container "onboarding-cc"). This is
// deliberately a thin, separate function rather than folded into
// hubspot.js — this data has nothing to do with HubSpot/CRM data, and
// keeping it separate matches the pattern already used for other
// standalone concerns in this repo (top5-scheduler.js,
// primary-outreach-rep-webhook.js).
//
// DEFAULT BEHAVIOR CHANGED: this used to resolve to a single bucket
// (team -> the viewer's own manager email -> track -> shared, stopping
// at the first non-empty match — copied exactly from Onboarding's own
// resolution order). Cipher's Resources tab now shows the UNION of every
// team/manager's content by default instead — every bucket that's ever
// had content authored for a given section, merged into one list. This
// works by listing every blob under content/ via Azure's List Blobs API
// (rather than needing to know every team/manager name in advance), then
// fetching and merging whichever ones match the requested section.
//
// Each merged block gets its source bucket prepended to its folder path
// (e.g. "Chris Knapp / Q3 Calls" instead of just "Q3 Calls") specifically
// so it's still clear whose content is whose once everything's combined
// — without that, a flat merged list would make it impossible to tell
// which team a given link or recording actually came from.
//
// The old single-bucket resolution is still available via ?scope=mine
// for anyone who wants just their own team's content, in case "show
// everything by default" turns out to be too noisy in practice.

import { withAuth } from "./utils/auth.js";

// Dedicated account name for Onboarding's storage — deliberately NOT
// reusing Cipher's own AZURE_STORAGE_ACCOUNT_NAME. Confirmed via a live
// diagnostic that these are two genuinely different storage accounts
// ("ciphercc" for Cipher's own data vs "carepathiqdata" for Onboarding's)
// — a SAS token is cryptographically signed for one specific account, so
// pointing it at the wrong account's URL always fails with a 403
// regardless of how correct every other parameter is. That mismatch was
// the actual root cause of every 403 hit while debugging this originally.
const ACCOUNT = process.env.AZURE_ONBOARDING_ACCOUNT_NAME;
// Dedicated, read-only, container-scoped SAS token for onboarding-cc —
// deliberately separate from AZURE_STORAGE_SAS_TOKEN (Cipher's own token
// for its own container).
const SAS = process.env.AZURE_ONBOARDING_SAS_TOKEN;
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

// Azure's List Blobs response is XML — this is a well-known, fixed
// structure (<Name>content/foo/bar.json</Name> repeated per blob), so a
// direct regex extraction is used here rather than pulling in a full XML
// parsing dependency for one simple, predictable tag.
async function listBlobNames(prefix) {
  const url = `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${SAS}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Azure list failed for prefix ${prefix}: ${res.status}`);
  const xml = await res.text();
  const names = [];
  const regex = /<Name>([^<]+)<\/Name>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) names.push(match[1]);
  return names;
}

// Turns a raw bucket identifier from the blob path into something
// readable to prepend onto folder names once merged — "team:client-
// executive" becomes "Client Executive Team", an email stays as-is
// (still identifiable, just not reformatted), "shared"/"bdr"/"ae" stay
// as their plain label.
function bucketLabel(bucket) {
  if (bucket.startsWith("team:")) {
    const slug = bucket.slice(5).replace(/-/g, " ");
    return slug.replace(/\b\w/g, c => c.toUpperCase()) + " Team";
  }
  return bucket;
}

export const handler = async (event, context) => {
  return withAuth(async (event, context, user) => {
    const qpDebug = event.queryStringParameters || {};
    if (qpDebug.debug === "1") {
      return {
        statusCode: 200,
        body: JSON.stringify({
          accountSet: !!ACCOUNT,
          accountValue: ACCOUNT || null,
          sasSet: !!SAS,
          sasLength: SAS ? SAS.length : 0,
          sasPreview: SAS ? `${SAS.slice(0, 8)}...${SAS.slice(-8)}` : null,
          containerValue: CONTAINER,
        }),
      };
    }

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

    const hasContent = (d) => d && Array.isArray(d.blocks) && d.blocks.length > 0;

    // ── ?scope=mine — the original single-bucket resolution, kept as an
    // opt-in in case the all-teams default turns out to be too noisy. ──
    if (qp.scope === "mine") {
      const track = qp.track || "bdr";
      const team = qp.team || null;
      const managerId = user.email;
      try {
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
    }

    // ── Default — union of every team/manager bucket's content ──────────
    try {
      const allBlobNames = await listBlobNames("content/");
      // Match content/{bucket}/{section}.json for exactly this section —
      // bucket can itself contain no further slashes (team:foo, an
      // email, bdr/ae, shared).
      const sectionSuffix = `/${section}.json`;
      const matchingBuckets = allBlobNames
        .filter(name => name.startsWith("content/") && name.endsWith(sectionSuffix))
        .map(name => name.slice("content/".length, -sectionSuffix.length))
        .filter(bucket => !bucket.includes("/")); // skip anything unexpectedly nested

      const results = await Promise.all(
        matchingBuckets.map(async bucket => {
          const data = await readJson(`content/${bucket}/${section}.json`, null);
          return { bucket, data };
        })
      );

      const mergedBlocks = [];
      results.forEach(({ bucket, data }) => {
        if (!hasContent(data)) return;
        const label = bucketLabel(bucket);
        data.blocks.forEach(block => {
          mergedBlocks.push({
            ...block,
            folder: block.folder ? `${label}/${block.folder}` : label,
          });
        });
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ title: TITLES[section], blocks: mergedBlocks }),
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  })(event, context);
};
