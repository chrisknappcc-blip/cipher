// netlify/functions/utils/accountAudit.js
//
// Helpers for the Account Cleanup admin tool. Deliberately free of Netlify,
// Azure and HubSpot imports, with every outside call injected, so the
// destructive logic can be tested without touching anything real.

// Every blob Cipher keeps per signed in account, relative to the storage
// container. Found by searching hubspot.js and the token and todo stores.
// Anything stored under a different name in some other function would be
// left behind as a harmless orphan.
export function perUserBlobNames(userId) {
  const todoKey = String(userId).replace(/[^a-zA-Z0-9]/g, '_') // todoStore.js sanitizes the id this way
  return [
    `tokens/${userId}.json`,               // HubSpot + Microsoft OAuth tokens (tokenStore.js)
    `outlook-tokens-${userId}.json`,
    `todo--${todoKey}.json`,               // tasks, including ones a manager pushed
    `top5-${userId}.json`,
    `pinned-${userId}.json`,
    `dismissed-${userId}.json`,
    `pipeline-discussed-${userId}.json`,
    `meeting-confirmations-${userId}.json`,
    `ooo-followups-${userId}.json`,
    `sequence-followups-${userId}.json`,
  ]
}

const isConfirmed = (u) => !!(u?.confirmed_at || u?.email_confirmed_at)

// Joins what Cipher remembers (roster profiles) with what the Identity service
// actually has, plus each profile's HubSpot connection state.
//   hubspotByUserId values: 'ok' | 'stale' | 'none' | 'error'
export function classifyAccounts({ profiles, identityUsers, hubspotByUserId }) {
  const identityListed = Array.isArray(identityUsers)
  const byId = new Map((identityUsers || []).map(u => [u.id, u]))

  const emailCounts = {}
  for (const p of profiles) {
    const e = (p.email || '').toLowerCase()
    if (e) emailCounts[e] = (emailCounts[e] || 0) + 1
  }

  const rows = profiles.map(p => {
    const idUser = byId.get(p.userId)
    const identityExists = identityListed ? !!idUser : null
    const hubspot = hubspotByUserId?.[p.userId] || 'unknown'

    let status
    let action = null
    if (!identityListed)                           status = 'unknown'
    else if (!identityExists)                    { status = 'ghost'; action = 'remove_leftover' }
    else if (hubspot === 'ok')                     status = 'ok'
    else if (hubspot === 'stale' || hubspot === 'none') { status = 'needs_reconnect'; action = 'reconnect' }
    else                                           status = 'check'

    return {
      userId: p.userId,
      email: p.email,
      identityExists,
      identityConfirmed: idUser ? isConfirmed(idUser) : null,
      identityCreatedAt: idUser?.created_at || null,
      hubspot,
      duplicates: emailCounts[(p.email || '').toLowerCase()] || 1,
      status,
      action,
    }
  })

  rows.sort((a, b) =>
    String(a.email || '').localeCompare(String(b.email || '')) ||
    (Number(b.identityExists === true) - Number(a.identityExists === true))
  )

  const profileIds = new Set(profiles.map(p => p.userId))
  const identityOnly = (identityUsers || [])
    .filter(u => !profileIds.has(u.id))
    .map(u => ({ userId: u.id, email: u.email, confirmed: isConfirmed(u), createdAt: u.created_at || null }))
    .sort((a, b) => String(a.email || '').localeCompare(String(b.email || '')))

  return { identityListed, rows, identityOnly }
}

export function removeFromRegistry(registry, userId) {
  const data = registry || {}
  const profiles = { ...(data.profiles || {}) }
  delete profiles[userId]
  return { ...data, userIds: (data.userIds || []).filter(id => id !== userId), profiles }
}

// Deletes every per account blob. If the storage token isn't allowed to delete,
// blank the blob instead so nothing usable remains, but only when it exists, so
// we never litter empty files for blobs that were never there.
export async function purgeUserData({ userId, blobBase, sas, fetchImpl = fetch }) {
  const results = []
  for (const name of perUserBlobNames(userId)) {
    const url = `${blobBase}/${name}${sas}`
    let result
    try {
      const del = await fetchImpl(url, { method: 'DELETE' })
      if (del.ok) {
        result = 'deleted'
      } else if (del.status === 404) {
        result = 'absent'
      } else if (del.status === 403 || del.status === 405) {
        const head = await fetchImpl(url, { method: 'HEAD' })
        if (head.status === 404) {
          result = 'absent'
        } else {
          const put = await fetchImpl(url, {
            method: 'PUT',
            headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/json' },
            body: '{}',
          })
          result = put.ok ? 'emptied' : `failed (${put.status})`
        }
      } else {
        result = `failed (${del.status})`
      }
    } catch (e) {
      result = `failed (${e.message})`
    }
    results.push({ name, result })
  }
  return results
}

// The guarded removal flow. Returns { status, body } so the route can pass it
// straight through. Guards, in order:
//   1. never your own account
//   2. must be able to ask the Identity service whether the account exists
//   3. a LIVE sign in account is only removed with deleteSignIn AND a typed
//      email that matches, checked here, not just in the browser
//   4. nothing else is touched if Identity refuses to delete
export async function removeAccount({
  targetId, callerId, deleteSignIn, confirmEmail,
  ia, profileEmail, registryUrl, blobBase, sas, fetchImpl = fetch,
}) {
  if (!targetId) return { status: 400, body: { error: 'userId is required' } }
  if (targetId === callerId) return { status: 400, body: { error: "You can't remove your own account from here." } }
  if (!ia) {
    return { status: 500, body: { error: "Identity service context not available, so I can't check whether this sign in account still exists. Nothing was changed." } }
  }

  const idRes = await fetchImpl(`${ia.base}/users/${encodeURIComponent(targetId)}`, { headers: ia.headers })
  let identityUser = null
  if (idRes.status === 200) identityUser = await idRes.json().catch(() => ({}))
  else if (idRes.status !== 404) {
    return { status: 502, body: { error: `Couldn't check the sign in account (${idRes.status}). Nothing was changed.` } }
  }

  const email = String(identityUser?.email || profileEmail || '').toLowerCase()

  let signInDeleted = false
  if (identityUser) {
    if (!deleteSignIn) {
      return { status: 409, body: { error: 'That sign in account still exists. Use Delete account to remove it along with its data.' } }
    }
    if (!email || String(confirmEmail || '').trim().toLowerCase() !== email) {
      return { status: 400, body: { error: "The email you typed doesn't match. Nothing was changed." } }
    }
    const del = await fetchImpl(`${ia.base}/users/${encodeURIComponent(targetId)}`, { method: 'DELETE', headers: ia.headers })
    if (!del.ok) {
      return { status: 502, body: { error: `Identity refused to delete the account (${del.status}). Nothing else was changed.` } }
    }
    signInDeleted = true
  }

  let registryRemoved = false
  try {
    const cur = await fetchImpl(registryUrl)
    if (cur.ok) {
      const data = await cur.json()
      const put = await fetchImpl(registryUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-ms-blob-type': 'BlockBlob' },
        body: JSON.stringify(removeFromRegistry(data, targetId)),
      })
      registryRemoved = put.ok
    } else {
      registryRemoved = cur.status === 404 // no registry at all means nothing to remove
    }
  } catch { registryRemoved = false }

  const blobs = await purgeUserData({ userId: targetId, blobBase, sas, fetchImpl })
  return { status: 200, body: { ok: true, email, signInDeleted, registryRemoved, blobs } }
}
