// netlify/functions/market-intel.js
//
// The API behind the Market Intel tab, at /api/intel/<route>.
//
//   GET  /status          who you are here (admin or not), the four BDRs, which settings exist
//   GET  /accounts        HubSpot companies for a BDR, with target reasons, size and stars
//   GET  /insights        the news items from the earlier tools, merged, matched to accounts, scored
//   GET  /competitive     deals, closures, new sites and ED volume news as a timeline, with a state view
//   GET  /ai-status       whether the article analyzer is on, and what it has used
//   POST /analyze         read one pasted article with Claude and return a card (saves nothing)
//   POST /analyze/save    save an analyzed article to the feed
//   GET  /home            the home screen for a BDR: windows open, best bets, what is happening nearby
//   GET  /map             accounts placed on the US map, by BDR, with recent news
//   GET  /account?id=     one account: HubSpot fields, its news, related records, contacts, partial score
//   POST /stars           star an account, or assign it to a BDR, inside Cipher (never written to HubSpot)
//   GET  /health          admins only: imports, duplicates, unmatched items, dates that disagree, size gaps
//   POST /refresh         admins only: read HubSpot companies, a step at a time (call again until done)
//   POST /import          admins only: bring in alerts, updates or accounts from the earlier tools
//   POST /state-table     admins only: save the state to BDR table pasted from Excel
//
// Market Intel only ever READS HubSpot. Stars and assignments live in Cipher's own storage.
// To switch it off without a deploy, set MARKET_INTEL to off in Netlify. Every route then answers that it is turned off.

import { withAuth } from './utils/auth.js'
import { isAdmin } from './utils/teamAccess.js'
import { BDRS, resolveBdr } from './utils/intelSchema.js'
import { PRODUCT_KIT } from './utils/intelFeed.js'
import { loadContext, buildInsightView, filterInsights, facetsOf, buildCompetitiveView, aiStatus, runAnalyzer, saveAnalysis, buildAccountView, buildHealth, importRecords, setStar, refreshStep, saveStateTable, buildMapView, buildAccountDetail, buildHomeView, withContacts } from './utils/intelService.js'
import { buildDeps } from './utils/intelDeps.js'

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) })
const parseBody = (event) => { try { return JSON.parse(event.body || '{}') } catch (_) { return null } }
const num = (v, fallback, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback }
const failure = (err) => json(/^(Storage|Could not save|Azure)/.test(String(err && err.message)) ? 500 : (err && err.status) || 400, { error: (err && err.message) || 'Something went wrong' })

export function createHandler(getDeps) {
  return async (event, context) => withAuth(async (event, ctx, user) => {
    const d = await getDeps(ctx)
    const now = d.now ? d.now() : new Date()
    if (d.disabled) return json(503, { error: 'Market Intel is turned off. An admin can switch it back on in Netlify.' })
    const path = (event.path || '').replace(/^.*?\/(?:market-intel|api\/intel)(?=\/|$)/, '') || '/'
    const qp = event.queryStringParameters || {}
    const admin = isAdmin(user, d.access)
    const needAdmin = () => json(403, { error: 'This is for admins only.' })
    const bdrParam = () => (qp.bdr && qp.bdr !== 'all' && qp.bdr !== 'none' ? resolveBdr(qp.bdr) : qp.bdr) || null

    try {
      if (event.httpMethod === 'GET' && path === '/status') {
        const ctx2 = await loadContext(d.store)
        return json(200, {
          admin, portalId: d.portalId, bdrs: BDRS, configured: d.config,
          accountsRefreshedAt: (ctx2.accountsDoc && ctx2.accountsDoc.refreshedAt) || null, accountCount: ctx2.accounts.length, insightCount: ctx2.items.length,
          stateTable: ctx2.config && ctx2.config.stateTable ? 'saved' : 'built in',
        })
      }

      if (event.httpMethod === 'GET' && path === '/accounts') {
        const ctx2 = await loadContext(d.store)
        return json(200, { ...buildAccountView(ctx2, { bdr: bdrParam(), targets: qp.targets === '1', bdrLed: qp.bdrLed === '1', q: qp.q, state: qp.state, limit: num(qp.limit, 300, 500), offset: num(qp.offset, 0, 100000) }), portalId: d.portalId, refreshedAt: (ctx2.accountsDoc && ctx2.accountsDoc.refreshedAt) || null })
      }

      if (event.httpMethod === 'GET' && path === '/home') {
        const ctx2 = await loadContext(d.store)
        return json(200, buildHomeView(ctx2, { bdr: bdrParam(), now }))
      }

      if (event.httpMethod === 'GET' && path === '/map') {
        const ctx2 = await loadContext(d.store)
        return json(200, buildMapView(ctx2, { bdr: bdrParam(), targets: qp.targets !== '0', bdrLed: qp.bdrLed === '1', alertsOnly: qp.alerts === '1', state: qp.state, now }))
      }

      if (event.httpMethod === 'GET' && path === '/account') {
        if (!qp.id) return json(400, { error: 'id is required.' })
        const ctx2 = await loadContext(d.store)
        const detail = buildAccountDetail(ctx2, qp.id, { now })
        if (!detail) return json(404, { error: 'That account is not in the HubSpot list. Refresh from HubSpot first.' })
        // The people come live from HubSpot, on the signed in person's own connection. If that is not possible the panel
        // still opens and says why the contacts are missing.
        let result = null, error = null
        if (d.hubspot && d.hubspot.fetchContacts) {
          try { result = await d.hubspot.fetchContacts(user.userId, qp.id) } catch (err) { error = err && err.status === 403 ? 'HubSpot is not connected for your account, so contacts are not shown.' : 'Contacts could not be loaded from HubSpot right now.' }
        }
        return json(200, withContacts(detail, result, error))
      }

      if (event.httpMethod === 'GET' && path === '/insights') {
        const ctx2 = await loadContext(d.store)
        const base = buildInsightView(ctx2, { now, bdr: bdrParam() })
        const items = filterInsights(base, { type: qp.type || null, days: qp.days ? num(qp.days, null, 3650) : null, state: qp.state || null, line: qp.line || null, q: qp.q || '', openOnly: qp.open === '1' })
        return json(200, { total: items.length, items: items.slice(0, num(qp.limit, 200, 500)), facets: facetsOf(base), products: PRODUCT_KIT })
      }

      if (event.httpMethod === 'GET' && path === '/competitive') {
        const ctx2 = await loadContext(d.store)
        return json(200, buildCompetitiveView(ctx2, { bdr: bdrParam(), state: qp.state || null, kind: qp.kind || null, phase: qp.phase || null, now }))
      }

      if (event.httpMethod === 'GET' && path === '/ai-status') return json(200, await aiStatus({ store: d.store, d, user, now }))

      if (event.httpMethod === 'POST' && path === '/analyze') {
        const body = parseBody(event)
        if (!body) return json(400, { error: 'The request was not valid JSON.' })
        return json(200, await runAnalyzer({ store: d.store, d, user, body, now }))
      }

      if (event.httpMethod === 'POST' && path === '/analyze/save') {
        const body = parseBody(event)
        if (!body) return json(400, { error: 'The request was not valid JSON.' })
        try { return json(200, await saveAnalysis({ store: d.store, user, body, now })) } catch (err) { if (err && err.status === 409) return json(409, { error: err.message, duplicate: err.duplicate }); throw err }
      }

      if (event.httpMethod === 'POST' && path === '/stars') {
        const body = parseBody(event)
        if (!body) return json(400, { error: 'The request was not valid JSON.' })
        if (body.accountId == null) return json(400, { error: 'accountId is required.' })
        const stars = await setStar({ store: d.store, user, accountId: String(body.accountId), star: body.star, assignTo: body.assignTo })
        return json(200, { ok: true, entry: stars[String(body.accountId)] || null })
      }

      if (event.httpMethod === 'GET' && path === '/health') {
        if (!admin) return needAdmin()
        const ctx2 = await loadContext(d.store)
        return json(200, await buildHealth(ctx2, { store: d.store, now }))
      }

      if (event.httpMethod === 'POST' && path === '/refresh') {
        if (!admin) return needAdmin()
        const body = parseBody(event) || {}
        const out = await refreshStep({ store: d.store, hubspot: d.hubspot, userId: user.userId, user, restart: !!body.restart, budgetMs: d.refreshBudgetMs ?? 18000, now: d.nowMs })
        return json(200, out)
      }

      if (event.httpMethod === 'POST' && path === '/import') {
        if (!admin) return needAdmin()
        const body = parseBody(event)
        if (!body) return json(400, { error: 'The request was not valid JSON.' })
        return json(200, await importRecords({ store: d.store, source: body.source, records: body.records, user, now }))
      }

      if (event.httpMethod === 'POST' && path === '/state-table') {
        if (!admin) return needAdmin()
        const body = parseBody(event)
        if (!body || typeof body.csv !== 'string') return json(400, { error: 'Send the table as text in "csv".' })
        const res = await saveStateTable({ store: d.store, csv: body.csv, user })
        return json(res.ok ? 200 : 400, res.ok ? res : { error: res.errors[0], errors: res.errors })
      }

      return json(404, { error: 'Not found' })
    } catch (err) {
      console.error('[market-intel]', path, err && err.message)
      return failure(err)
    }
  })(event, context)
}

let deps
export const handler = createHandler(() => (deps = deps || buildDeps()))
