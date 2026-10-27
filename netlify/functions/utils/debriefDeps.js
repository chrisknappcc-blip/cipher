// netlify/functions/utils/debriefDeps.js
// Builds the real dependencies (storage, Gong, Claude, the background trigger)
// from Netlify environment variables. Kept separate so the logic modules can be
// tested with fakes.

import { createDebriefStore } from './debriefStore.js'
import { createGongClient } from './gongClient.js'
import { makeClaudeCaller } from './anthropic.js'

export const debriefConfig = (env = process.env) => ({
  model: env.DEBRIEF_MODEL || 'claude-sonnet-5-5',
  minWords: 120,
  minProspectWords: 15,
  maxPerRun: 3, // Gong allows 3 concurrent requests per workspace
  initialLookbackDays: Number(env.GONG_BACKFILL_DAYS) || 2,
})

export const buildStore = (env = process.env) => createDebriefStore({
  account: env.AZURE_STORAGE_ACCOUNT_NAME,
  container: env.AZURE_STORAGE_CONTAINER || 'crm-tokens',
  sas: env.AZURE_STORAGE_SAS_TOKEN,
})

export const buildGong = (env = process.env) => createGongClient({
  accessKey: env.GONG_ACCESS_KEY,
  secret: env.GONG_ACCESS_KEY_SECRET,
  baseUrl: env.GONG_BASE_URL,
})

export const buildClaude = (env = process.env) => makeClaudeCaller({ apiKey: env.ANTHROPIC_API_KEY })

// Starts the background analysis for one call. The background function answers
// 202 straight away and keeps working for up to 15 minutes.
export function makeTrigger(env = process.env, fetchImpl = fetch) {
  return async (callId, extra = {}) => {
    const site = String(env.APP_URL || env.URL || '').replace(/\/+$/, '')
    if (!site) throw new Error('APP_URL is not set, so the background job cannot be reached.')
    if (!env.DEBRIEF_INTERNAL_SECRET) throw new Error('DEBRIEF_INTERNAL_SECRET is not set.')
    const res = await fetchImpl(`${site}/.netlify/functions/gong-analyze-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrief-secret': env.DEBRIEF_INTERNAL_SECRET },
      body: JSON.stringify({ callId, ...extra }),
    })
    if (!res.ok) throw new Error(`The background job rejected the request (${res.status}).`)
  }
}

// Which settings are present, as yes or no, for the status view. Never the values.
export const configHealth = (env = process.env) => ({
  gong: !!(env.GONG_ACCESS_KEY && env.GONG_ACCESS_KEY_SECRET && env.GONG_BASE_URL),
  anthropic: !!env.ANTHROPIC_API_KEY,
  internalSecret: !!env.DEBRIEF_INTERNAL_SECRET,
  appUrl: !!(env.APP_URL || env.URL),
  storage: !!(env.AZURE_STORAGE_ACCOUNT_NAME && env.AZURE_STORAGE_SAS_TOKEN),
  model: debriefConfig(env).model,
})
