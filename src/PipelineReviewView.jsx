// src/PipelineReviewView.jsx
// NEW FILE — path from repo root: src/PipelineReviewView.jsx
//
// Built for the bi-weekly leadership pipeline walkthrough. Three pipelines
// (Opportunity, Deal, Expansion — using HubSpot's own labels even though,
// confusingly, "Opportunity" actually holds the early-funnel stages and
// "Deal" holds the late-stage ones on this portal — verified against real
// data, not assumed), each broken into stages, whole team by default with
// an owner filter to narrow to one person.
//
// Next steps come straight from HubSpot's hs_next_step property, which your
// team already maintains manually — no AI involved. The recap panel pulls
// real logged engagements (notes, calls, meetings) for whichever deal is
// selected, fetched on click rather than upfront for the whole list.

import { useState, useEffect, useCallback, useMemo } from 'react'
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

  // Load pipeline config + owner list once on mount
  useEffect(() => {
    Promise.all([
      apiFetch('/api/hubspot/pipeline-review/config', getToken),
      apiFetch('/api/hubspot/owners', getToken).catch(() => ({ owners: [] })),
    ]).then(([configRes, ownersRes]) => {
      setConfig(configRes.pipelines)
      setOwners(ownersRes.owners || [])
      const firstPipelineId = Object.keys(configRes.pipelines || {})[0]
      setActivePipeline(firstPipelineId)
    }).catch(e => setError(e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [activePipeline, ownerFilter, getToken])

  useEffect(() => { loadDeals() }, [loadDeals])

  const dealsByStage = useMemo(() => {
    const map = {}
    for (const stage of stages) map[stage.id] = []
    for (const deal of deals) {
      if (map[deal.stageId]) map[deal.stageId].push(deal)
      else if (!map['_unknown']) map['_unknown'] = [deal]
      else map['_unknown'].push(deal)
    }
    return map
  }, [deals, stages])

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

  if (!config) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, background: 'var(--bg)', color: 'var(--text)', minHeight: '100%', padding: 4 }}>

      <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)' }}>

        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
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
        </div>

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
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', borderRadius: 10, padding: '1px 8px' }}>{stageDeals.length}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{isCollapsed ? 'Show' : 'Hide'}</span>
                  </div>
                  {!isCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {stageDeals.map(deal => (
                        <div key={deal.id} onClick={() => setSelectedDealId(deal.id)} style={{
                          padding: '12px 14px', borderRadius: 12, cursor: 'pointer',
                          border: selectedDealId === deal.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                          background: selectedDealId === deal.id ? 'var(--bg-hover)' : 'var(--bg-secondary)',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                            <div style={{ fontSize: 13, fontWeight: 500 }}>{deal.name}</div>
                            {formatAmount(deal.amount) && (
                              <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{formatAmount(deal.amount)}</div>
                            )}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 3 }}>
                            {deal.companyName || 'No company'} · {deal.ownerName || 'Unassigned'}
                            {daysAgo(deal.lastModified) != null && ` · updated ${daysAgo(deal.lastModified)}d ago`}
                          </div>
                          {deal.nextStep && (
                            <div style={{ fontSize: 11.5, color: 'var(--accent-text)', marginTop: 5 }}>
                              Next: {deal.nextStep}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {deals.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>No open deals in this pipeline{ownerFilter ? ' for this person' : ''}.</div>
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

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
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
