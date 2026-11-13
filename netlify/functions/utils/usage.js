// netlify/functions/utils/usage.js
//
// Notes, for each signed in person, when they were last active in Cipher and which sections they used, so an admin
// can see who is actually using it. Called from withAuth (utils/auth.js) once a request has been verified.
//
// SAFE BY CONSTRUCTION
//  - It can never break or noticeably slow a request: everything is wrapped, and it waits at most about 0.7 seconds.
//  - It writes at most about once every 10 minutes per person per running copy of the function (and at most once a
//    minute when someone opens a section they had not used in this stretch), so it adds almost no load.
//  - Each person has their own file, named by a hash. It deliberately does NOT use the shared roster file
//    (active-users.json): that file is rewritten whole, so frequent updates from several people at once could drop
//    someone from the roster.
//  - Turn it off at any time by setting USAGE_TRACKING=off in Netlify.

import { createHash } from 'node:crypto'
import { createDebriefStore } from './debriefStore.js'

export const THROTTLE_MS = 10 * 60e3
export const NEW_SECTION_MS = 60e3
export const WAIT_MS = 700
export const KEEP_DAYS = 60

export const usageName = (userId) => `usage/${createHash('sha256').update(`usage:${userId}`).digest('hex').slice(0, 24)}.json`

// Which part of Cipher a request belongs to, from its URL. Calls the app makes on every load (status, whoami) say the
// app is open, not which part is being used, so they count as activity but name no section.
const HUBSPOT_SECTIONS = {
  'right-now': 'Now', top5: 'Now', pin: 'Now', dismissed: 'Now', todo: 'Now', tasks: 'Now',
  'meetings-tracker': 'Meetings', 'pipeline-review': 'Pipeline Review', 'pipeline-snapshots': 'Pipeline Review',
  gold: 'Gold Accounts', 'gold-gaps': 'Gold Accounts', 'gap-cache': 'Gold Accounts',
  contacts: 'Dashboard', signals: 'Dashboard', feed: 'Dashboard', activity: 'Dashboard', 'activity-log': 'Dashboard', owners: 'Dashboard',
  'org-intel-contacts': 'Org Intelligence', reports: 'Reports', tabs: 'Resources', team: 'Team', admin: 'Admin',
}
const FUNCTION_SECTIONS = { debriefs: 'Debriefs', planner: 'My Plan', team: 'Team', 'contact-intel': 'Individual Research', 'hubspot-gap-search': 'Gold Accounts', 'get-resources': 'Resources' }
export function sectionOf(path) {
  const parts = String(path || '').replace(/^\/\.netlify\/functions\//, '/').replace(/^\/api\//, '/').split('/').filter(Boolean)
  const [fn, seg] = parts
  if (!fn) return null
  if (fn === 'hubspot') return HUBSPOT_SECTIONS[seg] || null
  return FUNCTION_SECTIONS[fn] || null
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
export const dayKey = (date) => dayFmt.format(date) // YYYY-MM-DD, Eastern

const memory = new Map() // userId -> what this running copy of the function has seen since it last wrote
let defaultStore
export const _resetUsageMemory = () => { memory.clear(); defaultStore = undefined } // for tests: forget what was seen and the storage connection

const realStore = () => {
  if (defaultStore) return defaultStore
  const { AZURE_STORAGE_ACCOUNT_NAME: account, AZURE_STORAGE_CONTAINER: container = 'crm-tokens', AZURE_STORAGE_SAS_TOKEN: sas } = process.env
  if (!account || !sas) return null
  defaultStore = createDebriefStore({ account, container, sas })
  return defaultStore
}

export async function trackUsage(user, event, deps = {}) {
  try {
    if (!user || !user.userId) return
    if (String((deps.env || process.env).USAGE_TRACKING || '').toLowerCase() === 'off') return
    const store = deps.store || realStore()
    if (!store) return
    const now = (deps.now || (() => new Date()))()
    const nowMs = now.getTime()
    const section = sectionOf(event && event.path)
    let m = memory.get(user.userId)
    if (!m) { m = { lastWriteAt: 0, requests: 0, sections: new Map(), persisted: new Set() }; memory.set(user.userId, m) }
    m.requests++
    if (section) m.sections.set(section, (m.sections.get(section) || 0) + 1)
    const age = nowMs - m.lastWriteAt
    if (age >= THROTTLE_MS) m.persisted.clear()
    const due = age >= THROTTLE_MS || (section && !m.persisted.has(section) && age >= NEW_SECTION_MS)
    if (!due) return

    const snapshot = { requests: m.requests, sections: new Map(m.sections) }
    m.requests = 0; m.sections = new Map(); m.lastWriteAt = nowMs
    const iso = now.toISOString(), today = dayKey(now)
    const write = store.updateJson(usageName(user.userId), (d) => {
      const rec = d || {}
      const sections = { ...(rec.sections || {}) }
      for (const [name, n] of snapshot.sections) sections[name] = { last: iso, count: ((sections[name] && sections[name].count) || 0) + n }
      return {
        userId: user.userId, email: user.email || rec.email || null, firstSeen: rec.firstSeen || iso, lastSeen: iso,
        days: [...new Set([...(rec.days || []), today])].sort().slice(-KEEP_DAYS), requests: (rec.requests || 0) + snapshot.requests, sections,
      }
    }, { fallback: {} }).then(() => { for (const name of snapshot.sections.keys()) m.persisted.add(name) }).catch((err) => {
      // keep what we saw so the next write includes it; never throw
      m.requests += snapshot.requests; for (const [name, n] of snapshot.sections) m.sections.set(name, (m.sections.get(name) || 0) + n)
      console.error('[usage] could not record activity:', err && err.message)
    })
    let timer
    await Promise.race([write, new Promise((resolve) => { timer = setTimeout(resolve, deps.waitMs ?? WAIT_MS) })])
    clearTimeout(timer)
  } catch (err) { console.error('[usage] skipped:', err && err.message) }
}
