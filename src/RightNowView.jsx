// src/RightNowView.jsx
// NEW FILE — path from repo root: src/RightNowView.jsx
//
// Real, working version of the Right Now Queue design we iterated on all
// session. Wired to actual endpoints: GET /right-now, GET/POST/DELETE /pin,
// GET /top5, and the existing /todo endpoints for manual tasks.
//
// Known limitations, being upfront rather than hiding them:
//   1. The queue mixes real to-do records (source: "todo") with DERIVED
//      items — signals, HubSpot tasks, meetings (source: "signal" | "task" |
//      "meeting"). Only to-dos have a real "mark complete" action on the
//      backend. For everything else, checking the box just dismisses it
//      from view for this browser session (a Set in component state) —
//      it is NOT persisted, so a page reload brings it back. Making that
//      persistent would need a small new "dismissed-ids" blob endpoint,
//      the same pattern as pins — not built yet.
//   2. The "@ tag a contact" typeahead from the mockup isn't wired in here.
//      /contacts as it exists today is built for territory/BDR filtering,
//      not free-text name search — using it for a live typeahead would
//      mean pulling hundreds of records per keystroke. A real version of
//      this needs a small dedicated search endpoint, not built yet.
//   3. The context panel here is intentionally basic (name, company,
//      whyTag, Priority Gold badge placeholder). The full sent/opened/
//      replied email timeline from the mockup needs its own data fetch
//      from HubSpot's per-contact activity, not part of /right-now today.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from './api'

function urgencyColor(score) {
  if (score >= 90) return 'var(--urgency-hot)'
  if (score >= 50) return 'var(--urgency-warm)'
  return 'var(--urgency-cooling)'
}

function displayName(item) {
  return item.contact?.name || item.label || 'Untitled'
}
function displayCompany(item) {
  return item.contact?.company || ''
}

export default function RightNowView({ getToken }) {
  const [queue, setQueue] = useState([])
  const [top5Picks, setTop5Picks] = useState([]) // raw {id, rank, rationale} from the scheduled job
  const [pinnedIds, setPinnedIds] = useState(new Set())
  const [dismissedIds, setDismissedIds] = useState(new Set()) // session-only, see note above
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [addText, setAddText] = useState('')
  const [adding, setAdding] = useState(false)
  const [selectedId, setSelectedId] = useState(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const [queueRes, top5Res, pinRes] = await Promise.all([
        apiFetch('/api/hubspot/right-now', getToken),
        apiFetch('/api/hubspot/top5', getToken).catch(() => ({ picks: [] })),
        apiFetch('/api/hubspot/pin', getToken).catch(() => ({ pinnedIds: [] })),
      ])
      setQueue(queueRes.queue || [])
      setTop5Picks(top5Res.picks || [])
      setPinnedIds(new Set(pinRes.pinnedIds || []))
      if (!selectedId && (queueRes.queue || []).length > 0) {
        setSelectedId(queueRes.queue[0].id)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [getToken, selectedId])

  useEffect(() => {
    load()
    // Light polling — the queue's underlying signals refresh every 3 min
    // elsewhere in Cipher, so matching that cadence here keeps it "live"
    // without hammering the endpoint on every render.
    const interval = setInterval(load, 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const visibleQueue = useMemo(
    () => queue.filter(item => !dismissedIds.has(item.id)),
    [queue, dismissedIds]
  )

  const top5Combined = useMemo(() => {
    const pinnedItems = visibleQueue
      .filter(item => pinnedIds.has(item.id))
      .map(item => ({ ...item, isPinned: true }))

    const slotsLeft = Math.max(5 - pinnedItems.length, 0)
    const aiItems = top5Picks
      .filter(p => !pinnedIds.has(p.id))
      .slice(0, slotsLeft)
      .map(p => {
        const match = visibleQueue.find(item => item.id === p.id)
        return match ? { ...match, rationale: p.rationale, isPinned: false } : null
      })
      .filter(Boolean)

    return [...pinnedItems, ...aiItems]
  }, [visibleQueue, pinnedIds, top5Picks])

  const top5Ids = useMemo(() => new Set(top5Combined.map(i => i.id)), [top5Combined])
  const restOfQueue = useMemo(
    () => visibleQueue.filter(item => !top5Ids.has(item.id)),
    [visibleQueue, top5Ids]
  )

  const togglePin = async (itemId) => {
    const isPinned = pinnedIds.has(itemId)
    setPinnedIds(prev => {
      const next = new Set(prev)
      isPinned ? next.delete(itemId) : next.add(itemId)
      return next
    })
    try {
      if (isPinned) {
        await apiFetch(`/api/hubspot/pin/${encodeURIComponent(itemId)}`, getToken, { method: 'DELETE' })
      } else {
        await apiFetch('/api/hubspot/pin', getToken, {
          method: 'POST',
          body: JSON.stringify({ itemId }),
        })
      }
    } catch (e) {
      // Revert optimistic update on failure
      setPinnedIds(prev => {
        const next = new Set(prev)
        isPinned ? next.add(itemId) : next.delete(itemId)
        return next
      })
      setError(`Couldn't update pin: ${e.message}`)
    }
  }

  const markDone = async (item) => {
    if (item.source === 'todo') {
      // Real completion — this is an actual to-do record.
      setQueue(prev => prev.filter(i => i.id !== item.id))
      try {
        const rawId = item.raw?.id || item.id.replace(/^todo-/, '')
        await apiFetch(`/api/hubspot/todo/${rawId}`, getToken, {
          method: 'PATCH',
          body: JSON.stringify({ completed: true }),
        })
      } catch (e) {
        setError(`Couldn't mark complete: ${e.message}`)
        load() // resync since the optimistic removal may now be wrong
      }
    } else {
      // Derived item (signal/task/meeting) — no backend "complete" action
      // exists for these. Session-only dismiss, per the note at the top
      // of this file.
      setDismissedIds(prev => new Set(prev).add(item.id))
    }
  }

  const addTask = async () => {
    const text = addText.trim()
    if (!text) return
    setAdding(true)
    try {
      const { item } = await apiFetch('/api/hubspot/todo', getToken, {
        method: 'POST',
        body: JSON.stringify({ text, autoDetected: false, priority: 'HIGH' }),
      })
      setAddText('')
      // Optimistically add it to the top of the queue so it's visible
      // immediately rather than waiting for the next poll.
      setQueue(prev => [{
        source: 'todo',
        id: `todo-${item.id}`,
        contactId: item.contactId || null,
        contact: null,
        label: item.text,
        queueScore: 90,
        whyTag: 'Manual to-do',
        raw: item,
      }, ...prev])
    } catch (e) {
      setError(`Couldn't add task: ${e.message}`)
    } finally {
      setAdding(false)
    }
  }

  const selectedItem = queue.find(i => i.id === selectedId) || null

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 0, background: 'var(--bg)', color: 'var(--text)', minHeight: '100%' }}>
      <div style={{ padding: '20px 24px', borderRight: '1px solid var(--border)' }}>

        {error && (
          <div style={{ background: 'var(--red-light)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {top5Combined.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '.3px', color: 'var(--urgency-hot)' }}>TOP 5 RIGHT NOW</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 22 }}>
              {top5Combined.map((item, idx) => {
                const color = item.isPinned ? 'var(--pin-color)' : urgencyColor(item.queueScore)
                return (
                  <div key={item.id} style={{
                    borderRadius: 10, padding: '11px 13px', display: 'flex', gap: 10, alignItems: 'flex-start',
                    background: `color-mix(in srgb, ${color} 12%, transparent)`,
                    border: `1.5px solid ${color}`,
                  }}>
                    {item.isPinned ? (
                      <button onClick={() => togglePin(item.id)} title="Unpin" style={{ background: 'none', border: 'none', cursor: 'pointer', color, fontSize: 11.5, flexShrink: 0 }}>
                        📌
                      </button>
                    ) : (
                      <div style={{ width: 20, height: 20, borderRadius: '50%', background: color, color: 'var(--bg)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {idx + 1}
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{displayName(item)}{displayCompany(item) ? ` · ${displayCompany(item)}` : ''}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {item.rationale || item.whyTag}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            value={addText}
            onChange={e => setAddText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addTask() }}
            placeholder="Add a task and hit enter"
            disabled={adding}
            style={{ flex: 1, background: 'var(--bg-panel)', border: '1px solid var(--border-strong)', color: 'var(--text)', borderRadius: 'var(--radius)', padding: '9px 12px', fontSize: 13 }}
          />
          <button onClick={addTask} disabled={adding || !addText.trim()}
            style={{ background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: 'var(--radius)', padding: '0 14px', cursor: 'pointer', opacity: adding || !addText.trim() ? 0.5 : 1 }}>
            +
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          Full queue · {restOfQueue.length} items
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {restOfQueue.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>Queue clear.</div>
          )}
          {restOfQueue.map(item => {
            const color = urgencyColor(item.queueScore)
            const isPinned = pinnedIds.has(item.id)
            return (
              <div key={item.id} onClick={() => setSelectedId(item.id)} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer',
                borderRadius: 10, border: `1.5px solid ${color}`,
                background: `color-mix(in srgb, ${color} 12%, transparent)`,
                outline: selectedId === item.id ? '2px solid var(--urgency-hot)' : 'none',
              }}>
                <button onClick={e => { e.stopPropagation(); markDone(item) }} title={item.source === 'todo' ? 'Mark complete' : 'Dismiss'}
                  style={{ width: 16, height: 16, borderRadius: 5, border: '1.5px solid var(--border-strong)', background: 'none', cursor: 'pointer', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{displayName(item)}{displayCompany(item) ? ` · ${displayCompany(item)}` : ''}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{item.whyTag}</div>
                </div>
                <button onClick={e => { e.stopPropagation(); togglePin(item.id) }} title={isPinned ? 'Unpin' : 'Pin to Top 5'}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: isPinned ? 'var(--pin-color)' : 'var(--text-tertiary)', fontSize: 14 }}>
                  📌
                </button>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>Context</div>
        {selectedItem ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>{displayName(selectedItem)}</div>
            {displayCompany(selectedItem) && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>{displayCompany(selectedItem)}</div>
            )}
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              {selectedItem.whyTag}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Select an item to see details.</div>
        )}
      </div>
    </div>
  )
}
