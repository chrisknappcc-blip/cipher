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
  const [refreshTick, setRefreshTick] = useState(0) // re-render every 10s so the "updated Xs ago" label stays current
  const [discussedIds, setDiscussedIds] = useState(new Set())

  useEffect(() => {
    Promise.all([
      apiFetch('/api/hubspot/pipeline-review/config', getToken),
      apiFetch('/api/hubspot/owners', getToken).catch(() => ({ owners: [] })),
      apiFetch('/api/hubspot/pipeline-review/discussed', getToken).catch(() => ({ dealIds: [] })),
    ]).then(([configRes, ownersRes, discussedRes]) => {
      setConfig(configRes.pipelines)
      setOwners(ownersRes.owners || [])
      setDiscussedIds(new Set(discussedRes.dealIds || []))
      const firstPipelineId = Object.keys(configRes.pipelines || {})[0]
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
  }, [activePipeline, ownerFilter, getToken])

  useEffect(() => { loadDeals() }, [loadDeals])

  // Ref so the auto-refresh interval below always calls the CURRENT
  // loadDeals (which changes identity when pipeline/owner filter change)
  // instead of closing over a stale version from when the interval started.
  const loadDealsRef = useRef(loadDeals)
  useEffect(() => { loadDealsRef.current = loadDeals }, [loadDeals])

  // Auto-refresh every 90s while this tab is open, so data stays current
  // during the live meeting without anyone needing to remember to refresh.
  useEffect(() => {
    const interval = setInterval(() => loadDealsRef.current(), 90 * 1000)
    return () => clearInterval(interval)
  }, [])

  const filteredDeals = useMemo(() => {
    return deals.filter(d => {
      if (minAmount && (!d.amount || Number(d.amount) < Number(minAmount))) return false
      if (maxAmount && (!d.amount || Number(d.amount) > Number(maxAmount))) return false
      if (closeBefore && (!d.closeDate || new Date(d.closeDate) > new Date(closeBefore))) return false
      if (closeAfter && (!d.closeDate || new Date(d.closeDate) < new Date(closeAfter))) return false
      if (staleOnly && !(daysAgo(d.lastContact) > 14)) return false
      return true
    })
  }, [deals, minAmount, maxAmount, closeBefore, closeAfter, staleOnly])

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

  const dealsByStage = useMemo(() => {
    const map = {}
    for (const stage of stages) map[stage.id] = []
    for (const deal of sortedDeals) {
      if (map[deal.stageId]) map[deal.stageId].push(deal)
    }
    return map
  }, [sortedDeals, stages])

  const selectedDeal = deals.find(d => d.id === selectedDealId) || null

  useEffect(() => {
    if (!selectedDealId) { setRecap([]); return }
    let cancelled = false
    setRecapLoading(true)
    apiFetch(`/api/hubspot/pipeline-review/deal/${selectedDealId}`, getToken)
      .then(data => { if (!cancelled) setRecap(data.recap || []) })
      .catch(() => { if (!cancelled) setRecap([]) })
      .finally(() => { if (!cancelled) setRecapLoading(false) })
    return () => { cancelled = true }
  }, [selectedDealId, getToken])

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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16, background: 'var(--bg)', color: 'var(--text)', minHeight: '100%', padding: 4 }}>

      <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)' }}>

        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {Object.entries(config).map(([id, p]) => (
            <button key={id} onClick={() => setActivePipeline(id)}
              style={{
                padding: '8px 14px', borderRadius: 'var(--radius)', fontSize: 12.5, cursor: 'pointer',
                background: activePipeline === id ? 'var(--accent)' : 'var(--bg-secondary)',
                color: activePipeline === id ? '#fff' : 'var(--text-secondary)',
                border: '1px solid ' + (activePipeline === id ? 'var(--accent)' : 'var(--border)'),
              }}>
              {p.label}
            </button>
          ))}

          <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)}
            style={{ marginLeft: 'auto', background: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12.5, padding: '8px 10px' }}>
            <option value="">Whole team</option>
            {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>

          <button onClick={() => setPresentationMode(p => !p)}
            style={{ fontSize: 12.5, padding: '8px 12px', borderRadius: 'var(--radius)', cursor: 'pointer', background: presentationMode ? 'var(--accent)' : 'var(--bg-secondary)', color: presentationMode ? '#fff' : 'var(--text-secondary)', border: '1px solid ' + (presentationMode ? 'var(--accent)' : 'var(--border)') }}>
            {presentationMode ? '✓ Presenting' : 'Presentation mode'}
          </button>
        </div>

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
            {stages.map(stage => {
              const stageDeals = dealsByStage[stage.id] || []
              if (stageDeals.length === 0) return null
              const isCollapsed = collapsedStages.has(stage.id)
              return (
                <div key={stage.id}>
                  <div onClick={() => toggleStage(stage.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{stage.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', borderRadius: 10, padding: '1px 8px' }}>
                      {stageDeals.filter(d => discussedIds.has(d.id)).length}/{stageDeals.length}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{isCollapsed ? 'Show' : 'Hide'}</span>
                  </div>
                  {!isCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {stageDeals.map(deal => {
                        const isDiscussed = discussedIds.has(deal.id)
                        return (
                        <div key={deal.id} onClick={() => setSelectedDealId(deal.id)} style={{
                          padding: '13px 15px', borderRadius: 12, cursor: 'pointer',
                          border: selectedDealId === deal.id ? '1px solid var(--accent)' : '1px solid var(--border)',
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
                              <div style={{ fontSize: 13.5, fontWeight: 500, textDecoration: isDiscussed ? 'line-through' : 'none' }}>{deal.name}</div>
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                              {deal.companyName || 'No company'} · {deal.ownerName || 'Unassigned'}
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
                              {deal.lastContactSource === 'company' && (
                                <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', marginTop: 1 }}>via company, not tagged to deal</div>
                              )}
                            </div>
                          </div>

                          {deal.nextStep && (
                            <div style={{ fontSize: 12, color: 'var(--accent-text)', marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                              Next: {deal.nextStep}
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
            {sortedDeals.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>
                No deals match{filtersActive ? ' the current filters' : ` in this pipeline${ownerFilter ? ' for this person' : ''}`}.
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)', alignSelf: 'start' }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>Talking points</div>
        {selectedDeal ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>{selectedDeal.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
              {selectedDeal.companyName || 'No company'} · {selectedDeal.ownerName || 'Unassigned'}
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
                {selectedDeal.lastContactSource === 'company' && (
                  <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', marginTop: 1 }}>via company record</div>
                )}
              </div>
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>
              Next step
            </div>
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, marginBottom: 16 }}>
              {selectedDeal.nextStep || <span style={{ color: 'var(--text-tertiary)' }}>No next step recorded in HubSpot.</span>}
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
                    <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
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
