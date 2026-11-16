import { useState, useEffect, useCallback } from 'react'
import { panel, muted, selStyle, btnStyle, Pill, REASON_LABEL, InsightCard, fmtDate, n0, sizeText, linkBtn } from './intelUi'

// IntelAccount.jsx: one account, the same panel wherever it is opened from (the map, the lists, a news card).
// It shows what HubSpot holds, the news matched to the account, who to talk to, related records, and the part of the
// opportunity score that has data today. Contacts are read live on the signed in person's own HubSpot connection.

const TERR = { 'Harley Reed': 'West', 'Abigail Evans': 'Central', 'Chiara Pate': 'Gulf', 'Chris Knapp': 'East' }

function Row({ k, v, placeholder }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}><span style={{ color: 'var(--text-secondary)' }}>{k}</span><span style={{ fontWeight: 600, textAlign: 'right', overflowWrap: 'anywhere', ...(placeholder ? { color: 'var(--text-tertiary)', fontStyle: 'italic', fontWeight: 400 } : {}) }}>{v}</span></div>
}
function Card({ title, note, children }) {
  return <section style={{ ...panel, padding: 16 }}><div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--accent-text)' }}>{title}</div>{note && <div style={{ ...muted, margin: '4px 0 8px' }}>{note}</div>}<div style={{ marginTop: note ? 0 : 8 }}>{children}</div></section>
}

export default function AccountPanel({ api, status, id, onBack, onOpen }) {
  const [d, setD] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    setError('')
    try { setD(await api(`/api/intel/account?id=${encodeURIComponent(id)}`)) } catch (e) { setError(e.message) }
  }, [api, id])
  useEffect(() => { setD(null); load() }, [load])

  const change = async (patch) => {
    setBusy(true)
    try { await api('/api/intel/stars', { method: 'POST', body: JSON.stringify({ accountId: id, ...patch }) }); await load() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const short = (key) => (status.bdrs.find((b) => b.key === key) || {}).short || key || 'Unassigned'
  const back = <button type="button" onClick={onBack} style={{ ...btnStyle(false), marginBottom: 12 }}>{'\u2190'} Back</button>

  if (error && !d) return <div>{back}<div style={{ ...panel, padding: 16, color: 'var(--red)' }}>{error}</div></div>
  if (!d) return <div>{back}<div style={{ ...panel, padding: 16, ...muted }}>Loading account...</div></div>
  const a = d.account, sz = a.size
  const tier = a.tier ? a.tier.replace(/^GOLD - /i, 'Gold ').replace(/-/g, ' to ') : null

  return (
    <div>
      {back}
      <div style={{ ...panel, padding: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {a.state && <Pill color="#1B5A78">{a.state}</Pill>}
          {a.bdr && TERR[a.bdr] && <Pill color="#1B5A78">{TERR[a.bdr]}</Pill>}
          {tier && <Pill color="#8A6D0B">{tier}</Pill>}
          {a.reasons.includes('bdr_led') && <Pill color="#5B3A8A">BDR led</Pill>}
          {a.starred && <Pill color="var(--accent-text)">Starred</Pill>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 24, letterSpacing: '-0.01em', overflowWrap: 'anywhere' }}>{a.name}</h3>
            <div style={muted}>{[a.city, a.state || a.stateRaw].filter(Boolean).join(', ')}{a.domain ? ` · ${a.domain}` : ''}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" aria-pressed={a.starred} disabled={busy} onClick={() => change({ star: !a.starred })} style={{ ...btnStyle(false), color: a.starred ? '#B7791F' : 'var(--text-secondary)', borderColor: a.starred ? '#B7791F' : 'var(--border)' }}>{a.starred ? '\u2605 Starred' : '\u2606 Star'}</button>
            <select aria-label="Assign to a BDR" value={a.bdrSource === 'hub' ? a.bdr : ''} disabled={busy} onChange={(e) => change({ assignTo: e.target.value || null })} style={selStyle}><option value="">Keep owner</option>{status.bdrs.map((b) => <option key={b.key} value={b.key}>{b.short}</option>)}</select>
            <a href={`https://app.hubspot.com/contacts/${status.portalId}/record/0-2/${a.id}`} target="_blank" rel="noopener noreferrer" style={{ ...btnStyle(false), textDecoration: 'none' }}>Open in HubSpot</a>
          </div>
        </div>
        {error && <div style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>{error}</div>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title="News on this account" note={d.news.length ? 'Highest score first. Items matched from a headline are marked possible.' : undefined}>
            {!d.news.length && <div style={{ ...muted, padding: '4px 0' }}>No news is matched to this account yet.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{d.news.map((it) => <InsightCard key={it.id} it={it} status={status} />)}</div>
          </Card>

          <Card title="Who to contact" note={d.contacts ? `${n0(d.contacts.total)} contacts in HubSpot. Showing the most recently contacted.` : undefined}>
            {d.contactsError && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{d.contactsError}</div>}
            {!d.contacts && !d.contactsError && <div style={muted}>Contacts are not available here.</div>}
            {d.contacts && (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 10px' }} aria-label="Persona coverage">
                  {d.contacts.coverage.map((c) => <span key={c.persona} title={c.contacts.length ? c.contacts.map((x) => x.name || 'No name').join(', ') : 'Nobody in the loaded contacts'}><Pill color={c.contacts.length ? '#2F5A17' : 'var(--text-tertiary)'}>{c.persona}{c.contacts.length ? ` (${c.contacts.length})` : ''}</Pill></span>)}
                </div>
                {d.contacts.list.map((c) => (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
                    <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{c.name || 'No name'}</div><div style={muted}>{c.title || 'No title'}</div></div>
                    <div style={{ ...muted, textAlign: 'right', whiteSpace: 'nowrap' }}>{c.lastContacted ? `contacted ${fmtDate(c.lastContacted)}` : 'never contacted'}</div>
                  </div>
                ))}
                {d.contacts.total > d.contacts.shown && <div style={{ ...muted, paddingTop: 8 }}>Coverage looks at the {d.contacts.shown} most recent. More are in HubSpot.</div>}
              </>
            )}
          </Card>

          {(d.parent || d.children.length > 0 || d.otherRecords.length > 0) && (
            <Card title="Related HubSpot records" note="Other records with the same name are shown so duplicates can be merged in HubSpot. Market Intel never merges them.">
              {d.parent && <div style={{ fontSize: 13, padding: '4px 0' }}>Part of <button type="button" style={linkBtn} onClick={() => onOpen(d.parent.id)}>{d.parent.name}</button></div>}
              {d.children.length > 0 && <div style={{ fontSize: 13, padding: '4px 0' }}>Includes {d.children.map((c, i) => <span key={c.id}>{i ? ', ' : ''}<button type="button" style={linkBtn} onClick={() => onOpen(c.id)}>{c.name}</button></span>)}</div>}
              {d.otherRecords.length > 0 && <div style={{ fontSize: 13, padding: '4px 0' }}>Same name: {d.otherRecords.map((c, i) => <span key={c.id}>{i ? ', ' : ''}<button type="button" style={linkBtn} onClick={() => onOpen(c.id)}>{c.name}</button>{` (${c.state || 'no state'}${c.bdr ? `, ${short(c.bdr)}` : ''})`}</span>)}</div>}
            </Card>
          )}
        </div>

        <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title="From HubSpot">
            <Row k="Assigned BDR" v={`${short(a.bdr)}${a.bdrSource === 'hub' ? ' (set in Cipher)' : a.bdrSource === 'state table' ? ' (from state table)' : ''}`} />
            <Row k="Company owner" v={a.ownerName || 'Not set'} placeholder={!a.ownerName} />
            <Row k="Gold tier" v={tier || 'Not tiered'} placeholder={!tier} />
            <Row k="Estimated ER visits" v={sizeText(sz.status, sz.er)} placeholder={sz.er == null} />
            <Row k="Beds" v={sz.beds != null ? n0(sz.beds) : 'Not in HubSpot'} placeholder={sz.beds == null} />
            {sz.hospitals != null && <Row k="Hospitals in network" v={n0(sz.hospitals)} />}
            {sz.discharges != null && <Row k="Discharges" v={n0(sz.discharges)} />}
            <Row k="Contacts" v={n0(a.contacts) || '0'} />
            <Row k="Deals" v={n0(a.deals) || '0'} />
            <Row k="Last contacted" v={a.lastContacted ? fmtDate(a.lastContacted) : 'Never'} />
            <Row k="HubSpot territory" v={a.territoryHs || 'Not set'} placeholder={!a.territoryHs} />
          </Card>

          <Card title="Opportunity score so far" note="Only the parts that have data are scored. The rest fill in as later phases land.">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '2px 0 8px' }}><span style={{ fontSize: 34, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{d.score.scored}</span><span style={muted}>of {d.score.of} scored</span></div>
            <Row k="Recent trigger, last 90 days" v={`${d.score.trigger} of 20`} />
            <Row k="Target account" v={`${d.score.target} of 5`} />
            <Row k="ED volume and size" v={d.score.size.status === 'ready' ? `Data ready: ${n0(d.score.size.er)} ER visits` : sizeText(d.score.size.status, null)} placeholder={d.score.size.status !== 'ready'} />
            {d.score.waiting.map((w) => <Row key={w} k={w} v="Waiting for data" placeholder />)}
          </Card>
        </div>
      </div>
    </div>
  )
}
