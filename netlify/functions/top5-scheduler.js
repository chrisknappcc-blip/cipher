// netlify/functions/top5-scheduler.js
// NEW FILE — path from repo root: netlify/functions/top5-scheduler.js
//
// Runs hourly (Netlify scheduled function), but only does real work at
// 8am and 1pm Eastern. Checking actual Eastern time via Intl instead of a
// fixed UTC cron means this self-corrects through DST twice a year with no
// manual schedule changes needed.
//
// For each known user: pulls their full Right Now Queue, hands the top
// candidates to Claude, and caches the ranked Top 5 + one-line rationale
// per item to Azure Blob. The /top5 endpoint in hubspot.js just reads that
// cache — this is the only place that ever calls the AI model for this
// feature, so cost stays fixed at two calls per rep per day, not per page load.

import { computeRightNowQueue, getActiveUserIds } from "./hubspot.js";

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

// DST-safe Eastern time check — no hardcoded UTC offset.
function currentEasternSlot() {
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

  if (hour === 8)  return { slot: "AM", dateKey };
  if (hour === 13) return { slot: "PM", dateKey };
  return null; // not a run hour — most invocations of this hourly function do nothing
}

async function alreadyRan(userId, dateKey, slot) {
  const last = await readJson(`top5-lastrun-${userId}.json`, null);
  return last && last.dateKey === dateKey && last.slot === slot;
}
async function markRan(userId, dateKey, slot) {
  await writeJson(`top5-lastrun-${userId}.json`, { dateKey, slot, ranAt: new Date().toISOString() });
}

async function rankTop5WithClaude(candidates) {
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

export default async () => {
  const { slot, dateKey } = currentEasternSlot() || {};
  if (!slot) return new Response("Not a scheduled run hour, skipping.", { status: 200 });

  const userIds = await getActiveUserIds();
  const results = [];

  for (const userId of userIds) {
    try {
      if (await alreadyRan(userId, dateKey, slot)) {
        results.push({ userId, skipped: "already ran this slot" });
        continue;
      }

      const queue = await computeRightNowQueue(userId, {});
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
