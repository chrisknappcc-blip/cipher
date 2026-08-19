// src/PipelineReviewView.jsx
// REPLACE — path from repo root: src/PipelineReviewView.jsx
//
// Built for the bi-weekly leadership pipeline walkthrough. Three pipelines
// (using HubSpot's own pipeline and stage names exactly, verified against
// live data rather than assumed), each broken into stages, whole team by
// default with an owner filter to narrow to one person.
//
// This pass adds: sort (amount, close date, last contact, name) applied
// within each stage group, filters (amount range, close date range, stale
// deals only), and a redesigned card with a prominent stat row — amount,
// close date, and last contact are now bold and color-coded instead of
// buried in a small gray subtitle line.
//
// "Last contact" uses notes_last_updated (HubSpot's own "Last Activity
// Date" — auto-maintained across notes/calls/emails/meetings/tasks), not
// hs_lastmodifieddate, since the latter just means "some field changed,"
// not "someone actually engaged with this deal."

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { apiFetch } from './api'

function formatAmount(amount) {
  if (!amount) return null
  const n = Number(amount)
  if (Number.isNaN(n)) return null
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function daysAgo(iso) {
  if (!iso) return null
  return Math.round((Date.now() - new Date(iso).getTime()) / 86400000)
}

function daysUntil(iso) {
  if (!iso) return null
  return Math.round((new Date(iso).getTime() - Date.now()) / 86400000)
}

function formatDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function lastContactColor(iso) {
  const d = daysAgo(iso)
  if (d == null) return 'var(--text-tertiary)'
  if (d > 30) return 'var(--urgency-stale)'
  if (d > 14) return 'var(--amber)'
  return 'var(--text-secondary)'
}

function closeDateColor(iso) {
  const d = daysUntil(iso)
  if (d == null) return 'var(--text-tertiary)'
  if (d < 0) return 'var(--urgency-stale)' // past close date, still open — worth calling out
  if (d <= 14) return 'var(--amber)'
  return 'var(--text-secondary)'
}

const SORT_OPTIONS = [
  { key: 'closeDate', label: 'Close date' },
  { key: 'amount', label: 'Deal size' },
  { key: 'lastContact', label: 'Last contact' },
  { key: 'name', label: 'Name' },
]

export default function PipelineReviewView({ getToken }) {
  const [config, setConfig] = useState(null)
  const [owners, setOwners] = useState([])
  const [activePipeline, setActivePipeline] = useState(null)
  const [ownerFilter, setOwnerFilter] = useState('')
  const [deals, setDeals] = useState([])
  const [stages, setStages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedDealId, setSelectedDealId] = useState(null)
  const [recap, setRecap] = useState([])
  const [recapLoading, setRecapLoading] = useState(false)
  const [collapsedStages, setCollapsedStages] = useState(new Set())

  const [sortField, setSortField] = useState('closeDate')
  const [sortDir, setSortDir] = useState('asc')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [closeBefore, setCloseBefore] = useState('')
  const [closeAfter, setCloseAfter] = useState('')
  const [staleOnly, setStaleOnly] = useState(false)

  // Live meeting features: presentation mode hides prep clutter, auto-refresh
  // keeps data current while the meeting runs, discussed tracking persists
  // so a mid-meeting reload doesn't lose progress.
  const [presentationMode, setPresentationMode] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [discussedIds, setDiscussedIds] = useState(new Set())

  // Company filter — searches ALL THREE pipelines at once for one company,
  // since a company's deals commonly span more than one pipeline.
  const [companyFilter, setCompanyFilter] = useState('')
  const [companyModeActive, setCompanyModeActive] = useState(false)

  // Focus Deal — SHARED across everyone (not scoped to the current user),
  // since someone curates this list before the meeting and everyone needs
  // to see the same curated set.
  const [focusIds, setFocusIds] = useState(new Set())
  const [focusOnly, setFocusOnly] = useState(false)

  // Hide pipelines that aren't relevant to this meeting (e.g. the early-
  // funnel Opportunity pipeline) — a personal display preference, so it's
  // stored locally rather than shared across everyone.
  const [hiddenPipelines, setHiddenPipelines] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('cipher-pipeline-review-hidden') || '[]')) }
    catch { return new Set() }
  })
  const togglePipelineHidden = (pipelineId) => {
    setHiddenPipelines(prev => {
      const next = new Set(prev)
      next.has(pipelineId) ? next.delete(pipelineId) : next.add(pipelineId)
      localStorage.setItem('cipher-pipeline-review-hidden', JSON.stringify([...next]))
      return next
    })
  }

  useEffect(() => {
    Promise.all([
      apiFetch('/api/hubspot/pipeline-review/config', getToken),
      apiFetch('/api/hubspot/owners', getToken).catch(() => ({ owners: [] })),
      apiFetch('/api/hubspot/pipeline-review/discussed', getToken).catch(() => ({ dealIds: [] })),
      apiFetch('/api/hubspot/pipeline-review/focus', getToken).catch(() => ({ dealIds: [] })),
    ]).then(([configRes, ownersRes, discussedRes, focusRes]) => {
      setConfig(configRes.pipelines)
      setOwners(ownersRes.owners || [])
      setDiscussedIds(new Set(discussedRes.dealIds || []))
      setFocusIds(new Set(focusRes.dealIds || []))
      const firstPipelineId = Object.keys(configRes.pipelines || {}).find(id => !hiddenPipelines.has(id)) || Object.keys(configRes.pipelines || {})[0]
      setActivePipeline(firstPipelineId)
    }).catch(e => setError(e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Purely a 10s tick to keep the "updated Xs ago" label live — doesn't
  // refetch anything, just forces a re-render of the timestamp display.
  useEffect(() => {
    const interval = setInterval(() => setRefreshTick(t => t + 1), 10 * 1000)
    return () => clearInterval(interval)
  }, [])

  const loadDeals = useCallback(async () => {
    if (companyModeActive) {
      if (!companyFilter.trim()) return
      setLoading(true)
      setError(null)
      try {
        const qs = new URLSearchParams({ company: companyFilter.trim() })
        const data = await apiFetch(`/api/hubspot/pipeline-review?${qs}`, getToken)
        setDeals(data.deals || [])
        setStages([])
        setLastRefreshed(Date.now())
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
      return
    }
    if (!activePipeline) return
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ pipeline: activePipeline })
      if (ownerFilter) qs.set('ownerId', ownerFilter)
      const data = await apiFetch(`/api/hubspot/pipeline-review?${qs}`, getToken)
      setDeals(data.deals || [])
      setStages(data.stages || [])
      setLastRefreshed(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [activePipeline, ownerFilter, companyModeActive, companyFilter, getToken])

  useEffect(() => { loadDeals() }, [loadDeals])

  // Ref so the auto-refresh interval below always calls the CURRENT
  // loadDeals (which changes identity when pipeline/owner filter change)
  // instead of closing over a stale version from when the interval started.
  const loadDealsRef = useRef(loadDeals)
  useEffect(() => { loadDealsRef.current = loadDeals }, [loadDeals])

  // Auto-refresh twice a day — this was firing every 90 seconds before,
  // which was excessive for a bi-weekly meeting tool and just meant
  // constant background API calls with no real benefit. Manual "Refresh
  // now" (below) is there for the actual moment it matters — right before
  // or during the meeting.
  useEffect(() => {
    const interval = setInterval(() => loadDealsRef.current(), 12 * 60 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const filteredDeals = useMemo(() => {
    return deals.filter(d => {
      if (minAmount && (!d.amount || Number(d.amount) < Number(minAmount))) return false
      if (maxAmount && (!d.amount || Number(d.amount) > Number(maxAmount))) return false
      if (closeBefore && (!d.closeDate || new Date(d.closeDate) > new Date(closeBefore))) return false
      if (closeAfter && (!d.closeDate || new Date(d.closeDate) < new Date(closeAfter))) return false
      if (staleOnly && !(daysAgo(d.lastContact) > 14)) return false
      if (focusOnly && !focusIds.has(d.id)) return false
      return true
    })
  }, [deals, minAmount, maxAmount, closeBefore, closeAfter, staleOnly, focusOnly, focusIds])

  const sortedDeals = useMemo(() => {
    const sorted = [...filteredDeals]
    sorted.sort((a, b) => {
      let av, bv
      if (sortField === 'amount') { av = Number(a.amount) || 0; bv = Number(b.amount) || 0 }
      else if (sortField === 'closeDate') { av = a.closeDate ? new Date(a.closeDate).getTime() : Infinity; bv = b.closeDate ? new Date(b.closeDate).getTime() : Infinity }
      else if (sortField === 'lastContact') { av = a.lastContact ? new Date(a.lastContact).getTime() : 0; bv = b.lastContact ? new Date(b.lastContact).getTime() : 0 }
      else { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase() }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return sorted
  }, [filteredDeals, sortField, sortDir])

  // Unified grouping for both modes. Pipeline mode groups by the fixed
  // stage list for that one pipeline. Company mode has no single fixed
  // stage list (deals can span all three pipelines), so it groups by
  // pipeline first, then by that pipeline's own stage order.
  const sections = useMemo(() => {
    if (companyModeActive) {
      if (!config) return []
      const byPipeline = {}
      for (const deal of sortedDeals) {
        const pid = deal.pipelineId
        if (!byPipeline[pid]) byPipeline[pid] = []
        byPipeline[pid].push(deal)
      }
      const result = []
      Object.keys(byPipeline).filter(pid => !hiddenPipelines.has(pid)).forEach(pid => {
        const pLabel = config[pid]?.label || 'Unknown pipeline'
        const stageOrder = config[pid]?.stages || []
        stageOrder.forEach(stage => {
          const stageDeals = byPipeline[pid].filter(d => d.stageId === stage.id)
          if (stageDeals.length > 0) {
            result.push({ key: `${pid}-${stage.id}`, label: `${pLabel} · ${stage.label}`, deals: stageDeals })
          }
        })
      })
      return result
    }
    return stages
      .map(stage => ({ key: stage.id, label: stage.label, deals: sortedDeals.filter(d => d.stageId === stage.id) }))
      .filter(s => s.deals.length > 0)
  }, [companyModeActive, sortedDeals, config, stages, hiddenPipelines])

  const selectedDeal = deals.find(d => d.id === selectedDealId) || null
  const [lastMeeting, setLastMeeting] = useState(null)

  useEffect(() => {
    if (!selectedDealId) { setRecap([]); setLastMeeting(null); return }
    let cancelled = false
    setRecapLoading(true)
    apiFetch(`/api/hubspot/pipeline-review/deal/${selectedDealId}`, getToken)
      .then(data => { if (!cancelled) { setRecap(data.recap || []); setLastMeeting(data.lastMeeting || null) } })
      .catch(() => { if (!cancelled) { setRecap([]); setLastMeeting(null) } })
      .finally(() => { if (!cancelled) setRecapLoading(false) })
    return () => { cancelled = true }
  }, [selectedDealId, getToken])

  const containerRef = useRef(null)

  // Real fullscreen, not just an internal style flag — fullscreening this
  // component's own container hides everything outside it (the app's
  // sidebar and header) automatically, since the browser only shows the
  // fullscreened element and its children while active.
  const togglePresentationMode = async () => {
    if (!presentationMode) {
      try { await containerRef.current?.requestFullscreen?.() } catch { /* fullscreen may be blocked, still apply the larger-view styling below */ }
      setPresentationMode(true)
    } else {
      if (document.fullscreenElement) {
        try { await document.exitFullscreen() } catch { /* ignore */ }
      }
      setPresentationMode(false)
    }
  }

  // Keep state in sync if the user exits fullscreen via Esc instead of the button.
  useEffect(() => {
    const onFsChange = () => { if (!document.fullscreenElement) setPresentationMode(false) }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const toggleStage = (stageId) => {
    setCollapsedStages(prev => {
      const next = new Set(prev)
      next.has(stageId) ? next.delete(stageId) : next.add(stageId)
      return next
    })
  }

  const clearFilters = () => {
    setMinAmount(''); setMaxAmount(''); setCloseBefore(''); setCloseAfter(''); setStaleOnly(false)
  }
  const filtersActive = minAmount || maxAmount || closeBefore || closeAfter || staleOnly

  const toggleDiscussed = async (dealId, e) => {
    e.stopPropagation()
    const nowDiscussed = !discussedIds.has(dealId)
    setDiscussedIds(prev => {
      const next = new Set(prev)
      nowDiscussed ? next.add(dealId) : next.delete(dealId)
      return next
    })
    try {
      await apiFetch('/api/hubspot/pipeline-review/discussed', getToken, {
        method: 'POST',
        body: JSON.stringify({ dealId, discussed: nowDiscussed }),
      })
    } catch {
      // Revert on failure
      setDiscussedIds(prev => {
        const next = new Set(prev)
        nowDiscussed ? next.delete(dealId) : next.add(dealId)
        return next
      })
    }
  }

  const resetMeeting = async () => {
    if (!window.confirm('Clear all "discussed" checkmarks to start a fresh meeting?')) return
    setDiscussedIds(new Set())
    try {
      await apiFetch('/api/hubspot/pipeline-review/discussed/reset', getToken, { method: 'POST' })
    } catch (e) {
      setError(`Couldn't reset: ${e.message}`)
    }
  }

  const toggleFocus = async (dealId, e) => {
    e.stopPropagation()
    const nowFocused = !focusIds.has(dealId)
    setFocusIds(prev => {
      const next = new Set(prev)
      nowFocused ? next.add(dealId) : next.delete(dealId)
      return next
    })
    try {
      await apiFetch('/api/hubspot/pipeline-review/focus', getToken, {
        method: 'POST',
        body: JSON.stringify({ dealId, focus: nowFocused }),
      })
    } catch {
      setFocusIds(prev => {
        const next = new Set(prev)
        nowFocused ? next.delete(dealId) : next.add(dealId)
        return next
      })
    }
  }

  const submitCompanySearch = () => {
    if (!companyFilter.trim()) return
    setCompanyModeActive(true)
  }
  const clearCompanySearch = () => {
    setCompanyFilter('')
    setCompanyModeActive(false)
  }

  const refreshedLabel = useMemo(() => {
    void refreshTick // dependency to force recompute on tick
    if (!lastRefreshed) return null
    const secs = Math.round((Date.now() - lastRefreshed) / 1000)
    if (secs < 60) return `Updated ${secs}s ago`
    return `Updated ${Math.round(secs / 60)}m ago`
  }, [lastRefreshed, refreshTick])

  if (!config) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  const inputStyle = { background: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12, padding: '6px 9px', width: 110 }

  return (
    <div ref={containerRef} style={{
      display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16,
      background: 'var(--bg)', color: 'var(--text)', minHeight: '100%', padding: 4,
      zoom: presentationMode ? 1.3 : 1,
    }}>

      <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)' }}>

        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {Object.entries(config).filter(([id]) => !hiddenPipelines.has(id)).map(([id, p]) => (
            <div key={id} style={{ position: 'relative', display: 'flex' }}>
              <button onClick={() => { setCompanyModeActive(false); setActivePipeline(id) }}
                disabled={companyModeActive}
                style={{
                  padding: '8px 26px 8px 14px', borderRadius: 'var(--radius)', fontSize: 12.5, cursor: companyModeActive ? 'default' : 'pointer',
                  opacity: companyModeActive ? 0.4 : 1,
                  background: activePipeline === id && !companyModeActive ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: activePipeline === id && !companyModeActive ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid ' + (activePipeline === id && !companyModeActive ? 'var(--accent)' : 'var(--border)'),
                }}>
                {p.label}
              </button>
              {!companyModeActive && (
                <button onClick={(e) => {
                    e.stopPropagation()
                    togglePipelineHidden(id)
                    if (activePipeline === id) {
                      const nextVisible = Object.keys(config).find(pid => pid !== id && !hiddenPipelines.has(pid))
                      if (nextVisible) setActivePipeline(nextVisible)
                    }
                  }}
                  title={`Hide ${p.label}`}
                  style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: activePipeline === id ? 'rgba(255,255,255,0.7)' : 'var(--text-tertiary)', padding: 2, lineHeight: 1 }}>
                  ×
                </button>
              )}
            </div>
          ))}

          {hiddenPipelines.size > 0 && !companyModeActive && (
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {hiddenPipelines.size} hidden ·{' '}
              {[...hiddenPipelines].map(id => (
                <button key={id} onClick={() => togglePipelineHidden(id)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent-text)', cursor: 'pointer', fontSize: 11.5, textDecoration: 'underline', padding: '0 2px' }}>
                  Show {config[id]?.label}
                </button>
              ))}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)} disabled={companyModeActive}
            style={{ background: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12.5, padding: '8px 10px', opacity: companyModeActive ? 0.4 : 1 }}>
            <option value="">Whole team</option>
            {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <input value={companyFilter} onChange={e => setCompanyFilter(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitCompanySearch() }}
              placeholder="Filter by company, e.g. AdventHealth"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12.5, padding: '8px 10px', width: 210 }} />
            {companyModeActive ? (
              <button onClick={clearCompanySearch} style={{ fontSize: 12.5, padding: '8px 12px', borderRadius: 'var(--radius)', cursor: 'pointer', background: 'var(--manager-color)', color: '#fff', border: 'none' }}>
                Clear
              </button>
            ) : (
              <button onClick={submitCompanySearch} style={{ fontSize: 12.5, padding: '8px 12px', borderRadius: 'var(--radius)', cursor: 'pointer', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                Search
              </button>
            )}
          </div>

          <button onClick={togglePresentationMode}
            style={{ fontSize: 12.5, padding: '8px 12px', borderRadius: 'var(--radius)', cursor: 'pointer', background: presentationMode ? 'var(--accent)' : 'var(--bg-secondary)', color: presentationMode ? '#fff' : 'var(--text-secondary)', border: '1px solid ' + (presentationMode ? 'var(--accent)' : 'var(--border)') }}>
            {presentationMode ? '✓ Presenting (Esc to exit)' : 'Presentation mode'}
          </button>
        </div>

        {companyModeActive && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
            Showing all pipelines for "{companyFilter}" · {deals.length} deal{deals.length !== 1 ? 's' : ''}
          </div>
        )}

        {/* Live-meeting status row: freshness, manual refresh, discussed progress, reset */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {refreshedLabel && <span>{refreshedLabel}</span>}
          <button onClick={loadDeals} disabled={loading}
            style={{ color: 'var(--accent-text)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, padding: 0 }}>
            {loading ? 'Refreshing…' : 'Refresh now'}
          </button>
          <span style={{ marginLeft: 'auto' }}>
            {deals.filter(d => discussedIds.has(d.id)).length} of {deals.length} discussed
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={focusOnly} onChange={e => setFocusOnly(e.target.checked)} />
            Focus deals only
          </label>
          <button onClick={resetMeeting} style={{ color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, padding: 0, textDecoration: 'underline' }}>
            New meeting
          </button>
        </div>

        {!presentationMode && (
        <>
        {/* Sort + filter toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Sort by</span>
          {SORT_OPTIONS.map(opt => (
            <button key={opt.key} onClick={() => {
              if (sortField === opt.key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
              else { setSortField(opt.key); setSortDir('asc') }
            }}
              style={{
                fontSize: 11.5, padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
                background: sortField === opt.key ? 'var(--accent)' : 'var(--bg-secondary)',
                color: sortField === opt.key ? '#fff' : 'var(--text-secondary)',
                border: '1px solid ' + (sortField === opt.key ? 'var(--accent)' : 'var(--border)'),
              }}>
              {opt.label}{sortField === opt.key && (sortDir === 'asc' ? ' ↑' : ' ↓')}
            </button>
          ))}
          <button onClick={() => setFiltersOpen(o => !o)}
            style={{ marginLeft: 'auto', fontSize: 11.5, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', background: filtersActive ? 'var(--manager-color)' : 'var(--bg-secondary)', color: filtersActive ? '#fff' : 'var(--text-secondary)', border: '1px solid ' + (filtersActive ? 'var(--manager-color)' : 'var(--border)') }}>
            Filters{filtersActive ? ' •' : ''}
          </button>
        </div>

        {filtersOpen && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14, padding: 12, background: 'var(--bg-secondary)', borderRadius: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>Min amount</div>
              <input type="number" value={minAmount} onChange={e => setMinAmount(e.target.value)} placeholder="$0" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>Max amount</div>
              <input type="number" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} placeholder="Any" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>Close after</div>
              <input type="date" value={closeAfter} onChange={e => setCloseAfter(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>Close before</div>
              <input type="date" value={closeBefore} onChange={e => setCloseBefore(e.target.value)} style={inputStyle} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', paddingBottom: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={staleOnly} onChange={e => setStaleOnly(e.target.checked)} />
              No contact in 14+ days
            </label>
            {filtersActive && (
              <button onClick={clearFilters} style={{ fontSize: 11.5, color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer', paddingBottom: 6 }}>
                Clear
              </button>
            )}
          </div>
        )}
        </>
        )}

        {error && (
          <div style={{ background: 'var(--red-light)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>Loading deals…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {sections.map(section => {
              const isCollapsed = collapsedStages.has(section.key)
              return (
                <div key={section.key}>
                  <div onClick={() => toggleStage(section.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{section.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', borderRadius: 10, padding: '1px 8px' }}>
                      {section.deals.filter(d => discussedIds.has(d.id)).length}/{section.deals.length}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{isCollapsed ? 'Show' : 'Hide'}</span>
                  </div>
                  {!isCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {section.deals.map(deal => {
                        const isDiscussed = discussedIds.has(deal.id)
                        const isFocused = focusIds.has(deal.id)
                        return (
                        <div key={deal.id} onClick={() => setSelectedDealId(deal.id)} style={{
                          padding: '13px 15px', borderRadius: 12, cursor: 'pointer',
                          border: isFocused ? '1.5px solid var(--pin-color)' : (selectedDealId === deal.id ? '1px solid var(--accent)' : '1px solid var(--border)'),
                          background: selectedDealId === deal.id ? 'var(--bg-hover)' : 'var(--bg-secondary)',
                          opacity: isDiscussed ? 0.55 : 1,
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <button onClick={(e) => toggleDiscussed(deal.id, e)} title={isDiscussed ? 'Mark not discussed' : 'Mark discussed'}
                                style={{
                                  width: 18, height: 18, borderRadius: 6, flexShrink: 0, cursor: 'pointer',
                                  border: '1.5px solid ' + (isDiscussed ? 'var(--accent)' : 'var(--border-strong)'),
                                  background: isDiscussed ? 'var(--accent)' : 'var(--bg)',
                                  color: '#fff', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                }}>
                                {isDiscussed ? '✓' : ''}
                              </button>
                              <button onClick={(e) => toggleFocus(deal.id, e)} title={isFocused ? 'Remove focus' : 'Mark as Focus Deal'}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
                                  padding: '4px 9px', borderRadius: 8,
                                  border: '1.5px solid ' + (isFocused ? 'var(--pin-color)' : 'var(--border-strong)'),
                                  background: isFocused ? 'var(--pin-color)' : 'var(--bg)',
                                  color: isFocused ? '#fff' : 'var(--text-secondary)',
                                }}>
                                <span>★</span> Focus
                              </button>
                              <a href={deal.hubspotDealUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                                style={{ fontSize: 13.5, fontWeight: 500, textDecoration: isDiscussed ? 'line-through' : 'none', color: 'var(--text)' }}>
                                {deal.name}
                              </a>
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                              {deal.hubspotCompanyUrl ? (
                                <a href={deal.hubspotCompanyUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                                  style={{ color: 'var(--text-tertiary)' }}>
                                  {deal.companyName || 'No company'}
                                </a>
                              ) : (deal.companyName || 'No company')}
                              {' · '}{deal.ownerName || 'Unassigned'}
                              {companyModeActive && deal.stageLabel && ` · ${deal.stageLabel}`}
                            </div>
                          </div>

                          {/* Prominent stat row — this is the "easier to call out" part */}
                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            <div>
                              <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Deal size</div>
                              <div style={{ fontSize: 14, fontWeight: 600 }}>{formatAmount(deal.amount) || '—'}</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Close date</div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: closeDateColor(deal.closeDate) }}>
                                {formatDate(deal.closeDate) || '—'}
                              </div>
                            </div>
                            <div>
                              <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Last contact</div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: lastContactColor(deal.lastContact) }}>
                                {daysAgo(deal.lastContact) != null ? `${daysAgo(deal.lastContact)}d ago` : 'No activity logged'}
                              </div>
                              {deal.lastContactSource && deal.lastContactSource !== 'deal' && (
                                <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', marginTop: 1 }}>via {deal.lastContactSource}, not tagged to deal</div>
                              )}
                            </div>
                          </div>

                          {(deal.currentStatus || deal.nextStep) && (
                            <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {deal.currentStatus && (
                                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                  <strong style={{ color: 'var(--text)' }}>Status:</strong> {deal.currentStatus}
                                </div>
                              )}
                              {deal.nextStep && (
                                <div style={{ fontSize: 12, color: 'var(--accent-text)' }}>
                                  <strong>Next:</strong> {deal.nextStep}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
            {sections.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>
                {companyModeActive
                  ? `No open deals found for "${companyFilter}".`
                  : `No deals match${filtersActive ? ' the current filters' : ` in this pipeline${ownerFilter ? ' for this person' : ''}`}.`}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)', position: 'sticky', top: 76, maxHeight: 'calc(100vh - 96px)', overflowY: 'auto' }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>Talking points</div>
        {selectedDeal ? (
          <>
            <a href={selectedDeal.hubspotDealUrl} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 14, fontWeight: 500, marginBottom: 2, color: 'var(--text)', display: 'block' }}>
              {selectedDeal.name}
            </a>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
              {selectedDeal.hubspotCompanyUrl ? (
                <a href={selectedDeal.hubspotCompanyUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-secondary)' }}>
                  {selectedDeal.companyName || 'No company'}
                </a>
              ) : (selectedDeal.companyName || 'No company')}
              {' · '}{selectedDeal.ownerName || 'Unassigned'}
            </div>

            <div style={{ display: 'flex', gap: 16, marginBottom: 16, borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', padding: '12px 0' }}>
              <div>
                <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Size</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{formatAmount(selectedDeal.amount) || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Close</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: closeDateColor(selectedDeal.closeDate) }}>{formatDate(selectedDeal.closeDate) || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Last contact</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: lastContactColor(selectedDeal.lastContact) }}>
                  {daysAgo(selectedDeal.lastContact) != null ? `${daysAgo(selectedDeal.lastContact)}d ago` : '—'}
                </div>
                {selectedDeal.lastContactSource && selectedDeal.lastContactSource !== 'deal' && (
                  <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', marginTop: 1 }}>via {selectedDeal.lastContactSource} record</div>
                )}
              </div>
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>
              Current status
            </div>
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 16 }}>
              {selectedDeal.currentStatus || <span style={{ color: 'var(--text-tertiary)' }}>Not recorded in HubSpot.</span>}
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>
              Next step
            </div>
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 16 }}>
              {selectedDeal.nextStep || <span style={{ color: 'var(--text-tertiary)' }}>No next step recorded in HubSpot.</span>}
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>
              Last meeting
            </div>
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 16 }}>
              {recapLoading ? (
                <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span>
              ) : lastMeeting ? (
                <>
                  {lastMeeting.subject} — {formatDate(lastMeeting.timestamp)}
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginLeft: 6 }}>
                    (via {lastMeeting.source === 'outlook' ? 'Outlook' : 'HubSpot'})
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>No meeting found in HubSpot or Outlook.</span>
              )}
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>
              Recent activity
            </div>
            {recapLoading ? (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Loading…</div>
            ) : recap.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No recent notes or logged activity found.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {recap.map((e, i) => (
                  <div key={i} style={{ fontSize: 12, padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <div style={{ color: 'var(--text-tertiary)', fontSize: 10.5, textTransform: 'uppercase', marginBottom: 3 }}>
                      {e.type}{daysAgo(e.timestamp) != null && ` · ${daysAgo(e.timestamp)}d ago`}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-line' }}>
                      {(e.body || e.subject || '').slice(0, 280)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Select a deal to see its recap and next steps.</div>
        )}
      </div>
    </div>
  )
}
