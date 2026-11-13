// netlify/functions/utils/teamReport.js
//
// Pure logic for the Team views: one person's queue numbers, and the "who is actually using Cipher" report.
// No network and no storage here, so every case can be tested.

import { dayKey } from './usage.js'

export const STATS_TTL_MS = 10 * 60e3
export const ERROR_TTL_MS = 2 * 60e3
export const ACTIVE_WITHIN_DAYS = 7
const DAY = 86400e3

// ─── One person's queue numbers ─────────────────────────────────────────────
export function statsFromQueue(queue, todos, now = new Date()) {
  const items = Array.isArray(queue) ? queue : []
  const oldest = items.map((i) => (i && i.raw && (i.raw.timestamp || i.raw.createdAt || i.raw.sentAt)) || null).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0]
  const today = dayKey(now)
  const completedToday = (Array.isArray(todos) ? todos : []).filter((t) => t && t.completed && t.completedAt && dayKey(new Date(t.completedAt)) === today).length
  return { queueCount: items.length, oldestHours: oldest ? Math.round((now.getTime() - new Date(oldest).getTime()) / 3600e3) : null, completedToday, computedAt: now.toISOString() }
}
export const statsFresh = (stats, now = new Date()) => !!stats && !!stats.computedAt && now.getTime() - Date.parse(stats.computedAt) < (stats.error ? ERROR_TTL_MS : STATS_TTL_MS)

// A plain reason for the screen. The real message goes to the server log, never to the browser.
export function friendlyQueueError(err) {
  const m = String((err && err.message) || err || '')
  if (/timed out|timeout/i.test(m)) return 'Took too long to load. Try again in a minute.'
  if (/not connected/i.test(m)) return 'HubSpot is not connected for this person.'
  if (/MISSING_SCOPES|scope/i.test(m)) return 'Their HubSpot connection needs to be redone.'
  if (/429|rate limit|too many/i.test(m)) return 'HubSpot is busy right now. Try again in a minute.'
  return 'Could not load their queue.'
}

// ─── Who is actually using Cipher ───────────────────────────────────────────
//   active        connected to HubSpot and used Cipher in the last 7 days
//   quiet         connected, last used more than 7 days ago
//   no_activity   connected, but no use recorded yet (recording began recently)
//   not_connected has used Cipher but HubSpot is not connected (or needs redoing)
//   never_opened  has a sign in account but has never opened Cipher
//   leftover      a saved profile whose sign in account no longer exists
export const STATUS_ORDER = ['active', 'quiet', 'no_activity', 'not_connected', 'never_opened', 'leftover']

export function buildUsageReport({ profiles = [], identityUsers = null, hubspot = {}, outlook = {}, usage = {}, now = new Date() }) {
  const nowMs = now.getTime()
  const cut7 = dayKey(new Date(nowMs - 6 * DAY)), cut30 = dayKey(new Date(nowMs - 29 * DAY))
  const idList = Array.isArray(identityUsers) ? identityUsers : null
  const byId = new Map((idList || []).map((u) => [u.id, u]))
  const confirmed = (u) => !!(u && (u.confirmed_at || u.email_confirmed_at))
  const blankOutlook = { connected: false, calendar: false }

  const rows = profiles.map((p) => {
    const u = usage[p.userId] || null
    const idUser = idList ? byId.get(p.userId) || null : undefined
    const connected = hubspot[p.userId] === 'connected'
    const lastSeen = (u && u.lastSeen) || null
    const recent = !!lastSeen && nowMs - Date.parse(lastSeen) <= ACTIVE_WITHIN_DAYS * DAY
    let status
    if (idList && !idUser) status = 'leftover'
    else if (!connected) status = 'not_connected'
    else if (recent) status = 'active'
    else if (lastSeen) status = 'quiet'
    else status = 'no_activity'
    const days = (u && u.days) || []
    const ox = outlook[p.userId] || blankOutlook
    return {
      userId: p.userId, email: p.email || (u && u.email) || null, status,
      hubspot: connected ? 'connected' : hubspot[p.userId] === 'unknown' ? 'unknown' : 'not connected',
      outlook: { connected: !!ox.connected, calendar: !!ox.calendar },
      lastSeen, firstSeen: (u && u.firstSeen) || null, activeDays7: days.filter((d) => d >= cut7).length, activeDays30: days.filter((d) => d >= cut30).length,
      sections: Object.entries((u && u.sections) || {}).map(([name, v]) => ({ name, last: (v && v.last) || null })).sort((a, b) => String(b.last).localeCompare(String(a.last))),
      signedUp: (idUser && idUser.created_at) || null, confirmed: idUser ? confirmed(idUser) : null,
    }
  })
  const profileIds = new Set(profiles.map((p) => p.userId))
  const neverOpened = (idList || []).filter((u) => !profileIds.has(u.id)).map((u) => ({
    userId: u.id, email: u.email || null, status: 'never_opened', hubspot: 'not connected', outlook: { ...blankOutlook }, lastSeen: null, firstSeen: null,
    activeDays7: 0, activeDays30: 0, sections: [], signedUp: u.created_at || null, confirmed: confirmed(u),
  }))
  const all = rows.concat(neverOpened).sort((a, b) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || String(a.email || '').localeCompare(String(b.email || '')))
  const count = (s) => all.filter((r) => r.status === s).length
  const firsts = Object.values(usage).map((u) => u && u.firstSeen).filter(Boolean).sort()
  return {
    identityKnown: !!idList, generatedAt: now.toISOString(), trackingSince: firsts[0] || null, rows: all,
    summary: {
      accounts: all.length - count('leftover'), active: count('active'), quiet: count('quiet'), noActivity: count('no_activity'), notConnected: count('not_connected'),
      neverOpened: count('never_opened'), leftover: count('leftover'), outlookConnected: all.filter((r) => r.outlook.connected).length, outlookCalendar: all.filter((r) => r.outlook.calendar).length,
    },
  }
}
