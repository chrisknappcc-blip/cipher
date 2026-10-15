// src/session.js
//
// WHY THIS FILE EXISTS
// Netlify Identity access tokens last one hour. After that, every API call needs
// a refresh, and the identity library handles that refresh in a way that signs
// people out far more often than it should. Three behaviors, each verified
// against the library source and the GoTrue server source:
//
//  1. GoTrue ROTATES refresh tokens. The first refresh revokes the old token;
//     using it a second time fails with invalid_grant.
//  2. The library only de-duplicates refreshes inside ONE page. Two Cipher tabs
//     (or a second window) both refresh with the same token when it expires.
//     One wins, the other gets invalid_grant.
//  3. On ANY failed refresh the library deletes the saved session from
//     localStorage. It can't tell a revoked token apart from a dropped
//     connection, a laptop waking up before Wi-Fi is back, or a 5xx. And since
//     localStorage is shared by every tab, the loser of the race wipes the
//     winner's fresh session. Next reload: "please sign in".
//
// This module sits in front of the library's jwt():
//   - uses the freshest token any tab has saved before refreshing at all
//   - serializes refreshes across tabs with the Web Locks API
//   - on a transient failure, restores the session the library just deleted
//     and retries, instead of leaving the user signed out
//   - only reports SessionExpiredError when the server actually rejects the token

const STORAGE_KEY  = 'gotrue.user'
const LOGOUT_FLAG  = 'cipher-logout-at'
const LOCK_NAME    = 'cipher-token-refresh'
const FRESH_MS     = 90 * 1000            // a token with less than this left counts as stale
let   RETRY_DELAYS = [0, 800, 2500]       // transient failure retries (ms)

export class SessionExpiredError extends Error {
  constructor() {
    super('Your session expired. Please sign in again.')
    this.name = 'SessionExpiredError'
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function readStored() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') } catch { return null }
}

// Expiry in ms, read straight from the JWT payload. Never trust a stored
// expires_at: some code paths wrote it in seconds, the library uses ms.
export function jwtExpiry(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4)
    return (JSON.parse(atob(padded)).exp || 0) * 1000
  } catch { return 0 }
}

const isFresh = (token) =>
  !!token?.access_token && jwtExpiry(token.access_token) - FRESH_MS > Date.now()

// A refresh the server actively refused (bad, revoked or expired refresh token,
// deleted user). Everything else, including no response at all, is transient.
const isAuthRejection = (err) => [400, 401, 403].includes(err?.status)

// If another tab already refreshed, its token is in localStorage. Use it
// instead of spending our (now revoked) refresh token.
function adoptNewerStoredToken(user) {
  const stored = readStored()?.token
  if (!stored?.access_token || !stored?.refresh_token) return
  const storedExp = jwtExpiry(stored.access_token)
  const liveExp   = jwtExpiry(user.token?.access_token)
  if (storedExp > liveExp) user.token = { ...stored, expires_at: storedExp }
}

async function withRefreshLock(fn) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(LOCK_NAME, fn)
  }
  return fn()
}

async function refreshWithRecovery() {
  // The library deletes the saved session when a refresh fails. Keep a copy so
  // a transient failure doesn't cost the user their login.
  const snapshot = localStorage.getItem(STORAGE_KEY)
  const restore  = () => {
    if (snapshot && !localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, snapshot)
  }

  let lastErr = null
  for (const delay of RETRY_DELAYS) {
    if (delay) await sleep(delay)
    restore()
    const user = window.netlifyIdentity?.currentUser()
    if (!user) continue
    try {
      return await user.jwt(true)
    } catch (err) {
      lastErr = err
      if (isAuthRejection(err)) break
    }
  }

  if (lastErr && isAuthRejection(lastErr)) throw new SessionExpiredError()

  // Never got an answer from the server. The session is fine; put it back.
  restore()
  throw new Error('Could not reach the sign in service. Your session is still active, try again in a moment.')
}

// Drop-in replacement for user.jwt(). Options:
//   forceRefresh  refresh even if the token looks valid (used after a 401)
//   rejectedToken the token the server just rejected, so we don't hand it back
export async function getAccessToken(opts = {}) {
  let user = window.netlifyIdentity?.currentUser()
  if (!user) throw new Error('Not authenticated')

  adoptNewerStoredToken(user)
  if (!opts.forceRefresh && isFresh(user.token)) return user.token.access_token

  return withRefreshLock(async () => {
    user = window.netlifyIdentity?.currentUser()
    if (!user) throw new Error('Not authenticated')

    // Another tab may have refreshed while we waited for the lock.
    adoptNewerStoredToken(user)
    const stillRejected = opts.forceRefresh && user.token?.access_token === opts.rejectedToken
    if (isFresh(user.token) && !stillRejected) return user.token.access_token

    return refreshWithRecovery()
  })
}

// Call when the user clicks Sign out, so other tabs don't "heal" the session
// back into existence.
export function markIntentionalLogout() {
  try { localStorage.setItem(LOGOUT_FLAG, String(Date.now())) } catch { /* ignore */ }
}

let guardsInstalled = false

// Safety net for tabs running older code (or browsers without Web Locks): if
// another tab deletes the saved session while this one still holds a valid
// login, write it back.
export function installSessionGuards() {
  if (guardsInstalled || typeof window === 'undefined') return
  guardsInstalled = true
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || e.newValue !== null) return
    const loggedOutAt = Number(localStorage.getItem(LOGOUT_FLAG) || 0)
    if (Date.now() - loggedOutAt < 15000) return           // real sign out: respect it
    const user = window.netlifyIdentity?.currentUser()
    if (user?.token?.refresh_token && isFresh(user.token)) user._saveSession()
  })
}

// Admin created accounts carry a "must change password" flag that sends the user to a
// forced "set a new password" screen. When someone has just chosen their own password
// through their own emailed reset link, that flag has done its job. Clear it, or they
// finish the reset and are sent straight to a SECOND "set a new password" screen.
// Returns true if cleared. Never throws: the worst case is they see the screen once more.
export async function clearMustChangePasswordFlag(accessToken, fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/.netlify/functions/clear-password-flag', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return false
    // The flag also lives in the saved copy of the user, which is what the app reads.
    const stored = readStored()
    if (stored) {
      stored.app_metadata = { ...(stored.app_metadata || {}), must_change_password: false }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    }
    return true
  } catch { return false }
}

// Test hook only.
export const _testing = { setRetryDelays: (d) => { RETRY_DELAYS = d } }
