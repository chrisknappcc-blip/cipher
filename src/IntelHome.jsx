import { useState, useEffect } from 'react'
import { panel, muted, Pill, TYPE_LABEL, WINDOW_TEXT, WINDOW_COLOR, fmtDate, linkBtn } from './intelUi'

// IntelHome.jsx: the Market Intel home screen. What is open to reach out about now, the best bets in order, and what is
// happening in the territory. Everything here is worked out by the server from the saved HubSpot and news data.

function Tile({ label, value, sub }) {
  return (
    <div style={{ ...panel, padding: '14px 16px', flex: '1 1 190px', minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, fontVariantNumeric: 'tabular-nums', margin: '4px 0 2px' }}>{value}</div>
      <div style={{ ...muted, overflowWrap: 'anywhere' }}>{sub}</div>
    </div>
  )
}

export default function HomeView({ api, status, scope, userName, onOpen }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    ;(async () => {
      setError('')
      try {
        const qs = new URLSearchParams()
        if (scope && scope !== 'all') qs.set('bdr', scope)
        const d = await api(`/api/intel/home?${qs}`)
        if (live) setData(d)
      } catch (e) { if (live) setError(e.message) }
    })()
    return () => { live = false }
  }, [api, scope])

  const short = (key) => (status.bdrs.find((b) => b.key === key) || {}).short
  const who = scope && scope !== 'all' ? `${short(scope)}'s territory` : 'all four territories'
  const first = String(userName || '').split(' ')[0]
  if (error && !data) return <div style={{ ...panel, padding: 16, color: 'var(--red)' }}>{error}</div>
  if (!data) return <div style={{ ...panel, padding: 16, ...muted }}>Loading...</div>
  const t = data.tiles
  if (!status.accountCount && !status.insightCount) return <div style={{ ...panel, padding: 20, fontSize: 14, lineHeight: 1.55 }}>Nothing is loaded yet. {status.admin ? 'Open Data health, refresh from HubSpot, then import the earlier tools.' : 'Ask an admin to load it from the Data health screen.'}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 22, letterSpacing: '-0.01em' }}>{first ? `Hello, ${first}` : 'Hello'}</h3>
        <div style={muted}>Showing {who}. News is as of the last import, and windows count from each announcement.</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <Tile label="Windows open now" value={t.windowsOpen} sub={`of ${t.withWindow} news items that have a window`} />
        <Tile label="Closing within 14 days" value={t.closing.length} sub={t.closing.length ? t.closing.map((c) => `${c.org}, ${c.daysLeft} days`).join(' · ') : 'Nothing is about to close'} />
        <Tile label="Top news score" value={t.topScore ? t.topScore.score : 'None'} sub={t.topScore ? t.topScore.org : 'No open window right now'} />
        <Tile label="Gold and starred accounts" value={t.targets} sub={`${t.targetsMissingSize} without size from Definitive`} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <section style={{ ...panel, padding: 16, flex: '999 1 560px', minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Best windows to reach out</div>
          <div style={{ ...muted, marginBottom: 8 }}>Highest news score first, among items whose window is open.</div>
          {!data.best.length && <div style={{ ...muted, padding: '12px 0' }}>Nothing has an open window for {who}.</div>}
          {data.best.map((it) => (
            <div key={it.id} style={{ display: 'flex', gap: 12, padding: '12px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ width: 46, height: 46, borderRadius: 10, flex: 'none', background: it.score >= 70 ? '#F4E7B4' : 'var(--bg-secondary)', color: it.score >= 70 ? '#5C4A05' : 'var(--text-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 17, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{it.score}</span><span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.06em' }}>SCORE</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {it.account && it.match.via !== 'title' ? <button type="button" onClick={() => onOpen(it.account.id)} style={{ ...linkBtn, fontSize: 14.5 }}>{it.org || it.account.name}</button> : <strong style={{ fontSize: 14.5 }}>{it.org || 'News item'}</strong>}
                  {it.states.map((s) => <Pill key={s} color="#1B5A78">{s}</Pill>)}
                  <Pill color={WINDOW_COLOR[it.window.status]}>{WINDOW_TEXT[it.window.status](it.window.daysLeft)}</Pill>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '3px 0 4px', overflowWrap: 'anywhere' }}>{it.title}</div>
                <div style={{ ...muted, display: 'flex', flexWrap: 'wrap', gap: '2px 12px' }}>
                  {it.leadProduct && <span>Lead: <strong>{it.leadProduct}</strong></span>}
                  {it.sources[0] && (it.sources[0].url ? <a href={it.sources[0].url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-text)' }}>{it.sources[0].name || 'Source'}, {fmtDate(it.sources[0].date)}</a> : <span>{it.sources[0].name}, {fmtDate(it.sources[0].date)}</span>)}
                </div>
              </div>
            </div>
          ))}
        </section>
        <section style={{ ...panel, padding: 16, flex: '1 1 300px', minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Facility watch</div>
          <div style={{ ...muted, marginBottom: 8 }}>The latest deals, closures and ED news in {who}.</div>
          {!data.watch.length && <div style={{ ...muted, padding: '12px 0' }}>Nothing recent.</div>}
          {data.watch.map((w) => (
            <div key={w.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{w.title}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 4 }}>
                {w.states.slice(0, 3).map((s) => <Pill key={s} color="#1B5A78">{s}</Pill>)}
                <Pill>{TYPE_LABEL[w.type] || w.type}</Pill>
                <span style={muted}>{fmtDate(w.published)}{w.sources[0] && w.sources[0].name ? `, ${w.sources[0].name}` : ''}</span>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
