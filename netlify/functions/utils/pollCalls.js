// netlify/functions/utils/pollCalls.js
//
// One pass of the poller: ask Gong for recent calls, keep the ones with an
// external participant, and hand the ones not yet analyzed to the background job.
//
// Care is taken that nothing falls through the cracks:
//  - each pass re-reads a few hours back, so a call that was still processing
//    in Gong last time is seen again;
//  - if there are more waiting than one pass should start (to stay inside Gong's
//    rate limit), the window stays anchored at the oldest waiting call instead
//    of moving forward past it;
//  - calls whose transcript is not ready stay in the window until it is.

import * as cd from './callDebrief.js'

const HOUR = 3600e3
const DAY = 24 * HOUR
const MAX_FAILURES = 3

export async function pollOnce({ gong, store, trigger, now = () => new Date(), config = {}, force = false }) {
  const maxPerRun = config.maxPerRun ?? 5
  const nowMs = now().getTime()
  const state = await store.getState()

  // Netlify lets anyone who knows a scheduled function's URL run it. So a pass that follows another
  // within a few minutes does nothing, which caps outside abuse at roughly the normal schedule.
  // The admin "run now" button passes force and skips this.
  const minGap = config.minIntervalMs ?? 10 * 60e3
  if (!force && state.lastPollAt && nowMs - Date.parse(state.lastPollAt) < minGap) return { skipped: 'ran_recently', lastPollAt: state.lastPollAt }

  let fromMs
  if (state.backfillFrom) fromMs = Date.parse(state.backfillFrom)
  else if (state.lastPolledTo) fromMs = Math.min(Date.parse(state.lastPolledTo) - 3 * HOUR, state.lowWater ? Date.parse(state.lowWater) : Infinity)
  else fromMs = nowMs - (config.initialLookbackDays ?? 2) * DAY
  fromMs = Math.max(fromMs, nowMs - (state.backfillFrom ? 60 : 14) * DAY)

  let calls
  try {
    calls = await gong.listCalls({ from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() })
  } catch (err) {
    await store.updateState((s) => ({ ...s, lastPollAt: now().toISOString(), lastPollError: err.message }))
    throw err
  }

  const external = calls
    .filter(cd.isExternalCall)
    .map((c) => ({ id: String(c.metaData?.id || ''), started: Date.parse(c.metaData?.started) }))
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
    const p = state.pending?.[id]?.lastTried
    const f = done.get(id)?.status === 'failed' ? done.get(id).updatedAt : null
    return (p && nowMs - Date.parse(p) < 10 * 60e3) || (f && nowMs - Date.parse(f) < 30 * 60e3)
  }

  const waiting = external.filter((c) => !resolved(c.id)).sort((a, b) => a.started - b.started)
  const ready = waiting.filter((c) => force || !tooSoon(c.id))
  const batch = ready.slice(0, maxPerRun)
  const results = await Promise.allSettled(batch.map((c) => trigger(c.id)))
  const triggerErrors = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason))

  const lowWater = waiting.length ? new Date(Math.min(...waiting.map((c) => c.started))).toISOString() : null
  const counts = { listed: calls.length, external: external.length, waiting: waiting.length, triggered: batch.length - triggerErrors.length, deferred: Math.max(0, ready.length - batch.length) }
  await store.updateState((s) => {
    const next = { ...s, lastPolledTo: new Date(nowMs).toISOString(), lowWater, lastPollAt: now().toISOString(), lastPollError: triggerErrors[0] || null, lastPollCounts: counts }
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
