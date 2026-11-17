import { useState, useMemo } from 'react'
import { panel, muted, btnStyle, Pill, InsightCard } from './intelUi'

// IntelProducts.jsx: the news sorted into one collapsible menu per solution (ED Connect, Referral IQ, Readmission IQ, CarePath IQ),
// so a rep can write for one product at a time. Inside each menu, news is grouped by how strong the fit is: it leads for that
// solution, the source also tagged it for it, or it is on the same subject. Every card says why it is there and gives an angle for
// that solution. A solution with little real news says so and says what the daily scan should look for.

const TIERS = [
  ['lead', (n) => `Leads for ${n}`], ['also', (n) => `Also tagged for ${n} by the source`], ['theme', () => 'On the same subject'],
]
const PAGE = 6
const bySignal = (a, b) => (b.score ?? -1) - (a.score ?? -1) || String(b.published).localeCompare(String(a.published))

function Angle({ fit }) {
  return (
    <div style={{ borderLeft: '3px solid var(--accent-text)', background: 'var(--bg-secondary)', borderRadius: '0 8px 8px 0', padding: '8px 12px', marginBottom: 6, fontSize: 13, lineHeight: 1.5 }}>
      <div><strong>Angle for {fit.product}:</strong> {fit.angle}</div>
      <div style={{ ...muted, marginTop: 2 }}>Why it is here: {fit.why}</div>
    </div>
  )
}

export default function BySolution({ items, kit, facets, status, onOpen }) {
  const groups = useMemo(() => {
    const g = Object.fromEntries(kit.map((k) => [k.name, { lead: [], also: [], theme: [], open: 0 }]))
    for (const it of items) {
      const live = !!(it.window && (it.window.status === 'open' || it.window.status === 'closing'))
      for (const f of it.productFit || []) { if (!g[f.product]) continue; g[f.product][f.role].push({ it, fit: f }); if (live) g[f.product].open++ }
    }
    for (const k of kit) for (const [role] of TIERS) g[k.name][role].sort((a, b) => bySignal(a.it, b.it))
    return g
  }, [items, kit])
  const first = kit.slice().sort((a, b) => groups[b.name].open - groups[a.name].open)[0]
  const [open, setOpen] = useState(() => (first ? { [first.name]: true } : {}))
  const [shown, setShown] = useState({})
  const thin = Object.fromEntries(((facets && facets.products) || []).map((p) => [p.name, p]))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {kit.map((k) => {
        const g = groups[k.name], total = g.lead.length + g.also.length + g.theme.length, isOpen = !!open[k.name], t = thin[k.name]
        const id = `sol-${k.name.replace(/\s+/g, '-')}`
        return (
          <section key={k.name} style={{ ...panel, padding: 0, overflow: 'hidden' }}>
            <button type="button" aria-expanded={isOpen} aria-controls={id} onClick={() => setOpen((o) => ({ ...o, [k.name]: !o[k.name] }))}
              style={{ all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', flexWrap: 'wrap' }}>
              <span aria-hidden="true" style={{ fontSize: 14, width: 14 }}>{isOpen ? '\u25BE' : '\u25B8'}</span>
              <span style={{ flex: '1 1 260px', minWidth: 0 }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{k.name}</span>
                {t && t.thin && <span style={{ marginLeft: 8 }}><Pill color="#8A3F06" title="Far less news about this solution than about the best covered one">Thin coverage</Pill></span>}
                <span style={{ display: 'block', ...muted, marginTop: 2 }}>{k.does}</span>
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                {g.lead.length} lead {'\u00B7'} {g.also.length} also {'\u00B7'} {g.theme.length} by subject{g.open ? <> {'\u00B7'} <strong style={{ color: 'var(--text)' }}>{g.open} open windows</strong></> : ''}
              </span>
            </button>
            {isOpen && (
              <div id={id} style={{ padding: '4px 16px 16px', borderTop: '1px solid var(--border)' }}>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', margin: '12px 0', fontSize: 13, lineHeight: 1.55 }}>
                  <div><strong>What to say:</strong> {k.proof}</div>
                  <div style={muted}>These are the approved proof points. Say &ldquo;customers have seen&rdquo;, never promise a result, and never name a customer.</div>
                </div>
                {t && t.thin && (
                  <div role="note" style={{ background: '#FBF3DC', border: '1px solid #E3D18F', borderRadius: 8, padding: '9px 12px', margin: '0 0 12px', fontSize: 13, lineHeight: 1.55, color: '#5C4A05' }}>
                    Thin coverage. Only {t.evidence} {t.evidence === 1 ? 'card is' : 'cards are'} about {k.name} on {t.evidence === 1 ? 'its' : 'their'} own, against {Math.max(...Object.values(thin).map((p) => p.evidence))} for the best covered solution. What is listed as Also was tagged for it by the earlier tool, and is often not about this subject. The daily scan should look for: {k.searchFor}.
                  </div>
                )}
                {total === 0 && <div style={{ ...muted, padding: '8px 0' }}>Nothing matches the filters for {k.name}.</div>}
                {TIERS.map(([role, label]) => {
                  const list = g[role]; if (!list.length) return null
                  const key = `${k.name}|${role}`, n = shown[key] || PAGE
                  return (
                    <div key={role} style={{ marginTop: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: 8 }}>{label(k.name)} <span style={{ fontWeight: 500 }}>({list.length})</span></div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        {list.slice(0, n).map(({ it, fit }) => <div key={it.id}><Angle fit={fit} /><InsightCard it={it} status={status} onOpen={it.match.via === 'title' ? undefined : onOpen} /></div>)}
                      </div>
                      {list.length > n && <button type="button" onClick={() => setShown((s) => ({ ...s, [key]: n + PAGE }))} style={{ ...btnStyle(false), marginTop: 10, fontSize: 12.5, padding: '5px 12px' }}>Show {Math.min(PAGE, list.length - n)} more of {list.length - n} left</button>}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
