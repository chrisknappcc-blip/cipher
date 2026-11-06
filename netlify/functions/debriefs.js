// netlify/functions/debriefs.js
//
// The API behind Cipher's Debriefs tab. Reached at /api/debriefs/<route>.
//
// Visibility is decided HERE, on the server, never in the browser:
//   a rep sees calls they were on; people in DEBRIEF_VIEW_ALL_EMAILS see everything.
// A call you may not see answers exactly like one that does not exist.

import { withAuth } from './utils/auth.js'
import * as cd from './utils/callDebrief.js'
import { buildStore, buildGong, makeTrigger, configHealth, buildPoll } from './utils/debriefDeps.js'

const DAY = 24 * 3600e3
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) })
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/
const CALL_RE = /^[0-9A-Za-z_-]{1,40}$/
const SEEN_RE = /^(recap:\d{4}-\d{2}-\d{2}|[0-9A-Za-z_-]{1,40})$/

export function createHandler(getDeps) {
  return async (event, context) => withAuth(async (event, _ctx, user) => {
    const { store, viewAllSet, trigger, health, poll, gong, pollTimeoutMs = 8500, coverageTimeoutMs = 20000, now = () => new Date() } = getDeps()
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
    // Runs the poller right now (admin only) and reports what it found, so the button gives an answer
    // instead of waiting for the next 15 minute tick. Kept short of the function time limit; if Gong is
    // slow the scheduled run carries on from where this left off.
    async function runPollNow() {
      if (!poll) return { error: 'The poller is not available.' }
      let timer
      const tooSlow = new Promise((resolve) => { timer = setTimeout(() => resolve({ slow: true }), pollTimeoutMs) })
      try { return await Promise.race([poll({ force: true, caller: 'admin button' }), tooSlow]) }
      catch (err) { return { error: err.message } }
      finally { clearTimeout(timer) }
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
        // How many calls each selected week holds, so a range that reaches back past what has been pulled in
        // shows zeros instead of looking like the filter did nothing. And, for people who see everything, the
        // reps to offer in the dropdown, including ones with no analyzed call yet.
        const weekCounts = Object.fromEntries(keys.slice(0, n).map((k) => [k, byWeek[k].length]))
        const st = viewAll ? await store.getState() : null
        const reps = viewAll ? cd.buildRepList(st.repsSeen, items, st.users) : null
        return json(200, {
          viewAll, email, weeks: keys.slice(0, n), weekCounts, ...(reps ? { reps } : {}), items,
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
      if (['/status', '/backfill', '/reanalyze', '/poll', '/coverage'].includes(path)) {
        if (!viewAll) return json(403, { error: 'Not allowed.' })

        if (method === 'GET' && path === '/status') {
          const keys = [currentWeek, cd.prevWeekStart(currentWeek)]
          const all = (await Promise.all(keys.map((k) => store.getIndex(k)))).flat()
          const state = await store.getState()
          const byStatus = {}
          all.forEach((s) => { byStatus[s.status] = (byStatus[s.status] || 0) + 1 })
          return json(200, {
            config: health ? health() : {},
            poll: { lastPollAt: state.lastPollAt || null, lastPollError: state.lastPollError || null, counts: state.lastPollCounts || null, lowWater: state.lowWater || null, backfillFrom: state.backfillFrom || null, waitingOnTranscript: Object.keys(state.pending || {}).length, ticks: state.ticks || [] },
            people: { count: (state.users || []).filter((u) => u.active !== false).length, fetchedAt: state.usersFetchedAt || null, error: state.usersError || null },
            byStatus,
            recentFailures: all.filter((s) => s.status === 'failed').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 10).map((s) => ({ callId: s.callId, title: s.title, error: s.error, attempts: s.attempts, updatedAt: s.updatedAt })),
          })
        }
        // What Gong has in the last N days versus what Cipher pulled in, by rep: how many calls, how many have an
        // outside participant, how many are analyzed, how many are waiting (and roughly what they will cost),
        // plus examples of calls that were left out as internal so a wrong call can be spotted. Read only.
        if (method === 'GET' && path === '/coverage') {
          if (!gong) return json(200, { error: 'The Gong connection is not available.' })
          const days = Math.min(30, Math.max(1, parseInt(qs.days, 10) || 14))
          const toMs = now().getTime(), fromMs = toMs - days * DAY
          let timer
          const tooSlow = new Promise((resolve) => { timer = setTimeout(() => resolve('slow'), coverageTimeoutMs) })
          let calls
          try { calls = await Promise.race([gong.listCalls({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }), tooSlow]) }
          catch (err) { return json(200, { days, error: `The check against Gong failed: ${err.message}` }) }
          finally { clearTimeout(timer) }
          if (calls === 'slow') return json(200, { days, error: 'Gong is taking too long to answer. Try fewer days, or try again in a minute.' })
          const weekKeys = Array.from({ length: Math.ceil(days / 7) + 1 }, (_, i) => cd.prevWeekStart(currentWeek, i))
          const done = new Map()
          for (const wk of await Promise.all(weekKeys.map((k) => store.getIndex(k)))) for (const s of wk) done.set(s.callId, s)
          const rows = calls.map((c) => { const meta = cd.callMeta(c); const o = cd.ownerOf(meta, cd.splitParties(c.parties || [])); return { id: meta.id, started: meta.startedIso, title: meta.title, host: { name: o.ownerName, email: o.ownerEmail }, kind: cd.callKind(c), scope: meta.scope, labels: cd.affiliationCounts(c.parties), status: done.get(meta.id)?.status || null } })
          let users = null
          try { users = typeof gong.listUsers === 'function' ? await gong.listUsers() : null } catch { users = null }
          return json(200, { days, ...cd.buildCoverage(rows, users) })
        }
        if (method === 'POST' && path === '/backfill') {
          const days = Math.min(60, Math.max(1, parseInt(body().days, 10) || 7))
          await store.updateState((s) => ({ ...s, backfillFrom: new Date(now().getTime() - days * DAY).toISOString() }))
          return json(200, { ok: true, days, poll: await runPollNow() })
        }
        if (method === 'POST' && path === '/poll') return json(200, { ok: true, poll: await runPollNow() })
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
  poll: buildPoll(),
  gong: (() => { try { return buildGong() } catch { return null } })(),
  health: () => configHealth(),
}))
