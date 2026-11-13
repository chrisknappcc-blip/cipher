// netlify/functions/team.js
//
// The API behind the Team tab, at /api/team/<route>.
//
//   GET /roster            who is on your team, instantly, with whatever queue numbers were saved last time
//   GET /stats?userId=     one person's queue numbers, worked out now (or taken from a recent save), within a time limit
//   GET /queue?userId=     one person's actual Right Now queue
//   GET /usage             admins only: who has an account, who is connected, and who is actually using Cipher
//
// WHY THIS EXISTS. The old roster (GET /api/hubspot/team) worked out every person's whole queue, many HubSpot calls
// each, inside a single request. With a dozen people that is slow enough to hit the function's time limit, and when it
// does the whole page fails. Here the roster never waits on HubSpot; each person's numbers load separately, so one slow
// or broken person only affects their own row. Who can see whom is unchanged: ADMIN_EMAILS and TEAM_HIERARCHY.

import { createHash } from 'node:crypto'
import { withAuth } from './utils/auth.js'
import { createDebriefStore } from './utils/debriefStore.js'
import { parseAccess, isAdmin, teamVisibility } from './utils/teamAccess.js'
import { buildUsageReport, statsFromQueue, statsFresh, friendlyQueueError } from './utils/teamReport.js'
import { usageName } from './utils/usage.js'

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) })
const lower = (s) => String(s || '').toLowerCase()
const statsName = (userId) => `team-stats/${createHash('sha256').update(`team-stats:${userId}`).digest('hex').slice(0, 24)}.json`
const safeId = (userId) => String(userId).replace(/[^0-9A-Za-z_-]/g, '')

const withTimeout = (promise, ms) => { let t; return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timed out')), ms) })]).finally(() => clearTimeout(t)) }
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) } }))
  return out
}

export function createHandler(getDeps) {
  return async (event, context) => withAuth(async (event, ctx, user) => {
    const d = await getDeps(ctx)
    const now = d.now ? d.now() : new Date()
    const path = (event.path || '').replace(/^.*\/team(?=\/|$)/, '') || '/'
    const qp = event.queryStringParameters || {}
    const admin = isAdmin(user, d.access), vis = teamVisibility(user.email, d.access)
    const canTeam = admin || vis.canAccess
    const visibleProfiles = async () => {
      const all = await d.profiles()
      return !vis.all && !admin ? all.filter((p) => vis.emails.has(lower(p.email))) : all
    }
    // A person must be on your team AND on the roster. That also means nobody can use this to poke at an arbitrary id.
    const findTarget = async () => (await visibleProfiles()).find((p) => p.userId === qp.userId)

    try {
      if (event.httpMethod === 'GET' && path === '/roster') {
        if (!canTeam) return json(403, { error: "You don't have access to the team view" })
        const profiles = (await visibleProfiles()).filter((p) => lower(p.email) !== lower(user.email))
        const saved = await Promise.all(profiles.map((p) => d.store.readJson(statsName(p.userId)).then((r) => r.data).catch(() => null)))
        return json(200, { generatedAt: now.toISOString(), roster: profiles.map((p, i) => ({ userId: p.userId, email: p.email, stats: saved[i] || null, fresh: statsFresh(saved[i], now) })) })
      }

      if (event.httpMethod === 'GET' && path === '/stats') {
        if (!canTeam) return json(403, { error: "You don't have access to the team view" })
        const target = await findTarget()
        if (!target) return json(404, { error: "That person isn't on your team" })
        const saved = (await d.store.readJson(statsName(target.userId)).catch(() => ({ data: null }))).data
        if (!qp.refresh && statsFresh(saved, now)) return json(200, { userId: target.userId, email: target.email, stats: saved, cached: true })
        const started = Date.now()
        let stats
        try {
          const queue = await withTimeout(d.computeQueue(target.userId), d.statsTimeoutMs ?? 20000)
          const todos = await d.getTodos(target.userId).catch(() => [])
          stats = statsFromQueue(queue, todos, now)
        } catch (err) {
          console.error(`[team] stats for ${target.userId} failed after ${Date.now() - started}ms:`, err && err.message)
          stats = { error: friendlyQueueError(err), computedAt: now.toISOString() }
        }
        await d.store.writeJson(statsName(target.userId), stats).catch(() => {})
        return json(200, { userId: target.userId, email: target.email, stats, cached: false })
      }

      if (event.httpMethod === 'GET' && path === '/queue') {
        if (!canTeam) return json(403, { error: "You don't have access to view other reps' queues" })
        const target = await findTarget()
        if (!target) return json(404, { error: "That person isn't on your team" })
        try { return json(200, { queue: await withTimeout(d.computeQueue(target.userId), d.queueTimeoutMs ?? 24000) }) }
        catch (err) { console.error(`[team] queue for ${target.userId} failed:`, err && err.message); return json(502, { error: friendlyQueueError(err) }) }
      }

      if (event.httpMethod === 'GET' && path === '/usage') {
        if (!admin) return json(403, { error: 'Admin only' })
        const profiles = await d.profiles()
        const identityUsers = await d.identityUsers(ctx).catch(() => null)
        const per = await mapLimit(profiles, 6, async (p) => ({
          p,
          hubspot: await d.hubspotState(p.userId).catch(() => 'unknown'),
          outlook: await d.outlookState(p.userId).catch(() => ({ connected: false, calendar: false })),
          usage: (await d.store.readJson(usageName(p.userId)).catch(() => ({ data: null }))).data,
        }))
        const report = buildUsageReport({
          profiles, identityUsers, now,
          hubspot: Object.fromEntries(per.map((x) => [x.p.userId, x.hubspot])),
          outlook: Object.fromEntries(per.map((x) => [x.p.userId, x.outlook])),
          usage: Object.fromEntries(per.filter((x) => x.usage).map((x) => [x.p.userId, x.usage])),
        })
        return json(200, report)
      }

      return json(404, { error: 'Not found' })
    } catch (err) {
      console.error('[team]', path, err && err.message)
      return json(500, { error: 'Something went wrong loading the team view.' })
    }
  })(event, context)
}

// ─── The real thing ─────────────────────────────────────────────────────────
let real
async function realDeps() {
  if (real) return real
  const hs = await import('./hubspot.js') // loaded only when needed, and only here
  const { getTodos } = await import('./utils/todoStore.js')
  const { getTokens } = await import('./utils/tokenStore.js')
  const { AZURE_STORAGE_ACCOUNT_NAME: account, AZURE_STORAGE_CONTAINER: container = 'crm-tokens', AZURE_STORAGE_SAS_TOKEN: sas } = process.env
  const store = createDebriefStore({ account, container, sas })
  real = {
    store, getTodos, access: parseAccess(), profiles: () => hs.getActiveUserProfiles(), computeQueue: (id) => hs.computeRightNowQueue(id, {}),
    // Only whether a connection exists. The token values themselves are never read out of this function.
    hubspotState: async (id) => { const t = await getTokens(id); return t && t.hubspot && t.hubspot.refresh_token ? 'connected' : 'not connected' },
    outlookState: async (id) => {
      const t = (await store.readJson(`outlook-tokens-${safeId(id)}.json`)).data
      return { connected: !!(t && t.access_token), calendar: !!(t && /(^|\s)calendars\.read(\s|$)/i.test(t.scope || '')) }
    },
    // The sign in accounts that really exist, from the Identity service (null if it cannot be read: never guessed).
    identityUsers: async (ctx) => {
      const ic = ctx && ctx.clientContext && ctx.clientContext.identity
      if (!ic || !ic.url || !ic.token) return null
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ic.token}` }
      const all = []; let after
      for (let page = 0; page < 30; page++) {
        const r = await fetch(`${ic.url}/admin/users?${new URLSearchParams({ per_page: '100', ...(after ? { after } : {}) })}`, { headers })
        if (!r.ok) return null
        const data = await r.json().catch(() => ({}))
        const users = Array.isArray(data) ? data : data.users || []
        all.push(...users)
        if (users.length < 100) return all
        after = users[users.length - 1] && users[users.length - 1].id
      }
      return null
    },
  }
  return real
}
export const handler = createHandler(realDeps)
