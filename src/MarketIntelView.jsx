import { useState, useEffect, useMemo, useCallback } from 'react'
import { apiFetch } from './api'

// MarketIntelView.jsx: Cipher's Market Intel tab.
//
// Accounts   HubSpot companies for a BDR, with why each is a target, its size from Definitive, and a star and assign
//            control. Stars and assignments are kept in Cipher. Nothing here writes to HubSpot.
// Insights   The news from the earlier tools, merged where two tools reported the same event, matched to HubSpot
//            accounts, with the outreach window each one has left.
// Data health  Admins only. Refresh from HubSpot, import the earlier tools' records, paste the state table, and see
//            what needs a decision: duplicate records, missing size, items with no account, dates that disagree.
//
// Who may do what is decided by the server. Nothing here is the lock.

const panel = { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }
const muted = { color: 'var(--text-tertiary)', fontSize: 12 }
const selStyle = { fontSize: 13, padding: '6px 9px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }
const btnStyle = (primary) => ({ fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 9, cursor: 'pointer', border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`, background: primary ? 'var(--accent)' : 'var(--bg-panel)', color: primary ? '#fff' : 'var(--text)' })
const TYPE_LABEL = { account_trigger: 'Account trigger', competitive: 'Competitive', ed_driver: 'ED driver', legislation: 'Legislation', coverage: 'Coverage', utilization: 'Utilization', readmissions: 'Readmissions' }
const WINDOW_TEXT = { open: (d) => `Window open, ${d} days left`, closing: (d) => `Closing, ${d} days left`, early: () => 'Window not open yet', passed: () => 'Window passed' }
const WINDOW_COLOR = { open: '#2F5A17', closing: '#8A3F06', early: '#3F4C58', passed: '#8A2820' }
const REASON_LABEL = { gold: 'Gold', bdr_led: 'BDR led', starred: 'Starred' }
const fmtDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '')
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never')
const n0 = (v) => (v == null ? '' : Number(v).toLocaleString('en-US'))

function Pill({ color = 'var(--text-secondary)', children, title }) {
  return <span title={title} style={{ fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 10, whiteSpace: 'nowrap', color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}>{children}</span>
}

function Th({ children }) { return <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 700, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{children}</th> }
function Td({ children, style }) { return <td style={{ padding: '10px', verticalAlign: 'top', borderBottom: '1px solid var(--border)', fontSize: 13, ...style }}>{children}</td> }

function SizeCell({ size, max }) {
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

// ---------- Accounts ----------

function AccountsView({ api, status, scope }) {
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [targets, setTargets] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const qs = new URLSearchParams({ limit: '500' })
      if (scope && scope !== 'all') qs.set('bdr', scope)
      if (targets) qs.set('targets', '1')
      if (q.trim()) qs.set('q', q.trim())
      setData(await api(`/api/intel/accounts?${qs}`))
    } catch (e) { setError(e.message) }
  }, [api, scope, targets, q])

  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t) }, [load, q])

  const change = async (row, patch) => {
    setBusyId(row.id)
    try { await api('/api/intel/stars', { method: 'POST', body: JSON.stringify({ accountId: row.id, ...patch }) }); await load() } catch (e) { setError(e.message) } finally { setBusyId('') }
  }
  const max = useMemo(() => Math.max(0, ...((data && data.rows) || []).map((r) => r.size.er || 0)), [data])
  const short = (key) => (status.bdrs.find((b) => b.key === key) || {}).short || key || 'Unassigned'

  if (error && !data) return <div style={{ ...panel, padding: 16, color: 'var(--red)' }}>{error}</div>
  if (!data) return <div style={{ ...panel, padding: 16, ...muted }}>Loading accounts...</div>
  if (!data.counts.accounts) return <div style={{ ...panel, padding: 20, fontSize: 14, lineHeight: 1.55 }}>HubSpot accounts have not been loaded yet. {status.admin ? 'Open Data health and choose Refresh from HubSpot.' : 'Ask an admin to refresh them from the Data health screen.'}</div>

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <input aria-label="Search accounts" placeholder="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...selStyle, minWidth: 220 }} />
        <label style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={targets} onChange={(e) => setTargets(e.target.checked)} />Targets only</label>
        <span style={muted}>{data.total.toLocaleString()} accounts{data.total > data.rows.length ? `, showing the first ${data.rows.length}` : ''} · {data.counts.targets.toLocaleString()} targets in all · {data.counts.targetsMissingSize} targets without size · HubSpot read {fmtWhen(data.refreshedAt)}</span>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
      <div style={{ ...panel, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead><tr><Th>Account</Th><Th>Owner</Th><Th>Why a target</Th><Th>Size from Definitive</Th><Th>Contacts</Th><Th>Last contacted</Th><Th>Star and assign</Th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <a href={`https://app.hubspot.com/contacts/${data.portalId}/record/0-2/${r.id}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-text)', fontWeight: 600, textDecoration: 'none' }}>{r.name}</a>
                  <div style={muted}>{[r.city, r.state || r.stateRaw].filter(Boolean).join(', ')}</div>
                </Td>
                <Td>{short(r.bdr)}{r.bdrSource === 'hub' && <div style={muted}>set in Cipher</div>}{r.bdrSource === 'state table' && <div style={muted}>from state table</div>}</Td>
                <Td><div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{r.reasons.length ? r.reasons.map((x) => <Pill key={x} color={x === 'gold' ? '#8A6D0B' : x === 'starred' ? 'var(--accent-text)' : '#5B3A8A'} title={x === 'gold' ? r.tier : undefined}>{x === 'gold' && r.tier ? r.tier.replace(/^GOLD - /i, 'Gold ').replace(/-/g, ' to ') : REASON_LABEL[x]}</Pill>) : <span style={muted}>Not a target</span>}</div></Td>
                <Td><SizeCell size={r.size} max={max} /></Td>
                <Td>{n0(r.contacts) || <span style={muted}>0</span>}</Td>
                <Td>{r.lastContacted ? fmtDate(r.lastContacted) : <span style={muted}>never</span>}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button type="button" aria-pressed={r.starred} aria-label={r.starred ? `Remove the star from ${r.name}` : `Star ${r.name}`} disabled={busyId === r.id} onClick={() => change(r, { star: !r.starred })}
                      style={{ ...btnStyle(false), padding: '5px 10px', color: r.starred ? '#B7791F' : 'var(--text-secondary)', borderColor: r.starred ? '#B7791F' : 'var(--border)' }}>{r.starred ? '★ Starred' : '☆ Star'}</button>
                    <select aria-label={`Assign ${r.name} to a BDR`} value={r.bdrSource === 'hub' ? r.bdr : ''} disabled={busyId === r.id} onChange={(e) => change(r, { assignTo: e.target.value || null })} style={selStyle}>
                      <option value="">Keep owner</option>
                      {status.bdrs.map((b) => <option key={b.key} value={b.key}>{b.short}</option>)}
                    </select>
                  </div>
                </Td>
              </tr>
            ))}
            {!data.rows.length && <tr><Td style={{ ...muted, padding: 20 }}>Nothing matches. Try clearing the search or turning off Targets only.</Td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------- Insights ----------

function InsightCard({ it, status }) {
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
          ? <span>{it.match.via === 'title' ? 'Possible account in HubSpot' : 'Account in HubSpot'}: <strong>{it.account.name}</strong>{it.account.state ? `, ${it.account.state}` : ''}{it.account.isTarget ? ' · target' : ''}{it.match.status === 'ambiguous' ? ` · could also be one of ${it.match.candidates.length - 1} other records` : ''}{it.match.via === 'title' ? ' · guessed from the headline, so check it' : ''}</span>
          : <span style={muted}>{it.level === 'federal' ? 'Federal item, no single account.' : 'No HubSpot account matched yet.'}</span>}
      </div>
      {it.dateConflict && <div style={{ marginTop: 8, background: '#FBF3DC', border: '1px solid #E3D18F', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, color: '#5C4A05' }}>The recorded date is {fmtDate(it.dateConflict.recorded)}, but the summary says &ldquo;{it.dateConflict.text}&rdquo;. Worth a look.</div>}
      {it.dateNotes && it.dateNotes.length > 0 && <div style={{ marginTop: 8, ...muted }}>The other tool dated this {fmtDate(it.dateNotes[0].date)}. Kept {fmtDate(it.dateNotes[0].kept)}.</div>}
    </div>
  )
}

function InsightsView({ api, status, scope }) {
  const [data, setData] = useState(null)
  const [type, setType] = useState('')
  const [days, setDays] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    ;(async () => {
      setError('')
      try {
        const qs = new URLSearchParams({ limit: '200' })
        if (scope && scope !== 'all') qs.set('bdr', scope)
        if (type) qs.set('type', type)
        if (days) qs.set('days', days)
        const d = await api(`/api/intel/insights?${qs}`)
        if (live) setData(d)
      } catch (e) { if (live) setError(e.message) }
    })()
    return () => { live = false }
  }, [api, scope, type, days])

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} style={selStyle}><option value="">All types</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="How recent" value={days} onChange={(e) => setDays(e.target.value)} style={selStyle}><option value="">Any date</option><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option></select>
        {data && <span style={muted}>{data.total} items, highest score first. Where two tools reported the same event, it is one card.</span>}
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {!data && !error && <div style={{ ...panel, padding: 16, ...muted }}>Loading insights...</div>}
      {data && !data.items.length && <div style={{ ...panel, padding: 20, fontSize: 14, lineHeight: 1.55 }}>Nothing to show. {status.admin ? 'Import the earlier tools\u2019 records on the Data health screen.' : 'Ask an admin to import the earlier tools\u2019 records.'}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{data && data.items.map((it) => <InsightCard key={it.id} it={it} status={status} />)}</div>
    </div>
  )
}

// ---------- Data health (admins) ----------

function Block({ title, note, children }) {
  return <section style={{ ...panel, padding: 16 }}><div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--accent-text)' }}>{title}</div>{note && <div style={{ ...muted, margin: '4px 0 10px' }}>{note}</div>}<div style={{ marginTop: note ? 0 : 10 }}>{children}</div></section>
}

function HealthView({ api, status, onChanged }) {
  const [h, setH] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [seed, setSeed] = useState(null)
  const [csv, setCsv] = useState('')
  const [lines, setLines] = useState([])

  const load = useCallback(async () => { try { setError(''); setH(await api('/api/intel/health')) } catch (e) { setError(e.message) } }, [api])
  useEffect(() => { load() }, [load])

  const refresh = async (restart) => {
    setBusy('refresh'); setMsg('Reading HubSpot...')
    try {
      let r = await api('/api/intel/refresh', { method: 'POST', body: JSON.stringify({ restart }) })
      while (!r.done) {
        setMsg(`Read ${r.count.toLocaleString()} of about ${(r.total || 0).toLocaleString()} companies so far...`)
        r = await api('/api/intel/refresh', { method: 'POST', body: JSON.stringify({}) })
      }
      setMsg(`Done. ${r.count.toLocaleString()} companies loaded.`)
      await load(); onChanged()
    } catch (e) { setMsg(e.message) } finally { setBusy('') }
  }

  const pickFile = async (file) => {
    setLines([]); setSeed(null)
    if (!file) return
    try {
      const j = JSON.parse(await file.text())
      if (!Array.isArray(j.alerts) && !Array.isArray(j.updates) && !Array.isArray(j.accounts)) throw new Error('That file has no alerts, updates or accounts in it.')
      setSeed(j)
    } catch (e) { setLines([`Could not read that file: ${e.message}`]) }
  }
  const runImport = async () => {
    setBusy('import'); setLines([])
    const out = []
    try {
      for (const source of ['alerts', 'updates', 'accounts']) {
        const records = seed[source]
        if (!records || !records.length) continue
        const r = await api('/api/intel/import', { method: 'POST', body: JSON.stringify({ source, records }) })
        out.push(`${source}: ${r.received} read, ${r.added} added, ${r.updated} updated, ${r.skipped} skipped. Matched to HubSpot: ${r.matched}, unsure: ${r.ambiguous}, none: ${r.unmatched}.${r.notes && r.notes.length ? ' ' + r.notes.join(' ') : ''}`)
        setLines([...out])
      }
      await load(); onChanged()
    } catch (e) { out.push(`Stopped: ${e.message}`); setLines([...out]) } finally { setBusy('') }
  }
  const saveTable = async () => {
    setBusy('table'); setMsg('')
    try { const r = await api('/api/intel/state-table', { method: 'POST', body: JSON.stringify({ csv }) }); setMsg(`Saved ${r.count} states.`); setCsv(''); await load(); onChanged() } catch (e) { setMsg(e.message) } finally { setBusy('') }
  }

  if (error && !h) return <div style={{ ...panel, padding: 16, color: 'var(--red)' }}>{error}</div>
  if (!h) return <div style={{ ...panel, padding: 16, ...muted }}>Loading Data health...</div>
  const a = h.accounts, ins = h.insights
  const tile = (label, value, sub) => <div style={{ ...panel, padding: '12px 14px', flex: '1 1 150px' }}><div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{label}</div><div style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>{sub && <div style={muted}>{sub}</div>}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {tile('HubSpot accounts', n0(a.count), `read ${fmtWhen(a.refreshedAt)}`)}
        {tile('Targets', n0(a.targets), `${a.targetsPendingSize.length} without size`)}
        {tile('News items', n0(ins.raw), `${ins.merged} merged, ${ins.matched} matched`)}
        {tile('Need a decision', n0(h.duplicates.filter((d) => d.kind === 'several_bdrs').length + ins.ambiguous.length + ins.dateConflicts.length), 'duplicates, unsure matches, dates')}
      </div>

      <Block title="Refresh from HubSpot" note="Reads companies in steps, so it never hits the time limit. It uses your HubSpot connection and only reads. The account list is replaced only when the whole read finishes.">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={btnStyle(true)} disabled={!!busy} onClick={() => refresh(true)}>{busy === 'refresh' ? 'Reading...' : 'Refresh from HubSpot'}</button>
          {h.refresh && !h.refresh.done && !busy && <button type="button" style={btnStyle(false)} onClick={() => refresh(false)}>Continue the unfinished read</button>}
          <span style={{ fontSize: 13 }} role="status">{msg}</span>
        </div>
      </Block>

      <Block title="Import from the earlier tools" note="Choose the seed file (market-intel-seed.json). Importing twice is safe: the same records are updated, not added again. Saved accounts are checked against HubSpot, not copied.">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".json,application/json" aria-label="Seed file" onChange={(e) => pickFile(e.target.files[0])} />
          {seed && <span style={muted}>{(seed.alerts || []).length} alerts, {(seed.updates || []).length} updates, {(seed.accounts || []).length} accounts</span>}
          <button type="button" style={btnStyle(true)} disabled={!seed || !!busy} onClick={runImport}>{busy === 'import' ? 'Importing...' : 'Import'}</button>
        </div>
        {lines.length > 0 && <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.55 }}>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </Block>

      <Block title="State to BDR table" note={`Using ${h.stateTable.source === 'saved' ? `the saved table, ${h.stateTable.rows} states saved ${fmtWhen(h.stateTable.savedAt)}` : 'the built in table, which matches the territory workbook'}. Paste two columns from Excel, a state and a BDR, only if a territory changes. HubSpot's Assigned BDR still comes first for any account that has one.`}>
        <textarea aria-label="State to BDR table" value={csv} onChange={(e) => setCsv(e.target.value)} rows={4} placeholder={'State\tBDR\nNJ\tChris Knapp\nOH\tAbby'} style={{ ...selStyle, width: '100%', fontFamily: 'var(--font-mono)', boxSizing: 'border-box' }} />
        <div style={{ marginTop: 8 }}><button type="button" style={btnStyle(true)} disabled={!csv.trim() || !!busy} onClick={saveTable}>Save table</button></div>
      </Block>

      <Block title="Systems with more than one HubSpot record" note={`Same name words, different owners or states first. These are listed for you to merge in HubSpot. Market Intel never merges them.${h.duplicatesHidden ? ` ${h.duplicatesHidden} names that appear in four or more states (such as Community Medical Center) are different hospitals, so they are left out.` : ''}`}>
        {h.duplicates.length ? <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><Th>Name</Th><Th>Records</Th><Th>Kind</Th><Th>BDRs</Th><Th>States</Th></tr></thead><tbody>
          {h.duplicates.slice(0, 25).map((d) => <tr key={d.key}><Td>{d.name}</Td><Td>{d.count}</Td><Td>{d.kind === 'several_bdrs' ? <Pill color="#8A3F06">Several BDRs</Pill> : d.kind === 'several_states' ? <Pill color="#8A6D0B">Several states</Pill> : <Pill>Same place</Pill>}</Td><Td>{d.bdrs.map((b) => (status.bdrs.find((x) => x.key === b) || {}).short || b).join(', ')}</Td><Td>{d.states.join(', ')}</Td></tr>)}
        </tbody></table></div> : <div style={muted}>None found.</div>}
      </Block>

      <Block title="Targets without size" note="Pending means the company has a Definitive ID and its numbers have not arrived yet. Not in HubSpot means it has no Definitive record at all.">
        {a.targetsPendingSize.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>{a.targetsPendingSize.map((p) => <li key={p.id}>{p.name}{p.state ? `, ${p.state}` : ''}: {p.status === 'pending_definitive' ? 'Definitive data pending' : p.status === 'partial' ? 'ER visits missing' : 'not in HubSpot'}</li>)}</ul> : <div style={muted}>Every target has size data.</div>}
      </Block>

      <Block title="News items with no clear account" note="No match means no HubSpot company in that state has the organization's name. Unsure means several records fit and none is clearly the right one.">
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          {ins.ambiguous.length > 0 && <><strong>Unsure ({ins.ambiguous.length})</strong><ul style={{ margin: '2px 0 10px', paddingLeft: 18 }}>{ins.ambiguous.slice(0, 20).map((x) => <li key={x.id}>{x.org || x.title}: {x.candidates.map((c) => `${c.name || c.id}${c.state ? ` (${c.state}${c.bdr ? `, ${(status.bdrs.find((b) => b.key === c.bdr) || {}).short || c.bdr}` : ''})` : ''}`).join(' or ')}</li>)}</ul></>}
          <strong>No match ({ins.unmatched.length})</strong>
          <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{ins.unmatched.slice(0, 25).map((x) => <li key={x.id}>{x.org || x.title}{x.states.length ? ` (${x.states.join(', ')})` : ''}</li>)}{ins.unmatched.length > 25 && <li style={muted}>and {ins.unmatched.length - 25} more</li>}</ul>
        </div>
      </Block>

      <Block title="Dates that disagree with the summary" note="The item keeps its recorded date. Check these and correct the source if needed.">
        {ins.dateConflicts.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>{ins.dateConflicts.map((d) => <li key={d.id}>{d.title}: dated {fmtDate(d.recorded)}, summary says &ldquo;{d.summarySays}&rdquo;</li>)}</ul> : <div style={muted}>None found.</div>}
      </Block>

      <Block title="Imports so far">
        {h.importLog.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>{h.importLog.map((l, i) => <li key={i}>{fmtWhen(l.at)}, {l.by || 'someone'}: {l.source}, {l.received} read, {l.added} added, {l.updated} updated</li>)}</ul> : <div style={muted}>Nothing imported yet.</div>}
      </Block>
    </div>
  )
}

// ---------- the tab ----------

export default function MarketIntelView({ getToken, currentUserName }) {
  const api = useCallback((path, options) => apiFetch(path, getToken, options), [getToken])
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [view, setView] = useState('accounts')
  const [scope, setScope] = useState(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const s = await api('/api/intel/status')
        if (!live) return
        setStatus(s)
        const me = String(currentUserName || '').toLowerCase()
        const mine = s.bdrs.find((b) => b.key.toLowerCase() === me)
        setScope((cur) => cur || (mine ? mine.key : 'all'))
      } catch (e) { if (live) setError(e.message) }
    })()
    return () => { live = false }
  }, [api, currentUserName, tick])

  if (error) return <div style={{ ...panel, padding: 16, color: 'var(--red)' }}>{error}</div>
  if (!status) return <div style={{ ...panel, padding: 16, ...muted }}>Loading Market Intel...</div>

  const tabs = [['accounts', 'Accounts'], ['insights', 'Insights'], ...(status.admin ? [['health', 'Data health']] : [])]
  const segs = [{ key: 'all', label: 'All' }, ...status.bdrs.map((b) => ({ key: b.key, label: `${b.short} · ${b.territory}` }))]
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 20px', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' }}>Market Intel</h2>
          <div style={muted}>HubSpot accounts and the team's market news in one place. Read only from HubSpot.</div>
        </div>
        <div role="group" aria-label="Territory" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {segs.map((s) => <button key={s.key} type="button" aria-pressed={scope === s.key} onClick={() => setScope(s.key)} style={{ ...btnStyle(false), padding: '6px 11px', fontWeight: scope === s.key ? 700 : 500, borderColor: scope === s.key ? 'var(--accent)' : 'var(--border)', background: scope === s.key ? 'var(--accent-light)' : 'var(--bg-panel)', color: scope === s.key ? 'var(--accent-text)' : 'var(--text-secondary)' }}>{s.label}</button>)}
        </div>
      </div>
      <div role="tablist" aria-label="Market Intel" style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)} style={{ ...btnStyle(false), borderRadius: 999, padding: '7px 16px', background: view === k ? 'var(--accent)' : 'var(--bg-secondary)', color: view === k ? '#fff' : 'var(--text-secondary)', borderColor: view === k ? 'var(--accent)' : 'var(--border)' }}>{label}</button>)}
      </div>
      {view === 'accounts' && <AccountsView api={api} status={status} scope={scope} />}
      {view === 'insights' && <InsightsView api={api} status={status} scope={scope} />}
      {view === 'health' && status.admin && <HealthView api={api} status={status} onChanged={() => setTick((t) => t + 1)} />}
    </div>
  )
}
