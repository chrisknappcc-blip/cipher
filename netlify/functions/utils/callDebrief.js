// netlify/functions/utils/callDebrief.js
//
// Pure logic for call debriefs: deciding which calls count, turning Gong's
// transcript into labeled text, the analysis prompt and output schema (John's
// "health system call debrief" rules, as structured data), the engagement score,
// weekly boundaries, who can see what, and the weekly recap roll up.
// No network calls here, so all of it is testable.

export const OUR_COMPANY = 'Care Continuity'
export const PROMPT_VERSION = 'v1-2026-10'
const ET = 'America/New_York'

// ─── Which calls count ──────────────────────────────────────────────────────
// Any call with an external participant. Checked per participant, not just on
// Gong's call level scope, so a call is never missed because of how it was tagged.
export function isExternalCall(call) {
  const parties = call?.parties || []
  return call?.metaData?.scope === 'External' || parties.some((p) => p.affiliation === 'External')
}

export function splitParties(parties = []) {
  const out = { internal: [], external: [], unknown: [], bySpeaker: new Map(), byUserId: new Map() }
  for (const p of parties) {
    const side = p.affiliation === 'Internal' ? 'internal' : p.affiliation === 'External' ? 'external' : 'unknown'
    const person = {
      name: p.name || '',
      email: String(p.emailAddress || '').toLowerCase(),
      title: p.title || '',
      speakerId: p.speakerId != null ? String(p.speakerId) : null,
      userId: p.userId != null ? String(p.userId) : null,
      side,
    }
    out[side].push(person)
    if (person.speakerId) out.bySpeaker.set(person.speakerId, person)
    if (person.userId) out.byUserId.set(person.userId, person)
  }
  return out
}

export function callMeta(call) {
  const m = call?.metaData || {}
  return {
    id: String(m.id),
    title: m.title || 'Untitled call',
    startedIso: m.started || null,
    started: m.started ? Date.parse(m.started) : NaN,
    durationSec: Number(m.duration) || 0,
    url: m.url || null,
    scope: m.scope || null,
    primaryUserId: m.primaryUserId != null ? String(m.primaryUserId) : null,
  }
}

// The rep the call belongs to: Gong's host if we can find them, else the first
// internal participant with an email.
export function ownerOf(meta, parties) {
  const host = meta.primaryUserId ? parties.byUserId.get(meta.primaryUserId) : null
  const person = (host && host.side === 'internal' ? host : null) || parties.internal.find((p) => p.email) || parties.internal[0] || null
  return { ownerName: person?.name || '', ownerEmail: person?.email || '' }
}

// ─── Transcript → labeled text ──────────────────────────────────────────────
function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '?:??'
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const SIDE_LABEL = { internal: 'CARE CONTINUITY', external: 'PROSPECT', unknown: 'UNKNOWN' }

export function formatTranscript({ transcript, parties }) {
  const words = { internal: 0, external: 0, unknown: 0, total: 0 }
  const lines = []
  const unidentified = new Map()
  for (const turn of transcript || []) {
    const text = (turn.sentences || []).map((s) => String(s.text || '').trim()).filter(Boolean).join(' ')
    if (!text) continue
    const sid = turn.speakerId != null ? String(turn.speakerId) : null
    const person = sid ? parties.bySpeaker.get(sid) : null
    const side = person?.side || 'unknown'
    let name = person?.name || person?.email
    if (!name) {
      const key = sid || 'none'
      if (!unidentified.has(key)) unidentified.set(key, unidentified.size + 1)
      name = `Unidentified speaker ${unidentified.get(key)}`
    }
    const title = side === 'external' && person?.title ? ` (${person.title})` : ''
    const n = text.split(/\s+/).length
    words[side] += n
    words.total += n
    lines.push(`[${fmtTime(turn.sentences?.[0]?.start)}] ${SIDE_LABEL[side]} ${name}${title}: ${text}`)
  }
  return { text: lines.join('\n'), words }
}

// ─── Engagement score ───────────────────────────────────────────────────────
// The AI rates each factor 0 to 5 and cites evidence. The score is computed here,
// so the weights are visible and can change without re-running a single call.
// Weights sum to 100. Bands are NOT calibrated yet: they are a starting point to
// check against whether a second meeting actually happened.
export const ENGAGEMENT_FACTORS = [
  { key: 'pain_fit', label: 'Stated problem fit', weight: 20,
    guide: 'The prospect described, in their own words, a pain, gap or metric problem that a Care Continuity solution addresses. 0 = none stated, 3 = real but general, 5 = specific, current and costly.' },
  { key: 'prospect_questions', label: 'Prospect initiated questions', weight: 15,
    guide: 'Questions the prospect raised on their own, and how specific they were (pricing, implementation, staffing, EMR or ADT integration, results at similar organizations). 0 = none, 3 = a few practical ones, 5 = many specific buying questions.' },
  { key: 'forward_motion', label: 'Forward motion', weight: 20,
    guide: 'Forward looking language, offers to share data or bring in others, and agreement to a concrete next step with an owner or date. 0 = vague or none, 3 = agreed to talk again, 5 = specific committed next step.' },
  { key: 'stakeholder_access', label: 'Stakeholder access', weight: 15,
    guide: 'Right people present or offered, a senior leader who engaged, an emerging champion. 0 = wrong audience, 3 = some relevant people, 5 = decision maker or champion actively engaged.' },
  { key: 'ownership_authority', label: 'Ownership and authority', weight: 10,
    guide: 'A clear owner of the problem who is present or reachable, and attendees who can act. 0 = nobody owns it, 3 = owner named but absent, 5 = owner present and engaged.' },
  { key: 'no_disqualifiers', label: 'Absence of disqualifiers', weight: 20,
    guide: 'Inverse of red flags: already solved in house, no real problem, no budget or capacity, a locked contract. 5 = no red flags, 3 = addressable concerns, 0 = a true disqualifier.' },
]

export function scoreEngagement(rated = []) {
  const byKey = new Map((Array.isArray(rated) ? rated : []).map((f) => [f?.key, f]))
  let total = 0
  const factors = ENGAGEMENT_FACTORS.map((def) => {
    const f = byKey.get(def.key)
    const missing = !f
    const rating = missing ? 0 : Math.min(5, Math.max(0, Math.round(Number(f.rating) || 0)))
    const points = (def.weight * rating) / 5
    total += points
    return { key: def.key, label: def.label, weight: def.weight, rating, points: Math.round(points * 10) / 10, evidence: missing ? 'Not rated.' : String(f.evidence || ''), missing }
  })
  const score = Math.round(total)
  const band = score >= 75 ? 'High' : score >= 50 ? 'Medium' : score >= 25 ? 'Low' : 'Very low'
  return { score, band, factors, calibrated: false }
}

// ─── The analysis request ───────────────────────────────────────────────────
export const SYSTEM_PROMPT = `You write internal debriefs of recorded sales calls between ${OUR_COMPANY} and a hospital or health system prospect. Respond ONLY by calling the record_debrief tool.

Every transcript line is labeled with a side. CARE CONTINUITY is our team. PROSPECT is the prospect's team. UNKNOWN means Gong could not tell; use context and say when a side is a guess.

SCOPE. The debrief covers ONLY what the prospect's team said and did. Leave out our pitch, case studies and product descriptions, except as brief context for a prospect question or reaction.

GROUND RULES
- Use only statements made by the prospect. Do not treat our rep's characterization as fact unless the prospect confirmed it or did not push back; if they did not push back, say that.
- Never invent numbers, names, titles, roles or processes. If something was not said, write "not discussed".
- Transcripts misattribute lines and garble names and words (for example "Care Count Moody" for ${OUR_COMPANY}). Use context to decide who most likely spoke. Where it matters, record the likely error in transcriptNotes instead of repeating it as fact. Do not "correct" a name or title beyond flagging a likely error.
- Every quote, flag and stakeholder needs who said it and an approximate time in m:ss, taken from the line labels.
- Be concrete and brief. Short quotes are better than paraphrase when the wording matters.
- prospect.organization is the organization's SHORT NAME only, a few words such as "Mercy Health". If you are unsure of the name, give your best short name and put the doubt in callTopic or transcriptNotes. prospect.callTopic is one sentence.

WHAT TO CAPTURE
1. attendees: every prospect side person (name, title or role as they stated it, anything notable about how they took part, and whether they spoke). absentInvitees: people invited or mentioned who did not attend, with any reason given. Include attendees who joined but never spoke.
2. organization and currentApproach: number of hospitals and clinics, rural or metro, ownership structure, service lines, payer mix, EMRs, volumes and other numbers; then who does the work today, the workflows, meetings, tools and notification flows, and how patients without a PCP or insurance are handled. Note who described it and how confident they sounded.
3. gaps: questions that went unanswered or got silence, processes nobody owned, topics never discussed, missing stakeholders.
4. questions: EVERY question the prospect asked, in order, with time, who, and the answer or context. Mark logistics ("can you repeat that", "is there a chat") as logistics and the rest as substantive. notAsked: important questions they did NOT ask, such as cost, ROI, contract terms, staffing model, timeline, prioritization, or whether the case study applies to an organization like theirs.
5. sentiment: a one line verdict ("Polite and cooperative, but lukewarm and noncommittal"), then evidence items labeled Engagement, Audience fit, Lens, Objections, Next steps, Champion, then a bottomLine on how qualified the opportunity is and what would move it forward.
6. greenFlags and redFlags: each grounded in something the prospect said or did, never in our own claims. If there are none of a kind, return an empty list rather than stretching weak evidence. Rate strength strong, moderate or weak. For each red flag say whether it is a true disqualifier or addressable in the next conversation. Green: a stated problem we address, admissions the process is manual or unowned, interest in specifics, forward looking language, an emerging champion. Red: already solved, no problem, no fit or capacity (budget, competing priorities, a pending vendor decision, a merger or EMR conversion, contract lock in, no authority), disengagement (repeated silence, pushback on relevance, deflection with no offer to connect, vague closing words). Flags must agree with the sentiment verdict.
7. peakEngagement: the single moment the prospect was most engaged, with the topic, time, who and what showed it, plus one or two runner ups.
8. ownership, stakeholders, followUpContacts, missingStakeholders: who owns the problem (say plainly if it is split, unclear or unowned, which is itself a key finding); every person, title, team or committee the prospect mentioned as relevant, with their likely role (decision-maker, budget holder, influencer, user or operator, technical or IT, blocker) and whether that role was stated or inferred; anyone the prospect offered to bring in, quoting their wording; and roles normally needed for this decision that were neither present nor mentioned.
9. nextQuestions: 4 to 6 specific questions for the next conversation that close the biggest gaps. Include one that tests the most important red flag, one that builds on the peak engagement moment, and one that confirms the problem owner or secures an introduction to a missing or suggested stakeholder.
10. glance: exactly 6 short bullets: the organization, current approach, key gaps, sentiment, flag balance, and problem owner plus follow up contacts.

ENGAGEMENT RATINGS. Rate each factor 0 to 5 with one or two sentences of evidence from the call. Be honest and consistent with your flags and verdict; do not inflate. Factors:
${ENGAGEMENT_FACTORS.map((f) => `- ${f.key}: ${f.label}. ${f.guide}`).join('\n')}

FOLLOW UPS. This is how we make sure our follow up has what the prospect needs.
- weOwe: every commitment OUR team made on the call (send something, schedule something, loop someone in, answer later), with who promised it and when.
- theyAsked: prospect questions that were unanswered, deferred or only partly answered, with status unanswered, deferred or partly_answered. Leave out questions that were fully answered.
- infoNeeded: the specific facts our follow up must include to answer what this prospect cares about, grounded in the call (for example the pricing model, EMR integration details, a case study at a similar size).`

const str = { type: 'string' }
const strArr = { type: 'array', items: str }
const strength = { type: 'string', enum: ['strong', 'moderate', 'weak'] }
const obj = (properties) => ({ type: 'object', required: Object.keys(properties), properties })
const list = (properties) => ({ type: 'array', items: obj(properties) })

export const DEBRIEF_TOOL = {
  name: 'record_debrief',
  description: 'Record the structured debrief of the call.',
  input_schema: obj({
    prospect: obj({ organization: { type: 'string', description: 'Short name only, six words at most. No explanation or caveats.' }, callTopic: { type: 'string', description: 'One sentence.' } }),
    glance: strArr,
    attendees: list({ name: str, role: str, notes: str, spoke: { type: 'boolean' } }),
    absentInvitees: list({ name: str, role: str, reason: str }),
    organization: obj({ summary: str, facts: strArr }),
    currentApproach: obj({ summary: str, sections: list({ heading: str, points: strArr }) }),
    gaps: strArr,
    questions: list({ who: str, time: str, question: str, context: str, kind: { type: 'string', enum: ['substantive', 'logistics'] } }),
    notAsked: strArr,
    sentiment: obj({ verdict: str, evidence: list({ label: str, text: str }), bottomLine: str }),
    greenFlags: list({ flag: str, evidence: str, who: str, time: str, strength }),
    redFlags: list({ flag: str, evidence: str, who: str, time: str, strength, disqualifier: { type: 'string', enum: ['disqualifier', 'addressable'] } }),
    peakEngagement: obj({ topic: str, time: str, who: str, evidence: str, runnersUp: strArr }),
    ownership: obj({ owner: str, onCall: { type: ['boolean', 'null'] }, saidBy: str, time: str, notes: str }),
    stakeholders: list({ name: str, title: str, mentionedBy: str, time: str, role: str, roleBasis: { type: 'string', enum: ['stated', 'inferred'] }, context: str }),
    followUpContacts: list({ name: str, title: str, wording: str }),
    missingStakeholders: strArr,
    nextQuestions: strArr,
    engagement: obj({ factors: list({ key: { type: 'string', enum: ENGAGEMENT_FACTORS.map((f) => f.key) }, rating: { type: 'integer', minimum: 0, maximum: 5 }, evidence: str }) }),
    followUps: obj({
      weOwe: list({ item: str, who: str, when: str }),
      theyAsked: list({ item: str, who: str, status: { type: 'string', enum: ['unanswered', 'deferred', 'partly_answered'] } }),
      infoNeeded: strArr,
    }),
    transcriptNotes: strArr,
  }),
}

const MAX_TRANSCRIPT_CHARS = 450000 // roughly 100k tokens; a normal hour long call is a tenth of this

export function buildAnalysisRequest({ model, maxTokens = 32000, meta, parties, transcriptText }) {
  const names = (list) => list.map((p) => p.name || p.email).filter(Boolean).join(', ') || 'not listed'
  const prospects = parties.external.concat(parties.unknown).map((p) => `${p.name || p.email || 'unnamed'}${p.title ? `, ${p.title}` : ''}`).join('; ') || 'not listed'
  let transcript = transcriptText
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    const head = transcript.slice(0, Math.floor(MAX_TRANSCRIPT_CHARS * 0.6))
    const tail = transcript.slice(-Math.floor(MAX_TRANSCRIPT_CHARS * 0.4))
    transcript = `${head}\n[... the middle of this transcript was omitted for length ...]\n${tail}`
  }
  const user = [
    'CALL DETAILS',
    `Title: ${meta.title}`,
    `Date: ${meta.startedIso || 'unknown'}`,
    `Length: ${Math.round(meta.durationSec / 60)} minutes`,
    `${OUR_COMPANY} attendees: ${names(parties.internal)}`,
    `Prospect attendees (per Gong): ${prospects}`,
    '',
    'TRANSCRIPT',
    transcript,
    '',
    'Now call the record_debrief tool with the complete debrief.',
  ].join('\n')
  return {
    model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    // The tool is offered but not forced: some models (claude-sonnet-5-5 among them) reject a
    // forced tool choice with a 400. The prompt tells the model to answer only by calling it,
    // and processCall retries once if it does not.
    tools: [DEBRIEF_TOOL],
    messages: [{ role: 'user', content: user }],
  }
}

export function extractToolInput(response) {
  const block = (response?.content || []).find((b) => b.type === 'tool_use' && b.name === DEBRIEF_TOOL.name)
  return block?.input && typeof block.input === 'object' ? block.input : null
}

// ─── Making model output safe to store and render ───────────────────────────
const s = (x) => (typeof x === 'string' ? x : x == null ? '' : String(x))
const a = (x) => (Array.isArray(x) ? x : [])
const o = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
const strs = (x) => a(x).map(s).filter(Boolean)
const items = (x, fn) => a(x).filter((i) => i && typeof i === 'object').map(fn)

export function normalizeAnalysis(raw) {
  const r = o(raw)
  return {
    prospect: { organization: s(o(r.prospect).organization), callTopic: s(o(r.prospect).callTopic) },
    glance: strs(r.glance),
    attendees: items(r.attendees, (i) => ({ name: s(i.name), role: s(i.role), notes: s(i.notes), spoke: i.spoke !== false })),
    absentInvitees: items(r.absentInvitees, (i) => ({ name: s(i.name), role: s(i.role), reason: s(i.reason) })),
    organization: { summary: s(o(r.organization).summary), facts: strs(o(r.organization).facts) },
    currentApproach: {
      summary: s(o(r.currentApproach).summary),
      sections: items(o(r.currentApproach).sections, (i) => ({ heading: s(i.heading), points: strs(i.points) })),
    },
    gaps: strs(r.gaps),
    questions: items(r.questions, (i) => ({ who: s(i.who), time: s(i.time), question: s(i.question), context: s(i.context), kind: i.kind === 'logistics' ? 'logistics' : 'substantive' })),
    notAsked: strs(r.notAsked),
    sentiment: {
      verdict: s(o(r.sentiment).verdict),
      evidence: items(o(r.sentiment).evidence, (i) => ({ label: s(i.label), text: s(i.text) })),
      bottomLine: s(o(r.sentiment).bottomLine),
    },
    greenFlags: items(r.greenFlags, (i) => ({ flag: s(i.flag), evidence: s(i.evidence), who: s(i.who), time: s(i.time), strength: ['strong', 'moderate', 'weak'].includes(i.strength) ? i.strength : 'moderate' })),
    redFlags: items(r.redFlags, (i) => ({ flag: s(i.flag), evidence: s(i.evidence), who: s(i.who), time: s(i.time), strength: ['strong', 'moderate', 'weak'].includes(i.strength) ? i.strength : 'moderate', disqualifier: i.disqualifier === 'disqualifier' ? 'disqualifier' : 'addressable' })),
    peakEngagement: { topic: s(o(r.peakEngagement).topic), time: s(o(r.peakEngagement).time), who: s(o(r.peakEngagement).who), evidence: s(o(r.peakEngagement).evidence), runnersUp: strs(o(r.peakEngagement).runnersUp) },
    ownership: { owner: s(o(r.ownership).owner), onCall: typeof o(r.ownership).onCall === 'boolean' ? r.ownership.onCall : null, saidBy: s(o(r.ownership).saidBy), time: s(o(r.ownership).time), notes: s(o(r.ownership).notes) },
    stakeholders: items(r.stakeholders, (i) => ({ name: s(i.name), title: s(i.title), mentionedBy: s(i.mentionedBy), time: s(i.time), role: s(i.role), roleBasis: i.roleBasis === 'stated' ? 'stated' : 'inferred', context: s(i.context) })),
    followUpContacts: items(r.followUpContacts, (i) => ({ name: s(i.name), title: s(i.title), wording: s(i.wording) })),
    missingStakeholders: strs(r.missingStakeholders),
    nextQuestions: strs(r.nextQuestions),
    engagement: { factors: items(o(r.engagement).factors, (i) => ({ key: s(i.key), rating: Number(i.rating) || 0, evidence: s(i.evidence) })) },
    followUps: {
      weOwe: items(o(r.followUps).weOwe, (i) => ({ item: s(i.item), who: s(i.who), when: s(i.when) })),
      theyAsked: items(o(r.followUps).theyAsked, (i) => ({ item: s(i.item), who: s(i.who), status: ['unanswered', 'deferred', 'partly_answered'].includes(i.status) ? i.status : 'unanswered' })),
      infoNeeded: strs(o(r.followUps).infoNeeded),
    },
    transcriptNotes: strs(r.transcriptNotes),
  }
}

// Returns a list of problems; empty means usable. Only the parts the product
// truly depends on are required, so a slightly thin answer is stored, not thrown away.
export function validateAnalysis(raw) {
  const problems = []
  if (!raw) return ['You did not call the record_debrief tool.']
  if (typeof raw !== 'object') return ['The response was not an object.']
  if (!s(o(raw.sentiment).verdict).trim()) problems.push('sentiment.verdict is missing.')
  if (!s(o(raw.prospect).organization).trim()) problems.push('prospect.organization is missing.')
  const keys = new Set(a(o(raw.engagement).factors).map((f) => f?.key))
  const have = ENGAGEMENT_FACTORS.filter((f) => keys.has(f.key)).length
  if (have < ENGAGEMENT_FACTORS.length) problems.push(`engagement.factors must rate all ${ENGAGEMENT_FACTORS.length} factors; got ${have}.`)
  return problems
}

// A short display name. Drops a parenthetical ("Mercy Health (as titled in the call...)" becomes "Mercy Health"),
// and only if the text is still long does it cut at the first sentence, so a real name such as
// "St. Luke's Health System" is never chopped at its "St.".
export function shortOrgName(value) {
  let cut = String(value || '').trim().split(/\s\(/)[0].trim()
  if (cut.length > 60) {
    const first = cut.split(/[.;]\s/)[0].trim()
    if (first.length >= 4) cut = first
  }
  return cut.length > 60 ? `${cut.slice(0, 57).trimEnd()}...` : cut
}

// ─── Summaries (what lists and recaps read, so they never load full records) ─
const DONE = new Set(['complete', 'too_short', 'no_transcript', 'skipped'])
export const isDoneStatus = (status) => DONE.has(status)

export function summarizeRecord(rec) {
  const an = rec.analysis
  const topRed = an ? (an.redFlags.find((f) => f.strength === 'strong') || an.redFlags[0]) : null
  return {
    callId: rec.callId,
    status: rec.status,
    started: rec.gong?.started || null,
    title: rec.gong?.title || '',
    url: rec.gong?.url || null,
    durationSec: rec.gong?.durationSec || 0,
    ownerName: rec.ownerName || '',
    ownerEmail: rec.ownerEmail || '',
    participantEmails: rec.participantEmails || [],
    externalNames: (rec.external || []).map((p) => p.name || p.email).filter(Boolean),
    externalEmails: (rec.external || []).map((p) => p.email).filter(Boolean),
    organization: shortOrgName(an?.prospect.organization),
    topic: an?.prospect.callTopic || '',
    engagement: rec.engagement ? { score: rec.engagement.score, band: rec.engagement.band } : null,
    verdict: an?.sentiment.verdict || '',
    greenCount: an ? an.greenFlags.length : 0,
    redCount: an ? an.redFlags.length : 0,
    topRedFlag: topRed ? topRed.flag : '',
    owedItems: an ? an.followUps.weOwe.map((i) => i.item).filter(Boolean).slice(0, 8) : [],
    openQuestions: an ? an.followUps.theyAsked.map((i) => i.item).filter(Boolean).slice(0, 8) : [],
    error: rec.status === 'failed' ? String(rec.error || '').slice(0, 300) : undefined,
    attempts: rec.attempts || 0,
    updatedAt: rec.analyzedAt || rec.failedAt || null,
  }
}

// ─── Weeks (Monday to Sunday, Eastern) ──────────────────────────────────────
function etParts(date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, weekday: p.weekday }
}
const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
const ymd = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`

// The Monday (Eastern calendar date) of the week a moment falls in: "2026-10-26".
export function weekStartKey(date) {
  const { y, m, d, weekday } = etParts(new Date(date))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - DOW[weekday])
  return ymd(dt)
}

// When a week's recap unlocks: Friday 4:00 PM Eastern (handles daylight saving).
export function weekReleaseAt(weekStart) {
  const [y, m, d] = weekStart.split('-').map(Number)
  const fri = new Date(Date.UTC(y, m - 1, d + 4))
  const [fy, fm, fd] = [fri.getUTCFullYear(), fri.getUTCMonth() + 1, fri.getUTCDate()]
  for (const offset of [4, 5]) {
    const cand = new Date(Date.UTC(fy, fm - 1, fd, 16 + offset))
    const p = etParts(cand)
    if (p.h === 16 && p.d === fd && p.m === fm) return cand
  }
  return new Date(Date.UTC(fy, fm - 1, fd, 21))
}

export function prevWeekStart(weekStart, n = 1) {
  const [y, m, d] = weekStart.split('-').map(Number)
  return ymd(new Date(Date.UTC(y, m - 1, d - 7 * n)))
}

// ─── Who can see what ───────────────────────────────────────────────────────
export function parseViewAll(value) {
  return new Set(String(value || 'jhansel@carecontinuity.com').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
}
export function canSee(item, email, viewAll) {
  const e = String(email || '').toLowerCase()
  if (!e) return false
  if (viewAll.has(e)) return true
  return (item.participantEmails || []).includes(e) || String(item.ownerEmail || '').toLowerCase() === e
}

// ─── Weekly recap ───────────────────────────────────────────────────────────
export function buildRecap({ summaries, weekStart, now = new Date(), viewAll = false }) {
  const releaseAt = weekReleaseAt(weekStart)
  const analyzed = summaries.filter((x) => x.status === 'complete' && x.engagement)
  const avg = analyzed.length ? Math.round(analyzed.reduce((t, x) => t + x.engagement.score, 0) / analyzed.length) : null
  const brief = (x) => ({ callId: x.callId, title: x.title, organization: x.organization, ownerName: x.ownerName, started: x.started, score: x.engagement?.score ?? null, band: x.engagement?.band ?? null, verdict: x.verdict })
  const bands = { High: 0, Medium: 0, Low: 0, 'Very low': 0 }
  analyzed.forEach((x) => { bands[x.engagement.band] += 1 })

  const recap = {
    weekStart,
    releaseAt: releaseAt.toISOString(),
    released: now.getTime() >= releaseAt.getTime(),
    totals: {
      calls: summaries.length,
      analyzed: analyzed.length,
      tooShort: summaries.filter((x) => x.status === 'too_short').length,
      failed: summaries.filter((x) => x.status === 'failed').length,
      avgEngagement: avg,
    },
    bands,
    topCalls: analyzed.slice().sort((x, y) => y.engagement.score - x.engagement.score).slice(0, 3).map(brief),
    needsAttention: analyzed
      .filter((x) => x.engagement.band === 'Low' || x.engagement.band === 'Very low' || x.redCount >= 2)
      .sort((x, y) => x.engagement.score - y.engagement.score).slice(0, 5)
      .map((x) => ({ ...brief(x), topRedFlag: x.topRedFlag })),
    owed: analyzed.filter((x) => x.owedItems.length).map((x) => ({ ...brief(x), items: x.owedItems })),
    openQuestions: analyzed.filter((x) => x.openQuestions.length).map((x) => ({ ...brief(x), items: x.openQuestions })),
  }
  if (viewAll) {
    const reps = new Map()
    for (const x of summaries) {
      const key = x.ownerEmail || x.ownerName || 'unassigned'
      if (!reps.has(key)) reps.set(key, { ownerName: x.ownerName || key, ownerEmail: x.ownerEmail, calls: 0, scored: 0, scoreSum: 0, owedCount: 0 })
      const r = reps.get(key)
      r.calls += 1
      if (x.engagement) { r.scored += 1; r.scoreSum += x.engagement.score }
      r.owedCount += x.owedItems?.length || 0
    }
    recap.byRep = [...reps.values()].map((r) => ({ ownerName: r.ownerName, ownerEmail: r.ownerEmail, calls: r.calls, avgEngagement: r.scored ? Math.round(r.scoreSum / r.scored) : null, owedCount: r.owedCount })).sort((x, y) => y.calls - x.calls)
  }
  return recap
}
