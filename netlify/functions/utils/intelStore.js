// netlify/functions/utils/intelStore.js
//
// Azure Blob storage for Market Intel, in Cipher's own container, all under intel/.
//
//   intel/accounts.json         the HubSpot companies Market Intel works with, trimmed to the fields it needs
//   intel/accounts-staging.json the same list while a refresh is part way through (becomes accounts.json when done)
//   intel/refresh-state.json    where a refresh is up to, so it can carry on across requests
//   intel/insights.json         every news item, merged, with its match to a HubSpot account
//   intel/stars.json            stars and BDR assignments made inside Cipher
//   intel/config.json           the state to BDR table, once someone saves one
//   intel/import-log.json       one line per import, for the Data health screen
//
// Files that more than one person can change at once (stars, the import log) are updated with Azure's ETag
// conditional writes: read, change, write only if nobody else wrote in between, and retry if they did. This is the
// same approach debriefStore.js uses. Nothing here needs delete permission on the SAS token.

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms))
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)))

export function createIntelStore({ account, container, sas, fetchImpl = fetch, sleep = sleepDefault }) {
  if (!account || !sas) throw new Error('Azure storage is not configured (AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_SAS_TOKEN).')
  const q = String(sas).startsWith('?') ? sas : `?${sas}`
  const url = (name) => `https://${account}.blob.core.windows.net/${container}/${name}${q}`

  async function readJson(name) {
    const res = await fetchImpl(url(name))
    if (res.status === 404) return { data: null, etag: null }
    if (!res.ok) throw new Error(`Storage read failed for ${name} (${res.status})`)
    return { data: await res.json(), etag: res.headers.get('etag') }
  }

  async function writeJson(name, data, { etag, isNew } = {}) {
    const headers = { 'Content-Type': 'application/json', 'x-ms-blob-type': 'BlockBlob' }
    if (isNew) headers['If-None-Match'] = '*'
    else if (etag) headers['If-Match'] = etag
    return fetchImpl(url(name), { method: 'PUT', headers, body: JSON.stringify(data) })
  }

  async function putJson(name, data) {
    const res = await writeJson(name, data)
    if (!res.ok) throw new Error(`Storage write failed for ${name} (${res.status})`)
    return data
  }

  async function updateJson(name, mutate, { fallback, maxAttempts = 10 } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { data, etag } = await readJson(name)
      const next = mutate(data === null ? clone(fallback) : data)
      const res = await writeJson(name, next, etag ? { etag } : { isNew: true })
      if (res.ok) return next
      if (res.status !== 412 && res.status !== 409) throw new Error(`Storage write failed for ${name} (${res.status})`)
      await sleep(Math.floor(Math.random() * Math.min(1000, 40 * 2 ** attempt)))
    }
    throw new Error(`Could not save ${name}: it is being written very actively right now.`)
  }

  const get = async (name, fallback) => (await readJson(name)).data ?? fallback

  return {
    readJson, writeJson, updateJson, putJson,

    getAccounts: () => get('intel/accounts.json', null),
    putAccounts: (doc) => putJson('intel/accounts.json', doc),
    getStaging: () => get('intel/accounts-staging.json', null),
    putStaging: (doc) => putJson('intel/accounts-staging.json', doc),
    getRefreshState: () => get('intel/refresh-state.json', null),
    putRefreshState: (doc) => putJson('intel/refresh-state.json', doc),

    getInsights: () => get('intel/insights.json', null),
    putInsights: (doc) => putJson('intel/insights.json', doc),

    getAiUsage: () => get('intel/ai-usage.json', { days: {} }),
    updateAiUsage: (fn) => updateJson('intel/ai-usage.json', (d) => fn(d || { days: {} }), { fallback: { days: {} } }),

    getStars: () => get('intel/stars.json', {}),
    updateStars: (fn) => updateJson('intel/stars.json', (s) => fn(s || {}), { fallback: {} }),

    getConfig: () => get('intel/config.json', null),
    putConfig: (doc) => putJson('intel/config.json', doc),

    getImportLog: () => get('intel/import-log.json', []),
    appendImportLog: (entry, keep = 50) => updateJson('intel/import-log.json', (list) => [entry, ...list].slice(0, keep), { fallback: [] }),
  }
}
