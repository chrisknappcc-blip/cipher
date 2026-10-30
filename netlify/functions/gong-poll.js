// netlify/functions/gong-poll.js
//
// Scheduled every 15 minutes. Asks Gong for recent calls with an external
// participant and starts the background analysis for any that are new.
// (Netlify scheduled functions only run on the published production deploy,
// and have a 30 second limit, which is why the analysis itself is a background function.)

import { pollOnce } from './utils/pollCalls.js'
import { buildStore, buildGong, makeTrigger, debriefConfig } from './utils/debriefDeps.js'

export const handler = async (event) => {
  try {
    const caller = (event && event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || ''
    const result = await pollOnce({ gong: buildGong(), store: buildStore(), trigger: makeTrigger(), config: debriefConfig(), caller })
    console.log('[gong-poll]', JSON.stringify(result))
  } catch (err) {
    console.error('[gong-poll] failed:', err.message)
  }
  return { statusCode: 200 }
}

export const config = { schedule: '*/15 * * * *' }
