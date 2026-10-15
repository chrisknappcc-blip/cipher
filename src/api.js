// src/api.js
export async function apiFetch(path, getToken, options = {}) {
  const send = async (tokenOpts) => {
    const token = await getToken(tokenOpts)

    if (!token) {
      throw new Error('No session token available. Please sign in again.')
    }

    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    })
    return { res, token }
  }

  let { res, token } = await send({ template: null })

  // A 401 means the token we sent was rejected before anything ran (expired in
  // transit, clock skew, or rotated by another tab). Refresh once and retry. Safe
  // for writes too, since a 401 is returned before the request is processed.
  if (res.status === 401) {
    ;({ res } = await send({ template: null, forceRefresh: true, rejectedToken: token }))
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || `Request failed: ${res.status}`)
  }
  return res.json()
}
