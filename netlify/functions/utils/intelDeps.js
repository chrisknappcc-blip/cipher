// netlify/functions/utils/intelDeps.js
// Builds the real dependencies for Market Intel (storage, HubSpot, who is an admin) from Netlify environment
// variables. Kept apart from the handler so the handler can be tested with fakes. Needs no new settings (MARKET_INTEL=off is an optional off switch): it reuses the
// Azure storage settings, HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET, and ADMIN_EMAILS or ADMIN_USER_IDS.

import { createIntelStore } from './intelStore.js'
import { createHubspotReader } from './intelHubspot.js'
import { getTokens, setTokens, isTokenValid } from './tokenStore.js'
import { parseAccess } from './teamAccess.js'
import { makeClaudeCaller } from './anthropic.js'

export const buildDeps = (env = process.env) => ({
  store: createIntelStore({ account: env.AZURE_STORAGE_ACCOUNT_NAME, container: env.AZURE_STORAGE_CONTAINER || 'crm-tokens', sas: env.AZURE_STORAGE_SAS_TOKEN }),
  access: parseAccess(env),
  hubspot: createHubspotReader({ getTokens, setTokens, isTokenValid, clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET }),
  portalId: env.HUBSPOT_PORTAL_ID || '39921549',
  // The article analyzer reuses Cipher's Claude key, with at most two tries so it always answers inside the 26 second limit. MARKET_INTEL_AI=off switches only the analyzer off. INTEL_MODEL, INTEL_AI_DAILY_LIMIT, INTEL_PRICE_IN
  // and INTEL_PRICE_OUT (dollars per million tokens, for the cost estimate) are optional.
  claude: env.ANTHROPIC_API_KEY ? makeClaudeCaller({ apiKey: env.ANTHROPIC_API_KEY, maxAttempts: 2 }) : null,
  model: env.INTEL_MODEL || 'claude-haiku-4-5-20251001',
  aiLimit: Number(env.INTEL_AI_DAILY_LIMIT) > 0 ? Number(env.INTEL_AI_DAILY_LIMIT) : 25,
  aiOff: String(env.MARKET_INTEL_AI || '').toLowerCase() === 'off',
  prices: { priceIn: Number(env.INTEL_PRICE_IN) || 1, priceOut: Number(env.INTEL_PRICE_OUT) || 5 },
  disabled: String(env.MARKET_INTEL || '').toLowerCase() === 'off',
  config: {
    azure: !!(env.AZURE_STORAGE_ACCOUNT_NAME && env.AZURE_STORAGE_SAS_TOKEN),
    hubspotApp: !!(env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET),
    anthropic: !!env.ANTHROPIC_API_KEY,
  },
})
