// netlify/functions/utils/gongClient.js
//
// Thin client for the three Gong endpoints the call debrief uses. Auth is HTTP
// Basic with the Access Key as the username and the Access Key Secret as the
// password; the base URL is specific to your Gong workspace (shown on Gong's
// API page, for example https://company-17.api.gong.io).
//
// Gong limits a workspace to 3 requests a second and 10,000 a day. A 429 comes
// back with a Retry-After header, which this honors.

export class GongError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'GongError'
    this.status = status
  }
}

function friendly(status, text) {
  if (status === 401) return 'Gong rejected the credentials (401). Check GONG_ACCESS_KEY, GONG_ACCESS_KEY_SECRET and GONG_BASE_URL. The secret is only shown once, when the key is created.'
  if (status === 403) return 'Gong accepted the key but refused this request (403). Check that the key has not been revoked or expired (Gong emails the technical administrator before a key expires). If it has, create a new key and update the two Netlify settings.'
  return `Gong API error ${status}: ${String(text).slice(0, 300)}`
}

export function createGongClient({
  accessKey, secret, baseUrl,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxRetries = 4,
}) {
  if (!accessKey || !secret || !baseUrl) {
    throw new Error('Gong is not configured. Set GONG_ACCESS_KEY, GONG_ACCESS_KEY_SECRET and GONG_BASE_URL in Netlify.')
  }
  const base = String(baseUrl).trim().replace(/\/+$/, '')
  const auth = 'Basic ' + Buffer.from(`${accessKey}:${secret}`).toString('base64')

  async function post(path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 429 && attempt < maxRetries) {
        const hinted = Number(res.headers?.get?.('retry-after'))
        await sleep((Number.isFinite(hinted) && hinted > 0 ? hinted : 2 ** attempt) * 1000)
        continue
      }
      if (res.ok) return res.json()
      const text = await res.text().catch(() => '')
      // Gong answers 404 when a query simply matches nothing. Only treat that as
      // empty when the body says so, so a wrong base URL fails loudly instead of
      // quietly returning "no calls".
      if (res.status === 404 && /no calls found/i.test(text)) return null
      throw new GongError(res.status, friendly(res.status, text))
    }
  }

  const PARTIES = { exposedFields: { parties: true } } // without this Gong omits the participants entirely

  return {
    // Calls that started in [from, to] (ISO strings), with participants.
    async listCalls({ from, to, maxPages = 50 }) {
      const calls = []
      let cursor
      for (let page = 0; page < maxPages; page++) {
        const body = { filter: { fromDateTime: from, toDateTime: to }, contentSelector: PARTIES }
        if (cursor) body.cursor = cursor
        const data = await post('/v2/calls/extensive', body)
        if (!data) break
        calls.push(...(data.calls || []))
        cursor = data.records?.cursor || data.cursor
        if (!cursor) break
      }
      return calls
    },

    async getCall(callId) {
      const data = await post('/v2/calls/extensive', { filter: { callIds: [String(callId)] }, contentSelector: PARTIES })
      return data?.calls?.[0] || null
    },

    // Array of monologues { speakerId, topic, sentences: [{ start, end, text }] }, or null if not ready.
    async getTranscript(callId) {
      const data = await post('/v2/calls/transcript', { filter: { callIds: [String(callId)] } })
      const found = data?.callTranscripts?.find((c) => String(c.callId) === String(callId)) || data?.callTranscripts?.[0]
      return found?.transcript || null
    },
  }
}
