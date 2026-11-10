// netlify/functions/utils/pollCalls.js
//
// One pass of the poller: ask Gong for recent calls, keep the ones with an
// external participant, and hand the ones not yet analyzed to the background job.
//
// Care is taken that nothing falls through the cracks:
//  - every pass re-reads the last several days (default 7), not just a few hours. Gong lists a call by when it
//    STARTED, and a call can show up in the list hours later (processing, or a phone system syncing late), so a
//    short look back lets those slip past for good. Calls already analyzed cost nothing to re-read;
//  - if there are more waiting than one pass should start (to stay inside Gong's
//    rate limit), the window stays anchored at the oldest waiting call instead
//    of moving forward past it;
//  - calls whose transcript is not ready stay in the window until it is.

import * as cd from './callDebrief.js'

const HOUR = 3600e3
const DAY = 24 * HOUR
const MAX_FAILURES = 3
// A call whose transcript is not ready is tried again less and less often: 10 minutes, 20, 40, 80, 160, 320, then every
// 6 hours. Before this, every such call was retried on every pass, oldest first, so a few calls that never get a
// transcript could take every slot and starve newer calls that were ready.
const RETRY_BASE_MS = 10 * 60e3
const RETRY_MAX_MS = 6 * HOUR
export const retryAfterMs = (attempts) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, (attempts || 1) - 1))

export async function pollOnce({ gong, store, trigger, now = () => new Date(), config = {}, force = false, caller = '' }) {
  const maxPerRun = force ? (config.maxPerForcedRun ?? 8) : (config.maxPerRun ?? 5)
  const nowMs = now().getTime()
  const state = await store.getState()

  // Netlify lets anyone who knows a scheduled function's URL run it. So a pass that follows another
  // within a few minutes does nothing, which caps outside abuse at roughly the normal schedule.
  // The admin "run now" button passes force and skips this.
  // Note who asked, even if this pass then does nothing, so the Status screen can show whether Netlify's
  // scheduler is really calling in. At most one note per 30 seconds, the last eight kept.
  const lastTick = state.ticks && state.ticks[0]
  if (!lastTick || nowMs - Date.parse(lastTick.at) > 30e3) {
    await store.updateState((s) => ({ ...s, ticks: [{ at: new Date(nowMs).toISOString(), caller: String(caller).slice(0, 60) }, ...(s.ticks || [])].slice(0, 8) }))
  }
  const minGap = config.minIntervalMs ?? 10 * 60e3
  if (!force && state.lastPollAt && nowMs - Date.parse(state.lastPollAt) < minGap) return { skipped: 'ran_recently', lastPollAt: state.lastPollAt }

  let fromMs = nowMs - (config.rescanDays ?? 7) * DAY
  if (state.backfillFrom) fromMs = Math.min(fromMs, Date.parse(state.backfillFrom))
  if (state.lowWater) fromMs = Math.min(fromMs, Date.parse(state.lowWater))
  fromMs = Math.max(fromMs, nowMs - (state.backfillFrom ? 60 : 14) * DAY)

  let calls
  try {
    calls = await gong.listCalls({ from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() })
  } catch (err) {
    await store.updateState((s) => ({ ...s, lastPollAt: now().toISOString(), lastPollError: err.message }))
    throw err
  }

  // Who hosted the calls that have an outside side to them, so the rep list can show people even before one of
  // their calls has been analyzed (and shows who is missing if some never are).
  const hostMap = new Map()
  for (const c of calls) {
    const kind = cd.callKind(c)
    if (kind !== 'external' && kind !== 'likely_external') continue
    const o = cd.ownerOf(cd.callMeta(c), cd.splitParties(c.parties || []))
    const key = String(o.ownerEmail || o.ownerName || '').toLowerCase()
    if (!key) continue
    const at = c.metaData?.started || null
    const cur = hostMap.get(key)
    if (!cur) hostMap.set(key, { name: o.ownerName, email: o.ownerEmail, lastCall: at }); else if (at && (!cur.lastCall || at > cur.lastCall)) cur.lastCall = at
  }

  const external = calls
    .filter(cd.isExternalCall)
    .map((c) => {
      const meta = cd.callMeta(c), parts = cd.splitParties(c.parties || []), o = cd.ownerOf(meta, parts)
      return { id: String(c.metaData?.id || ''), started: Date.parse(c.metaData?.started), info: { startedIso: meta.startedIso, title: meta.title, url: meta.url, ownerName: o.ownerName, ownerEmail: o.ownerEmail, participantEmails: [...new Set(parts.internal.map((p) => p.email).filter(Boolean))], kind: cd.callKind(c) } }
    })
    .filter((c) => c.id && Number.isFinite(c.started))

  // What is already done, from the weekly indexes covering the window.
  const done = new Map()
  for (let wk = cd.weekStartKey(fromMs), last = cd.weekStartKey(nowMs); wk <= last; wk = nextWeek(wk)) {
    for (const s of await store.getIndex(wk)) done.set(s.callId, s)
  }
  const resolved = (id) => {
    const s = done.get(id)
    return !!s && (cd.isDoneStatus(s.status) || (s.status === 'failed' && (s.attempts || 0) >= MAX_FAILURES))
  }
  const tooSoon = (id) => {
    const p = state.pending?.[id]
    const f = done.get(id)?.status === 'failed' ? done.get(id).updatedAt : null
    return !!((p && p.lastTried && nowMs - Date.parse(p.lastTried) < retryAfterMs(p.attempts)) || (f && nowMs - Date.parse(f) < 30 * 60e3))
  }
  const triedBefore = (id) => !!state.pending?.[id] || done.get(id)?.status === 'failed'

  const waiting = external.filter((c) => !resolved(c.id)).sort((a, b) => a.started - b.started)
  // Calls never tried go first (oldest first), then retries, so fresh calls are never stuck behind old ones.
  const ready = waiting.filter((c) => force || !tooSoon(c.id)).sort((a, b) => (triedBefore(a.id) ? 1 : 0) - (triedBefore(b.id) ? 1 : 0) || a.started - b.started)
  const batch = ready.slice(0, maxPerRun)
  const results = await Promise.allSettled(batch.map((c) => trigger(c.id)))
  const triggerErrors = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason))

  // The list of everyone in Gong, twice a day: a couple of requests, so the rep list can include people who have not
  // hosted a call lately. If Gong refuses (the key may not allow it), say so on Status and carry on; retry in an hour.
  let peopleUpdate = {}
  const peopleAge = state.usersFetchedAt ? nowMs - Date.parse(state.usersFetchedAt) : Infinity
  if (peopleAge > (config.usersRefreshMs ?? 12 * HOUR) && typeof gong.listUsers === 'function') {
    try {
      const list = await gong.listUsers()
      peopleUpdate = { users: list.slice(0, 600).map(({ name, email, active }) => ({ name, email, active })), usersFetchedAt: new Date(nowMs).toISOString(), usersError: null }
    } catch (err) { peopleUpdate = { usersError: String(err.message || err).slice(0, 200), usersFetchedAt: new Date(nowMs - 11 * HOUR).toISOString() } }
  }

  // The calls found and not finished, kept so the screen can show them instead of leaving them invisible.
  const waitingCalls = waiting.slice(0, 150).map((c) => ({ id: c.id, started: c.info.startedIso, title: c.info.title, url: c.info.url, ownerName: c.info.ownerName, ownerEmail: c.info.ownerEmail, participantEmails: c.info.participantEmails, kind: c.info.kind, attempts: state.pending?.[c.id]?.attempts || 0, reason: state.pending?.[c.id]?.reason || null }))

  const lowWater = waiting.length ? new Date(Math.min(...waiting.map((c) => c.started))).toISOString() : null
  const counts = { listed: calls.length, external: external.length, done: external.length - waiting.length, likely: calls.filter((c) => cd.callKind(c) === 'likely_external').length, waiting: waiting.length, triggered: batch.length - triggerErrors.length, deferred: Math.max(0, ready.length - batch.length) }
  await store.updateState((s) => {
    const next = { ...s, ...peopleUpdate, waitingCalls, repsSeen: cd.mergeRepsSeen(s.repsSeen, [...hostMap.values()]), lastPolledTo: new Date(nowMs).toISOString(), lowWater, lastPollAt: now().toISOString(), lastPollError: triggerErrors[0] || null, lastPollCounts: counts }
    if (!waiting.length) delete next.backfillFrom
    return next
  })
  return { ...counts, triggerErrors }
}

function nextWeek(wk) {
  const [y, m, d] = wk.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + 7))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}
