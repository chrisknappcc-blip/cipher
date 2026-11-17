import { useState } from 'react'
import { panel, muted, btnStyle, Pill, InsightCard, fmtDate, n0 } from './intelUi'

// IntelAnalyzer.jsx: read one pasted article with Claude and turn it into a card for the feed. Claude is told to use only the
// facts stated in the text. The rep sees the card first, and nothing reaches the feed until they press Save.

const field = { width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text)', fontFamily: 'inherit' }

export default function Analyzer({ api, status, onSaved }) {
  const [open, setOpen] = useState(false)
  const [ai, setAi] = useState(null)
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [saved, setSaved] = useState(false)
  const [needForce, setNeedForce] = useState(false)

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next && !ai) { try { setAi(await api('/api/intel/ai-status')) } catch (e) { setError(e.message) } }
  }
  const refreshStatus = async () => { try { setAi(await api('/api/intel/ai-status')) } catch (_) { /* the count is a convenience */ } }
  const reset = () => { setResult(null); setSaved(false); setError(''); setNeedForce(false); setText(''); setUrl(''); setSourceName('') }

  const analyze = async () => {
    setBusy(true); setError(''); setResult(null); setSaved(false); setNeedForce(false)
    try { setResult(await api('/api/intel/analyze', { method: 'POST', body: JSON.stringify({ text, url, sourceName }) })) } catch (e) { setError(e.message) } finally { setBusy(false); refreshStatus() }
  }
  const save = async (force) => {
    setBusy(true); setError('')
    try { await api('/api/intel/analyze/save', { method: 'POST', body: JSON.stringify({ record: result.record, force: !!force }) }); setSaved(true); setNeedForce(false); if (onSaved) onSaved() } catch (e) { setError(e.message); if (/already in the feed/.test(e.message)) setNeedForce(true) } finally { setBusy(false) }
  }

  const off = ai && !ai.enabled
  return (
    <section style={{ ...panel, padding: 14, marginBottom: 14 }}>
      <button type="button" aria-expanded={open} onClick={toggle} style={{ ...btnStyle(false), border: 'none', padding: 0, background: 'none', display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
        <span aria-hidden="true">{open ? '\u25BE' : '\u25B8'}</span> Analyze an article
        <span style={{ ...muted, fontWeight: 400 }}>Paste an announcement and Claude turns it into a card.</span>
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          {off && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{ai.reason}</div>}
          {!off && !saved && (
            <div style={{ display: 'grid', gap: 8 }}>
              <textarea aria-label="Article text" value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder="Paste the article text here. A few sentences at least." style={{ ...field, resize: 'vertical' }} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <input aria-label="Link to the original" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Link to the original announcement (required)" style={{ ...field, flex: '2 1 300px', width: 'auto' }} />
                <input aria-label="Source name" value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="Source name (optional)" style={{ ...field, flex: '1 1 160px', width: 'auto' }} />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <button type="button" disabled={busy || text.trim().length < 20 || !url.trim()} onClick={analyze} style={btnStyle(true)}>{busy && !result ? 'Reading...' : 'Analyze'}</button>
                {ai && <span style={muted}>{ai.usedToday} of {ai.limitPerDay} analyses used today. This month the team has run {ai.month.runs}, about ${ai.month.estCost.toFixed(2)} at the current estimate.</span>}
              </div>
              <div style={muted}>Claude uses only the facts in the text and leaves the rest blank. Check the card before saving it.</div>
            </div>
          )}
          {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 13, marginTop: 10 }}>{error}</div>}

          {result && !saved && (
            <div style={{ marginTop: 14 }}>
              {result.truncated && <div style={{ ...muted, marginBottom: 8 }}>The article was long, so Claude read the first part of it.</div>}
              {!result.savable && (
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 13, lineHeight: 1.55 }}>
                  <strong>{result.analysis.title}</strong><div style={{ marginTop: 4 }}>{result.analysis.summary}</div><div style={{ ...muted, marginTop: 6 }}>{result.notSavable}</div>
                </div>
              )}
              {result.savable && result.preview && (
                <>
                  <div style={{ ...muted, marginBottom: 8 }}>This is how the card will look in the feed.</div>
                  <InsightCard it={{ ...result.preview, addedBy: result.record.addedBy, fromArticle: true }} status={status} />
                  {result.duplicate && (
                    <div style={{ marginTop: 10, background: '#FBF3DC', border: '1px solid #E3D18F', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: '#5C4A05' }}>
                      This looks like news already in the feed: <strong>{result.duplicate.title}</strong>{result.duplicate.published ? `, ${fmtDate(result.duplicate.published)}` : ''}. Saving adds a second card.
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12, alignItems: 'center' }}>
                    {!result.duplicate && !needForce && <button type="button" disabled={busy} onClick={() => save(false)} style={btnStyle(true)}>Save to feed</button>}
                    {(result.duplicate || needForce) && <button type="button" disabled={busy} onClick={() => save(true)} style={btnStyle(false)}>Save anyway</button>}
                    <button type="button" disabled={busy} onClick={reset} style={btnStyle(false)}>Discard</button>
                    {result.usage && <span style={muted}>{n0(result.usage.input)} tokens read, {n0(result.usage.output)} written.</span>}
                  </div>
                </>
              )}
              {!result.savable && <div style={{ marginTop: 10 }}><button type="button" onClick={reset} style={btnStyle(false)}>Try another article</button></div>}
            </div>
          )}
          {saved && (
            <div style={{ marginTop: 6, fontSize: 13 }}>
              <Pill color="#2F5A17">Saved</Pill> It is in the feed now, marked as added from an article. <button type="button" onClick={reset} style={{ ...btnStyle(false), marginLeft: 8 }}>Analyze another</button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
