// src/TeamView.jsx
// NEW FILE — path from repo root: src/TeamView.jsx
//
// Manager view: roster of every known rep with queue health at a glance,
// click into any rep to see their actual Right Now queue, push a task
// directly into it. Gated server-side by isAdminUser (ADMIN_EMAILS env
// var) — GET /team and POST /team/push both 403 for non-admins, so this
// component isn't the real security boundary, just the UI for it.

import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from './api'

function urgencyColor(hours) {
  if (hours == null) return 'var(--text-tertiary)'
  if (hours >= 24) return 'var(--urgency-stale)'
  if (hours >= 8) return 'var(--amber)'
  return 'var(--text-secondary)'
}

function displayName(item) {
  return item.contact?.name || item.label || 'Untitled'
}
function displayCompany(item) {
  return item.contact?.company || ''
}

export default function TeamView({ getToken }) {
  const [roster, setRoster] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [forbidden, setForbidden] = useState(false)
  const [activeUserId, setActiveUserId] = useState(null)
  const [activeQueue, setActiveQueue] = useState([])
  const [queueLoading, setQueueLoading] = useState(false)
  const [pushText, setPushText] = useState('')
  const [pushing, setPushing] = useState(false)
  const [toast, setToast] = useState(null)

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(t => (t === msg ? null : t)), 2500)
  }, [])

  const loadRoster = useCallback(async () => {
    try {
      setError(null)
      const data = await apiFetch('/api/hubspot/team', getToken)
      setRoster(data.roster || [])
      if (!activeUserId && data.roster?.length > 0) {
        setActiveUserId(data.roster[0].userId)
      }
    } catch (e) {
      if (e.message?.includes('403') || e.message?.toLowerCase().includes('admin')) {
        setForbidden(true)
      } else {
        setError(e.message)
      }
    } finally {
      setLoading(false)
    }
  }, [getToken, activeUserId])

  useEffect(() => { loadRoster() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const activeRep = roster.find(r => r.userId === activeUserId) || null

  useEffect(() => {
    if (!activeUserId) { setActiveQueue([]); return }
    let cancelled = false
    setQueueLoading(true)
    apiFetch(`/api/hubspot/team/queue?userId=${encodeURIComponent(activeUserId)}`, getToken)
      .then(data => { if (!cancelled) setActiveQueue(data.queue || []) })
      .catch(() => { if (!cancelled) setActiveQueue([]) })
      .finally(() => { if (!cancelled) setQueueLoading(false) })
    return () => { cancelled = true }
  }, [activeUserId, getToken])

  const pushTask = async () => {
    const text = pushText.trim()
    if (!text || !activeUserId) return
    setPushing(true)
    try {
      await apiFetch('/api/hubspot/team/push', getToken, {
        method: 'POST',
        body: JSON.stringify({ targetUserId: activeUserId, text }),
      })
      setPushText('')
      showToast(`Pushed to ${activeRep?.email || 'rep'}`)
      loadRoster()
      apiFetch(`/api/hubspot/team/queue?userId=${encodeURIComponent(activeUserId)}`, getToken)
        .then(data => setActiveQueue(data.queue || []))
        .catch(() => {})
    } catch (e) {
      setError(`Couldn't push task: ${e.message}`)
    } finally {
      setPushing(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  if (forbidden) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>
        This view is only available to admins. If you should have access, check that your email is in the ADMIN_EMAILS setting.
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, background: 'var(--bg)', color: 'var(--text)', minHeight: '100%', position: 'relative', padding: 4 }}>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-panel)', border: '1px solid var(--border)', color: 'var(--text)', padding: '11px 20px', borderRadius: 'var(--radius-lg)', fontSize: 13, boxShadow: 'var(--shadow-soft)', zIndex: 100 }}>
          {toast}
        </div>
      )}

      <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)' }}>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 16 }}>Team</div>

        {error && (
          <div style={{ background: 'var(--red-light)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 12.5, marginBottom: 14 }}>
            {error}
          </div>
        )}

        {roster.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No reps registered yet — this fills in as people log into Cipher.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {roster.map(rep => (
              <div key={rep.userId} onClick={() => setActiveUserId(rep.userId)} style={{
                padding: '13px 14px', borderRadius: 14, cursor: 'pointer',
                background: activeUserId === rep.userId ? 'var(--bg-hover)' : 'var(--bg-secondary)',
                border: activeUserId === rep.userId ? '1px solid var(--border-strong)' : '1px solid transparent',
              }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{rep.email || rep.userId}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 3 }}>
                  {rep.queueCount ?? 0} in queue · {rep.completedToday ?? 0} done today
                </div>
                {rep.oldestHours != null && (
                  <div style={{ fontSize: 11, color: urgencyColor(rep.oldestHours), marginTop: 2 }}>
                    Oldest item {rep.oldestHours >= 24 ? `${Math.round(rep.oldestHours / 24)}d` : `${rep.oldestHours}h`} old
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)', alignSelf: 'start' }}>
        {activeRep ? (
          <>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>{activeRep.email || activeRep.userId}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 18 }}>
              {activeRep.queueCount ?? 0} items in queue · {activeRep.completedToday ?? 0} completed today
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              <input
                value={pushText}
                onChange={e => setPushText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') pushTask() }}
                placeholder={`Push a task into their Right Now`}
                disabled={pushing}
                style={{ flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border-strong)', color: 'var(--text)', borderRadius: 'var(--radius)', padding: '9px 12px', fontSize: 13 }}
              />
              <button onClick={pushTask} disabled={pushing || !pushText.trim()}
                style={{ background: 'var(--manager-color)', border: 'none', color: '#fff', borderRadius: 'var(--radius)', padding: '0 16px', cursor: 'pointer', fontSize: 12.5, whiteSpace: 'nowrap', opacity: pushing || !pushText.trim() ? 0.5 : 1 }}>
                {pushing ? 'Pushing…' : 'Push'}
              </button>
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              Their queue
            </div>
            {queueLoading ? (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Loading…</div>
            ) : activeQueue.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Queue clear.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {activeQueue.slice(0, 15).map(item => {
                  const fromManager = !!item.assignedBy
                  const color = fromManager ? 'var(--manager-color)' : 'var(--urgency-warm)'
                  return (
                    <div key={item.id} style={{
                      padding: '11px 14px', borderRadius: 12,
                      border: `1px solid color-mix(in srgb, ${color} 40%, var(--border))`,
                      background: `color-mix(in srgb, ${color} 8%, var(--bg-panel))`,
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {displayName(item)}{displayCompany(item) ? ` · ${displayCompany(item)}` : ''}
                        {fromManager && (
                          <span style={{ fontSize: 10, color: 'var(--manager-color)', border: '1px solid var(--manager-color)', borderRadius: 10, padding: '1px 7px', marginLeft: 8 }}>
                            From {item.assignedBy.split('@')[0]}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{item.whyTag}</div>
                    </div>
                  )
                })}
                {activeQueue.length > 15 && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', textAlign: 'center', paddingTop: 4 }}>
                    +{activeQueue.length - 15} more
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Select a rep to see details.</div>
        )}
      </div>
    </div>
  )
}
