// netlify/functions/add-resource-link.js
// NEW FILE — path from repo root: netlify/functions/add-resource-link.js
//
// Lets Cipher write directly into the same content library Onboarding
// authors into — Cipher -> Blob, not just Onboarding -> Blob -> Cipher.
// Admin-only (matches the same isAdminUser/currentUserName gating pattern
// used elsewhere in Cipher for admin-only actions).
//
// CONCURRENCY: this is a real, second writer into a file Onboarding's own
// Content Manager can also write to at any time. A naive "read the file,
// add a link, write it back" has a race condition — if someone edits the
// same section in Onboarding at nearly the same moment, whichever save
// happens second could silently overwrite the other's change with no
// warning. This uses Azure Blob's own ETag mechanism to guard against
// that: the write only succeeds if the blob hasn't changed since it was
// read. If it has (a real concurrent edit happened), this re-reads the
// latest version, re-applies the new link on top of it, and retries —
// up to 3 attempts — rather than silently losing whoever's data came
// second. This detects and resolves the race; it doesn't eliminate the
// small window where it could happen, since nothing can lock a file
// Onboarding's own separate app can still write to independently.
//
// The link gets written into the calling admin's OWN bucket
// (content/{email}/{section}.json) — the same place their own authored
// content already lives in Onboarding's own model. It shows up in
// Cipher's merged "all teams" view either way, since that view combines
// every bucket regardless of which one a given link was added to.

import { withAuth } from "./utils/auth.js";

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);
const isAdminUser = (u) => ADMIN_EMAILS.has((u?.email || "").toLowerCase()) || ADMIN_USER_IDS.has(u?.userId || "");

const ACCOUNT = process.env.AZURE_ONBOARDING_ACCOUNT_NAME;
// Deliberately a SEPARATE, write-capable token from AZURE_ONBOARDING_SAS_TOKEN
// (which stays read-only, permissions sp=rl, used by get-resources.js).
// Keeping them separate means the read path can never accidentally write,
// even if this file has a bug — the read-only token simply lacks the
// permission to, regardless of what code tries to do with it.
const WRITE_SAS = process.env.AZURE_ONBOARDING_WRITE_SAS_TOKEN;
const CONTAINER = process.env.AZURE_ONBOARDING_CONTAINER || "onboarding-cc";

const TITLES = {
  "gong-library": "Insightful Gong Recordings",
  "app-walkthroughs": "Tools We Use",
  intranet: "Valuable Links",
};

function blobUrl(blobName) {
  return `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${encodeURIComponent(blobName)}?${WRITE_SAS}`;
}

// Returns both the parsed content and the ETag needed for a conditional
// write later — a 404 (blob doesn't exist yet) is a valid starting
// state, not an error, since this may be the first link ever added to a
// brand new bucket/section combination.
async function readWithEtag(blobName) {
  const res = await fetch(blobUrl(blobName));
  if (res.status === 404) return { data: null, etag: null, isNew: true };
  if (!res.ok) throw new Error(`Azure read failed for ${blobName}: ${res.status}`);
  const data = await res.json();
  const etag = res.headers.get("etag");
  return { data, etag, isNew: false };
}

// Conditional write — If-Match on an existing blob (fails with 412 if
// someone else wrote to it since it was read), If-None-Match: * for a
// brand new blob (fails with 409 if someone else created it in the
// meantime — same race, different direction).
async function writeWithEtag(blobName, content, etag, isNew) {
  const headers = {
    "x-ms-blob-type": "BlockBlob",
    "Content-Type": "application/json",
  };
  headers[isNew ? "If-None-Match" : "If-Match"] = isNew ? "*" : etag;
  const res = await fetch(blobUrl(blobName), {
    method: "PUT",
    headers,
    body: JSON.stringify(content),
  });
  return res;
}

export const handler = async (event, context) => {
  return withAuth(async (event, context, user) => {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
    }
    if (!isAdminUser(user)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Admin only" }) };
    }
    if (!ACCOUNT || !WRITE_SAS) {
      return { statusCode: 500, body: JSON.stringify({ error: "Write access not configured — AZURE_ONBOARDING_WRITE_SAS_TOKEN is missing." }) };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    const { section, label, url, description, folder } = body;
    if (!section || !TITLES[section]) {
      return { statusCode: 400, body: JSON.stringify({ error: `section must be one of: ${Object.keys(TITLES).join(", ")}` }) };
    }
    if (!label || !url) {
      return { statusCode: 400, body: JSON.stringify({ error: "label and url are required" }) };
    }

    const blobName = `content/${user.email}/${section}.json`;
    const newBlock = {
      id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "link",
      label,
      url,
      description: description || "",
      folder: folder || "",
    };

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { data, etag, isNew } = await readWithEtag(blobName);
      const content = data && Array.isArray(data.blocks)
        ? { ...data, blocks: [...data.blocks, newBlock] }
        : { title: TITLES[section], blocks: [newBlock] };

      const res = await writeWithEtag(blobName, content, etag, isNew);
      if (res.ok) {
        return { statusCode: 200, body: JSON.stringify({ ok: true, block: newBlock, attempt }) };
      }
      // 412 (existing blob changed) or 409 (new blob created by someone
      // else) both mean a genuine concurrent write happened — loop back
      // and retry against the now-current version rather than give up
      // and lose the link, or silently overwrite what changed.
      if (res.status !== 412 && res.status !== 409) {
        return { statusCode: 500, body: JSON.stringify({ error: `Azure write failed: ${res.status}` }) };
      }
    }

    return {
      statusCode: 409,
      body: JSON.stringify({ error: `Could not save after ${MAX_ATTEMPTS} attempts — this section is being edited very actively right now. Try again in a moment.` }),
    };
  })(event, context);
};
