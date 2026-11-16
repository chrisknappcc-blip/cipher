import { useState, useEffect, useMemo } from 'react'
import { MAP_W, MAP_H, STATE_PATHS } from './usMapData'
import { panel, muted, selStyle, Pill, Th, Td, n0, linkBtn } from './intelUi'

// IntelMap.jsx: the Market Intel territory map. States are coloured by the BDR who owns them, and each placeable account
// is one pin, placed by its HubSpot city. Pins with news in the last 30 days are solid, the rest hollow, and Gold
// accounts wear a gold ring. Accounts whose city cannot be placed are counted below the map, never put in a guessed spot.
// Clicking a pin (or Enter on it) shows the accounts there and opens the account panel.

const TERR = {
  'Harley Reed': { label: 'West', fill: '#EFD6C6', strong: '#C9622F' }, 'Abigail Evans': { label: 'Central', fill: '#DDD4EA', strong: '#7B5FB5' },
  'Chiara Pate': { label: 'Gulf', fill: '#EDE1B6', strong: '#B8901A' }, 'Chris Knapp': { label: 'East', fill: '#CFE3EE', strong: '#2E86AB' },
}
const STATE_CODES = Object.keys(STATE_PATHS).sort()
const CELL = 7 // pins closer than this many map units (a few miles) are grouped into one

function Check({ label, checked, onChange }) {
  return <label style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>
}

export default function MapView({ api, status, scope, onOpen }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [targets, setTargets] = useState(true)
  const [bdrLed, setBdrLed] = useState(false)
  const [alerts, setAlerts] = useState(false)
  const [state, setState] = useState('')
  const [sel, setSel] = useState(null)

  useEffect(() => {
    let live = true
    ;(async () => {
      setError('')
      try {
        const qs = new URLSearchParams({ targets: targets ? '1' : '0' })
        if (scope && scope !== 'all') qs.set('bdr', scope)
        if (targets && bdrLed) qs.set('bdrLed', '1')
        if (alerts) qs.set('alerts', '1')
        if (state) qs.set('state', state)
        const d = await api(`/api/intel/map?${qs}`)
        if (live) { setData(d); setSel(null) }
      } catch (e) { if (live) setError(e.message) }
    })()
    return () => { live = false }
  }, [api, scope, targets, bdrLed, alerts, state])

  const groups = useMemo(() => {
    // Pins within CELL map units of a group's centre join it, so two cities that are a few miles apart become one pin
    // with a count, wherever a grid line would have fallen.
    const gs = []
    for (const p of (data && data.pins) || []) {
      let g = gs.find((q) => Math.hypot(q.cx - p.x, q.cy - p.y) < CELL)
      if (!g) { g = { key: p.id, pins: [], cx: p.x, cy: p.y }; gs.push(g) }
      g.pins.push(p)
      g.cx = g.pins.reduce((a, b) => a + b.x, 0) / g.pins.length
      g.cy = g.pins.reduce((a, b) => a + b.y, 0) / g.pins.length
    }
    return gs.map((g) => ({ key: g.key, pins: g.pins, x: g.cx, y: g.cy, news: g.pins.some((p) => p.alerts > 0), gold: g.pins.some((p) => p.reasons.includes('gold')), starred: g.pins.some((p) => p.reasons.includes('starred')) }))
  }, [data])
  const selected = groups.find((g) => g.key === sel)
  const short = (key) => (status.bdrs.find((b) => b.key === key) || {}).short || key || 'Unassigned'
  const perBdr = useMemo(() => { const c = {}; for (const p of (data && data.pins) || []) c[p.bdr] = (c[p.bdr] || 0) + 1; return c }, [data])

  if (error && !data) return <div style={{ ...panel, padding: 16, color: 'var(--red)' }}>{error}</div>
  if (!data) return <div style={{ ...panel, padding: 16, ...muted }}>Loading the map...</div>
  if (!status.accountCount) return <div style={{ ...panel, padding: 20, fontSize: 14, lineHeight: 1.55 }}>HubSpot accounts have not been loaded yet. {status.admin ? 'Open Data health and choose Refresh from HubSpot.' : 'Ask an admin to refresh them.'}</div>
  const dim = (owner) => scope && scope !== 'all' && owner !== scope

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <Check label="Targets only" checked={targets} onChange={setTargets} />
        {targets && <Check label="Include BDR led" checked={bdrLed} onChange={setBdrLed} />}
        <Check label="News in the last 30 days" checked={alerts} onChange={setAlerts} />
        <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} style={selStyle}><option value="">All states</option>{STATE_CODES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <span style={muted}>{data.total.toLocaleString()} on the map{data.truncated ? `, showing the first ${data.pins.length}` : ''}{data.unplaced ? ` · ${data.unplaced} have no city HubSpot can place` : ''}</span>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <section style={{ ...panel, padding: 14, flex: '999 1 620px', minWidth: 0 }}>
          <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label="Map of the United States coloured by BDR territory, with accounts as pins" style={{ width: '100%', height: 'auto', display: 'block' }}>
            {STATE_CODES.map((s) => {
              const owner = data.stateOwner[s], t = TERR[owner]
              return <path key={s} d={STATE_PATHS[s]} fill={t ? t.fill : '#E4DCC2'} stroke={state === s ? 'var(--text)' : 'var(--bg-panel)'} strokeWidth={state === s ? 2 : 1.2} opacity={dim(owner) ? 0.4 : 1} style={{ cursor: 'pointer' }} onClick={() => setState(state === s ? '' : s)}><title>{s}{t ? `, ${t.label}` : ''}{data.stateStats[s] ? `, ${data.stateStats[s].accounts} shown` : ''}</title></path>
            })}
            {groups.map((g) => {
              const r = g.pins.length > 1 ? 8 : 6, isSel = g.key === sel
              const label = g.pins.length > 1 ? `${g.pins.length} accounts near ${g.pins[0].city || g.pins[0].state}` : g.pins[0].name
              return (
                <g key={g.key} role="button" tabIndex={0} aria-label={`${label}${g.news ? ', news in the last 30 days' : ''}`} style={{ cursor: 'pointer', outline: 'none' }} onClick={() => setSel(isSel ? null : g.key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(isSel ? null : g.key) } }}>
                  {isSel && <circle cx={g.x} cy={g.y} r={r + 9} fill="#0E6F78" fillOpacity="0.2" stroke="#0E6F78" strokeWidth="2" />}
                  {(g.gold || g.starred) && <circle cx={g.x} cy={g.y} r={r + 3} fill="none" stroke={g.gold ? '#C9A227' : '#1C6FBE'} strokeWidth="2.5" />}
                  <circle cx={g.x} cy={g.y} r={r} fill={g.news ? '#201C13' : '#FDFBF5'} stroke={g.news ? '#FDFBF5' : '#201C13'} strokeWidth="1.8" />
                  {g.pins.length > 1 && <text x={g.x} y={g.y + 3.4} textAnchor="middle" fontSize="9.5" fontWeight="700" fill={g.news ? '#fff' : '#201C13'} style={{ pointerEvents: 'none' }}>{g.pins.length}</text>}
                </g>
              )
            })}
          </svg>
          <div style={{ ...muted, display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
            <span>{'\u25CF'} News in the last 30 days</span><span>{'\u25CB'} No recent news</span><span style={{ color: '#8A6D0B' }}>{'\u25EF'} Gold ring: Gold account</span><span>Click a state to filter. Placement is by city.</span>
          </div>
        </section>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section style={{ ...panel, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--accent-text)', marginBottom: 8 }}>Territories</div>
            {status.bdrs.map((b) => { const t = TERR[b.key]; return (
              <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', opacity: dim(b.key) ? 0.5 : 1 }}>
                <span style={{ width: 16, height: 16, borderRadius: 4, background: t.fill, border: `2px solid ${t.strong}`, flex: 'none' }} />
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: scope === b.key ? 700 : 500 }}>{b.short}, {t.label}</span>
                <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{perBdr[b.key] || 0} pinned</span>
              </div>) })}
          </section>
          <section style={{ ...panel, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--accent-text)', marginBottom: 8 }}>{selected ? (selected.pins.length > 1 ? `${selected.pins.length} accounts here` : 'Selected account') : 'Selected'}</div>
            {!selected && <div style={muted}>Click a pin to see the account.</div>}
            {selected && selected.pins.slice(0, 8).map((p) => (
              <div key={p.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <button type="button" onClick={() => onOpen(p.id)} style={{ ...linkBtn, fontSize: 14 }}>{p.name}</button>
                <div style={{ ...muted, margin: '2px 0 4px' }}>{[p.city, p.state].filter(Boolean).join(', ')} · {short(p.bdr)}{p.er != null ? ` · ${n0(p.er)} est. ER visits` : ''}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{p.tier && <Pill color="#8A6D0B">{p.tier.replace(/^GOLD - /i, 'Gold ').replace(/-/g, ' to ')}</Pill>}{p.reasons.includes('starred') && <Pill color="var(--accent-text)">Starred</Pill>}{p.alerts > 0 && <Pill color="#2F5A17">{p.alerts} news in 30 days</Pill>}</div>
              </div>
            ))}
            {selected && selected.pins.length > 8 && <div style={{ ...muted, paddingTop: 8 }}>and {selected.pins.length - 8} more. Click a state to narrow it.</div>}
          </section>
        </div>
      </div>
      <section style={{ ...panel, overflowX: 'auto', marginTop: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
          <thead><tr><Th>On the map</Th><Th>State</Th><Th>Owner</Th><Th>Est. ER visits</Th><Th>News, 30 days</Th></tr></thead>
          <tbody>
            {data.pins.slice(0, 15).map((p) => <tr key={p.id}><Td><button type="button" onClick={() => onOpen(p.id)} style={linkBtn}>{p.name}</button></Td><Td>{p.state}</Td><Td>{short(p.bdr)}</Td><Td>{p.er != null ? n0(p.er) : <span style={muted}>Not in HubSpot</span>}</Td><Td>{p.alerts || <span style={muted}>0</span>}</Td></tr>)}
            {!data.pins.length && <tr><Td style={{ ...muted, padding: 20 }}>Nothing matches these filters.</Td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  )
}
