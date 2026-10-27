// netlify/functions/utils/debriefStore.js
//
// Azure Blob storage for call debriefs, in Cipher's own container.
//
//   debriefs/call-<callId>.json      the full record for one call
//   debriefs/index-<monday>.json     one small summary per call, per week (what lists read)
//   debriefs/state.json              poller bookkeeping
//   debriefs/lock-<callId>.json      stops two jobs analyzing the same call
//   debriefs/seen-<hash>.json        which debriefs each person has opened
//
// Files several jobs can write at once (the weekly index, state, seen) are
// updated with Azure's ETag conditional writes, the same approach as
// add-resource-link.js: read, change, write only if nobody else wrote in between,
// and retry if they did. Nothing here needs delete permission on the SAS token.

import { createHash } from 'node:crypto'

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms))
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)))

export function createDebriefStore({ account, container, sas, fetchImpl = fetch, sleep = sleepDefault, now = () => Date.now() }) {
  if (!account || !sas) throw new Error('Azure storage is not configured (AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_SAS_TOKEN).')
  const q = String(sas).startsWith('?') ? sas : `?${sas}`
  const url = (name) => `https://${account}.blob.core.windows.net/${container}/${name}${q}`
  const safe = (id) => String(id).replace(/[^0-9A-Za-z_-]/g, '')

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

  // Read, change, write only if unchanged since the read; retry on a conflict.
  async function updateJson(name, mutate, { fallback, maxAttempts = 10 } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { data, etag } = await readJson(name)
      const next = mutate(data === null ? clone(fallback) : data)
      const res = await writeJson(name, next, etag ? { etag } : { isNew: true })
      if (res.ok) return next
      if (res.status !== 412 && res.status !== 409) throw new Error(`Storage write failed for ${name} (${res.status})`)
      // Full jitter: a random wait up to a doubling ceiling. A fixed delay makes
      // writers that collided wake together and collide again.
      await sleep(Math.floor(Math.random() * Math.min(1000, 40 * 2 ** attempt)))
    }
    throw new Error(`Could not save ${name}: it is being written very actively right now.`)
  }

  const callName = (id) => `debriefs/call-${safe(id)}.json`
  const indexName = (week) => `debriefs/index-${week}.json`
  const seenName = (email) => `debriefs/seen-${createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 24)}.json`

  return {
    readJson, writeJson, updateJson,

    async getDetail(id) { return (await readJson(callName(id))).data },
    async putDetail(id, record) {
      const res = await writeJson(callName(id), record)
      if (!res.ok) throw new Error(`Storage write failed for call ${id} (${res.status})`)
    },

    async getIndex(week) { return (await readJson(indexName(week))).data || [] },
    async upsertSummary(week, summary) {
      return updateJson(indexName(week), (list) => {
        const next = list.slice()
        const i = next.findIndex((x) => x.callId === summary.callId)
        if (i >= 0) next[i] = summary; else next.push(summary)
        return next
      }, { fallback: [] })
    },

    async getState() { return (await readJson('debriefs/state.json')).data || {} },
    async updateState(fn) { return updateJson('debriefs/state.json', (s) => fn(s || {}) , { fallback: {} }) },

    // A lock is a record, not a delete, so no delete permission is needed. A lock
    // older than ttlMs is treated as abandoned (a job that died mid-way).
    async acquireLock(id, ttlMs = 20 * 60 * 1000) {
      const name = `debriefs/lock-${safe(id)}.json`
      const { data, etag } = await readJson(name)
      if (data && !data.released && now() - data.at < ttlMs) return false
      const res = await writeJson(name, { at: now(), released: false }, etag ? { etag } : { isNew: true })
      if (res.ok) return true
      if (res.status === 412 || res.status === 409) return false
      throw new Error(`Storage write failed for lock ${id} (${res.status})`)
    },
    async releaseLock(id) {
      await updateJson(`debriefs/lock-${safe(id)}.json`, () => ({ at: 0, released: true, releasedAt: now() }), { fallback: {} })
    },

    async getSeen(email) { return (await readJson(seenName(email))).data?.seen || {} },
    async markSeen(email, ids) {
      const stamp = new Date(now()).toISOString()
      return updateJson(seenName(email), (d) => {
        const seen = { ...(d?.seen || {}) }
        for (const id of ids) if (!seen[id]) seen[id] = stamp
        const keep = Object.entries(seen).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 1500)
        return { seen: Object.fromEntries(keep) }
      }, { fallback: { seen: {} } })
    },
  }
}
