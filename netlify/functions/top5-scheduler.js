// netlify/functions/top5-scheduler.js
// NEW FILE — path from repo root: netlify/functions/top5-scheduler.js
//
// Runs every hour (Netlify scheduled function). Previously restricted to
// 8am/1pm Eastern only — now runs every hour on the hour, giving a much
// more "live" feel at a modest cost increase (roughly $8-10/month for a
// team under 10, vs ~$1.50/month at twice a day).
//
// For each known user: pulls their full Right Now Queue, hands the top
// candidates to Claude, and caches the ranked Top 5 + one-line rationale
// per item to Azure Blob. The /top5 endpoint in hubspot.js just reads that
// cache — this is the only place that ever calls the AI model for this
// feature, so cost stays fixed at the scheduled cadence, not per page load.

import { computeRightNowQueue, getActiveUserIds, checkSequenceCompletions, rankTop5WithClaude } from "./hubspot.js";

const AZURE_ACCOUNT   = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const AZURE_SAS_TOKEN = process.env.AZURE_STORAGE_SAS_TOKEN;
const AZURE_CONTAINER = process.env.AZURE_STORAGE_CONTAINER || "crm-tokens";

function blobUrl(name) {
  const sas = (AZURE_SAS_TOKEN || "").startsWith("?") ? AZURE_SAS_TOKEN : `?${AZURE_SAS_TOKEN}`;
  return `https://${AZURE_ACCOUNT}.blob.core.windows.net/${AZURE_CONTAINER}/${name}${sas}`;
}

async function readJson(name, fallback) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return fallback;
  try {
    const res = await fetch(blobUrl(name));
    if (!res.ok) return fallback;
    return await res.json();
  } catch { return fallback; }
}
async function writeJson(name, data) {
  if (!AZURE_ACCOUNT || !AZURE_SAS_TOKEN) return;
  await fetch(blobUrl(name), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-ms-blob-type": "BlockBlob" },
    body: JSON.stringify(data),
  });
}

// Returns the current Eastern-time hour and date, used as the run-guard key
// (dateKey + hour) so a retry or overlapping invocation within the same
// hour doesn't double-fire. DST-safe since it reads real Eastern time via
// Intl rather than a fixed UTC offset.
function currentEasternHourKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = t => parts.find(p => p.type === t)?.value;
  const hour = parseInt(get("hour"), 10);
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  return { slot: `h${hour}`, dateKey };
}

async function alreadyRan(userId, dateKey, slot) {
  const last = await readJson(`top5-lastrun-${userId}.json`, null);
  return last && last.dateKey === dateKey && last.slot === slot;
}
async function markRan(userId, dateKey, slot) {
  await writeJson(`top5-lastrun-${userId}.json`, { dateKey, slot, ranAt: new Date().toISOString() });
}

export default async () => {
  const { slot, dateKey } = currentEasternHourKey();

  const userIds = await getActiveUserIds();
  const results = [];

  for (const userId of userIds) {
    try {
      if (await alreadyRan(userId, dateKey, slot)) {
        results.push({ userId, skipped: "already ran this slot" });
        continue;
      }

      const queue = await computeRightNowQueue(userId, {});

      // Moved here from the live /right-now path — this was costing every
      // single page load up to 60 API calls (30 contacts, 2 calls each) to
      // detect something that doesn't need to be instant. Once an hour is
      // a perfectly fine cadence for "a sequence quietly finished."
      await checkSequenceCompletions(userId);

      const pinnedData = await readJson(`pinned-${userId}.json`, { pinnedIds: [] });
      const pinnedIds = new Set(pinnedData.pinnedIds || []);

      // Don't waste a ranking slot on something already pinned — pins
      // always show regardless of what the AI picks (see /top5 consumer logic).
      const candidates = queue.filter(item => !pinnedIds.has(item.id)).slice(0, 20);

      const picks = candidates.length > 0 ? await rankTop5WithClaude(candidates) : [];

      await writeJson(`top5-${userId}.json`, {
        picks,
        generatedAt: new Date().toISOString(),
        slot,
      });
      await markRan(userId, dateKey, slot);
      results.push({ userId, picks: picks.length });
    } catch (err) {
      console.error(`[top5-scheduler] Failed for user ${userId}:`, err.message);
      results.push({ userId, error: err.message });
    }
  }

  return new Response(JSON.stringify({ slot, dateKey, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  schedule: "0 * * * *", // every hour on the hour; the function itself decides whether to act
};
