// netlify/functions/admin-create-user.js
// NEW FILE — path from repo root: netlify/functions/admin-create-user.js
//
// Admin-only: creates a Netlify Identity user directly with a known
// temporary password, completely bypassing the normal email-invite-link
// flow.
//
// WHY THIS EXISTS: Netlify Identity's normal invite flow sends a one-time
// confirmation link by email. Corporate email security systems (Microsoft
// Defender's "Safe Links" is the most common one) pre-fetch every link in
// an incoming email to scan it for safety BEFORE the real recipient ever
// sees it — and because the confirmation link is single-use, that
// automated pre-fetch consumes it. By the time the actual person clicks
// the link themselves, it's already been used, and they get an
// inexplicable "invalid or expired token" error with no clear fix. This
// has hit new team members trying to join Cipher more than once.
//
// The fix: skip the email-link step entirely. Netlify Identity's Admin
// API can create a fully-confirmed user with a real password directly —
// no link, no token to get pre-consumed, nothing to race against an email
// scanner. You (the admin) hand the new person their email and temporary
// password directly (text, Slack, in person — whatever's convenient),
// and they log in immediately with no confirmation step at all.
//
// SETUP — nothing new needed. This reuses:
//   - The same ADMIN_EMAILS / ADMIN_USER_IDS check already used elsewhere
//     in Cipher (netlify/functions/hubspot.js) — only an existing admin
//     can call this.
//   - Netlify's own service-level Identity credential, automatically
//     provided to every function invocation via context.clientContext.
//     identity when Identity is enabled on the site — this has admin
//     access to the Identity Admin API regardless of the calling user's
//     own Identity role, so there's no separate "does my account have
//     the Admin role" dependency to worry about.
//   - Sets app_metadata.must_change_password = true on every user this
//     creates or fixes — app_metadata can only ever be set by an admin/
//     service credential, never by the user themselves, which is what
//     makes this a real enforced flag rather than something a new user
//     could quietly clear on their own.

import { withAuth } from "./utils/auth.js";

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);
const ADMIN_USER_IDS = new Set(
  (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);
const isAdminUser = (u) => ADMIN_EMAILS.has((u?.email || "").toLowerCase()) || ADMIN_USER_IDS.has(u?.userId || "");

function generateTempPassword() {
  // Reasonably strong, easy to read/type over text or a phone call —
  // avoids visually ambiguous characters (0/O, 1/l/I).
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let pw = "";
  for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

export const handler = async (event, context) => {
  return withAuth(async (event, context, user) => {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
    }
    if (!isAdminUser(user)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Admin only" }) };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    const email = (body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return { statusCode: 400, body: JSON.stringify({ error: "A valid email is required" }) };
    }
    const password = body.password || generateTempPassword();

    // Netlify automatically provides this to every function invocation
    // when Identity is enabled on the site — a service-level credential
    // scoped to this one invocation, with admin access to the Identity
    // Admin API regardless of which user actually called this function.
    // This is the standard, documented pattern for exactly this use case,
    // and it's more reliable than the previous approach (passing through
    // the calling admin's own token), which only worked because that
    // admin happened to have the Identity "Admin" role assigned — a
    // separate, easy-to-miss permission system from the app-level
    // isAdminUser check above.
    const identityContext = context.clientContext && context.clientContext.identity;
    if (!identityContext || !identityContext.url || !identityContext.token) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Identity service context not available — confirm Identity is enabled for this site in Site settings." }),
      };
    }
    const identityBase = `${identityContext.url}/admin`;
    const identityHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${identityContext.token}` };

    try {
      // Look up whether this email already has a user record — this
      // matters specifically because someone who already went through a
      // failed invite (the exact scenario this endpoint exists for) has a
      // PENDING, unconfirmed user sitting in Netlify Identity already.
      // Trying to create a fresh user on top of that would fail with a
      // "user already registered" error — the right move for an existing
      // pending invite is to update it (set a real password, confirm it),
      // not create a second record.
      let existingUser = null;
      let after = undefined;
      for (let page = 0; page < 10 && !existingUser; page++) {
        const qs = new URLSearchParams({ per_page: "100", ...(after ? { after } : {}) });
        const listRes = await fetch(`${identityBase}/users?${qs}`, { headers: identityHeaders });
        if (!listRes.ok) break; // fall through to plain create attempt below
        const listData = await listRes.json().catch(() => ({}));
        const users = Array.isArray(listData) ? listData : (listData.users || []);
        existingUser = users.find(u => (u.email || "").toLowerCase() === email);
        if (users.length < 100) break; // last page
        after = users[users.length - 1]?.id;
      }

      // app_metadata (not user_metadata) is deliberately used for the
      // must-change-password flag — app_metadata can only be set by an
      // admin/service credential, never by the user themselves through
      // the normal client update() call. That's what makes this a real
      // enforced flag rather than something a new user could quietly
      // clear on their own.
      const metadataBody = { app_metadata: { must_change_password: true } };

      let res, data, action;
      if (existingUser) {
        action = "updated";
        res = await fetch(`${identityBase}/users/${existingUser.id}`, {
          method: "PUT",
          headers: identityHeaders,
          body: JSON.stringify({ password, email_confirm: true, ...metadataBody }),
        });
      } else {
        action = "created";
        res = await fetch(`${identityBase}/users`, {
          method: "POST",
          headers: identityHeaders,
          body: JSON.stringify({ email, password, email_confirm: true, ...metadataBody }),
        });
      }
      data = await res.json().catch(() => ({}));

      if (!res.ok) {
        return {
          statusCode: res.status,
          body: JSON.stringify({ error: data.msg || data.error_description || `Netlify Identity Admin API error (${res.status})` }),
        };
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          email,
          password, // returned once, here, so you can relay it — never stored or logged anywhere
          userId: data.id,
          action, // "created" (brand new) or "updated" (fixed a stuck pending invite)
          message: action === "updated"
            ? "Found an existing pending invite for this email and confirmed it directly with a new password — no email link needed. They'll be required to change this password on first login."
            : "User created and fully confirmed — no email link needed. They'll be required to change this password on first login.",
        }),
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  })(event, context);
};
