// netlify/functions/debriefs.js
//
// The API behind Cipher's Debriefs tab. Reached at /api/debriefs/<route>.
//
// Visibility is decided HERE, on the server, never in the browser:
//   a rep sees calls they were on; people in DEBRIEF_VIEW_ALL_EMAILS see everything.
// A call you may not see answers exactly like one that does not exist.

import { withAuth } from './utils/auth.js'
import * as cd from './utils/callDebrief.js'
import { buildStore, makeTrigger, configHealth } from './utils/debriefDeps.js'

const DAY = 24 * 3600e3
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) })
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/
const CALL_RE = /^[0-9A-Za-z_-]{1,40}$/
const SEEN_RE = /^(recap:\d{4}-\d{2}-\d{2}|[0-9A-Za-z_-]{1,40})$/

export function createHandler(getDeps) {
  return async (event, context) => withAuth(async (event, _ctx, user) => {
    const { store, viewAllSet, trigger, health, now = () => new Date() } = getDeps()
    const email = String(user.email || '').toLowerCase()
    const viewAll = viewAllSet.has(email)
    const method = event.httpMethod
    const path = (event.path || '').replace(/^.*\/debriefs(?=\/|$)/, '') || '/'
    const qs = event.queryStringParameters || {}
    const currentWeek = cd.weekStartKey(now())

    const body = () => { try { return JSON.parse(event.body || '{}') } catch { return {} } }
    const weekOf = (v) => (WEEK_RE.test(String(v || '')) ? cd.weekStartKey(new Date(`${v}T12:00:00Z`)) : currentWeek)
    const visible = (list) => list.filter((s) => cd.canSee(s, email, viewAllSet)).map((s) => (viewAll ? s : { ...s, error: undefined }))

    // Visible summaries for the current week and the ones before it.
    async function loadWeeks(count) {
      const keys = Array.from({ length: count }, (_, i) => cd.prevWeekStart(currentWeek, i))
      const lists = await Promise.all(keys.map((k) => store.getIndex(k)))
      return { keys, byWeek: Object.fromEntries(keys.map((k, i) => [k, visible(lists[i])])) }
    }
    // The most recent week whose recap has been released (this week after Friday 4pm, else last week).
    const latestReleased = () => (now().getTime() >= cd.weekReleaseAt(currentWeek).getTime() ? currentWeek : cd.prevWeekStart(currentWeek))

    try {
      if (method === 'GET' && path === '/list') {
        const n = Math.min(8, Math.max(1, parseInt(qs.weeks, 10) || 2))
        const { keys, byWeek } = await loadWeeks(Math.max(n, 2))
        const items = keys.slice(0, n).flatMap((k) => byWeek[k]).sort((a, b) => String(b.started).localeCompare(String(a.started)))
        const seen = await store.getSeen(email)
        const rw = latestReleased()
        return json(200, {
          viewAll, email, weeks: keys.slice(0, n), items,
          unreadIds: items.filter((s) => s.status === 'complete' && !seen[s.callId]).map((s) => s.callId),
          recap: { week: rw, unread: !!(byWeek[rw]?.length) && !seen[`recap:${rw}`] },
        })
      }

      if (method === 'GET' && path.startsWith('/call/')) {
        const id = decodeURIComponent(path.slice('/call/'.length))
        if (!CALL_RE.test(id)) return json(404, { error: 'Not found' })
        const rec = await store.getDetail(id)
        if (!rec || !cd.canSee(rec, email, viewAllSet)) return json(404, { error: 'Not found' })
        return json(200, { viewAll, record: viewAll ? rec : { ...rec, error: undefined } })
      }

      if (method === 'GET' && path === '/recap') {
        const week = weekOf(qs.week)
        let summaries = visible(await store.getIndex(week))
        if (viewAll && qs.rep) summaries = summaries.filter((s) => String(s.ownerEmail).toLowerCase() === String(qs.rep).toLowerCase())
        const recap = cd.buildRecap({ summaries, weekStart: week, now: now(), viewAll })
        const seen = await store.getSeen(email)
        return json(200, { viewAll, recap, unread: recap.released && summaries.length > 0 && !seen[`recap:${week}`] })
      }

      if (method === 'GET' && path === '/unread') {
        const { byWeek } = await loadWeeks(2)
        const seen = await store.getSeen(email)
        const calls = Object.values(byWeek).flat().filter((s) => s.status === 'complete' && !seen[s.callId]).length
        const rw = latestReleased()
        const recap = !!(byWeek[rw]?.length) && !seen[`recap:${rw}`]
        return json(200, { count: calls + (recap ? 1 : 0), calls, recap })
      }

      if (method === 'POST' && path === '/seen') {
        const ids = body().ids
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((i) => typeof i === 'string' && SEEN_RE.test(i))) return json(400, { error: 'ids must be a list of up to 200 valid ids.' })
        await store.markSeen(email, ids)
        return json(200, { ok: true })
      }

      // Everything below is for people who can see everything.
      if (['/status', '/backfill', '/reanalyze'].includes(path)) {
        if (!viewAll) return json(403, { error: 'Not allowed.' })

        if (method === 'GET' && path === '/status') {
          const keys = [currentWeek, cd.prevWeekStart(currentWeek)]
          const all = (await Promise.all(keys.map((k) => store.getIndex(k)))).flat()
          const state = await store.getState()
          const byStatus = {}
          all.forEach((s) => { byStatus[s.status] = (byStatus[s.status] || 0) + 1 })
          return json(200, {
            config: health ? health() : {},
            poll: { lastPollAt: state.lastPollAt || null, lastPollError: state.lastPollError || null, counts: state.lastPollCounts || null, lowWater: state.lowWater || null, backfillFrom: state.backfillFrom || null, waitingOnTranscript: Object.keys(state.pending || {}).length },
            byStatus,
            recentFailures: all.filter((s) => s.status === 'failed').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 10).map((s) => ({ callId: s.callId, title: s.title, error: s.error, attempts: s.attempts, updatedAt: s.updatedAt })),
          })
        }
        if (method === 'POST' && path === '/backfill') {
          const days = Math.min(60, Math.max(1, parseInt(body().days, 10) || 7))
          await store.updateState((s) => ({ ...s, backfillFrom: new Date(now().getTime() - days * DAY).toISOString() }))
          return json(200, { ok: true, days })
        }
        if (method === 'POST' && path === '/reanalyze') {
          const callId = String(body().callId || '')
          if (!CALL_RE.test(callId)) return json(400, { error: 'A valid callId is required.' })
          await trigger(callId, { force: true })
          return json(200, { ok: true })
        }
      }
      return json(404, { error: 'Not found' })
    } catch (err) {
      console.error('[debriefs]', path, err.message)
      return json(500, { error: 'Something went wrong loading debriefs.' })
    }
  })(event, context)
}

export const handler = createHandler(() => ({
  store: buildStore(),
  viewAllSet: cd.parseViewAll(process.env.DEBRIEF_VIEW_ALL_EMAILS),
  trigger: makeTrigger(),
  health: () => configHealth(),
}))
