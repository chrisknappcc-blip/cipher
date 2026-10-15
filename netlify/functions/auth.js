// netlify/functions/utils/auth.js
// Netlify Identity JWT verification — replaces @clerk/backend

export async function verifyAuth(event, context) {
  // 1. Normal path. Netlify has already verified the token's signature and
  //    expiry and populated context.clientContext.user.
  const ctxUser = context?.clientContext?.user
  if (ctxUser?.sub) {
    return { userId: ctxUser.sub, email: ctxUser.email ?? null }
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization']
  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Missing or malformed Authorization header', 401)
  }
  const token = authHeader.replace('Bearer ', '').trim()

  // 2. Fallback. This used to decode the token WITHOUT checking its signature
  //    or expiry, so anyone could forge a token naming any user, an admin's
  //    email included, and be believed. Confirmed by test: a token with a random
  //    ID and a made up signature got through. It also meant expired tokens and
  //    tokens for deleted accounts worked forever. Now the Identity service
  //    itself has to vouch for the token, and we trust ITS answer (id and
  //    email), never the claims inside the token we were handed.
  const identityUrl = context?.clientContext?.identity?.url
  if (identityUrl) {
    try {
      const res = await fetch(`${identityUrl}/user`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) {
        const u = await res.json()
        if (u?.id) return { userId: u.id, email: u.email ?? null }
      }
    } catch (_) {}
    throw new AuthError('Invalid or expired session token', 401)
  }

  // 3. Local development only: `netlify dev` has no Identity context to ask.
  //    Never reachable in production, where NETLIFY_DEV is not set.
  if (process.env.NETLIFY_DEV === 'true') {
    try {
      const parts = token.split('.')
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]))
        if (payload.sub) return { userId: payload.sub, email: payload.email ?? null }
      }
    } catch (_) {}
  }

  throw new AuthError('Invalid or expired session token', 401)
}

export function withAuth(handler) {
  return async (event, context) => {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        },
        body: '',
      }
    }
    try {
      const user = await verifyAuth(event, context)
      return await handler(event, context, user)
    } catch (err) {
      if (err instanceof AuthError) {
        return {
          statusCode: err.statusCode,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({ error: err.message }),
        }
      }
      console.error('[withAuth] Unhandled error:', err)
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Internal server error' }),
      }
    }
  }
}

class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message)
    this.statusCode = statusCode
  }
}
