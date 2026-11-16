// netlify/functions/utils/intelService.js
//
// What Market Intel does, kept apart from the HTTP handler so each piece can be tested with fakes.
//
// Raw records are stored as they were imported, and the merged view (which items are the same event, which HubSpot
// account each one belongs to, scores, owners) is worked out when someone asks. So changing a matching rule never
// needs a re-import, and a new HubSpot refresh is picked up straight away.

import {
  BDRS, PACK_STATE_TABLE, normState, resolveBdr, sizeOf, targetReasons, effectiveBdr, buildAccountIndex, matchOrg, matchTitle,
  findDuplicates, pendingSize, parseStateTable, fromAlert, fromUpdate, mergeInsights, scoreInsight, summaryDateHint,
} from './intelSchema.js'

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
    const isTarget = acct ? targetReasons(acct, ctx.stars).length > 0 : false
    const own = acct ? effectiveBdr(acct, ctx.stars, ctx.stateTable) : { bdr: ctx.stateTable[m.states[0]] || null, source: m.states[0] ? 'state table' : null }
    const sc = scoreInsight(m, { today, isTarget })
    // Only an event that has already happened should carry the date of the event. An announcement of something later
    // (an opening, a closing date, a law taking effect) is allowed to be dated earlier than the day it happens.
    const hint = /complet|closed|definitive|signed|final/i.test(m.dealStatus || '') ? summaryDateHint(m.whatHappened, m.published, today) : null
    const row = {
      ...m, ...sc, merged: m.mergedIds.length + 1, dateConflict: hint, bdr: own.bdr, bdrSource: own.source,
      account: acct ? { id: acct.id, name: acct.name, state: acct.state, isTarget, reasons: targetReasons(acct, ctx.stars) } : null, match: { status: match.status, candidates: match.candidates || [], via: match.via || null },
    }
    if (bdr && bdr !== 'all' && row.bdr !== bdr) continue
    if (type && row.type !== type) continue
    if (days && row.ageDays != null && row.ageDays > days) continue
    out.push(row)
  }
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(b.published).localeCompare(String(a.published)))
}

export function buildAccountView(ctx, { bdr = null, targets = false, q = '', state = null, limit = 300, offset = 0 } = {}) {
  const needle = String(q || '').trim().toLowerCase()
  const st = state ? normState(state) : null
  const rows = []
  const byBdr = {}
  let targetCount = 0, pending = 0
  for (const a of ctx.accounts) {
    const own = effectiveBdr(a, ctx.stars, ctx.stateTable)
    const reasons = targetReasons(a, ctx.stars)
    const size = sizeOf(a)
    byBdr[own.bdr || 'none'] = (byBdr[own.bdr || 'none'] || 0) + 1
    if (reasons.length) { targetCount++; if (size.status !== 'ok') pending++ }
    if (bdr && bdr !== 'all') { if (bdr === 'none' ? own.bdr : own.bdr !== bdr) continue }
    if (targets && !reasons.length) continue
    if (st && a.state !== st) continue
    if (needle && !a.name.toLowerCase().includes(needle)) continue
    rows.push({
      id: a.id, name: a.name, state: a.state, stateRaw: a.stateRaw, city: a.city, domain: a.domain, bdr: own.bdr, bdrSource: own.source, tier: a.tier, bdrLed: a.bdrLed, reasons,
      starred: !!(ctx.stars[a.id] && ctx.stars[a.id].star), size, contacts: a.contacts, deals: a.deals, lastContacted: a.lastContacted, definitiveId: a.definitiveId,
    })
  }
  rows.sort((x, y) => (y.reasons.length ? 1 : 0) - (x.reasons.length ? 1 : 0) || tierRank(x.tier) - tierRank(y.tier) || (y.size.er || 0) - (x.size.er || 0) || x.name.localeCompare(y.name))
  return { total: rows.length, rows: rows.slice(offset, offset + limit), counts: { accounts: ctx.accounts.length, targets: targetCount, targetsMissingSize: pending, byBdr } }
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
      withBdr: accounts.filter((a) => resolveBdr(a.bdr)).length, withSize, targets: accounts.filter((a) => targetReasons(a, ctx.stars).length).length,
      byBdr: Object.fromEntries(BDRS.map((b) => [b.key, accounts.filter((a) => resolveBdr(a.bdr) === b.key).length])),
      targetsPendingSize: pendingSize(accounts, ctx.stars).slice(0, 60),
    },
    duplicates: dups.groups.slice(0, 40).map((d) => ({ ...d, ids: d.ids.slice(0, 8) })), duplicatesHidden: dups.hiddenCommon,
    insights: {
      count: view.length, raw: ctx.items.length, merged: view.filter((v) => v.merged > 1).length,
      byOrigin: ctx.items.reduce((m, i) => { m[i.origin] = (m[i.origin] || 0) + 1; return m }, {}),
      matched: view.filter((v) => v.match.status === 'matched').length, ambiguous, unmatched, dateConflicts,
    },
    stateTable: ctx.config && ctx.config.stateTable ? { source: 'saved', rows: ctx.config.stateTableRows ?? null, savedAt: clean(ctx.config.stateTableSavedAt), by: clean(ctx.config.stateTableBy) } : { source: 'built in', rows: Object.keys(PACK_STATE_TABLE).length, savedAt: null, by: null },
    importLog: (importLog || []).slice(0, 8), refresh,
  }
}
