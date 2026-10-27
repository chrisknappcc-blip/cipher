// netlify/functions/gong-analyze-background.js
//
// A Netlify BACKGROUND function (the "-background" in the name is what makes it
// one): it answers 202 immediately and can run for up to 15 minutes, which a
// transcript analysis needs. Not meant to be called by people, so it requires a
// shared secret that only the poller and the admin "re-analyze" button know.

import { timingSafeEqual } from 'node:crypto'
import { processCall } from './utils/processCall.js'
import { buildStore, buildGong, buildClaude, debriefConfig } from './utils/debriefDeps.js'

function sameSecret(sent, expected) {
  const a = Buffer.from(String(sent || '')), b = Buffer.from(String(expected || ''))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

export const handler = async (event) => {
  const sent = event.headers?.['x-debrief-secret'] || event.headers?.['X-Debrief-Secret']
  if (!sameSecret(sent, process.env.DEBRIEF_INTERNAL_SECRET)) {
    console.error('[gong-analyze] rejected: missing or wrong secret')
    return { statusCode: 401, body: 'unauthorized' }
  }
  let body = {}
  try { body = JSON.parse(event.body || '{}') } catch { /* handled below */ }
  const callId = String(body.callId || '')
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(callId)) {
    console.error('[gong-analyze] rejected: bad callId')
    return { statusCode: 400, body: 'bad callId' }
  }
  try {
    const result = await processCall({
      callId,
      force: body.force === true,
      deps: { gong: buildGong(), store: buildStore(), claude: buildClaude(), config: debriefConfig() },
    })
    console.log('[gong-analyze]', callId, JSON.stringify(result))
  } catch (err) {
    console.error('[gong-analyze] crashed:', callId, err.message)
  }
  return { statusCode: 200 }
}
