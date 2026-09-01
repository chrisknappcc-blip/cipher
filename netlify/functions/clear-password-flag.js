// netlify/functions/clear-password-flag.js
// NEW FILE — path from repo root: netlify/functions/clear-password-flag.js
//
// Called by a user themselves, right after they successfully set a real
// password on first login, to clear the must_change_password flag set on
// their account by admin-create-user.js. This is NOT an admin-only
// endpoint — any authenticated user can call it, but deliberately only to
// clear their OWN flag. Regular users can't set app_metadata directly
// through Netlify Identity's normal client-side update() call (only an
// admin/service credential can), so this small server-side step is what
// actually lets the flag get cleared once the real password is in place.

import { withAuth } from "./utils/auth.js";

export const handler = async (event, context) => {
  return withAuth(async (event, context, user) => {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    const identityContext = context.clientContext && context.clientContext.identity;
    if (!identityContext || !identityContext.url || !identityContext.token) {
      return { statusCode: 500, body: JSON.stringify({ error: "Identity service context not available." }) };
    }

    try {
      const res = await fetch(`${identityContext.url}/admin/users/${user.userId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${identityContext.token}`,
        },
        // Only ever touches the calling user's own record (user.userId
        // comes from their own verified session, not anything client-
        // supplied) — there's no way to pass a different user's ID in.
        body: JSON.stringify({ app_metadata: { must_change_password: false } }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { statusCode: res.status, body: JSON.stringify({ error: data.msg || `Failed to clear flag (${res.status})` }) };
      }

      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  })(event, context);
};
