// netlify/functions/utils/intelHubspot.js
//
// Reads the HubSpot companies Market Intel works with. Read only: nothing here writes to HubSpot.
//
// It uses the same per person token files as the rest of Cipher (utils/tokenStore.js) and refreshes them the same way
// hubspot.js does. The refresh button is an admin's, so it runs on that admin's own HubSpot connection.
//
// A company is pulled when ANY of these is filled in: Assigned BDR, Gold tier, BDR led target, Definitive hospital
// count, or Definitive ER visits. That is every company the hub can say something useful about.
//
// Companies come back 200 at a time. fetchSome() keeps going until its time budget is spent and hands back a cursor, so
// a refresh can carry on in the next request instead of running into the function's time limit.

import { normState } from './intelSchema.js'

export const COMPANY_PROPS = [
  'name', 'domain', 'city', 'state', 'assigned_bdr', 'priority_tier__bdr', 'target_account__bdr_led_outreach', 'territory', 'hubspot_owner_id', 'hs_parent_company_id',
  'num_associated_contacts', 'num_associated_deals', 'notes_last_contacted', 'definitive_id',
  'est_of_er_visits__c', 'total_er_visits', 'dhc___of_beds', 'dhc___of_hospitals_in_network', 'dhc___of_discharges', 'dhc_net_patient_revenue',
  'dhc_payer_mix_to_medicare', 'dhc_payor_mix', 'dhc_network_id', 'dhc_parent_network_id', 'dhc_parent_network_name',
]

const FILTER_GROUPS = ['assigned_bdr', 'priority_tier__bdr', 'target_account__bdr_led_outreach', 'dhc___of_hospitals_in_network', 'est_of_er_visits__c']
  .map((propertyName) => ({ filters: [{ propertyName, operator: 'HAS_PROPERTY' }] }))

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const text = (v) => (v == null || v === '' ? null : String(v))

export function mapCompany(rec) {
  const p = rec.properties || {}
  return {
    id: String(rec.id), name: p.name || '', domain: text(p.domain), city: text(p.city), state: normState(p.state), stateRaw: text(p.state),
    bdr: text(p.assigned_bdr), tier: text(p.priority_tier__bdr), bdrLed: text(p.target_account__bdr_led_outreach), territoryHs: text(p.territory),
    ownerId: text(p.hubspot_owner_id), parentId: text(p.hs_parent_company_id), contacts: num(p.num_associated_contacts), deals: num(p.num_associated_deals),
    lastContacted: text(p.notes_last_contacted), definitiveId: text(p.definitive_id),
    size: {
      er: num(p.est_of_er_visits__c) ?? num(p.total_er_visits), beds: num(p.dhc___of_beds), hospitals: num(p.dhc___of_hospitals_in_network), discharges: num(p.dhc___of_discharges),
      npr: num(p.dhc_net_patient_revenue), medicareMix: num(p.dhc_payer_mix_to_medicare), medicaidMix: text(p.dhc_payor_mix),
      networkId: text(p.dhc_network_id), parentNetworkId: text(p.dhc_parent_network_id), parentNetworkName: text(p.dhc_parent_network_name),
    },
  }
}

export class HubspotError extends Error {
  constructor(message, status = 500) { super(message); this.status = status }
}

export function createHubspotReader({ getTokens, setTokens, isTokenValid, clientId, clientSecret, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), api = 'https://api.hubapi.com', now = () => Date.now() }) {
  async function refresh(userId, tokens) {
    if (!clientId || !clientSecret) throw new HubspotError('HubSpot is not configured on the server (HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET).', 500)
    const res = await fetchImpl(`${api}/oauth/v1/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: tokens.hubspot.refresh_token }),
    })
    if (!res.ok) throw new HubspotError('HubSpot refused to renew this connection. Reconnect HubSpot in Cipher, then try again.', 403)
    const d = await res.json()
    const hubspot = { access_token: d.access_token, refresh_token: d.refresh_token || tokens.hubspot.refresh_token, expires_at: now() + d.expires_in * 1000 }
    await setTokens(userId, { hubspot })
    return hubspot
  }

  async function getToken(userId, { forceRefresh = false } = {}) {
    const tokens = await getTokens(userId)
    if (!tokens || !tokens.hubspot || !tokens.hubspot.access_token) throw new HubspotError('HubSpot is not connected for your account. Connect it in Cipher first.', 403)
    if (forceRefresh || !isTokenValid(tokens.hubspot)) return refresh(userId, tokens)
    return tokens.hubspot
  }

  // One request, with a pause and retry for rate limits and server errors, and one token renewal if HubSpot says 401.
  async function call(userId, path, { method = 'GET', body, maxAttempts = 4 } = {}) {
    let renewed = false
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const token = await getToken(userId, { forceRefresh: renewed && attempt > 1 })
      const res = await fetchImpl(`${api}${path}`, {
        method, headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      })
      if (res.ok) return res.json()
      if (res.status === 401 && !renewed) { renewed = true; continue }
      const retryable = res.status === 429 || res.status >= 500
      if (retryable && attempt < maxAttempts) {
        const hinted = Number(res.headers && res.headers.get && res.headers.get('retry-after'))
        await sleep((Number.isFinite(hinted) && hinted > 0 ? hinted : attempt) * 1000)
        continue
      }
      const detail = await res.text().catch(() => '')
      throw new HubspotError(`HubSpot returned ${res.status}. ${detail.slice(0, 200)}`, res.status === 403 ? 403 : 502)
    }
    throw new HubspotError('HubSpot stayed unavailable after several tries.', 502)
  }

  async function searchPage(userId, after) {
    const body = { filterGroups: FILTER_GROUPS, properties: COMPANY_PROPS, sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }], limit: 200 }
    if (after) body.after = after
    const d = await call(userId, '/crm/v3/objects/companies/search', { method: 'POST', body })
    return { results: (d.results || []).map(mapCompany), next: (d.paging && d.paging.next && d.paging.next.after) || null, total: d.total ?? null }
  }

  // Pages until the time budget is spent or there are no more. Returns what it got and where to resume.
  async function fetchSome(userId, { cursor = null, budgetMs = 18000 } = {}) {
    const started = now()
    const accounts = []
    let next = cursor, total = null, pages = 0
    do {
      const page = await searchPage(userId, next)
      accounts.push(...page.results)
      total = page.total ?? total
      next = page.next
      pages += 1
    } while (next && now() - started < budgetMs)
    return { accounts, cursor: next, total, pages }
  }

  // The people at one company: name, title and last contacted, newest contact first. A search, so still read only.
  async function fetchContacts(userId, companyId, { limit = 100 } = {}) {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'associations.company', operator: 'EQ', value: String(companyId) }] }],
      properties: ['firstname', 'lastname', 'jobtitle', 'notes_last_contacted'], sorts: [{ propertyName: 'notes_last_contacted', direction: 'DESCENDING' }], limit,
    }
    const d = await call(userId, '/crm/v3/objects/contacts/search', { method: 'POST', body })
    const contacts = (d.results || []).map((r) => { const p = r.properties || {}; return { id: String(r.id), name: [p.firstname, p.lastname].filter(Boolean).join(' ') || null, title: text(p.jobtitle), lastContacted: text(p.notes_last_contacted) } })
    return { total: d.total ?? contacts.length, contacts }
  }

  async function fetchOwners(userId) {
    try {
      const d = await call(userId, '/crm/v3/owners?limit=500')
      return Object.fromEntries((d.results || []).map((o) => [String(o.id), [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || String(o.id)]))
    } catch (_) {
      return {}
    }
  }

  return { getToken, call, searchPage, fetchSome, fetchOwners, fetchContacts }
}
