// netlify/functions/utils/intelSchema.js
//
// The pure logic behind the Market Intel tab. No network, no storage, no clock of its own, so every rule here can be
// tested with plain data.
//
//   states        normState turns "nj", "New Jersey" and "N.J." into NJ.
//   BDRs          four reps, joined on their HubSpot name (Abigail Evans), shown by the name they go by (Abby).
//   matching      matchOrg finds the HubSpot company for a hospital or system name inside one state, and says so
//                 plainly when it is not sure (ambiguous) or finds nothing (none). It never guesses silently.
//   adapters      fromAlert and fromUpdate turn the team's earlier tools (Healthcare Account Intelligence alerts and
//                 Front Door Radar updates) into one insight shape.
//   merging       mergeInsights joins the same event reported by two tools into one card, and keeps both sources.
//   scoring       scoreInsight is Account Intelligence's news score and outreach window, kept as it was.
//   data health   findDuplicates, pendingSize and summaryDateHint feed the Data health screen.

export const BDRS = [
  { key: 'Harley Reed', short: 'Harley', territory: 'West' },
  { key: 'Abigail Evans', short: 'Abby', territory: 'Central' },
  { key: 'Chiara Pate', short: 'Chiara', territory: 'Gulf' },
  { key: 'Chris Knapp', short: 'Chris', territory: 'East' },
]
export const bdrShort = (key) => (BDRS.find((b) => b.key === key) || {}).short || key || ''

// A name typed any common way finds its rep: "Abby", "abigail evans", "Chris Knapp".
export function resolveBdr(v) {
  const t = String(v || '').trim().toLowerCase()
  if (!t) return null
  const hit = BDRS.find((b) => b.key.toLowerCase() === t || b.short.toLowerCase() === t || b.key.toLowerCase().split(' ')[0] === t)
  return hit ? hit.key : null
}

// The four territories, as in the team's Territory Breakout workbook (checked state for state, Nov 16, 2026) and the
// prompt pack, which agree. HubSpot's Assigned BDR agrees on every state spot checked. Used until a different table is saved.
const PACK = {
  'Harley Reed': 'AK AZ CA CO HI IA ID KS MN MT ND NE NM NV OK OR SD UT WA WY',
  'Abigail Evans': 'IL IN MI MO NC OH WI WV',
  'Chiara Pate': 'AL AR FL GA KY LA MS TN TX',
  'Chris Knapp': 'CT DC DE MA MD ME NH NJ NY PA RI SC VA VT',
}
export const PACK_STATE_TABLE = Object.fromEntries(Object.entries(PACK).flatMap(([bdr, list]) => list.split(' ').map((s) => [s, bdr])))

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
  NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}
const NAME_TO_ABBR = Object.fromEntries([...Object.entries(STATES).map(([a, n]) => [n.toLowerCase(), a]), ['washington dc', 'DC'], ['washington d c', 'DC']])
export const STATE_CODES = Object.keys(STATES)
export const stateName = (code) => STATES[code] || code

export function normState(v) {
  const t = String(v == null ? '' : v).trim()
  if (!t) return null
  const up = t.toUpperCase().replace(/\./g, '')
  if (STATES[up]) return up
  return NAME_TO_ABBR[t.toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim()] || null
}

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const slug = (s) => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// ---------- names ----------

const STOP = new Set(['health', 'healthcare', 'system', 'systems', 'medical', 'medicine', 'center', 'centre', 'hospital', 'hospitals', 'the', 'of', 'and', 'inc', 'llc',
  'care', 'network', 'group', 'clinic', 'clinics', 'partners', 'services', 'corporation', 'co', 'at', 'in', 'for'])

export const nameTokens = (name) => String(name || '').toLowerCase().replace(/['’]/g, '').replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !STOP.has(w))
export const nameKey = (name) => nameTokens(name).sort().join(' ')

const tokenEq = (a, b) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)))
const within = (small, big) => small.length > 0 && small.every((t) => big.some((u) => tokenEq(t, u)))
const meaningful = (toks) => toks.some((t) => t.length >= 3)

// 'exact' when each name's words are all in the other, 'subset' when only one side's are, null when neither.
function relation(a, b) {
  if (!a.length || !b.length || !meaningful(a) || !meaningful(b)) return null
  const ab = within(a, b), ba = within(b, a)
  if (ab && ba) return 'exact'
  if (ab || ba) return 'subset'
  return null
}

export const hospitalId = (name, city, state) => `${String(normState(state) || 'xx').toLowerCase()}-${slug(city) || 'unknown'}-${slug(nameTokens(name).slice(0, 2).join(' ')) || 'unnamed'}`

// ---------- accounts ----------

// Size, from the Definitive fields in HubSpot. A company with a Definitive ID but no numbers yet is "pending", which
// is different from "not in HubSpot": the first one fills itself in when the integration reaches it.
export function sizeOf(a) {
  const s = (a && a.size) || {}
  const er = num(s.er), beds = num(s.beds)
  if (er != null || beds != null) return { status: er != null ? 'ok' : 'partial', er, beds, hospitals: num(s.hospitals) }
  return { status: a && a.definitiveId ? 'pending_definitive' : 'none', er: null, beds: null, hospitals: null }
}

export const targetReasons = (a, stars = {}) => {
  const out = []
  if (a && a.tier) out.push('gold')
  if (a && a.bdrLed) out.push('bdr_led')
  if (a && stars[a.id] && stars[a.id].star) out.push('starred')
  return out
}

// Who owns it: a BDR's choice in the hub first, then HubSpot's Assigned BDR, then the state table.
export function effectiveBdr(a, stars = {}, stateTable = PACK_STATE_TABLE) {
  const hub = stars[a.id] && stars[a.id].assignedBdr
  if (hub) return { bdr: hub, source: 'hub' }
  const own = resolveBdr(a.bdr)
  if (own) return { bdr: own, source: 'hubspot' }
  const byState = a.state && stateTable[a.state]
  if (byState) return { bdr: byState, source: 'state table' }
  return { bdr: null, source: null }
}

export function buildAccountIndex(accounts) {
  const byState = new Map(), all = []
  for (const a of accounts || []) {
    const e = { a, tokens: nameTokens(a.name) }
    all.push(e)
    const k = a.state || '__none'
    if (!byState.has(k)) byState.set(k, [])
    byState.get(k).push(e)
  }
  return { byState, all }
}

const strength = (a) => (a.tier ? 8 : 0) + (a.bdr ? 4 : 0) + (sizeOf(a).status === 'ok' ? 2 : 0) + (a.definitiveId ? 1 : 0) + Math.log10(1 + (sizeOf(a).er || 0)) / 10

// Several records can share a name's words (a system and its flagship hospital, or plain duplicates). It is a clear
// match when one is far better populated or at least one and a half times the size. Otherwise it is a toss up, and the
// screen says so instead of picking silently.
function pickBest(cands) {
  const exact = cands.filter((c) => c.rel === 'exact')
  const pool = exact.length ? exact : cands
  pool.sort((x, y) => strength(y.e.a) - strength(x.e.a))
  let clear = pool.length === 1
  if (!clear) {
    const ep = sizeOf(pool[0].e.a).er || 0, eq = sizeOf(pool[1].e.a).er || 0
    clear = strength(pool[0].e.a) - strength(pool[1].e.a) >= 3 || (eq > 0 && ep >= 1.5 * eq)
  }
  return { primary: pool[0], status: clear ? 'matched' : 'ambiguous', pool }
}

// Find the HubSpot company for a name inside one state.
export function matchOrg(org, stateRaw, index) {
  const st = normState(stateRaw)
  const ot = nameTokens(org)
  const cands = ((index.byState.get(st) || [])).map((e) => ({ e, rel: relation(ot, e.tokens) })).filter((c) => c.rel)
  const elsewhere = index.all.filter((e) => e.a.state !== st && relation(ot, e.tokens) === 'exact').slice(0, 5).map((e) => e.a.id)
  if (!cands.length) return { status: 'none', accountId: null, candidates: [], elsewhere }
  const { primary, status, pool } = pickBest(cands)
  return { status, accountId: primary.e.a.id, candidates: pool.slice(0, 5).map((c) => c.e.a.id), elsewhere }
}

// For records with no organization field (the Radar), look for a company whose whole name appears in the title.
export function matchTitle(title, states, index) {
  const tt = nameTokens(title)
  const found = []
  for (const st of states || []) {
    for (const e of index.byState.get(st) || []) {
      if (!meaningful(e.tokens)) continue
      if (e.tokens.length && within(e.tokens, tt)) found.push({ e, rel: 'exact' })
    }
  }
  if (!found.length) return { status: 'none', accountId: null, candidates: [], elsewhere: [] }
  const { primary, status, pool } = pickBest(found)
  return { status, accountId: primary.e.a.id, candidates: pool.slice(0, 5).map((c) => c.e.a.id), elsewhere: [] }
}

// Records that are probably the same system: the same words in the name. Different BDRs or states is the serious kind.
export function findDuplicates(accounts) {
  const groups = new Map()
  for (const a of accounts || []) {
    const k = nameKey(a.name)
    if (k.length < 3) continue
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(a)
  }
  const out = []
  for (const [key, list] of groups) {
    if (list.length < 2) continue
    const bdrs = [...new Set(list.map((x) => x.bdr).filter(Boolean))], states = [...new Set(list.map((x) => x.state || x.stateRaw).filter(Boolean))]
    out.push({ key, name: list[0].name, count: list.length, kind: bdrs.length > 1 ? 'several_bdrs' : states.length > 1 ? 'several_states' : 'same_place', bdrs, states, ids: list.map((x) => x.id) })
  }
  const rank = { several_bdrs: 0, several_states: 1, same_place: 2 }
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.count - a.count || a.name.localeCompare(b.name))
}

export const pendingSize = (accounts, stars = {}) => (accounts || []).filter((a) => targetReasons(a, stars).length && sizeOf(a).status !== 'ok')
  .map((a) => ({ id: a.id, name: a.name, state: a.state, status: sizeOf(a).status }))

// ---------- state table ----------

// Accepts the rows people paste out of Excel: "NJ, Chris Knapp", "New Jersey<TAB>Chris", with or without a header.
export function parseStateTable(text) {
  const table = {}, errors = []
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim()
    if (!raw) return
    const parts = raw.split(/[\t,;|]+/).map((s) => s.trim()).filter(Boolean)
    if (parts.length < 2) { errors.push(`Line ${i + 1}: expected a state and a BDR`); return }
    const st = normState(parts[0]), bdr = resolveBdr(parts[1])
    if (i === 0 && !st && /state/i.test(parts[0])) return // header row
    if (!st) { errors.push(`Line ${i + 1}: "${parts[0]}" is not a state`); return }
    if (!bdr) { errors.push(`Line ${i + 1}: "${parts[1]}" is not one of the four BDRs`); return }
    table[st] = bdr
  })
  return { table, errors, count: Object.keys(table).length }
}

// ---------- the news items from the earlier tools ----------

export const WINDOWS = { ed: [0, 21], mna: [7, 45], lead: [3, 30], growth: [0, 60] }
const BASE = { ed: 40, mna: 35, lead: 25, growth: 20 }
const dayNum = (iso) => Math.floor(Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`) / 86400000)

const eventKind = (a) => {
  const t = `${a.title || ''}`.toLowerCase()
  if (a.cat === 'ed') return 'new_ed'
  if (a.cat === 'mna') return /merge/.test(t) ? 'merger' : 'acquisition'
  if (a.cat === 'lead') return 'leadership'
  return 'growth'
}

export function fromAlert(a) {
  const st = normState(a.state)
  return {
    id: `ai:${a._id || a.id}`, origin: 'account-intelligence', type: 'account_trigger', cat: a.cat || null, ed: !!a.ed, eventKind: eventKind(a),
    org: a.org || null, states: st ? [st] : [], title: a.title || '', whatHappened: a.summary || '', whyItMatters: a.why || '', openingLine: a.hook || '',
    leadProduct: (a.products || [])[0] || null, secondaryProduct: (a.products || [])[1] || null,
    contacts: (a.contacts || []).map((c) => ({ name: c.name || null, title: c.role || null, why: c.why || null })),
    outreachSteps: a.outreach || a.steps || a.plan || null, locations: a.locations || null,
    sources: [{ name: a.sourceName || null, url: a.sourceUrl || null, date: a.date || null, origin: 'account-intelligence' }],
    published: a.date || null, status: 'verified', workflowStatus: a.status || 'new',
  }
}

const TOPIC_TYPE = [['Readmissions', 'readmissions'], ['Medicaid & coverage', 'coverage'], ['Medicaid and coverage', 'coverage'], ['Payment rules', 'legislation'], ['Prior auth', 'legislation'],
  ['CON & licensing', 'legislation'], ['CON and licensing', 'legislation'], ['Emergency dept', 'ed_driver']]
const MOVED = /pending|complet|definitive|final|announced|signed/i

export function typeFromTopics(topics = [], status = '') {
  const t = Array.isArray(topics) ? topics : []
  if (t.some((x) => /urgent care|health system news/i.test(x)) && MOVED.test(status)) return 'competitive'
  for (const [name, type] of TOPIC_TYPE) if (t.includes(name)) return type
  if (t.some((x) => /referrals/i.test(x))) return 'utilization'
  return 'utilization'
}

export function fromUpdate(u) {
  const states = (u.states || []).map(normState).filter(Boolean)
  const raw = String(u.level || '').toLowerCase()
  const level = /federal/.test(raw) ? 'federal' : /^state/.test(raw) ? 'state' : raw ? 'system' : ((u.id || '').startsWith('fed-') ? 'federal' : states.length > 1 ? 'state' : 'system')
  return {
    id: `fdr:${u.id}`, origin: 'front-door-radar', type: typeFromTopics(u.topics, u.status), cat: null, ed: false, eventKind: null, org: null, states, level,
    title: u.title || '', whatHappened: u.summary || '', whyItMatters: u.why || '', openingLine: '', leadProduct: null, secondaryProduct: null, contacts: [], outreachSteps: null,
    topics: u.topics || [], dealStatus: u.status || null, deadline: u.keyDate ? { date: u.keyDate, label: u.keyLabel || null } : null,
    sources: [{ name: u.sourceTitle || null, url: u.sourceUrl || null, date: u.date || null, origin: 'front-door-radar' }],
    published: u.date || null, status: 'verified', workflowStatus: null,
  }
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_RE = MONTHS.join('|')

// A date the summary itself states, when it disagrees with the record's date by more than a month. Only dates that
// are already in the past count, so "takes effect Jan 1, 2027" never looks like a mistake.
export function summaryDateHint(summary, recorded, today) {
  if (!summary || !recorded) return null
  const exact = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2}),?\\s+(20\\d{2})`, 'i').exec(summary)
  const loose = new RegExp(`\\b(early|mid|late)?\\s*(${MONTH_RE})\\s+(20\\d{2})`, 'i').exec(summary)
  let iso = null, text = null
  if (exact) { iso = `${exact[3]}-${String(MONTHS.indexOf(exact[1].toLowerCase()) + 1).padStart(2, '0')}-${String(exact[2]).padStart(2, '0')}`; text = exact[0] }
  else if (loose) { const d = { early: 5, mid: 15, late: 25 }[(loose[1] || '').toLowerCase()] || 15; iso = `${loose[3]}-${String(MONTHS.indexOf(loose[2].toLowerCase()) + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; text = loose[0].trim() }
  if (!iso) return null
  if (today && dayNum(iso) > dayNum(today)) return null
  return Math.abs(dayNum(iso) - dayNum(recorded)) > 31 ? { recorded, hint: iso, text } : null
}

const GENERIC = new Set(['completes', 'complete', 'completed', 'acquisition', 'acquire', 'acquires', 'acquired', 'takeover', 'agreement', 'sign', 'signs', 'signed', 'joins', 'join', 'names', 'named', 'closes', 'closed',
  'opens', 'opened', 'breaks', 'ground', 'announces', 'new', 'plan', 'plans', 'builds', 'build', 'emergency', 'department', 'expansion', 'reaches', 'definitive', 'files', 'adds', 'to', 'now', 'its', 'from',
  'after', 'with', 'over', 'ceo', 'steps', 'down', 'board', 'terminates', 'chief', 'president', 'move', 'moves', 'leaves', 'bed', 'beds', 'er', 'ed'])
const distinctive = (title) => new Set(nameTokens(title).filter((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t)))

// The same event, reported by two tools, becomes one insight with both sources. It only joins an alert to a Radar
// update when they share a state and at least two distinctive words, so an unrelated item is never swallowed.
export function mergeInsights(list) {
  const alerts = list.filter((i) => i.origin === 'account-intelligence')
  const others = list.filter((i) => i.origin !== 'account-intelligence')
  const absorbed = new Set(), out = []
  for (const a of alerts) {
    const da = distinctive(`${a.org || ''} ${a.title}`)
    const merged = { ...a, sources: [...a.sources], mergedIds: [], dateNotes: [] }
    for (const o of others) {
      if (absorbed.has(o.id) || !o.states.some((s) => a.states.includes(s))) continue
      const shared = [...distinctive(o.title)].filter((t) => da.has(t))
      if (shared.length < 2) continue
      absorbed.add(o.id)
      merged.mergedIds.push(o.id)
      merged.sources.push(...o.sources)
      if (o.deadline) merged.deadline = o.deadline
      if (o.dealStatus) merged.dealStatus = o.dealStatus
      if (o.topics && o.topics.length) merged.topics = o.topics
      const od = o.published, ad = a.published
      if (od && ad && Math.abs(dayNum(od) - dayNum(ad)) > 21) merged.dateNotes.push({ source: o.origin, date: od, kept: ad })
    }
    out.push(merged)
  }
  for (const o of others) if (!absorbed.has(o.id)) out.push({ ...o, mergedIds: [], dateNotes: [] })
  return out
}

// News score (0 to 99) and outreach window, as Account Intelligence worked them out. A match to a target account adds 10.
export function scoreInsight(ins, { today, isTarget = false } = {}) {
  if (!ins.published) return { score: null, ageDays: null, window: null }
  const age = dayNum(today) - dayNum(ins.published)
  const base = BASE[ins.cat] ?? 15
  const rec = age <= 7 ? 25 : age <= 30 ? 15 : age <= 90 ? 5 : 0
  const score = Math.min(99, base + rec + (ins.ed ? 20 : 0) + (isTarget ? 10 : 0))
  const w = WINDOWS[ins.cat]
  if (!w) return { score, ageDays: age, window: null }
  const left = w[1] - age
  const status = age < w[0] ? 'early' : left < 0 ? 'passed' : left <= 14 ? 'closing' : 'open'
  return { score, ageDays: age, window: { status, daysLeft: left, start: w[0], end: w[1] } }
}
