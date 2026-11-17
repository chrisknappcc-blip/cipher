import { useState, useEffect } from 'react'
import { panel, muted, selStyle, btnStyle, Pill, InsightCard, CLASS_LABEL, PHASE_LABEL, fmtDate, n0, sizeText, linkBtn } from './intelUi'

// IntelCompetitive.jsx: ED and competitive news as a timeline. Deals, closures, new sites and ED volume news, newest first and
// grouped by month. A deal that has not happened yet is flagged Watch. Beside each event are your Gold and starred accounts in
// the same state, put as a question, because a source rarely confirms what an event does to a neighbor. News carries no city,
// so this is a state view rather than a metro view.

const PHASE_COLOR = { watch: '#8A3F06', closed: '#2F5A17', event: 'var(--text-secondary)' }

export default function CompetitiveView({ api, status, scope, onOpen, refreshKey = 0 }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [state, setState] = useState('')
  const [kind, setKind] = useState('')
  const [phase, setPhase] = useState('')
  const [shown, setShown] = useState({})

  useEffect(() => {
    let live = true
    ;(async () => {
      setError('')
      try {
        const qs = new URLSearchParams()
        if (scope && scope !== 'all') qs.set('bdr', scope)
        if (state) qs.set('state', state)
        if (kind) qs.set('kind', kind)
        if (phase) qs.set('phase', phase)
        const d = await api(`/api/intel/competitive?${qs}`)
        if (live) setData(d)
      } catch (e) { if (live) setError(e.message) }
    })()
    return () => { live = false }
  }, [api, scope, state, kind, phase, refreshKey])

  if (error && !data) return <div style={{ ...panel, padding: 16, color: 'var(--red)' }}>{error}</div>
  if (!data) return <div style={{ ...panel, padding: 16, ...muted }}>Loading the timeline...</div>
  const f = data.facets, s = data.summary, sv = data.stateView
  const stateOptions = Object.keys(f.states).sort()

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} style={selStyle}><option value="">All states</option>{stateOptions.map((k) => <option key={k} value={k}>{k} ({f.states[k]})</option>)}</select>
        <select aria-label="Kind of event" value={kind} onChange={(e) => setKind(e.target.value)} style={selStyle}><option value="">All kinds</option>{['deal', 'closure', 'new_site', 'ed_flow'].map((k) => <option key={k} value={k}>{CLASS_LABEL[k]} ({f.kinds[k] || 0})</option>)}</select>
        <select aria-label="Status" value={phase} onChange={(e) => setPhase(e.target.value)} style={selStyle}><option value="">Any status</option>{['watch', 'closed', 'event'].map((k) => <option key={k} value={k}>{PHASE_LABEL[k]} ({f.phases[k] || 0})</option>)}</select>
        <span style={muted}>{s.events} events {'\u00B7'} {s.watch} to watch {'\u00B7'} {s.closed} closed. Newest first.</span>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{error}</div>}

      {sv && (
        <section style={{ ...panel, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--accent-text)', marginBottom: 6 }}>In {sv.state}</div>
          <div style={{ fontSize: 13, marginBottom: 8 }}>{sv.events} events, {sv.watch} to watch, {sv.closed} closed. {sv.accountTotal} of your Gold and starred accounts are here.</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 13 }}>
            {sv.accounts.map((a) => <span key={a.id}><button type="button" onClick={() => onOpen(a.id)} style={linkBtn}>{a.name}</button><span style={muted}>{a.city ? `, ${a.city}` : ''} {'\u00B7'} {a.er != null ? `${n0(a.er)} est. ER visits` : sizeText(a.sizeStatus, a.er)}</span></span>)}
            {!sv.accounts.length && <span style={muted}>None of your Gold or starred accounts are in this state.</span>}
          </div>
        </section>
      )}

      {!data.months.length && <div style={{ ...panel, padding: 20, fontSize: 14, lineHeight: 1.55 }}>Nothing matches. {status.insightCount ? 'Try another state, kind or status.' : status.admin ? 'Import the earlier tools\u2019 records on the Data health screen.' : 'Ask an admin to load the news.'}</div>}
      {data.months.map((m) => (
        <section key={m.key} aria-label={m.label} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 700, margin: '4px 0 8px' }}>{m.label} <span style={{ ...muted, fontWeight: 400 }}>{m.events.length} {m.events.length === 1 ? 'event' : 'events'}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {m.events.map((e) => (
              <div key={e.id} style={{ ...panel, padding: 14 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ ...muted, fontVariantNumeric: 'tabular-nums', marginRight: 4 }}>{fmtDate(e.published)}</span>
                  <Pill color={PHASE_COLOR[e.phase]} title={e.phase === 'watch' ? 'A deal or new site that has not happened yet' : undefined}>{PHASE_LABEL[e.phase]}</Pill>
                  <Pill color="var(--accent-text)">{CLASS_LABEL[e.eventClass]}</Pill>
                  {e.states.map((st) => <Pill key={st} color="#1B5A78">{st}</Pill>)}
                  {e.merged > 1 && <Pill color="#2F5A17">{e.merged} sources merged</Pill>}
                </div>
                <div style={{ fontSize: 14.5, fontWeight: 650, lineHeight: 1.35 }}>{e.title}</div>
                <div style={{ ...muted, margin: '4px 0 6px' }}>{e.sources.map((src, i) => (src.url ? <a key={i} href={src.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-text)', marginRight: 12 }}>{src.name || 'Source'}, {fmtDate(src.date)}</a> : <span key={i} style={{ marginRight: 12 }}>{src.name || 'Source'}, {fmtDate(src.date)}</span>))}</div>
                {e.account && e.match.via !== 'title' && <div style={{ fontSize: 13, marginBottom: 4 }}>Involves <button type="button" onClick={() => onOpen(e.account.id)} style={linkBtn}>{e.account.name}</button>{e.account.isTarget ? ', one of your targets' : ''}.</div>}
                {e.nearby.accounts.length > 0 && (
                  <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Your accounts in {e.nearby.states.join(', ')}: </span>
                    {e.nearby.accounts.map((a, i) => <span key={a.id}>{i ? ', ' : ''}<button type="button" onClick={() => onOpen(a.id)} style={linkBtn}>{a.name}</button></span>)}
                    {e.nearby.total > e.nearby.accounts.length ? ` and ${e.nearby.total - e.nearby.accounts.length} more` : ''}. <em>{e.nearby.question}</em>
                  </div>
                )}
                <button type="button" aria-expanded={!!shown[e.id]} onClick={() => setShown((x) => ({ ...x, [e.id]: !x[e.id] }))} style={{ ...btnStyle(false), marginTop: 8, fontSize: 12.5, padding: '5px 10px' }}>{shown[e.id] ? 'Hide the four part card' : 'Show the four part card'}</button>
                {shown[e.id] && <div style={{ marginTop: 10 }}><InsightCard it={e} status={status} onOpen={e.match.via === 'title' ? undefined : onOpen} /></div>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
