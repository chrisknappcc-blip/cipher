// src/RightNowView.jsx
// REPLACE — path from repo root: src/RightNowView.jsx
//
// Real, working version of the Right Now Queue design we iterated on all
// session. Wired to actual endpoints: GET /right-now, GET/POST/DELETE /pin,
// GET /top5, and the existing /todo endpoints for manual tasks.
//
// Changes this pass, based on real usability feedback:
//   - Pin button now shows explicit text state ("Pin to Top 5" vs "Pinned")
//     instead of relying on an icon + hover tooltip to communicate a toggle.
//   - Every queue row's reason ("why it's here") is now labeled explicitly
//     rather than shown as an unlabeled line of gray text.
//   - Checking a box now shows an inline confirmation of what happened and
//     where the item went ("Marked complete" / "Dismissed"), and there's a
//     Done toggle to actually go look at that log.
//
// Known limitations, still true from before:
//   1. The queue mixes real to-do records (source: "todo") with DERIVED
//      items — signals, HubSpot tasks, meetings. Only to-dos have a real
//      "mark complete" action on the backend; everything else is a
//      session-only dismiss (see the Done log note below).
//   2. The Done log below is SESSION-ONLY — it resets on page reload. Todo
//      completions are real and permanent on the backend; what resets is
//      just this view's record of "what did I action in this browser tab
//      today." Building true persisted history for dismissed signals/tasks/
//      meetings would need a new backend log, not built yet.
//   3. The "@ tag a contact" typeahead and full email timeline are still
//      not wired in — same gaps as last pass, no dedicated endpoints yet.

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

function sourceLabel(source) {
  if (source === 'todo') return 'To-do'
  if (source === 'signal') return 'Email activity'
  if (source === 'task') return 'HubSpot task'
  if (source === 'meeting') return 'Meeting'
  return 'Item'
}

export default function RightNowView({ getToken }) {
  const [queue, setQueue] = useState([])
  const [top5Picks, setTop5Picks] = useState([]) // raw {id, rank, rationale} from the scheduled job
  const [pinnedIds, setPinnedIds] = useState(new Set())
  const [dismissedIds, setDismissedIds] = useState(new Set())
  const [doneLog, setDoneLog] = useState([]) // session log of {id, name, company, whyTag, action, at} — see note above
  const [view, setView] = useState('queue') // 'queue' | 'done'
  const [toast, setToast] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [addText, setAddText] = useState('')
  const [adding, setAdding] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [visibleCount, setVisibleCount] = useState(10)

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(t => (t === msg ? null : t)), 2500)
  }, [])

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
  const pagedQueue = restOfQueue.slice(0, visibleCount)

  const togglePin = async (itemId, itemName) => {
    const isPinned = pinnedIds.has(itemId)
    setPinnedIds(prev => {
      const next = new Set(prev)
      isPinned ? next.delete(itemId) : next.add(itemId)
      return next
    })
    showToast(isPinned ? `Unpinned ${itemName}` : `Pinned ${itemName} to Top 5`)
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
      setPinnedIds(prev => {
        const next = new Set(prev)
        isPinned ? next.add(itemId) : next.delete(itemId)
        return next
      })
      setError(`Couldn't update pin: ${e.message}`)
    }
  }

  const logDone = (item, action) => {
    setDoneLog(prev => [{
      id: item.id,
      name: displayName(item),
      company: displayCompany(item),
      whyTag: item.whyTag,
      action,
      at: new Date().toISOString(),
    }, ...prev])
  }

  const markDone = async (item) => {
    const name = displayName(item)
    if (item.source === 'todo') {
      setQueue(prev => prev.filter(i => i.id !== item.id))
      logDone(item, 'completed')
      showToast(`Marked "${name}" complete — see Done`)
      try {
        const rawId = item.raw?.id || item.id.replace(/^todo-/, '')
        await apiFetch(`/api/hubspot/todo/${rawId}`, getToken, {
          method: 'PATCH',
          body: JSON.stringify({ completed: true }),
        })
      } catch (e) {
        setError(`Couldn't mark complete: ${e.message}`)
        load()
      }
    } else {
      setDismissedIds(prev => new Set(prev).add(item.id))
      logDone(item, 'dismissed')
      showToast(`Dismissed "${name}" for this session — see Done`)
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
      showToast('Added to queue')
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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 0, background: 'var(--bg)', color: 'var(--text)', minHeight: '100%', position: 'relative' }}>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-panel)', border: '1px solid var(--border-strong)', color: 'var(--text)', padding: '10px 18px', borderRadius: 'var(--radius)', fontSize: 13, boxShadow: '0 4px 16px rgba(0,0,0,0.3)', zIndex: 100 }}>
          {toast}
        </div>
      )}

      <div style={{ padding: '20px 24px', borderRight: '1px solid var(--border)' }}>

        {error && (
          <div style={{ background: 'var(--red-light)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: '1px solid var(--border)' }}>
          <button onClick={() => setView('queue')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 4px', marginRight: 16, fontSize: 13, fontWeight: view === 'queue' ? 600 : 400, color: view === 'queue' ? 'var(--text)' : 'var(--text-tertiary)', borderBottom: view === 'queue' ? '2px solid var(--urgency-hot)' : '2px solid transparent' }}>
            Queue
          </button>
          <button onClick={() => setView('done')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 4px', fontSize: 13, fontWeight: view === 'done' ? 600 : 400, color: view === 'done' ? 'var(--text)' : 'var(--text-tertiary)', borderBottom: view === 'done' ? '2px solid var(--urgency-hot)' : '2px solid transparent', display: 'flex', alignItems: 'center', gap: 6 }}>
            Done
            {doneLog.length > 0 && (
              <span style={{ fontSize: 10, background: 'var(--bg-secondary)', color: 'var(--text-tertiary)', borderRadius: 10, padding: '1px 6px' }}>{doneLog.length}</span>
            )}
          </button>
        </div>

        {view === 'done' ? (
          <>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 14 }}>
              What you've actioned this session. To-do completions are saved for good; dismissed items reset if you reload the page.
            </div>
            {doneLog.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>Nothing done yet this session.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {doneLog.map((entry, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', opacity: 0.8 }}>
                    <span style={{ fontSize: 14 }}>{entry.action === 'completed' ? '✓' : '—'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, textDecoration: 'line-through', textDecorationColor: 'var(--border-strong)' }}>
                        {entry.name}{entry.company ? ` · ${entry.company}` : ''}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {entry.action === 'completed' ? 'Marked complete' : 'Dismissed'} · {entry.whyTag}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {top5Combined.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '.3px', color: 'var(--urgency-hot)' }}>TOP 5 RIGHT NOW</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 22 }}>
                  {top5Combined.map((item, idx) => {
                    const color = item.isPinned ? 'var(--pin-color)' : urgencyColor(item.queueScore)
                    const name = displayName(item)
                    return (
                      <div key={item.id} style={{
                        borderRadius: 14, padding: '13px 16px', display: 'flex', gap: 11, alignItems: 'flex-start',
                        background: `color-mix(in srgb, ${color} 10%, var(--bg-panel))`,
                        border: `1px solid color-mix(in srgb, ${color} 40%, var(--border))`,
                        boxShadow: 'var(--shadow-soft)',
                      }}>
                        {item.isPinned ? (
                          <div style={{ width: 20, height: 20, borderRadius: '50%', background: color, color: 'var(--bg)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            📌
                          </div>
                        ) : (
                          <div style={{ width: 20, height: 20, borderRadius: '50%', background: color, color: 'var(--bg)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {idx + 1}
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{name}{displayCompany(item) ? ` · ${displayCompany(item)}` : ''}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                            <span style={{ color: 'var(--text-tertiary)' }}>Why: </span>{item.rationale || item.whyTag}
                          </div>
                        </div>
                        <button onClick={() => togglePin(item.id, name)}
                          style={{
                            flexShrink: 0, fontSize: 11, padding: '4px 9px', borderRadius: 6, cursor: 'pointer',
                            background: item.isPinned ? color : 'none',
                            color: item.isPinned ? 'var(--bg)' : 'var(--text-tertiary)',
                            border: item.isPinned ? 'none' : '1px solid var(--border-strong)',
                          }}>
                          {item.isPinned ? 'Remove pin' : 'Pin here'}
                        </button>
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
              Full queue · {restOfQueue.length} items{restOfQueue.length > 10 ? ` · showing ${Math.min(visibleCount, restOfQueue.length)}` : ''}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {restOfQueue.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>Queue clear.</div>
              )}
              {pagedQueue.map(item => {
                const color = urgencyColor(item.queueScore)
                const isPinned = pinnedIds.has(item.id)
                const name = displayName(item)
                return (
                  <div key={item.id} onClick={() => setSelectedId(item.id)} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer',
                    borderRadius: 10, border: `1.5px solid ${color}`,
                    background: `color-mix(in srgb, ${color} 12%, transparent)`,
                    outline: selectedId === item.id ? '2px solid var(--urgency-hot)' : 'none',
                  }}>
                    <button onClick={e => { e.stopPropagation(); markDone(item) }}
                      title={item.source === 'todo' ? 'Mark complete' : 'Dismiss from this session'}
                      style={{ width: 16, height: 16, borderRadius: 5, border: '1.5px solid var(--border-strong)', background: 'none', cursor: 'pointer', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{name}{displayCompany(item) ? ` · ${displayCompany(item)}` : ''}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                        <span style={{ color: 'var(--text-tertiary)' }}>{sourceLabel(item.source)} · </span>{item.whyTag || 'No reason recorded'}
                      </div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); togglePin(item.id, name) }}
                      style={{
                        flexShrink: 0, fontSize: 11, padding: '4px 9px', borderRadius: 6, cursor: 'pointer',
                        background: isPinned ? 'var(--pin-color)' : 'none',
                        color: isPinned ? 'var(--bg)' : 'var(--text-tertiary)',
                        border: isPinned ? 'none' : '1px solid var(--border-strong)',
                      }}>
                      {isPinned ? 'Pinned' : 'Pin to Top 5'}
                    </button>
                  </div>
                )
              })}
            </div>

            {restOfQueue.length > visibleCount && (
              <button onClick={() => setVisibleCount(c => c + 10)}
                style={{ width: '100%', marginTop: 12, padding: '10px', background: 'var(--bg-panel)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 'var(--radius)', fontSize: 12.5, cursor: 'pointer' }}>
                Show 10 more ({restOfQueue.length - visibleCount} remaining)
              </button>
            )}
            {visibleCount > 10 && restOfQueue.length <= visibleCount && (
              <button onClick={() => setVisibleCount(10)}
                style={{ width: '100%', marginTop: 12, padding: '10px', background: 'none', border: 'none', color: 'var(--text-tertiary)', fontSize: 12.5, cursor: 'pointer' }}>
                Show less
              </button>
            )}
          </>
        )}
      </div>

      <div style={{ padding: 20 }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>Context</div>
        {selectedItem ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>{displayName(selectedItem)}</div>
            {displayCompany(selectedItem) && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>{displayCompany(selectedItem)}</div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              Why it's in the queue
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {selectedItem.whyTag || 'No reason recorded'}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Select an item to see details.</div>
        )}
      </div>
    </div>
  )
}
