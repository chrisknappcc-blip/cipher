// netlify/functions/utils/intelService.js
//
// What Market Intel does, kept apart from the HTTP handler so each piece can be tested with fakes.
//
// Raw records are stored as they were imported, and the merged view (which items are the same event, which HubSpot
// account each one belongs to, scores, owners) is worked out when someone asks. So changing a matching rule never
// needs a re-import, and a new HubSpot refresh is picked up straight away.

import {
  BDRS, PACK_STATE_TABLE, normState, resolveBdr, sizeOf, targetReasons, isTarget, effectiveBdr, buildAccountIndex, matchOrg, matchTitle,
  findDuplicates, pendingSize, parseStateTable, fromAlert, fromUpdate, mergeInsights, scoreInsight, summaryDateHint, nameKey, personaCoverage,
} from './intelSchema.js'
import { locate } from './intelGeo.js'
import { serviceLinesOf, classOf, phaseOf, fourPartOf, productFit, PRODUCT_KIT, PRODUCT_NAMES, SERVICE_LINES, isDuplicateNews, monthKey, monthLabel } from './intelFeed.js'
import { analyzeArticle, toRecord, cleanRecord, MIN_TEXT, MAX_TEXT, SAVABLE, addUsage, usedToday, summarizeUsage } from './intelAI.js'

export const etDate = (now) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const clean = (v) => (v === undefined ? null : v)

const tierRank = (tier) => {
  if (!tier) return 999
  if (/highest/i.test(tier)) return 0
  const m = /gold\D*(\d+)/i.exec(tier)
  return m ? Number(m[1]) : 500
}

export async function loadContext(store) {
  const [accountsDoc, insightsDoc, stars, config] = await Promise.all([store.getAccounts(), store.getInsights(), store.getStars(), store.getConfig()])
  const accounts = (accountsDoc && accountsDoc.accounts) || []
  return {
    accountsDoc, accounts, index: buildAccountIndex(accounts), byId: new Map(accounts.map((a) => [a.id, a])),
    items: (insightsDoc && insightsDoc.items) || [], stars: stars || {}, config,
    stateTable: (config && config.stateTable) || PACK_STATE_TABLE,
  }
}

// ---------- importing ----------

export async function importRecords({ store, source, records, user, now = new Date() }) {
  if (!['alerts', 'updates', 'accounts'].includes(source)) throw new Error('Unknown import source. Use alerts, updates or accounts.')
  if (!Array.isArray(records) || !records.length) throw new Error('There are no records in that file.')
  if (records.length > 2000) throw new Error('That is more than 2,000 records. Split the file and import it in parts.')
  const ctx = await loadContext(store)
  const entry = { at: new Date(now).toISOString(), by: (user && user.email) || null, source, received: records.length, added: 0, updated: 0, skipped: 0, matched: 0, ambiguous: 0, unmatched: 0, notes: [] }

  if (source === 'accounts') {
    // The saved accounts in the earlier tool are not copied in. HubSpot is the source of truth. This only reports how many
    // of them HubSpot already knows, so nothing is lost silently.
    for (const r of records) {
      const m = matchOrg(r.name, r.state, ctx.index)
      if (m.status === 'matched') entry.matched++; else if (m.status === 'ambiguous') entry.ambiguous++; else entry.unmatched++
    }
    entry.notes.push('Accounts are reported, not copied. HubSpot stays the source of truth.')
    if (!ctx.accounts.length) entry.notes.push('HubSpot accounts are not loaded yet, so none could be matched. Refresh from HubSpot first, then import again.')
    await store.appendImportLog(entry)
    return entry
  }

  const adapt = source === 'alerts' ? fromAlert : fromUpdate
  const have = new Map(ctx.items.map((i) => [i.id, i]))
  const next = ctx.items.slice()
  for (const r of records) {
    const ok = source === 'alerts' ? (r._id || r.id) && (r.title || r.org) : r.id && r.title
    if (!ok) { entry.skipped++; continue }
    const ins = adapt(r)
    const m = source === 'alerts' ? matchOrg(ins.org, ins.states[0], ctx.index) : (ins.level === 'federal' ? { status: 'none' } : matchTitle(ins.title, ins.states, ctx.index))
    if (m.status === 'matched') entry.matched++; else if (m.status === 'ambiguous') entry.ambiguous++; else entry.unmatched++
    if (have.has(ins.id)) { next[next.findIndex((x) => x.id === ins.id)] = ins; entry.updated++ } else { next.push(ins); entry.added++ }
  }
  if (!ctx.accounts.length) entry.notes.push('HubSpot accounts are not loaded yet, so matching will show up after the first refresh.')
  await store.putInsights({ version: 1, updatedAt: entry.at, items: next })
  await store.appendImportLog(entry)
  return entry
}

// ---------- the merged view ----------

export function buildInsightView(ctx, { now = new Date(), bdr = null, type = null, days = null } = {}) {
  const today = etDate(now)
  const merged = mergeInsights(ctx.items)
  const out = []
  for (const m of merged) {
    const match = m.origin === 'account-intelligence' ? matchOrg(m.org, m.states[0], ctx.index) : (m.level === 'federal' ? { status: 'none', accountId: null, candidates: [] } : matchTitle(m.title, m.states, ctx.index))
    const acct = match.accountId ? ctx.byId.get(match.accountId) : null
    const target = acct ? isTarget(targetReasons(acct, ctx.stars)) : false
    const own = acct ? effectiveBdr(acct, ctx.stars, ctx.stateTable) : { bdr: ctx.stateTable[m.states[0]] || null, source: m.states[0] ? 'state table' : null }
    const sc = scoreInsight(m, { today, isTarget: target })
    // Only an event that has already happened should carry the date of the event. An announcement of something later
    // (an opening, a closing date, a law taking effect) is allowed to be dated earlier than the day it happens.
    const hint = /complet|closed|definitive|signed|final/i.test(m.dealStatus || '') ? summaryDateHint(m.whatHappened, m.published, today) : null
    const row = {
      ...m, ...sc, merged: m.mergedIds.length + 1, dateConflict: hint, bdr: own.bdr, bdrSource: own.source,
      account: acct ? { id: acct.id, name: acct.name, state: acct.state, isTarget: target, reasons: targetReasons(acct, ctx.stars) } : null, match: { status: match.status, candidates: match.candidates || [], via: match.via || null },
      serviceLines: serviceLinesOf(m), eventClass: classOf(m), phase: phaseOf(m), fourPart: fourPartOf(m), productFit: productFit(m),
    }
    if (bdr && bdr !== 'all' && row.bdr !== bdr) continue
    if (type && row.type !== type) continue
    if (days && row.ageDays != null && row.ageDays > days) continue
    out.push(row)
  }
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(b.published).localeCompare(String(a.published)))
}

export function buildAccountView(ctx, { bdr = null, targets = false, bdrLed = false, q = '', state = null, limit = 300, offset = 0 } = {}) {
  const needle = String(q || '').trim().toLowerCase()
  const st = state ? normState(state) : null
  const rows = []
  const byBdr = {}
  let targetCount = 0, pending = 0, bdrLedOnly = 0, bdrLedInView = 0
  for (const a of ctx.accounts) {
    const own = effectiveBdr(a, ctx.stars, ctx.stateTable)
    const reasons = targetReasons(a, ctx.stars)
    const size = sizeOf(a)
    byBdr[own.bdr || 'none'] = (byBdr[own.bdr || 'none'] || 0) + 1
    const target = isTarget(reasons)
    if (target) { targetCount++; if (size.status !== 'ok') pending++ } else if (reasons.includes('bdr_led')) bdrLedOnly++
    if (bdr && bdr !== 'all') { if (bdr === 'none' ? own.bdr : own.bdr !== bdr) continue }
    if (!target && reasons.includes('bdr_led')) bdrLedInView++ // counted for the BDR being viewed, so the checkbox says what ticking it adds
    if (targets && !isTarget(reasons, { bdrLed })) continue
    if (st && a.state !== st) continue
    if (needle && !a.name.toLowerCase().includes(needle)) continue
    rows.push({
      id: a.id, name: a.name, state: a.state, stateRaw: a.stateRaw, city: a.city, domain: a.domain, bdr: own.bdr, bdrSource: own.source, tier: a.tier, bdrLed: a.bdrLed, reasons,
      starred: !!(ctx.stars[a.id] && ctx.stars[a.id].star), size, contacts: a.contacts, deals: a.deals, lastContacted: a.lastContacted, definitiveId: a.definitiveId,
    })
  }
  rows.sort((x, y) => (y.reasons.length ? 1 : 0) - (x.reasons.length ? 1 : 0) || tierRank(x.tier) - tierRank(y.tier) || (y.size.er || 0) - (x.size.er || 0) || x.name.localeCompare(y.name))
  return { total: rows.length, rows: rows.slice(offset, offset + limit), counts: { accounts: ctx.accounts.length, targets: targetCount, bdrLedOnly, bdrLedInView, targetsMissingSize: pending, byBdr } }
}

// ---------- filtering the feed ----------

export function filterInsights(items, { type = null, days = null, state = null, line = null, q = '', openOnly = false } = {}) {
  const st = state ? normState(state) : null
  const needle = String(q || '').trim().toLowerCase()
  return items.filter((i) => (!type || i.type === type) && (!days || i.ageDays == null || i.ageDays <= days) && (!st || i.states.includes(st)) && (!line || i.serviceLines.includes(line))
    && (!openOnly || (i.window && (i.window.status === 'open' || i.window.status === 'closing'))) && (!needle || `${i.title} ${i.org || ''} ${i.whatHappened}`.toLowerCase().includes(needle)))
}

// What the filters can offer, counted over everything in scope, so a choice that would show nothing is easy to see.
// A solution is thin when few cards are truly about it (its lead news, or news on its own subject): fewer than this many, or fewer
// than a quarter of what the best covered solution has. The screen says so rather than padding it out.
export const THIN_BELOW = 10
export const THIN_SHARE = 0.25

export function facetsOf(items) {
  const states = {}, lines = {}, types = {}
  const prod = Object.fromEntries(PRODUCT_NAMES.map((p) => [p, { lead: 0, also: 0, theme: 0, open: 0 }]))
  for (const i of items) {
    for (const s of i.states) states[s] = (states[s] || 0) + 1
    for (const l of i.serviceLines) lines[l] = (lines[l] || 0) + 1
    types[i.type] = (types[i.type] || 0) + 1
    const open = !!(i.window && (i.window.status === 'open' || i.window.status === 'closing'))
    for (const f of i.productFit || []) { prod[f.product][f.role]++; if (open) prod[f.product].open++ }
  }
  const evidence = (n) => prod[n].lead + prod[n].theme
  const best = Math.max(0, ...PRODUCT_NAMES.map(evidence))
  return { states, types, lines: SERVICE_LINES.map((l) => ({ ...l, count: lines[l.key] || 0 })),
    products: PRODUCT_NAMES.map((name) => ({ name, ...prod[name], searchFor: PRODUCT_KIT.find((k) => k.name === name).searchFor, evidence: evidence(name), thin: evidence(name) < THIN_BELOW || evidence(name) < best * THIN_SHARE })) }
}

// ---------- ED and competitive: the timeline and the state view ----------

const TIMELINE_CLASSES = ['deal', 'closure', 'new_site', 'ed_flow']
const names = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`)
const QUESTION = {
  deal: (n) => `Could this change where patients and referrals go for ${n}?`,
  closure: (n) => `Could this shift ED volume to ${n}?`, ed_flow: (n) => `Could this shift ED volume to ${n}?`,
  new_site: (n) => `Could this draw low acuity volume and referrals away from ${n}?`,
}

// Deals, closures, new sites and ED volume news, newest first and grouped by month. A pending deal is Watch. Beside each
// event are the Gold and starred accounts in the same state, framed as a question because a source rarely confirms impact.
// News carries no city, so this is a state view, not a metro view.
export function buildCompetitiveView(ctx, { bdr = null, state = null, kind = null, phase = null, now = new Date() } = {}) {
  const st = state ? normState(state) : null
  const all = buildInsightView(ctx, { now, bdr }).filter((i) => TIMELINE_CLASSES.includes(i.eventClass))
  const facets = { states: {}, kinds: {}, phases: {} }
  for (const i of all) {
    for (const s of i.states) facets.states[s] = (facets.states[s] || 0) + 1
    facets.kinds[i.eventClass] = (facets.kinds[i.eventClass] || 0) + 1
    facets.phases[i.phase] = (facets.phases[i.phase] || 0) + 1
  }
  const rows = all.filter((i) => (!st || i.states.includes(st)) && (!kind || i.eventClass === kind) && (!phase || i.phase === phase))
  const byState = new Map()
  for (const a of ctx.accounts) {
    if (!a.state) continue
    const own = effectiveBdr(a, ctx.stars, ctx.stateTable)
    if (bdr && bdr !== 'all' && own.bdr !== bdr) continue
    if (!isTarget(targetReasons(a, ctx.stars))) continue
    if (!byState.has(a.state)) byState.set(a.state, [])
    byState.get(a.state).push(a)
  }
  for (const list of byState.values()) list.sort((x, y) => (sizeOf(y).er || 0) - (sizeOf(x).er || 0) || x.name.localeCompare(y.name))
  const events = rows.map((i) => {
    const near = []
    for (const s of i.states) for (const a of byState.get(s) || []) if (!(i.account && i.account.id === a.id) && !near.some((n) => n.id === a.id)) near.push(a)
    const top = near.slice(0, 4).map((a) => ({ id: a.id, name: a.name, state: a.state }))
    return { ...i, nearby: { total: near.length, accounts: top, states: i.states, question: top.length ? QUESTION[i.eventClass](names(top.map((a) => a.name))) : null } }
  }).sort((a, b) => String(b.published).localeCompare(String(a.published)) || (b.score ?? 0) - (a.score ?? 0))
  const months = []
  for (const e of events) {
    const k = monthKey(e.published)
    let m = months[months.length - 1]
    if (!m || m.key !== k) { m = { key: k, label: monthLabel(k), events: [] }; months.push(m) }
    m.events.push(e)
  }
  const stateView = st ? { state: st, accounts: (byState.get(st) || []).slice(0, 12).map((a) => { const sz = sizeOf(a); return { id: a.id, name: a.name, city: a.city, er: sz.er, sizeStatus: sz.status } }), accountTotal: (byState.get(st) || []).length, events: rows.length, watch: rows.filter((r) => r.phase === 'watch').length, closed: rows.filter((r) => r.phase === 'closed').length } : null
  return { months, summary: { events: events.length, watch: events.filter((e) => e.phase === 'watch').length, closed: events.filter((e) => e.phase === 'closed').length, byKind: events.reduce((m, e) => { m[e.eventClass] = (m[e.eventClass] || 0) + 1; return m }, {}) }, facets, stateView }
}

// ---------- the article analyzer ----------

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })
const userKey = (user) => (user && (user.sub || user.email)) || 'unknown'

export async function aiStatus({ store, d, user, now = new Date() }) {
  const day = etDate(now), doc = await store.getAiUsage()
  return {
    enabled: !d.aiOff && !!d.claude, reason: d.aiOff ? 'The analyzer is switched off (MARKET_INTEL_AI).' : !d.claude ? 'The analyzer needs ANTHROPIC_API_KEY set in Netlify.' : null,
    model: d.model, limitPerDay: d.aiLimit, usedToday: usedToday(doc, day, userKey(user)), month: summarizeUsage(doc, day, d.prices || {}),
    note: 'Cost is an estimate from token counts, at the rates set for the model.',
  }
}

const dupSummary = (i) => ({ id: i.id, title: i.title, org: i.org || null, published: i.published || null, source: (i.sources && i.sources[0]) || null })

// Reads one pasted article with Claude and returns what it found, as a card ready to save. Nothing is saved here.
export async function runAnalyzer({ store, d, user, body, now = new Date() }) {
  if (d.aiOff || !d.claude) throw fail(503, d.aiOff ? 'The article analyzer is switched off.' : 'The article analyzer is not set up. ANTHROPIC_API_KEY is missing in Netlify.')
  const text = String((body && body.text) || '').trim(), url = String((body && body.url) || '').trim()
  if (text.length < MIN_TEXT) throw fail(400, `Paste the article text, at least a short paragraph (${MIN_TEXT} characters), so Claude has facts to use. A headline alone is not enough.`)
  if (!/^https?:\/\/\S+\.\S+/.test(url)) throw fail(400, 'Add the link to the original announcement so the card can point back to its source.')
  const day = etDate(now), uid = userKey(user)
  if (usedToday(await store.getAiUsage(), day, uid) >= d.aiLimit) throw fail(429, `You have used your ${d.aiLimit} analyses for today. It resets tomorrow.`)
  let result
  try { result = await analyzeArticle({ claude: d.claude, model: d.model, text, url }) } catch (err) {
    if (/readable answer|clear announcement/.test(String(err && err.message))) throw fail(422, err.message)
    throw fail(502, 'Claude could not be reached right now. Try again in a minute.')
  }
  await store.updateAiUsage((doc) => addUsage(doc, { day, uid, input: result.usage.input, output: result.usage.output }))
  const record = toRecord(result.analysis, { url, sourceName: body.sourceName, date: body.date, user, now })
  const ctx = await loadContext(store)
  const id = `ai:${record._id}`
  const dup = ctx.items.filter((i) => i.id !== id).find((i) => isDuplicateNews({ title: record.title, org: record.org, url }, i))
  const savable = result.analysis.relevant && SAVABLE.includes(record.cat)
  let preview = null
  if (savable) { const ins = fromAlert(record); preview = buildInsightView({ ...ctx, items: [...ctx.items.filter((i) => i.id !== ins.id), ins] }, { now }).find((r) => r.id === ins.id) || null }
  return {
    analysis: result.analysis, record, savable, preview, duplicate: dup ? dupSummary(dup) : null, truncated: text.length > MAX_TEXT, read: { chars: text.length, words: text.split(/\s+/).filter(Boolean).length },
    notSavable: savable ? null : 'This does not look like a tracked kind of news: an ED change, a deal, a leadership change, hospital growth, a readmissions or post acute story, or a referral, payment or coverage story. It was not added.',
    usage: { input: result.usage.input, output: result.usage.output, model: result.model },
  }
}

// Saves an analyzed article to the feed. The record comes back from the browser, so it is rebuilt from allowed fields only,
// and the person saving is taken from their sign in, never from what the page says.
export async function saveAnalysis({ store, user, body, now = new Date() }) {
  const record = cleanRecord(body && body.record, user)
  record.date = record.date || etDate(now)
  const ctx = await loadContext(store)
  const id = `ai:${record._id}`
  const dup = ctx.items.filter((i) => i.id !== id).find((i) => isDuplicateNews({ title: record.title, org: record.org, url: record.sourceUrl }, i))
  if (dup && !(body && body.force === true)) throw fail(409, 'This looks like news that is already in the feed.', { duplicate: dupSummary(dup) })
  const entry = await importRecords({ store, source: 'alerts', records: [record], user, now })
  return { id, replaced: entry.updated > 0, entry }
}

// ---------- the map ----------

// One pin per account that can be placed. Accounts whose city is not known are counted, not guessed at. Pins are
// largest first, and capped so a broad view cannot flood the screen.
export function buildMapView(ctx, { bdr = null, targets = true, bdrLed = false, alertsOnly = false, state = null, now = new Date(), limit = 700 } = {}) {
  const st = state ? normState(state) : null
  const recent = new Map()
  for (const v of buildInsightView(ctx, { now })) {
    if (!v.account || v.match.via === 'title' || v.ageDays == null || v.ageDays > 30) continue
    const cur = recent.get(v.account.id) || { count: 0, best: null }
    cur.count++
    if (v.window && ['open', 'closing'].includes(v.window.status)) cur.best = cur.best == null ? v.score : Math.max(cur.best, v.score ?? 0)
    recent.set(v.account.id, cur)
  }
  const pins = []
  let unplaced = 0, inScope = 0
  const missed = []
  const stateStats = {}
  for (const a of ctx.accounts) {
    const own = effectiveBdr(a, ctx.stars, ctx.stateTable)
    const reasons = targetReasons(a, ctx.stars)
    if (bdr && bdr !== 'all' && (bdr === 'none' ? own.bdr : own.bdr !== bdr)) continue
    if (targets && !isTarget(reasons, { bdrLed })) continue
    if (st && a.state !== st) continue
    if (a.state) { const s = (stateStats[a.state] = stateStats[a.state] || { accounts: 0, alerts: 0 }); s.accounts++; if (recent.has(a.id)) s.alerts++ }
    if (alertsOnly && !recent.has(a.id)) continue
    inScope++
    const pos = locate(a.city, a.state)
    if (!pos) { unplaced++; if (missed.length < 400) missed.push({ id: a.id, name: a.name, city: a.city || null, state: a.state, target: isTarget(reasons) }); continue }
    const size = sizeOf(a)
    pins.push({ id: a.id, name: a.name, state: a.state, city: a.city, x: pos.x, y: pos.y, bdr: own.bdr, reasons, tier: a.tier, er: size.er, beds: size.beds, sizeStatus: size.status, alerts: recent.has(a.id) ? recent.get(a.id).count : 0, window: recent.has(a.id) ? recent.get(a.id).best : null })
  }
  pins.sort((p, q) => (q.alerts ? 1 : 0) - (p.alerts ? 1 : 0) || (q.er || 0) - (p.er || 0) || p.name.localeCompare(q.name))
  const perBdr = {}
  for (const p of pins) perBdr[p.bdr] = (perBdr[p.bdr] || 0) + 1
  // The accounts that cannot be placed, Gold ones first, so the city can be fixed in HubSpot.
  const unplacedList = missed.sort((x, y) => Number(y.target) - Number(x.target) || x.name.localeCompare(y.name)).slice(0, 10).map(({ id, name, city, state }) => ({ id, name, city, state }))
  return { pins: pins.slice(0, limit), total: pins.length, truncated: pins.length > limit, unplaced, unplacedList, perBdr, inScope, stateOwner: ctx.stateTable, stateStats }
}

// ---------- one account ----------

// Everything on one account: its HubSpot fields, the news matched to it, related records, and the part of the score that
// has data today. The score is deliberately partial: trigger and target are real, size has data but no rule yet, and the
// rest wait for Phases 4 and 5.
export function buildAccountDetail(ctx, id, { now = new Date() } = {}) {
  const a = ctx.byId.get(String(id))
  if (!a) return null
  const own = effectiveBdr(a, ctx.stars, ctx.stateTable)
  const reasons = targetReasons(a, ctx.stars)
  const size = sizeOf(a)
  const news = buildInsightView(ctx, { now }).filter((v) => v.account && v.account.id === a.id)
  const key = nameKey(a.name)
  const others = key ? ctx.accounts.filter((x) => x.id !== a.id && nameKey(x.name) === key).slice(0, 8).map((x) => ({ id: x.id, name: x.name, state: x.state || x.stateRaw, bdr: x.bdr })) : []
  const parent = a.parentId && ctx.byId.get(a.parentId)
  const trigger = news.some((n) => n.match.via !== 'title' && n.ageDays != null && n.ageDays <= 90) ? 20 : 0
  const target = isTarget(reasons) ? 5 : 0
  const names = (ctx.accountsDoc && ctx.accountsDoc.ownerNames) || {}
  return {
    account: { id: a.id, name: a.name, domain: a.domain, city: a.city, state: a.state, stateRaw: a.stateRaw, bdr: own.bdr, bdrSource: own.source, tier: a.tier, bdrLed: a.bdrLed, reasons, starred: !!(ctx.stars[a.id] && ctx.stars[a.id].star),
      size: { ...size, discharges: a.size && a.size.discharges, npr: a.size && a.size.npr }, contacts: a.contacts, deals: a.deals, lastContacted: a.lastContacted, definitiveId: a.definitiveId, territoryHs: a.territoryHs, ownerName: a.ownerId ? names[a.ownerId] || null : null },
    parent: parent ? { id: parent.id, name: parent.name } : null,
    children: ctx.accounts.filter((x) => x.parentId === a.id).slice(0, 25).map((x) => ({ id: x.id, name: x.name, state: x.state })),
    otherRecords: others,
    news: news.slice(0, 25),
    score: { trigger, target, scored: trigger + target, of: 100, size: { status: size.status === 'ok' ? 'ready' : size.status, er: size.er, beds: size.beds },
      waiting: ['Competitive pressure nearby', 'Readmission penalty', 'Priority service lines', 'Value based exposure', 'Integration readiness'] },
  }
}

export const withContacts = (detail, result, error) => ({ ...detail, contacts: result ? { total: result.total, shown: result.contacts.length, list: result.contacts.slice(0, 12), coverage: personaCoverage(result.contacts) } : null, contactsError: error || null })

// ---------- the home screen ----------

export function buildHomeView(ctx, { bdr = null, now = new Date() } = {}) {
  const items = buildInsightView(ctx, { now, bdr })
  const live = items.filter((i) => i.window && (i.window.status === 'open' || i.window.status === 'closing'))
  const closing = live.filter((i) => i.window.status === 'closing')
  const best = live.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.window.daysLeft - b.window.daysLeft).slice(0, 5)
  const watch = items.filter((i) => i.origin === 'front-door-radar' && ['competitive', 'ed_driver'].includes(i.type)).sort((a, b) => String(b.published).localeCompare(String(a.published))).slice(0, 4)
  let targets = 0, missing = 0
  for (const a of ctx.accounts) {
    const own = effectiveBdr(a, ctx.stars, ctx.stateTable)
    if (bdr && bdr !== 'all' && own.bdr !== bdr) continue
    const r = targetReasons(a, ctx.stars)
    if (isTarget(r)) { targets++; if (sizeOf(a).status !== 'ok') missing++ }
  }
  return { tiles: { windowsOpen: live.length, withWindow: items.filter((i) => i.window).length, closing: closing.map((i) => ({ id: i.id, org: i.org, daysLeft: i.window.daysLeft })), topScore: best[0] ? { score: best[0].score, org: best[0].org } : null, targets, targetsMissingSize: missing }, best, watch }
}

// ---------- stars and assignments ----------

export async function setStar({ store, user, accountId, star, assignTo }) {
  const accounts = (await store.getAccounts()) || { accounts: [] }
  if (!accounts.accounts.some((a) => a.id === String(accountId))) throw new Error('That account is not in the HubSpot list. Refresh from HubSpot first.')
  if (star === undefined && assignTo === undefined) throw new Error('Say what to change: star, or assignTo.')
  let who
  if (assignTo !== undefined && assignTo !== null) { who = resolveBdr(assignTo); if (!who) throw new Error('assignTo must be one of the four BDRs, or null to clear it.') }
  const at = new Date().toISOString()
  return store.updateStars((s) => {
    const cur = s[accountId] || { star: false, assignedBdr: null }
    const next = { ...cur }
    if (star !== undefined) next.star = !!star
    if (assignTo !== undefined) next.assignedBdr = assignTo === null ? null : who
    next.by = (user && user.email) || null
    next.at = at
    const out = { ...s }
    if (!next.star && !next.assignedBdr) delete out[accountId]
    else out[accountId] = next
    return out
  })
}

// ---------- refreshing accounts from HubSpot, a step at a time ----------

export async function refreshStep({ store, hubspot, userId, user, now = () => Date.now(), budgetMs = 18000, restart = false }) {
  let state = await store.getRefreshState()
  let staging = null
  if (!state || state.done || restart) {
    state = { startedAt: new Date(now()).toISOString(), by: (user && user.email) || null, cursor: null, pages: 0, count: 0, total: null, done: false }
    staging = { accounts: [] }
  } else {
    staging = (await store.getStaging()) || { accounts: [] }
  }
  const got = await hubspot.fetchSome(userId, { cursor: state.cursor, budgetMs })
  const seen = new Set(staging.accounts.map((a) => a.id))
  for (const a of got.accounts) if (!seen.has(a.id)) { staging.accounts.push(a); seen.add(a.id) }
  state.cursor = got.cursor
  state.pages += got.pages
  state.count = staging.accounts.length
  state.total = got.total ?? state.total
  if (!got.cursor) {
    const ownerNames = await hubspot.fetchOwners(userId)
    const finishedAt = new Date(now()).toISOString()
    await store.putAccounts({ version: 1, refreshedAt: finishedAt, by: state.by, count: staging.accounts.length, ownerNames, accounts: staging.accounts })
    state.done = true
    state.finishedAt = finishedAt
    await store.putStaging({ accounts: [] })
  } else {
    await store.putStaging(staging)
  }
  await store.putRefreshState(state)
  return { done: state.done, count: state.count, total: state.total, pages: state.pages, finishedAt: state.finishedAt || null }
}

// ---------- the state to BDR table ----------

export async function saveStateTable({ store, csv, user }) {
  const parsed = parseStateTable(csv)
  if (parsed.errors.length) return { ok: false, errors: parsed.errors.slice(0, 20), count: parsed.count }
  if (parsed.count < 10) return { ok: false, errors: [`Only ${parsed.count} states were found. A full table has about 50. Nothing was saved.`], count: parsed.count }
  const cfg = (await store.getConfig()) || {}
  await store.putConfig({ ...cfg, stateTable: { ...PACK_STATE_TABLE, ...parsed.table }, stateTableSavedAt: new Date().toISOString(), stateTableBy: (user && user.email) || null, stateTableRows: parsed.count })
  return { ok: true, count: parsed.count, errors: [] }
}

// ---------- Data health ----------

// Cards that may be the same event even after the merge: the same source link, or a headline that is mostly the same words.
function possibleDuplicates(view) {
  const out = []
  for (let a = 0; a < view.length && out.length < 15; a++) for (let b = a + 1; b < view.length && out.length < 15; b++) {
    if (isDuplicateNews(view[a], view[b])) out.push({ a: { id: view[a].id, title: view[a].title, org: view[a].org }, b: { id: view[b].id, title: view[b].title, org: view[b].org } })
  }
  return out
}

export async function buildHealth(ctx, { store, now = new Date() } = {}) {
  const today = etDate(now)
  const view = buildInsightView(ctx, { now })
  const unmatched = view.filter((v) => v.match.status === 'none' && v.level !== 'federal').map((v) => ({ id: v.id, title: v.title, org: v.org, states: v.states, origin: v.origin }))
  const ambiguous = view.filter((v) => v.match.status === 'ambiguous').map((v) => ({ id: v.id, title: v.title, org: v.org, states: v.states, candidates: v.match.candidates.map((id) => { const a = ctx.byId.get(id); return a ? { id, name: a.name, state: a.state, bdr: a.bdr } : { id } }) }))
  const dateConflicts = view.filter((v) => v.dateConflict).map((v) => ({ id: v.id, title: v.title, recorded: v.dateConflict.recorded, summarySays: v.dateConflict.text, hint: v.dateConflict.hint, origin: v.origin }))
  const accounts = ctx.accounts
  const dups = findDuplicates(accounts)
  const withSize = accounts.filter((a) => sizeOf(a).status === 'ok').length
  const [importLog, refresh] = store ? await Promise.all([store.getImportLog(), store.getRefreshState()]) : [[], null]
  return {
    today,
    accounts: {
      count: accounts.length, refreshedAt: (ctx.accountsDoc && ctx.accountsDoc.refreshedAt) || null, refreshedBy: (ctx.accountsDoc && ctx.accountsDoc.by) || null,
      withBdr: accounts.filter((a) => resolveBdr(a.bdr)).length, withSize, targets: accounts.filter((a) => isTarget(targetReasons(a, ctx.stars))).length,
      bdrLedOnly: accounts.filter((a) => { const r = targetReasons(a, ctx.stars); return r.includes('bdr_led') && !isTarget(r) }).length,
      byBdr: Object.fromEntries(BDRS.map((b) => [b.key, accounts.filter((a) => resolveBdr(a.bdr) === b.key).length])),
      targetsPendingSize: pendingSize(accounts, ctx.stars).slice(0, 60),
    },
    duplicates: dups.groups.slice(0, 40).map((d) => ({ ...d, ids: d.ids.slice(0, 8) })), duplicatesHidden: dups.hiddenCommon,
    insights: {
      count: view.length, raw: ctx.items.length, merged: view.filter((v) => v.merged > 1).length,
      byOrigin: ctx.items.reduce((m, i) => { m[i.origin] = (m[i.origin] || 0) + 1; return m }, {}),
      matched: view.filter((v) => v.match.status === 'matched').length, ambiguous, unmatched, dateConflicts,
      unsourced: view.filter((v) => !v.fourPart.sourced).slice(0, 20).map((v) => ({ id: v.id, title: v.title, org: v.org, origin: v.origin })),
      possibleDuplicates: possibleDuplicates(view), byProduct: facetsOf(view).products,
    },
    stateTable: ctx.config && ctx.config.stateTable ? { source: 'saved', rows: ctx.config.stateTableRows ?? null, savedAt: clean(ctx.config.stateTableSavedAt), by: clean(ctx.config.stateTableBy) } : { source: 'built in', rows: Object.keys(PACK_STATE_TABLE).length, savedAt: null, by: null },
    importLog: (importLog || []).slice(0, 8), refresh,
  }
}
