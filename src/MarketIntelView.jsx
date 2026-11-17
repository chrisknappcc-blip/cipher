import { useState, useEffect, useMemo, useCallback } from 'react'
import { apiFetch } from './api'
import { panel, muted, selStyle, btnStyle, Pill, Th, Td, SizeCell, InsightCard, REASON_LABEL, TYPE_LABEL, fmtDate, fmtWhen, n0, linkBtn } from './intelUi'
import HomeView from './IntelHome'
import MapView from './IntelMap'
import AccountPanel from './IntelAccount'
import CompetitiveView from './IntelCompetitive'
import Analyzer from './IntelAnalyzer'
import BySolution from './IntelProducts'

// MarketIntelView.jsx: Cipher's Market Intel tab.
//
// Home       What is open to reach out about now, the best bets in order, and what is happening nearby.
// Insights   The news sorted into a collapsible menu for each of the four solutions (or one plain list), as the pack's four part card, filtered by state, service line and type, with an analyzer that turns a
//            pasted article into a card.
// ED and Competitive  Deals, closures and new sites as a timeline, deals still pending flagged Watch, with a state view.
// Map        The US by territory, with each account placed by its HubSpot city.
// Account    One account in one panel, opened from the map, the lists or a news card.
// Accounts   HubSpot companies for a BDR, with why each is a target, its size from Definitive, and a star and assign
//            control. Stars and assignments are kept in Cipher. Nothing here writes to HubSpot.
// Insights   The news from the earlier tools, merged where two tools reported the same event, matched to HubSpot
//            accounts, with the outreach window each one has left.
// Data health  Admins only. Refresh from HubSpot, import the earlier tools' records, paste the state table, and see
//            what needs a decision: duplicate records, missing size, items with no account, dates that disagree.
//
// Who may do what is decided by the server. Nothing here is the lock.

// ---------- Accounts ----------

function AccountsView({ api, status, scope, onOpen }) {
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [targets, setTargets] = useState(true)
  const [bdrLed, setBdrLed] = useState(false)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const qs = new URLSearchParams({ limit: '500' })
      if (scope && scope !== 'all') qs.set('bdr', scope)
      if (targets) qs.set('targets', '1')
      if (targets && bdrLed) qs.set('bdrLed', '1')
      if (q.trim()) qs.set('q', q.trim())
      setData(await api(`/api/intel/accounts?${qs}`))
    } catch (e) { setError(e.message) }
  }, [api, scope, targets, bdrLed, q])

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
        {targets && <label style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }} title="Accounts flagged BDR led in HubSpot that are not on the Gold list"><input type="checkbox" checked={bdrLed} onChange={(e) => setBdrLed(e.target.checked)} />Include BDR led ({data.counts.bdrLedInView})</label>}
        <span style={muted}>{data.total.toLocaleString()} accounts{data.total > data.rows.length ? `, showing the first ${data.rows.length}` : ''} · {data.counts.targets.toLocaleString()} Gold and starred accounts in all · {data.counts.targetsMissingSize} without size · HubSpot read {fmtWhen(data.refreshedAt)}</span>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
      <div style={{ ...panel, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead><tr><Th>Account</Th><Th>Owner</Th><Th>Why a target</Th><Th>Size from Definitive</Th><Th>Contacts</Th><Th>Last contacted</Th><Th>Star and assign</Th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <button type="button" onClick={() => onOpen(r.id)} style={{ ...linkBtn, fontSize: 13 }}>{r.name}</button>
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

function InsightsView({ api, status, scope, onOpen }) {
  const [data, setData] = useState(null)
  const [type, setType] = useState('')
  const [days, setDays] = useState('')
  const [state, setState] = useState('')
  const [line, setLine] = useState('')
  const [q, setQ] = useState('')
  const [qNow, setQNow] = useState('')
  const [openOnly, setOpenOnly] = useState(false)
  const [mode, setMode] = useState('solution')
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setTimeout(() => setQNow(q.trim()), 250); return () => clearTimeout(t) }, [q])
  useEffect(() => {
    let live = true
    ;(async () => {
      setError('')
      try {
        const qs = new URLSearchParams({ limit: '500' })
        if (scope && scope !== 'all') qs.set('bdr', scope)
        if (type) qs.set('type', type)
        if (days) qs.set('days', days)
        if (state) qs.set('state', state)
        if (line) qs.set('line', line)
        if (qNow) qs.set('q', qNow)
        if (openOnly) qs.set('open', '1')
        const d = await api(`/api/intel/insights?${qs}`)
        if (live) setData(d)
      } catch (e) { if (live) setError(e.message) }
    })()
    return () => { live = false }
  }, [api, scope, type, days, state, line, qNow, openOnly, tick])

  const f = data && data.facets
  const filtered = !!(type || days || state || line || qNow || openOnly)
  const clear = () => { setType(''); setDays(''); setState(''); setLine(''); setQ(''); setQNow(''); setOpenOnly(false) }
  return (
    <div>
      <Analyzer api={api} status={status} onSaved={() => setTick((t) => t + 1)} />
      <div role="group" aria-label="How to sort the news" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <button type="button" aria-pressed={mode === 'solution'} onClick={() => setMode('solution')} style={btnStyle(mode === 'solution')}>By solution</button>
        <button type="button" aria-pressed={mode === 'all'} onClick={() => setMode('all')} style={btnStyle(mode === 'all')}>All news</button>
        <span style={muted}>{mode === 'solution' ? 'One menu for each of the four solutions, so you can write for one product at a time.' : 'One list, highest score first.'}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <input aria-label="Search the news" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the news" style={{ ...selStyle, width: 190 }} />
        <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} style={selStyle}><option value="">All states</option>{f && Object.keys(f.states).sort().map((k) => <option key={k} value={k}>{k} ({f.states[k]})</option>)}</select>
        <select aria-label="Service line" value={line} onChange={(e) => setLine(e.target.value)} style={selStyle}><option value="">All service lines</option>{f && f.lines.map((l) => <option key={l.key} value={l.key} disabled={!l.count && line !== l.key}>{l.label} ({l.count})</option>)}</select>
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} style={selStyle}><option value="">All types</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="How recent" value={days} onChange={(e) => setDays(e.target.value)} style={selStyle}><option value="">Any date</option><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option></select>
        <label style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />Open windows only</label>
        {filtered && <button type="button" onClick={clear} style={{ ...btnStyle(false), padding: '5px 10px', fontSize: 12.5 }}>Clear filters</button>}
        {data && <span style={muted}>{data.total} items, highest score first. Where two tools reported the same event, it is one card.</span>}
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {!data && !error && <div style={{ ...panel, padding: 16, ...muted }}>Loading insights...</div>}
      {data && !data.items.length && <div style={{ ...panel, padding: 20, fontSize: 14, lineHeight: 1.55 }}>{filtered ? 'Nothing matches these filters.' : `Nothing to show. ${status.admin ? 'Import the earlier tools\u2019 records on the Data health screen.' : 'Ask an admin to load the news.'}`}</div>}
      {data && data.items.length > 0 && mode === 'solution' && <BySolution items={data.items} kit={data.products} facets={data.facets} status={status} onOpen={onOpen} />}
      {mode === 'all' && <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{data && data.items.map((it) => <InsightCard key={it.id} it={it} status={status} onOpen={it.match.via === 'title' ? undefined : onOpen} />)}</div>}
    </div>
  )
}

// ---------- Data health (admins) ----------

function Block({ title, note, children }) {
  return <section style={{ ...panel, padding: 16 }}><div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--accent-text)' }}>{title}</div>{note && <div style={{ ...muted, margin: '4px 0 10px' }}>{note}</div>}<div style={{ marginTop: note ? 0 : 10 }}>{children}</div></section>
}

function HealthView({ api, status, onChanged }) {
  const [h, setH] = useState(null)
  const [ai, setAi] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [seed, setSeed] = useState(null)
  const [csv, setCsv] = useState('')
  const [lines, setLines] = useState([])

  const load = useCallback(async () => { try { setError(''); setH(await api('/api/intel/health')); setAi(await api('/api/intel/ai-status').catch(() => null)) } catch (e) { setError(e.message) } }, [api])
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
        {tile('Gold and starred', n0(a.targets), `${a.targetsPendingSize.length} without size · ${n0(a.bdrLedOnly)} more are BDR led`)}
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

      <Block title="News with no source link" note="Every card should point back to its source. Add the link in the tool the news came from, then import again.">
        {ins.unsourced.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>{ins.unsourced.map((u) => <li key={u.id}>{u.title}{u.org ? ` (${u.org})` : ''}</li>)}</ul> : <div style={muted}>Every card has a source link.</div>}
      </Block>

      <Block title="News that may be the same event" note="The same source link, or a headline that is mostly the same words. The scan and the Radar are already merged. These are left for you to judge.">
        {ins.possibleDuplicates.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>{ins.possibleDuplicates.map((d, i) => <li key={i}>{d.a.title} <span style={muted}>and</span> {d.b.title}</li>)}</ul> : <div style={muted}>None found.</div>}
      </Block>

      <Block title="News coverage by solution" note="How much real news there is for each solution. Lead and same subject cards are about it. Also is only the earlier tool's tag. Thin means far less than the best covered solution, and the daily scan should look for what is listed.">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>{ins.byProduct.map((p) => <li key={p.name}><strong>{p.name}</strong>: {p.lead} lead, {p.theme} on the subject, {p.also} also, {p.open} open windows.{p.thin ? <> <Pill color="#8A3F06">Thin</Pill> Look for: {p.searchFor}.</> : ''}</li>)}</ul>
      </Block>

      <Block title="Article analyzer" note="Reads a pasted article with Claude, using Cipher's existing Claude key. A count is kept so the cost is never a surprise.">
        {ai ? <div style={{ fontSize: 13, lineHeight: 1.7 }}>{ai.enabled ? 'On.' : `Off. ${ai.reason}`} Model {ai.model}. Limit {ai.limitPerDay} analyses per person per day. This month: {ai.month.runs} analyses, {n0(ai.month.input)} tokens read, {n0(ai.month.output)} written, about ${ai.month.estCost.toFixed(2)} (an estimate).</div> : <div style={muted}>Not available.</div>}
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
  const [view, setView] = useState('home')
  const [openId, setOpenId] = useState(null)
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

  const tabs = [['home', 'Home'], ['map', 'Map'], ['insights', 'Insights'], ['competitive', 'ED and Competitive'], ['accounts', 'Accounts'], ...(status.admin ? [['health', 'Data health']] : [])]
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
        {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => { setView(k); setOpenId(null) }} style={{ ...btnStyle(false), borderRadius: 999, padding: '7px 16px', background: view === k ? 'var(--accent)' : 'var(--bg-secondary)', color: view === k ? '#fff' : 'var(--text-secondary)', borderColor: view === k ? 'var(--accent)' : 'var(--border)' }}>{label}</button>)}
      </div>
      {openId && <AccountPanel api={api} status={status} id={openId} onBack={() => setOpenId(null)} onOpen={setOpenId} />}
      {!openId && view === 'home' && <HomeView api={api} status={status} scope={scope} userName={currentUserName} onOpen={setOpenId} />}
      {!openId && view === 'map' && <MapView api={api} status={status} scope={scope} onOpen={setOpenId} />}
      {!openId && view === 'competitive' && <CompetitiveView api={api} status={status} scope={scope} onOpen={setOpenId} />}
      {!openId && view === 'accounts' && <AccountsView api={api} status={status} scope={scope} onOpen={setOpenId} />}
      {!openId && view === 'insights' && <InsightsView api={api} status={status} scope={scope} onOpen={setOpenId} />}
      {!openId && view === 'health' && status.admin && <HealthView api={api} status={status} onChanged={() => setTick((t) => t + 1)} />}
    </div>
  )
}
