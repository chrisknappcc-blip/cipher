// src/intelUi.jsx
//
// The small pieces every Market Intel screen shares: the panel and button styles, pills, table cells, the size cell and the
// news card. Kept in one place so the map, the account panel, the home screen and the lists all look the same.

export const panel = { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }
export const muted = { color: 'var(--text-tertiary)', fontSize: 12 }
export const selStyle = { fontSize: 13, padding: '6px 9px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }
export const btnStyle = (primary) => ({ fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 9, cursor: 'pointer', border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`, background: primary ? 'var(--accent)' : 'var(--bg-panel)', color: primary ? '#fff' : 'var(--text)' })
export const TYPE_LABEL = { account_trigger: 'Account trigger', competitive: 'Competitive', ed_driver: 'ED driver', legislation: 'Legislation', coverage: 'Coverage', utilization: 'Utilization', readmissions: 'Readmissions' }
export const WINDOW_TEXT = { open: (d) => `Window open, ${d} days left`, closing: (d) => `Closing, ${d} days left`, early: () => 'Window not open yet', passed: () => 'Window passed' }
export const WINDOW_COLOR = { open: '#2F5A17', closing: '#8A3F06', early: '#3F4C58', passed: '#8A2820' }
export const REASON_LABEL = { gold: 'Gold', bdr_led: 'BDR led', starred: 'Starred' }
export const fmtDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '')
export const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never')
export const n0 = (v) => (v == null ? '' : Number(v).toLocaleString('en-US'))

export function Pill({ color = 'var(--text-secondary)', children, title }) {
  return <span title={title} style={{ fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 10, whiteSpace: 'nowrap', color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}>{children}</span>
}

export function Th({ children }) { return <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 700, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{children}</th> }
export function Td({ children, style }) { return <td style={{ padding: '10px', verticalAlign: 'top', borderBottom: '1px solid var(--border)', fontSize: 13, ...style }}>{children}</td> }

export function SizeCell({ size, max }) {
  if (size.status === 'ok' || size.status === 'partial') {
    return (
      <div style={{ minWidth: 150 }}>
        {size.er != null
          ? <div><strong style={{ fontVariantNumeric: 'tabular-nums' }}>{n0(size.er)}</strong> <span style={muted}>est. ER visits</span></div>
          : <div style={muted}>ER visits not in HubSpot</div>}
        {size.er != null && max > 0 && <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-secondary)', margin: '4px 0 2px', overflow: 'hidden' }}><div style={{ height: 6, width: `${Math.max(3, (size.er / max) * 100)}%`, background: 'var(--accent)' }} /></div>}
        <div style={muted}>{size.beds != null ? `${n0(size.beds)} beds` : ''}{size.hospitals ? ` · ${size.hospitals} hospitals` : ''}</div>
      </div>
    )
  }
  if (size.status === 'pending_definitive') return <span style={muted} title="This company has a Definitive ID. The numbers arrive when your Definitive integration reaches it.">Definitive data pending</span>
  return <span style={muted}>Not in HubSpot</span>
}


export const linkBtn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-text)', fontWeight: 700, fontSize: 'inherit', fontFamily: 'inherit', textDecoration: 'underline' }

export function InsightCard({ it, status, onOpen }) {
  const w = it.window
  const short = (key) => (status.bdrs.find((b) => b.key === key) || {}).short || key
  return (
    <div style={{ ...panel, padding: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <Pill color="var(--accent-text)">{TYPE_LABEL[it.type] || it.type}</Pill>
        {it.states.map((s) => <Pill key={s} color="#1B5A78">{s}</Pill>)}
        {w && <Pill color={WINDOW_COLOR[w.status]}>{WINDOW_TEXT[w.status](w.daysLeft)}</Pill>}
        {it.score != null && it.origin === 'account-intelligence' && <Pill color="#8A6D0B" title="News score from 0 to 99">Score {it.score}</Pill>}
        {it.merged > 1 && <Pill color="#2F5A17" title="Two tools reported this. They are shown as one.">{it.merged} sources merged</Pill>}
        {it.bdr && <Pill color="var(--text-secondary)">{short(it.bdr)}</Pill>}
      </div>
      <div style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.35, marginBottom: 6 }}>{it.title}</div>
      {it.whatHappened && <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.55 }}>{it.whatHappened}</p>}
      {it.whyItMatters && <p style={{ margin: '0 0 8px', fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}><strong>Why it matters.</strong> {it.whyItMatters}</p>}
      {it.openingLine && <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 13, margin: '0 0 8px' }}>&ldquo;{it.openingLine}&rdquo;</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', alignItems: 'center', fontSize: 12.5, color: 'var(--text-secondary)' }}>
        {it.leadProduct && <span>Lead: <strong>{it.leadProduct}</strong>{it.secondaryProduct ? `, also ${it.secondaryProduct}` : ''}</span>}
        {it.sources.map((s, i) => s.url ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-text)' }}>{s.name || 'Source'}, {fmtDate(s.date)}</a> : <span key={i}>{s.name}, {fmtDate(s.date)}</span>)}
        {it.deadline && <span>Takes effect {fmtDate(it.deadline.date)}</span>}
      </div>
      <div style={{ marginTop: 8, fontSize: 12.5 }}>
        {it.account
          ? <span>{it.match.via === 'title' ? 'Possible account in HubSpot' : 'Account in HubSpot'}: {onOpen ? <button type="button" onClick={() => onOpen(it.account.id)} style={linkBtn}>{it.account.name}</button> : <strong>{it.account.name}</strong>}{it.account.state ? `, ${it.account.state}` : ''}{it.account.isTarget ? ' · target' : ''}{it.match.status === 'ambiguous' ? ` · could also be one of ${it.match.candidates.length - 1} other records` : ''}{it.match.via === 'title' ? ' · guessed from the headline, so check it' : ''}</span>
          : <span style={muted}>{it.level === 'federal' ? 'Federal item, no single account.' : 'No HubSpot account matched yet.'}</span>}
      </div>
      {it.dateConflict && <div style={{ marginTop: 8, background: '#FBF3DC', border: '1px solid #E3D18F', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, color: '#5C4A05' }}>The recorded date is {fmtDate(it.dateConflict.recorded)}, but the summary says &ldquo;{it.dateConflict.text}&rdquo;. Worth a look.</div>}
      {it.dateNotes && it.dateNotes.length > 0 && <div style={{ marginTop: 8, ...muted }}>The other tool dated this {fmtDate(it.dateNotes[0].date)}. Kept {fmtDate(it.dateNotes[0].kept)}.</div>}
    </div>
  )
}

