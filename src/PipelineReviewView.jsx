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
  const [selectedPipelines, setSelectedPipelines] = useState(new Set())
  const [ownerFilter, setOwnerFilter] = useState('')
  const [deals, setDeals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedDealId, setSelectedDealId] = useState(null)
  const [recap, setRecap] = useState([])
  const [recapLoading, setRecapLoading] = useState(false)
  const [collapsedStages, setCollapsedStages] = useState(new Set())

  const [sortField, setSortField] = useState(null)
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

  // ── Snapshot / comparison feature ──────────────────────────────────
  const [subView, setSubView] = useState('review') // 'review' | 'snapshots'
  const [snapshotsList, setSnapshotsList] = useState([])
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [snapshotsError, setSnapshotsError] = useState(null)
  const [snapshotTaking, setSnapshotTaking] = useState(false)
  const [snapshotMessage, setSnapshotMessage] = useState(null)
  const [compareIdA, setCompareIdA] = useState('')
  const [compareIdB, setCompareIdB] = useState('')
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState(null)
  const [snapA, setSnapA] = useState(null)
  const [snapB, setSnapB] = useState(null)
  const [drillDownOpen, setDrillDownOpen] = useState(false)
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
      setSelectedPipelines(new Set(firstPipelineId ? [firstPipelineId] : []))
      // Same guarantee as togglePipelineSelected — whatever gets selected
      // here must also not be hidden, in case every pipeline happened to
      // be hidden from a prior session's localStorage state.
      if (firstPipelineId && hiddenPipelines.has(firstPipelineId)) {
        setHiddenPipelines(prevHidden => {
          const nextHidden = new Set(prevHidden)
          nextHidden.delete(firstPipelineId)
          localStorage.setItem('cipher-pipeline-review-hidden', JSON.stringify([...nextHidden]))
          return nextHidden
        })
      }
    }).catch(e => setError(e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Purely a 10s tick to keep the "updated Xs ago" label live — doesn't
  // refetch anything, just forces a re-render of the timestamp display.
  useEffect(() => {
    const interval = setInterval(() => setRefreshTick(t => t + 1), 10 * 1000)
    return () => clearInterval(interval)
  }, [])

  const togglePipelineSelected = (pipelineId) => {
    setSelectedPipelines(prev => {
      const next = new Set(prev)
      if (next.has(pipelineId)) {
        if (next.size === 1) return prev // don't allow deselecting the last one
        next.delete(pipelineId)
      } else {
        next.add(pipelineId)
        // Selecting a pipeline should always make it visible. Without
        // this, a pipeline could end up selected (so loadDeals fetches
        // its data) while ALSO still marked hidden from an earlier hide-
        // button click (so the sections display filter excludes it
        // entirely) — the exact combination that shows a real fetch count
        // but zero visible deals.
        if (hiddenPipelines.has(pipelineId)) {
          setHiddenPipelines(prevHidden => {
            const nextHidden = new Set(prevHidden)
            nextHidden.delete(pipelineId)
            localStorage.setItem('cipher-pipeline-review-hidden', JSON.stringify([...nextHidden]))
            return nextHidden
          })
        }
      }
      return next
    })
  }

  const loadDeals = useCallback(async () => {
    if (companyModeActive) {
      if (!companyFilter.trim()) return
      setLoading(true)
      setError(null)
      try {
        const qs = new URLSearchParams({ company: companyFilter.trim() })
        const data = await apiFetch(`/api/hubspot/pipeline-review?${qs}`, getToken)
        setDeals(data.deals || [])
        setLastRefreshed(Date.now())
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
      return
    }
    if (selectedPipelines.size === 0) { setDeals([]); return }
    setLoading(true)
    setError(null)
    try {
      // Fetch every selected pipeline in parallel and merge — each deal
      // already carries its own pipelineId/pipelineLabel/stageLabel from
      // the backend, so merging multiple pipelines' results together is
      // safe without needing a separate "combined" endpoint.
      const results = await Promise.all(
        [...selectedPipelines].map(pid => {
          const qs = new URLSearchParams({ pipeline: pid })
          if (ownerFilter) qs.set('ownerId', ownerFilter)
          return apiFetch(`/api/hubspot/pipeline-review?${qs}`, getToken)
        })
      )
      setDeals(results.flatMap(r => r.deals || []))
      setLastRefreshed(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [selectedPipelines, ownerFilter, companyModeActive, companyFilter, getToken])

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
      if (!sortField) { av = a.closeDate ? new Date(a.closeDate).getTime() : Infinity; bv = b.closeDate ? new Date(b.closeDate).getTime() : Infinity }
      else if (sortField === 'amount') { av = Number(a.amount) || 0; bv = Number(b.amount) || 0 }
      else if (sortField === 'closeDate') { av = a.closeDate ? new Date(a.closeDate).getTime() : Infinity; bv = b.closeDate ? new Date(b.closeDate).getTime() : Infinity }
      else if (sortField === 'lastContact') { av = a.lastContact ? new Date(a.lastContact).getTime() : 0; bv = b.lastContact ? new Date(b.lastContact).getTime() : 0 }
      else { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase() }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return sorted
  }, [filteredDeals, sortField, sortDir])

  // One unified grouping approach for all three cases (single pipeline,
  // multiple pipelines selected, or company search across all of them) —
  // group by pipeline, then by that pipeline's own stage order. The
  // pipeline name only prefixes the section heading when more than one
  // pipeline is actually being shown, so selecting just one still looks
  // exactly like before.
  // Custom bucket order requested — named stages sort into this exact
  // sequence; anything not in this list keeps its original HubSpot order,
  // appended after the named ones.
  const STAGE_PRIORITY = ['Procurement', 'Pricing', 'Value Prop', 'Engaged', 'Expansion', 'Revisit']
  const sortStagesByPriority = (stages) => {
    return [...stages].sort((a, b) => {
      const ai = STAGE_PRIORITY.findIndex(p => (a.label || '').includes(p))
      const bi = STAGE_PRIORITY.findIndex(p => (b.label || '').includes(p))
      if (ai === -1 && bi === -1) return 0
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  }

  const showPipelinePrefix = companyModeActive || selectedPipelines.size > 1
  const sections = useMemo(() => {
    if (!config) return []
    // Unconditional — whatever path led to zero pipelines selected,
    // nothing renders. This doesn't need to know HOW selection became
    // empty; it just guarantees the outcome is always correct.
    if (selectedPipelines.size === 0) return []

    const byPipeline = {}
    for (const deal of sortedDeals) {
      const pid = deal.pipelineId
      if (!byPipeline[pid]) byPipeline[pid] = []
      byPipeline[pid].push(deal)
    }
    const result = []
    Object.keys(byPipeline).filter(pid => !hiddenPipelines.has(pid) || selectedPipelines.has(pid)).forEach(pid => {
      const pLabel = config[pid]?.label || 'Unknown pipeline'
      const stageOrder = sortStagesByPriority(config[pid]?.stages || [])
      stageOrder.forEach(stage => {
        const stageDeals = byPipeline[pid].filter(d => d.stageId === stage.id)
        if (stageDeals.length > 0) {
          result.push({
            key: `${pid}-${stage.id}`,
            label: showPipelinePrefix ? `${pLabel} · ${stage.label}` : stage.label,
            deals: stageDeals,
          })
        }
      })
    })
    return result
  }, [sortedDeals, config, hiddenPipelines, showPipelinePrefix, selectedPipelines])

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
  const collapseAllStages = () => setCollapsedStages(new Set(sections.map(s => s.key)))
  const expandAllStages = () => setCollapsedStages(new Set())

  // Default to rolled up on initial load — only fires once, tracked via
  // ref, so it doesn't re-collapse everything every time the section list
  // recomputes from a filter change (which would undo a user's manual
  // expand/collapse choices mid-session).
  const hasSetInitialCollapse = useRef(false)
  useEffect(() => {
    if (hasSetInitialCollapse.current) return
    if (sections.length === 0) return
    setCollapsedStages(new Set(sections.map(s => s.key)))
    hasSetInitialCollapse.current = true
  }, [sections])

  // ── Snapshot / comparison logic ──────────────────────────────────────
  // Captures exactly what's currently on screen — sortedDeals, the final
  // filtered+sorted array that actually feeds the visible sections —
  // rather than every deal in the pipeline regardless of active filters.
  // discussedIds/focusIds are merged in per-deal since those live as
  // separate client-side state, not on the deal object itself.
  const takeSnapshot = async () => {
    if (sortedDeals.length === 0) {
      setSnapshotMessage({ type: 'error', text: 'Nothing currently visible to snapshot — adjust your filters first.' })
      return
    }
    setSnapshotTaking(true)
    setSnapshotMessage(null)
    try {
      const dealsForSnapshot = sortedDeals.map(d => ({
        id: d.id,
        name: d.name,
        pipelineId: d.pipelineId,
        pipelineLabel: d.pipelineLabel,
        stageId: d.stageId,
        stageLabel: d.stageLabel,
        amount: d.amount,
        closeDate: d.closeDate,
        currentStatus: d.currentStatus,
        nextStep: d.nextStep,
        ownerName: d.ownerName,
        companyName: d.companyName,
        lastContact: d.lastContact,
        discussed: discussedIds.has(d.id),
        focus: focusIds.has(d.id),
      }))
      const pipelineLabels = [...new Set(dealsForSnapshot.map(d => d.pipelineLabel).filter(Boolean))]
      const data = await apiFetch('/api/hubspot/pipeline-snapshots', getToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelineLabel: pipelineLabels.join(', ') || 'Pipeline Review',
          deals: dealsForSnapshot,
        }),
      })
      setSnapshotMessage({ type: 'success', text: `Snapshot saved — ${dealsForSnapshot.length} deals captured.` })
    } catch (e) {
      setSnapshotMessage({ type: 'error', text: e.message })
    } finally {
      setSnapshotTaking(false)
    }
  }

  const fetchSnapshotsList = async () => {
    setSnapshotsLoading(true)
    setSnapshotsError(null)
    try {
      const data = await apiFetch('/api/hubspot/pipeline-snapshots?metaOnly=1', getToken)
      setSnapshotsList((data.snapshots || []).sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt)))
    } catch (e) {
      setSnapshotsError(e.message)
    } finally {
      setSnapshotsLoading(false)
    }
  }

  useEffect(() => {
    if (subView === 'snapshots') fetchSnapshotsList()
  }, [subView])

  const runComparison = async () => {
    if (!compareIdA || !compareIdB) return
    setCompareLoading(true)
    setCompareError(null)
    setSnapA(null); setSnapB(null)
    try {
      const [a, b] = await Promise.all([
        apiFetch(`/api/hubspot/pipeline-snapshots?id=${encodeURIComponent(compareIdA)}`, getToken),
        apiFetch(`/api/hubspot/pipeline-snapshots?id=${encodeURIComponent(compareIdB)}`, getToken),
      ])
      // Always compare in chronological order regardless of which
      // snapshot was picked as "A" vs "B" in the dropdowns — "changes"
      // should always read as earlier-to-later, not depend on click order.
      const [earlier, later] = new Date(a.takenAt) <= new Date(b.takenAt) ? [a, b] : [b, a]
      setSnapA(earlier)
      setSnapB(later)
    } catch (e) {
      setCompareError(e.message)
    } finally {
      setCompareLoading(false)
    }
  }

  // Computes the actual diff between two snapshots — matched by deal id.
  // Returns both per-deal change records (for drill-down) and aggregate
  // counts (for the summary).
  const snapshotDiff = useMemo(() => {
    if (!snapA || !snapB) return null
    const dealsA = new Map((snapA.deals || []).map(d => [d.id, d]))
    const dealsB = new Map((snapB.deals || []).map(d => [d.id, d]))
    const allIds = new Set([...dealsA.keys(), ...dealsB.keys()])

    const newDeals = [], removedDeals = [], stageChanges = [], statusChanges = [], discussedChanges = [], amountChanges = [], closeDateChanges = []

    allIds.forEach(id => {
      const before = dealsA.get(id)
      const after = dealsB.get(id)
      if (!before && after) { newDeals.push(after); return }
      if (before && !after) { removedDeals.push(before); return }
      if (before.stageLabel !== after.stageLabel) stageChanges.push({ id, name: after.name, before: before.stageLabel, after: after.stageLabel })
      if ((before.currentStatus || '') !== (after.currentStatus || '')) statusChanges.push({ id, name: after.name, before: before.currentStatus, after: after.currentStatus })
      if (before.discussed !== after.discussed) discussedChanges.push({ id, name: after.name, before: before.discussed, after: after.discussed })
      if (Number(before.amount || 0) !== Number(after.amount || 0)) amountChanges.push({ id, name: after.name, before: before.amount, after: after.amount })
      if ((before.closeDate || '') !== (after.closeDate || '')) closeDateChanges.push({ id, name: after.name, before: before.closeDate, after: after.closeDate })
    })

    return {
      newDeals, removedDeals, stageChanges, statusChanges, discussedChanges, amountChanges, closeDateChanges,
      dealsA, dealsB,
    }
  }, [snapA, snapB])

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
      display: 'flex', flexDirection: 'column', gap: 16,
      background: 'var(--bg)', color: 'var(--text)', minHeight: '100%', padding: 4,
      zoom: presentationMode ? 1.3 : 1,
    }}>

      {/* ── Sub-view toggle: Review / Snapshots ── */}
      <div style={{ display: 'flex', background: 'var(--bg-panel)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', padding: 3, gap: 2, width: 'fit-content' }}>
        {[{ k: 'review', l: 'Review' }, { k: 'snapshots', l: 'Snapshots' }].map(({ k, l }) => (
          <button key={k} onClick={() => setSubView(k)}
            style={{ fontSize: 12.5, padding: '5px 14px', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer',
              fontWeight: subView === k ? 500 : 400, background: subView === k ? 'var(--bg-secondary)' : 'transparent',
              color: subView === k ? 'var(--text)' : 'var(--text-secondary)' }}>
            {l}
          </button>
        ))}
      </div>

      {subView === 'review' && (
      <>
      {/* ── Dedicated header: pipeline selector, team/search, sort, filters ── */}
      <div style={{ padding: '10px 18px', background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)' }}>

        <div style={{ display: 'flex', gap: 6, marginBottom: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {Object.entries(config).filter(([id]) => !hiddenPipelines.has(id)).map(([id, p]) => {
            const isSelected = selectedPipelines.has(id) && !companyModeActive
            return (
            <div key={id} style={{ position: 'relative', display: 'flex' }}>
              <button onClick={() => { setCompanyModeActive(false); togglePipelineSelected(id) }}
                disabled={companyModeActive}
                title={isSelected ? `Remove ${p.label} from view` : `Add ${p.label} to view`}
                style={{
                  padding: '5px 26px 5px 14px', borderRadius: 'var(--radius)', fontSize: 12.5, cursor: companyModeActive ? 'default' : 'pointer',
                  opacity: companyModeActive ? 0.4 : 1,
                  background: isSelected ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: isSelected ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid ' + (isSelected ? 'var(--accent)' : 'var(--border)'),
                }}>
                {isSelected && '✓ '}{p.label}
              </button>
              {!companyModeActive && (
                <button onClick={(e) => {
                    e.stopPropagation()
                    togglePipelineHidden(id)
                    if (selectedPipelines.has(id) && selectedPipelines.size === 1) {
                      const nextVisible = Object.keys(config).find(pid => pid !== id && !hiddenPipelines.has(pid))
                      // If there's nothing else visible to fall back to,
                      // clear the selection outright — leaving it pointing
                      // at the pipeline that was just hidden meant the app
                      // still showed that pipeline's stages even though no
                      // pill was visible anywhere to indicate it was still
                      // "selected." Nothing visible should mean nothing
                      // selected, not a selection nobody can see.
                      setSelectedPipelines(new Set(nextVisible ? [nextVisible] : []))
                    }
                  }}
                  title={`Hide ${p.label}`}
                  style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: isSelected ? 'rgba(255,255,255,0.7)' : 'var(--text-tertiary)', padding: 2, lineHeight: 1 }}>
                  ×
                </button>
              )}
            </div>
            )
          })}
          {selectedPipelines.size > 1 && !companyModeActive && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{selectedPipelines.size} pipelines combined</span>
          )}

          {hiddenPipelines.size > 0 && !companyModeActive && (
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {hiddenPipelines.size} hidden ·{' '}
              {[...hiddenPipelines].map(id => (
                <button key={id} onClick={() => { togglePipelineHidden(id); setSelectedPipelines(new Set([id])) }}
                  style={{ background: 'none', border: 'none', color: 'var(--accent-text)', cursor: 'pointer', fontSize: 11.5, textDecoration: 'underline', padding: '0 2px' }}>
                  Show {config[id]?.label}
                </button>
              ))}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 5, flexWrap: 'wrap', alignItems: 'center' }}>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5 }}>
            <input type="checkbox" checked={focusOnly} onChange={e => setFocusOnly(e.target.checked)} style={{ width: 15, height: 15 }} />
            Focus deals only
          </label>
        </div>

        {/* "New meeting" (resets discussed-tracking) hidden for now — not needed at this time. Handler (resetMeeting) still intact below if this comes back. */}

        {!presentationMode && (
        <>
        {/* Sort + filter toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
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
          <button onClick={takeSnapshot} disabled={snapshotTaking}
            style={{ marginLeft: 'auto', fontSize: 11.5, padding: '5px 10px', borderRadius: 8, cursor: snapshotTaking ? 'not-allowed' : 'pointer', background: snapshotTaking ? 'var(--bg)' : 'var(--nav-resources)', color: snapshotTaking ? 'var(--text-tertiary)' : '#fff', border: 'none', fontWeight: 500 }}>
            {snapshotTaking ? 'Saving…' : '📸 Take Snapshot'}
          </button>
          <button onClick={() => setFiltersOpen(o => !o)}
            style={{ fontSize: 11.5, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', background: filtersActive ? 'var(--manager-color)' : 'var(--bg-secondary)', color: filtersActive ? '#fff' : 'var(--text-secondary)', border: '1px solid ' + (filtersActive ? 'var(--manager-color)' : 'var(--border)') }}>
            Filters{filtersActive ? ' •' : ''}
          </button>
        </div>

        {snapshotMessage && (
          <div style={{ fontSize: 11.5, marginBottom: 6, color: snapshotMessage.type === 'error' ? 'var(--red)' : 'var(--green, #16a34a)' }}>
            {snapshotMessage.text}
          </div>
        )}

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

        {sections.length > 1 && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={collapseAllStages} style={{ fontSize: 11.5, color: 'var(--accent-text)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Hide all
            </button>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>·</span>
            <button onClick={expandAllStages} style={{ fontSize: 11.5, color: 'var(--accent-text)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Show all
            </button>
          </div>
        )}

      </div>
      {/* ── End dedicated header — deals and context panel open below it ── */}

      <div style={{ display: 'grid', gridTemplateColumns: '520px 1fr', gap: 16 }}>
      <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)' }}>

        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>Loading deals…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {sections.map(section => {
              const isCollapsed = collapsedStages.has(section.key)
              const sectionTotal = section.deals.reduce((sum, d) => sum + (Number(d.amount) || 0), 0)
              return (
                <div key={section.key}>
                  <div onClick={() => toggleStage(section.key)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{section.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', borderRadius: 10, padding: '1px 8px' }}>
                      {section.deals.filter(d => discussedIds.has(d.id)).length}/{section.deals.length} discussed
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{formatAmount(sectionTotal)} total</span>
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

                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            <div>
                              <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Size</div>
                              <div style={{ fontSize: 14, fontWeight: 600 }}>{formatAmount(deal.amount) || '—'}</div>
                            </div>
                            <div>
                              <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Close</div>
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
      </>
      )}

      {subView === 'snapshots' && (
        <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Pipeline Snapshots</h2>
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginBottom: 18 }}>
            Compare two past snapshots to see what changed between review sessions.
          </div>

          {snapshotsError && (
            <div style={{ background: 'var(--red-light)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 16 }}>
              {snapshotsError}
            </div>
          )}

          {snapshotsLoading ? (
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Loading snapshots…</div>
          ) : snapshotsList.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius)', color: 'var(--text-tertiary)', fontSize: 13 }}>
              No snapshots yet — take one from the Review tab after your next pipeline walkthrough.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 20, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Earlier snapshot</div>
                  <select value={compareIdA} onChange={e => setCompareIdA(e.target.value)}
                    style={{ padding: '8px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, minWidth: 260 }}>
                    <option value="">Select a snapshot…</option>
                    {snapshotsList.map(s => (
                      <option key={s.id} value={s.id}>
                        {new Date(s.takenAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · {s.pipelineLabel} · {s.dealCount} deals
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Later snapshot</div>
                  <select value={compareIdB} onChange={e => setCompareIdB(e.target.value)}
                    style={{ padding: '8px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, minWidth: 260 }}>
                    <option value="">Select a snapshot…</option>
                    {snapshotsList.map(s => (
                      <option key={s.id} value={s.id}>
                        {new Date(s.takenAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · {s.pipelineLabel} · {s.dealCount} deals
                      </option>
                    ))}
                  </select>
                </div>
                <button onClick={runComparison} disabled={!compareIdA || !compareIdB || compareLoading}
                  style={{ padding: '9px 18px', background: (!compareIdA || !compareIdB || compareLoading) ? 'var(--bg-secondary)' : 'var(--accent)', color: (!compareIdA || !compareIdB || compareLoading) ? 'var(--text-tertiary)' : '#fff', border: 'none', borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: (!compareIdA || !compareIdB || compareLoading) ? 'not-allowed' : 'pointer' }}>
                  {compareLoading ? 'Comparing…' : 'Compare'}
                </button>
              </div>

              {compareError && (
                <div style={{ background: 'var(--red-light)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 16 }}>
                  {compareError}
                </div>
              )}

              {snapshotDiff && (
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>
                    Comparing {new Date(snapA.takenAt).toLocaleDateString()} → {new Date(snapB.takenAt).toLocaleDateString()}
                  </div>

                  {/* Summary counts */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 8, marginBottom: 18 }}>
                    {[
                      { label: 'New Deals', count: snapshotDiff.newDeals.length, color: 'var(--green, #16a34a)' },
                      { label: 'Removed', count: snapshotDiff.removedDeals.length, color: 'var(--text-tertiary)' },
                      { label: 'Moved Stage', count: snapshotDiff.stageChanges.length, color: 'var(--accent)' },
                      { label: 'Status Updated', count: snapshotDiff.statusChanges.length, color: 'var(--amber, #d97706)' },
                      { label: 'Discussed Changed', count: snapshotDiff.discussedChanges.length, color: 'var(--nav-resources)' },
                      { label: 'Amount Changed', count: snapshotDiff.amountChanges.length, color: 'var(--red)' },
                    ].map(({ label, count, color }) => (
                      <div key={label} style={{ padding: '12px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', textAlign: 'center' }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color }}>{count}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  <button onClick={() => setDrillDownOpen(o => !o)}
                    style={{ fontSize: 12.5, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500, padding: 0, marginBottom: 12 }}>
                    {drillDownOpen ? '▼ Hide full detail' : '▶ Show full detail'}
                  </button>

                  {drillDownOpen && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                      {snapshotDiff.stageChanges.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-tertiary)', marginBottom: 8 }}>Stage Changes</div>
                          {snapshotDiff.stageChanges.map(c => (
                            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', marginBottom: 4, fontSize: 12.5 }}>
                              <span style={{ fontWeight: 500 }}>{c.name}</span>
                              <span style={{ color: 'var(--text-secondary)' }}>{c.before || '—'} → <strong style={{ color: 'var(--accent)' }}>{c.after || '—'}</strong></span>
                            </div>
                          ))}
                        </div>
                      )}
                      {snapshotDiff.statusChanges.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-tertiary)', marginBottom: 8 }}>Status Text Changes</div>
                          {snapshotDiff.statusChanges.map(c => (
                            <div key={c.id} style={{ padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', marginBottom: 4, fontSize: 12.5 }}>
                              <div style={{ fontWeight: 500, marginBottom: 3 }}>{c.name}</div>
                              <div style={{ color: 'var(--text-tertiary)' }}>Before: {c.before || '—'}</div>
                              <div style={{ color: 'var(--text)' }}>After: {c.after || '—'}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {snapshotDiff.discussedChanges.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-tertiary)', marginBottom: 8 }}>Discussed Status Changed</div>
                          {snapshotDiff.discussedChanges.map(c => (
                            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', marginBottom: 4, fontSize: 12.5 }}>
                              <span style={{ fontWeight: 500 }}>{c.name}</span>
                              <span>{c.before ? 'Discussed' : 'Not discussed'} → <strong>{c.after ? 'Discussed' : 'Not discussed'}</strong></span>
                            </div>
                          ))}
                        </div>
                      )}
                      {snapshotDiff.amountChanges.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-tertiary)', marginBottom: 8 }}>Amount Changes</div>
                          {snapshotDiff.amountChanges.map(c => (
                            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', marginBottom: 4, fontSize: 12.5 }}>
                              <span style={{ fontWeight: 500 }}>{c.name}</span>
                              <span>{formatAmount(c.before) || '—'} → <strong>{formatAmount(c.after) || '—'}</strong></span>
                            </div>
                          ))}
                        </div>
                      )}
                      {snapshotDiff.newDeals.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-tertiary)', marginBottom: 8 }}>New Deals</div>
                          {snapshotDiff.newDeals.map(d => (
                            <div key={d.id} style={{ padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', marginBottom: 4, fontSize: 12.5 }}>
                              <strong>{d.name}</strong> — {d.stageLabel} · {formatAmount(d.amount) || '—'}
                            </div>
                          ))}
                        </div>
                      )}
                      {snapshotDiff.removedDeals.length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-tertiary)', marginBottom: 8 }}>No Longer Visible</div>
                          {snapshotDiff.removedDeals.map(d => (
                            <div key={d.id} style={{ padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', marginBottom: 4, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                              {d.name} — was {d.stageLabel}
                            </div>
                          ))}
                        </div>
                      )}
                      {snapshotDiff.stageChanges.length === 0 && snapshotDiff.statusChanges.length === 0 && snapshotDiff.discussedChanges.length === 0 &&
                       snapshotDiff.amountChanges.length === 0 && snapshotDiff.newDeals.length === 0 && snapshotDiff.removedDeals.length === 0 && (
                        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No changes detected between these two snapshots.</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
