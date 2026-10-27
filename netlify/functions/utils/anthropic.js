// netlify/functions/utils/anthropic.js
//
// Calls the Claude Messages API with retries for the failures that are worth
// retrying (rate limits, overload, server errors). Returns the raw response.

export function makeClaudeCaller({ apiKey, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxAttempts = 4 }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in Netlify.')
  return async function claude(request) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (res.ok) return res.json()
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500
      if (retryable && attempt < maxAttempts - 1) {
        const hinted = Number(res.headers?.get?.('retry-after'))
        await sleep((Number.isFinite(hinted) && hinted > 0 ? hinted : 2 ** attempt * 2) * 1000)
        continue
      }
      const text = await res.text().catch(() => '')
      throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 300)}`)
    }
    throw new Error('The Anthropic API stayed unavailable after several tries.')
  }
}
