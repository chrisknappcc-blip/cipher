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

// The size of a company in words, so every screen says the same thing about a missing number.
export const sizeText = (status, er) => (er != null ? n0(er) : status === 'pending_definitive' ? 'Definitive data pending' : status === 'partial' ? 'ER visits missing' : 'Not in HubSpot')

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

export const LINE_LABEL = { ed: 'ED and urgent care', cardio: 'Cardiology', ortho: 'Orthopedics', neuro: 'Neurology', gi: 'GI', derm: 'Dermatology', onc: 'Oncology', womens: "Women's and maternity", behavioral: 'Behavioral health', peds: 'Pediatrics' }
export const CLASS_LABEL = { deal: 'Deal', closure: 'Closure', new_site: 'New site', ed_flow: 'ED volume', leadership: 'Leadership', growth: 'Growth', policy: 'Policy' }
export const PHASE_LABEL = { watch: 'Watch', closed: 'Closed', event: 'Reported' }

function Part({ n, title, suggested, children }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '9px 0', borderTop: '1px solid var(--border)' }}>
      <div aria-hidden="true" style={{ flex: 'none', width: 22, height: 22, borderRadius: 11, background: 'var(--bg-secondary)', color: 'var(--accent-text)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{n}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: 3 }}>
          {title}{suggested && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontStyle: 'italic', marginLeft: 8, color: 'var(--text-tertiary)' }}>suggested by rule, not from the source</span>}
        </div>
        {children}
      </div>
    </div>
  )
}

// The prompt pack's four part card: what happened, why it matters, how Care Continuity closes the loop, and who to contact
// with an opening line. Anything the source did not give is filled by a rule and says so.
export function InsightCard({ it, status, onOpen }) {
  const w = it.window
  // Older answers carried no four part fields. Fall back to what the card does have, so a card never fails to draw.
  const fp = it.fourPart || { product: { lead: it.leadProduct || null, secondary: it.secondaryProduct || null, derived: false }, contacts: { list: it.contacts || [], derived: false }, opening: { text: it.openingLine || '', derived: false }, sourced: (it.sources || []).some((x) => x && x.url) }
  const fits = (it.productFit || []).filter((f) => f.product !== fp.product.lead).slice(0, 3)
  const short = (key) => (status.bdrs.find((b) => b.key === key) || {}).short || key
  return (
    <div style={{ ...panel, padding: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <Pill color="var(--accent-text)">{TYPE_LABEL[it.type] || it.type}</Pill>
        {it.states.map((s) => <Pill key={s} color="#1B5A78">{s}</Pill>)}
        {it.phase === 'watch' && <Pill color="#8A3F06" title="A deal or new site that has not happened yet">Watch</Pill>}
        {w && <Pill color={WINDOW_COLOR[w.status]}>{WINDOW_TEXT[w.status](w.daysLeft)}</Pill>}
        {it.score != null && it.origin === 'account-intelligence' && <Pill color="#8A6D0B" title="News score from 0 to 99">Score {it.score}</Pill>}
        {it.merged > 1 && <Pill color="#2F5A17" title="Two tools reported this. They are shown as one.">{it.merged} sources merged</Pill>}
        {it.bdr && <Pill color="var(--text-secondary)">{short(it.bdr)}</Pill>}
        {(it.serviceLines || []).slice(0, 3).map((l) => <Pill key={l} color="#5B3A8A">{LINE_LABEL[l] || l}</Pill>)}
        {it.fromArticle && <Pill color="#1B5A78" title="Read from a pasted article with the analyzer">Added from an article{it.addedBy ? ` by ${it.addedBy.split('@')[0]}` : ''}</Pill>}
        {fp && !fp.sourced && <Pill color="#8A2820" title="Every card should point back to its source">No source link</Pill>}
      </div>
      <div style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.35, marginBottom: 6 }}>{it.title}</div>

      <Part n={1} title="What happened">
        <p style={{ margin: '0 0 4px', fontSize: 13, lineHeight: 1.55 }}>{it.whatHappened || 'The source does not say.'}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {it.sources.map((s, i) => (s.url ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-text)' }}>{s.name || 'Source'}, {fmtDate(s.date)}</a> : <span key={i}>{s.name || 'Source'}, {fmtDate(s.date)}</span>))}
          {it.deadline && <span>Takes effect {fmtDate(it.deadline.date)}</span>}
        </div>
      </Part>
      <Part n={2} title="Why it matters">
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: it.whyItMatters ? 'inherit' : 'var(--text-tertiary)' }}>{it.whyItMatters || 'The source does not say.'}</p>
      </Part>
      <Part n={3} title="How Care Continuity closes the loop" suggested={fp && fp.product.derived}>
        <div style={{ fontSize: 13 }}>{fp.product.lead ? <>Lead: <strong>{fp.product.lead}</strong>{fp.product.secondary ? `, also ${fp.product.secondary}` : ''}</> : <span style={muted}>The source does not say.</span>}</div>
        {fits.length > 0 && <div style={{ ...muted, marginTop: 4 }}>Also fits: {fits.map((f) => `${f.product} (${f.why.charAt(0).toLowerCase()}${f.why.slice(1)})`).join(' \u00B7 ')}</div>}
      </Part>
      <Part n={4} title="Who to contact" suggested={fp && fp.contacts.derived}>
        {fp.contacts.list.length ? fp.contacts.list.map((c, i) => <div key={i} style={{ fontSize: 13, lineHeight: 1.5 }}>{c.name ? <strong>{c.name}, </strong> : null}{c.title}{c.why ? <span style={muted}> {'\u00B7'} {c.why}</span> : null}</div>) : <div style={{ fontSize: 13, ...muted }}>The source does not say.</div>}
        {fp.opening.text && (
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 13, margin: '8px 0 0' }}>
            <div style={{ ...muted, marginBottom: 2 }}>{fp.opening.derived ? 'Suggested question, built from the headline' : 'Opening line'}</div>
            &ldquo;{fp.opening.text}&rdquo;
          </div>
        )}
      </Part>

      <div style={{ marginTop: 6, fontSize: 12.5 }}>
        {it.account
          ? <span>{it.match.via === 'title' ? 'Possible account in HubSpot' : 'Account in HubSpot'}: {onOpen ? <button type="button" onClick={() => onOpen(it.account.id)} style={linkBtn}>{it.account.name}</button> : <strong>{it.account.name}</strong>}{it.account.state ? `, ${it.account.state}` : ''}{it.account.isTarget ? ' \u00B7 target' : ''}{it.match.status === 'ambiguous' ? ` \u00B7 could also be one of ${it.match.candidates.length - 1} other records` : ''}{it.match.via === 'title' ? ' \u00B7 guessed from the headline, so check it' : ''}</span>
          : <span style={muted}>{it.level === 'federal' ? 'Federal item, no single account.' : 'No HubSpot account matched yet.'}</span>}
      </div>
      {it.dateConflict && <div style={{ marginTop: 8, background: '#FBF3DC', border: '1px solid #E3D18F', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, color: '#5C4A05' }}>The recorded date is {fmtDate(it.dateConflict.recorded)}, but the summary says &ldquo;{it.dateConflict.text}&rdquo;. Worth a look.</div>}
      {it.dateNotes && it.dateNotes.length > 0 && <div style={{ marginTop: 8, ...muted }}>The other tool dated this {fmtDate(it.dateNotes[0].date)}. Kept {fmtDate(it.dateNotes[0].kept)}.</div>}
    </div>
  )
}
