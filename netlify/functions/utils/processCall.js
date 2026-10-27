// netlify/functions/utils/processCall.js
//
// Takes one Gong call from "exists" to "analyzed and stored". Every outside
// dependency (Gong, storage, Claude) is passed in, so each path is testable.
//
// Outcomes, in the record's `status`:
//   complete       analyzed and scored
//   too_short      a real call, but not enough said to analyze (still counted)
//   no_transcript  Gong never produced a transcript (after about a day of trying)
//   skipped        not an external call, or not found in Gong
//   failed         something broke; retried a few times, with the reason kept
// A transcript that is simply not ready yet is NOT a status: the call is left
// to be tried again on the next poll.

import * as cd from './callDebrief.js'

export const MAX_PENDING_ATTEMPTS = 96          // about a day at one try per 15 minutes
export const GIVE_UP_AFTER_MS = 48 * 3600 * 1000

const person = (p) => ({ name: p.name, email: p.email, title: p.title })

export async function processCall({ callId, force = false, deps }) {
  const { gong, store, claude, config, now = () => new Date() } = deps
  const id = String(callId)
  const iso = () => now().toISOString()

  const existing = await store.getDetail(id)
  if (existing && cd.isDoneStatus(existing.status) && !force) {
    // If the record saved but the index write after it failed, repair the index
    // here instead of paying to analyze the same call again.
    const week = cd.weekStartKey(Date.parse(existing.gong?.started) || now())
    await store.upsertSummary(week, cd.summarizeRecord(existing))
    return { skipped: 'already_done', status: existing.status }
  }
  if (!(await store.acquireLock(id))) return { skipped: 'locked' }

  let base = null
  let weekStart = cd.weekStartKey(now())
  try {
    const call = await gong.getCall(id)
    if (!call) return await pending('call_not_found', null)

    const parties = cd.splitParties(call.parties || [])
    const meta = cd.callMeta(call)
    const { ownerName, ownerEmail } = cd.ownerOf(meta, parties)
    weekStart = cd.weekStartKey(Number.isFinite(meta.started) ? meta.started : now())
    base = {
      callId: id,
      gong: { title: meta.title, started: meta.startedIso, durationSec: meta.durationSec, url: meta.url, scope: meta.scope },
      ownerName, ownerEmail,
      participantEmails: [...new Set(parties.internal.map((p) => p.email).filter(Boolean))],
      internal: parties.internal.map(person),
      external: parties.external.concat(parties.unknown).map(person),
      promptVersion: cd.PROMPT_VERSION,
    }

    if (!cd.isExternalCall(call)) return await finish({ ...base, status: 'skipped', note: 'No external participants.' })

    const transcript = await gong.getTranscript(id)
    if (!transcript || !transcript.length) return await pending('no_transcript', meta)

    const fmt = cd.formatTranscript({ transcript, parties })
    if (fmt.words.total < config.minWords || fmt.words.external + fmt.words.unknown < config.minProspectWords) {
      return await finish({ ...base, status: 'too_short', words: fmt.words, note: 'Not enough was said to analyze.' })
    }

    const request = cd.buildAnalysisRequest({ model: config.model, meta, parties, transcriptText: fmt.text })
    const usage = { input_tokens: 0, output_tokens: 0 }
    const ask = async (req) => {
      const resp = await claude(req)
      usage.input_tokens += resp?.usage?.input_tokens || 0
      usage.output_tokens += resp?.usage?.output_tokens || 0
      return cd.extractToolInput(resp)
    }

    let raw = await ask(request)
    let problems = cd.validateAnalysis(raw)
    if (problems.length) {
      // One repair attempt, telling the model exactly what was wrong.
      const retry = structuredClone(request)
      retry.messages[0].content += `\n\nIMPORTANT: your previous attempt was rejected because: ${problems.join(' ')} Produce a complete debrief.`
      raw = await ask(retry)
      problems = cd.validateAnalysis(raw)
    }
    if (problems.length) throw new Error(`The analysis came back incomplete: ${problems.join(' ')}`)

    const analysis = cd.normalizeAnalysis(raw)
    const engagement = cd.scoreEngagement(analysis.engagement.factors)
    return await finish({
      ...base, status: 'complete', analysis, engagement, words: fmt.words,
      model: config.model, usage, analyzedAt: iso(), attempts: (existing?.attempts || 0) + 1,
    })
  } catch (err) {
    // A failed re-analysis must never destroy a good record that already exists.
    if (existing?.status === 'complete') return { status: 'failed', error: err.message, kept: 'existing_record' }
    const attempts = (existing?.attempts || 0) + 1
    const rec = { ...(base || { callId: id, gong: {}, participantEmails: [], internal: [], external: [] }), status: 'failed', error: err.message, attempts, failedAt: iso() }
    await finish(rec).catch(() => {})
    return { status: 'failed', error: err.message, attempts }
  } finally {
    await store.releaseLock(id).catch(() => {})
  }

  async function finish(record) {
    await store.putDetail(id, record)
    await store.upsertSummary(weekStart, cd.summarizeRecord(record))
    await store.updateState((s) => {
      if (!s.pending?.[id]) return s
      const p = { ...s.pending }
      delete p[id]
      return { ...s, pending: p }
    })
    return { status: record.status, usage: record.usage }
  }

  // Not ready yet (no transcript, or Gong has not listed the call). Remember the
  // try, and after about a day stop waiting and record that there was none.
  async function pending(reason, meta) {
    let attempts = 0
    await store.updateState((s) => {
      const p = { ...(s.pending || {}) }
      const cur = p[id] || { attempts: 0, firstSeen: iso() }
      attempts = cur.attempts + 1
      p[id] = { ...cur, attempts, lastTried: iso(), reason }
      return { ...s, pending: p }
    })
    const ageMs = meta && Number.isFinite(meta.started) ? now().getTime() - meta.started : 0
    if (attempts >= MAX_PENDING_ATTEMPTS || ageMs > GIVE_UP_AFTER_MS) {
      const status = reason === 'no_transcript' ? 'no_transcript' : 'skipped'
      const note = reason === 'no_transcript' ? 'Gong never produced a transcript for this call.' : 'This call was not found in Gong.'
      return await finish({ ...(base || { callId: id, gong: {}, participantEmails: [], internal: [], external: [] }), status, note })
    }
    return { pending: reason, attempts }
  }
}
