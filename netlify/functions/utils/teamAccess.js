// netlify/functions/utils/teamAccess.js
//
// Who may see the Team views. These are the SAME rules hubspot.js uses (ADMIN_EMAILS or ADMIN_USER_IDS for admins,
// TEAM_HIERARCHY for managers), kept in one small place so the new team function follows them exactly. A test
// compares this against a copy of the rules in hubspot.js across many cases.

export function parseAccess(env = process.env) {
  const adminEmails = new Set((env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  const adminIds = new Set((env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean))
  let hierarchy = {}
  try { hierarchy = JSON.parse(env.TEAM_HIERARCHY || '{}') } catch { hierarchy = {} }
  return { adminEmails, adminIds, hierarchy }
}

export const isAdmin = (user, access) => access.adminEmails.has(String((user && user.email) || '').toLowerCase()) || access.adminIds.has((user && user.userId) || '')

// { canAccess, all, emails }: a manager sees their own reports, or everyone if their list holds "*".
export function teamVisibility(requestingEmail, access) {
  const email = String(requestingEmail || '').toLowerCase()
  const entry = Object.entries(access.hierarchy || {}).find(([mgr]) => mgr.toLowerCase() === email)
  if (!entry) return { canAccess: false, all: false, emails: new Set([email]) }
  const reports = (entry[1] || []).map((e) => String(e).toLowerCase())
  if (reports.includes('*')) return { canAccess: true, all: true, emails: null }
  return { canAccess: true, all: false, emails: new Set([email, ...reports]) }
}
