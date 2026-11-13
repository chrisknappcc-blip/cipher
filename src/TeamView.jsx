// src/TeamView.jsx
//
// Two tabs:
//   Queues             who is on your team, with queue health at a glance, their actual queue, and a box to push them a task.
//   Who's using Cipher admins only: who has an account, who is connected to HubSpot and Outlook, and who is really using it.
//
// The roster appears at once. Each person's numbers are then fetched one at a time (two at once), so a slow or broken
// person only affects their own row instead of failing the whole page. Who may see whom is decided on the server
// (ADMIN_EMAILS and TEAM_HIERARCHY); this file is only the screen.

import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from './api'

const muted = { color: 'var(--text-tertiary)', fontSize: 12 }
const panel = { background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)' }
const btn = { fontSize: 12, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer' }

function urgencyColor(hours) {
  if (hours == null) return 'var(--text-tertiary)'
  if (hours >= 24) return 'var(--urgency-stale)'
  if (hours >= 8) return 'var(--amber)'
  return 'var(--text-secondary)'
}
const displayName = (item) => item.contact?.name || item.label || 'Untitled'
const displayCompany = (item) => item.contact?.company || ''

// "just now", "5 minutes ago", "3 hours ago", "yesterday", "9 days ago", or the date if it was long ago.
export function ago(iso, now = new Date()) {
  if (!iso) return 'Never'
  const ms = now.getTime() - Date.parse(iso)
  if (!Number.isFinite(ms)) return 'Never'
  const min = Math.floor(ms / 60e3)
  if (min < 2) return 'just now'
  if (min < 60) return `${min} minutes ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 45) return `${day} days ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
// A function that ran out of time answers with a web page instead of data, which the app's request helper reports as
// "Unknown error". Say what it means.
const friendly = (m) => (!m || /unknown error|failed to fetch|networkerror|request failed|load failed/i.test(m) ? 'The server did not answer in time. Try again in a minute.' : m)
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '')

const STATUS = {
  active: { label: 'Using it', color: '#2E7D4F', help: 'Connected and used Cipher in the last 7 days' },
  quiet: { label: 'Quiet', color: '#B7791F', help: 'Connected, but has not used Cipher in more than 7 days' },
  no_activity: { label: 'No activity yet', color: '#6B7280', help: 'Connected, but no use recorded yet (recording is recent)' },
  not_connected: { label: 'Not connected', color: '#A63D40', help: 'Has opened Cipher but HubSpot is not connected, so most of it will not work for them' },
  never_opened: { label: 'Never opened', color: '#6B7280', help: 'Has a sign in account but has never opened Cipher' },
  leftover: { label: 'Leftover profile', color: '#6B7280', help: 'A saved profile whose sign in account no longer exists (clean up in Settings, Account Cleanup)' },
}
function Pill({ status }) {
  const s = STATUS[status] || { label: status, color: '#6B7280', help: '' }
  return <span title={s.help} style={{ fontSize: 11.5, padding: '2px 9px', borderRadius: 10, whiteSpace: 'nowrap', fontWeight: 600, color: s.color, background: `color-mix(in srgb, ${s.color} 14%, transparent)` }}>{s.label}</span>
}

// ─── Who's using Cipher ─────────────────────────────────────────────────────
export function UsagePanel({ getToken, now = () => new Date() }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setData(await apiFetch('/api/team/usage', getToken)) }
    catch (e) { if (/403|admin/i.test(e.message || '')) setForbidden(true); else setError(friendly(e.message)) }
    finally { setLoading(false) }
  }, [getToken])
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const t = now()

  if (loading && !data) return <div style={{ ...muted, padding: 24 }}>Loading who is using Cipher...</div>
  if (forbidden) return <div style={{ padding: 40, textAlign: 'center', ...muted, fontSize: 13 }}>Only admins can see who is using Cipher.</div>
  if (error && !data) return <div style={{ ...panel, padding: 18 }}><div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{error}</div><button style={btn} onClick={load}>Try again</button></div>
  const s = data.summary
  const card = (label, value, color) => <div key={label} style={{ ...panel, padding: '12px 16px', minWidth: 120 }}><div style={{ fontSize: 24, fontWeight: 600, color: color || 'var(--text)' }}>{value}</div><div style={{ ...muted, marginTop: 2 }}>{label}</div></div>
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div data-usage-summary style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {card('Accounts', s.accounts)}{card('Using it this week', s.active, STATUS.active.color)}{card('Connected but quiet', s.quiet, STATUS.quiet.color)}
        {s.noActivity > 0 && card('No activity yet', s.noActivity, STATUS.no_activity.color)}{card('Need to reconnect', s.notConnected, s.notConnected ? STATUS.not_connected.color : undefined)}
        {card('Never opened Cipher', s.neverOpened)}{card('Outlook connected', s.outlookConnected)}{card('With calendar access', s.outlookCalendar)}
      </div>
      <div style={{ ...muted, lineHeight: 1.55 }}>
        {data.trackingSince ? <>Activity has been recorded since {shortDate(data.trackingSince)}. </> : <>Activity recording has just started, so nobody shows as active until they next use Cipher. </>}
        "Using it" means they used Cipher in the last 7 days. A browser tab left open in the background can count as activity.
        {!data.identityKnown && <div data-identity-note style={{ color: 'var(--amber)', marginTop: 4 }}>The sign in list could not be read just now, so people who never opened Cipher and leftover profiles are not shown.</div>}
      </div>
      <div style={{ ...panel, padding: 0, overflowX: 'auto' }}>
        <table data-usage-table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead><tr>{['Person', 'Status', 'HubSpot', 'Outlook', 'Last seen', 'Active days (7 / 30)', 'Sections used', 'Signed up'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid var(--border)', ...muted, fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.userId} data-person={r.userId} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '10px 12px', fontWeight: 500, overflowWrap: 'anywhere' }}>{r.email || r.userId}</td>
                <td style={{ padding: '10px 12px' }}><Pill status={r.status} /></td>
                <td style={{ padding: '10px 12px' }}>{r.hubspot === 'connected' ? 'Connected' : r.hubspot === 'unknown' ? 'Unknown' : 'Not connected'}</td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{r.outlook.connected ? (r.outlook.calendar ? 'Mail and calendar' : 'Mail only') : 'Not connected'}</td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }} title={r.lastSeen ? new Date(r.lastSeen).toLocaleString() : ''}>{ago(r.lastSeen, t)}</td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{r.lastSeen ? `${r.activeDays7} / ${r.activeDays30}` : ''}</td>
                <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }} title={r.sections.map((x) => `${x.name}: ${ago(x.last, t)}`).join('\n')}>{r.sections.map((x) => x.name).join(', ')}</td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{r.signedUp ? shortDate(r.signedUp) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.rows.length === 0 && <div style={{ padding: 18, ...muted }}>Nobody yet.</div>}
      </div>
      <div><button style={btn} onClick={load} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button></div>
    </div>
  )
}

// ─── Queues ─────────────────────────────────────────────────────────────────
export default function TeamView({ getToken, now = () => new Date(), concurrency = 2 }) {
  const [tab, setTab] = useState('queues')
  const [roster, setRoster] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [forbidden, setForbidden] = useState(false)
  const [loadingIds, setLoadingIds] = useState(() => new Set())
  const [activeUserId, setActiveUserId] = useState(null)
  const [activeQueue, setActiveQueue] = useState([])
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueError, setQueueError] = useState(null)
  const [pushText, setPushText] = useState('')
  const [pushing, setPushing] = useState(false)
  const [toast, setToast] = useState(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const showToast = useCallback((msg) => { setToast(msg); setTimeout(() => setToast((t) => (t === msg ? null : t)), 2500) }, [])
  const setStats = (userId, stats) => setRoster((rs) => rs.map((r) => (r.userId === userId ? { ...r, stats, fresh: true } : r)))
  const mark = (userId, on) => setLoadingIds((s) => { const n = new Set(s); if (on) n.add(userId); else n.delete(userId); return n })

  // Fetch one person's numbers. A failure lands in their own row.
  const loadStats = useCallback(async (userId, refresh = false) => {
    mark(userId, true)
    try {
      const r = await apiFetch(`/api/team/stats?userId=${encodeURIComponent(userId)}${refresh ? '&refresh=1' : ''}`, getToken)
      if (alive.current) setStats(userId, r.stats)
    } catch (e) { if (alive.current) setStats(userId, { error: friendly(e.message), computedAt: null }) }
    finally { if (alive.current) mark(userId, false) }
  }, [getToken])

  // Work through a list of people, a couple at a time, so HubSpot is never hit with everyone at once.
  const loadMany = useCallback(async (ids, refresh = false) => {
    const queue = [...ids]
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => { while (queue.length) await loadStats(queue.shift(), refresh) }))
  }, [loadStats, concurrency])

  const loadRoster = useCallback(async () => {
    try {
      setError(null)
      const data = await apiFetch('/api/team/roster', getToken)
      const rows = data.roster || []
      setRoster(rows)
      setActiveUserId((cur) => cur || (rows[0] && rows[0].userId) || null)
      setLoading(false)
      loadMany(rows.filter((r) => !r.fresh).map((r) => r.userId))
    } catch (e) {
      if (/403|admin|access/i.test(e.message || '')) setForbidden(true); else setError(friendly(e.message))
      setLoading(false)
    }
  }, [getToken, loadMany])
  useEffect(() => { loadRoster() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadQueue = useCallback((userId) => {
    setQueueLoading(true); setQueueError(null)
    return apiFetch(`/api/team/queue?userId=${encodeURIComponent(userId)}`, getToken)
      .then((d) => { if (alive.current) setActiveQueue(d.queue || []) })
      .catch((e) => { if (alive.current) { setActiveQueue([]); setQueueError(friendly(e.message)) } })
      .finally(() => { if (alive.current) setQueueLoading(false) })
  }, [getToken])
  useEffect(() => { if (!activeUserId) { setActiveQueue([]); return } loadQueue(activeUserId) }, [activeUserId, loadQueue])

  const activeRep = roster.find((r) => r.userId === activeUserId) || null
  const pushTask = async () => {
    const text = pushText.trim()
    if (!text || !activeUserId) return
    setPushing(true)
    try {
      await apiFetch('/api/hubspot/team/push', getToken, { method: 'POST', body: JSON.stringify({ targetUserId: activeUserId, text }) })
      setPushText(''); showToast(`Pushed to ${activeRep?.email || 'rep'}`)
      loadStats(activeUserId, true); loadQueue(activeUserId)
    } catch (e) { setError(`Couldn't push task: ${e.message}`) }
    finally { setPushing(false) }
  }

  const tabBtn = (key, label) => <button key={key} onClick={() => setTab(key)} style={{ ...btn, background: tab === key ? 'var(--accent-light)' : 'var(--bg-secondary)', fontWeight: tab === key ? 600 : 400 }}>{label}</button>
  const header = <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>{tabBtn('queues', 'Queues')}{tabBtn('usage', "Who's using Cipher")}</div>

  if (tab === 'usage') return <div style={{ padding: 16 }}>{header}<UsagePanel getToken={getToken} now={now} /></div>
  if (loading) return <div style={{ padding: 16 }}>{header}<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 260 }}><div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /></div></div>
  if (forbidden) return <div style={{ padding: 16 }}>{header}<div style={{ padding: 40, textAlign: 'center', color: 'var(--text-tertiary)' }}>The queue view is only available to admins and managers. If you should have access, check that your email is in the ADMIN_EMAILS or TEAM_HIERARCHY setting. Admins can still open Who's using Cipher.</div></div>

  return (
    <div style={{ padding: 16, background: 'var(--bg)', color: 'var(--text)', position: 'relative' }}>
      {header}
      {toast && <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-panel)', border: '1px solid var(--border)', color: 'var(--text)', padding: '10px 18px', borderRadius: 'var(--radius)', fontSize: 13, zIndex: 50, boxShadow: 'var(--shadow-soft)' }}>{toast}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16 }}>
        <div style={{ ...panel, padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 500, flex: 1 }}>Team</div>
            <button style={btn} disabled={loadingIds.size > 0 || roster.length === 0} onClick={() => loadMany(roster.map((r) => r.userId), true)}>{loadingIds.size > 0 ? 'Refreshing...' : 'Refresh numbers'}</button>
          </div>
          {error && (
            <div data-team-error style={{ background: 'var(--red-light)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 12.5, marginBottom: 14 }}>
              {error}<div style={{ marginTop: 8 }}><button style={btn} onClick={loadRoster}>Try again</button></div>
            </div>
          )}
          {roster.length === 0 && !error ? (
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No reps registered yet. This fills in as people log into Cipher.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {roster.map((rep) => {
                const st = rep.stats, busy = loadingIds.has(rep.userId)
                return (
                  <div key={rep.userId} data-rep={rep.userId} onClick={() => setActiveUserId(rep.userId)} style={{ padding: '13px 14px', borderRadius: 14, cursor: 'pointer', background: activeUserId === rep.userId ? 'var(--bg-hover)' : 'var(--bg-secondary)', border: activeUserId === rep.userId ? '1px solid var(--border-strong)' : '1px solid transparent' }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' }}>{rep.email || rep.userId}</div>
                    {busy && !st?.queueCount && st?.queueCount !== 0 && <div data-loading style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 3 }}>Loading queue...</div>}
                    {st && st.error && !busy && (
                      <div data-row-error style={{ fontSize: 11.5, color: 'var(--red)', marginTop: 3 }}>
                        {st.error} <button style={{ ...btn, padding: '2px 8px', marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); loadStats(rep.userId, true) }}>Retry</button>
                      </div>
                    )}
                    {st && !st.error && st.queueCount != null && (
                      <>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 3 }}>{st.queueCount} in queue · {st.completedToday ?? 0} done today{busy ? ' · updating...' : ''}</div>
                        {st.oldestHours != null && <div style={{ fontSize: 11, color: urgencyColor(st.oldestHours), marginTop: 2 }}>Oldest item {st.oldestHours >= 24 ? `${Math.round(st.oldestHours / 24)}d` : `${st.oldestHours}h`} old</div>}
                      </>
                    )}
                    {!st && !busy && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 3 }}>Waiting to load...</div>}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div style={{ ...panel, padding: 22, position: 'sticky', top: 76, maxHeight: 'calc(100vh - 96px)', overflowY: 'auto' }}>
          {activeRep ? (
            <>
              <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4, overflowWrap: 'anywhere' }}>{activeRep.email || activeRep.userId}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 18 }}>
                {activeRep.stats && !activeRep.stats.error && activeRep.stats.queueCount != null ? `${activeRep.stats.queueCount} items in queue · ${activeRep.stats.completedToday ?? 0} completed today` : ' '}
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
                <input value={pushText} onChange={(e) => setPushText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') pushTask() }} placeholder="Push a task into their Right Now" disabled={pushing} style={{ flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border-strong)', color: 'var(--text)', borderRadius: 'var(--radius)', padding: '9px 12px', fontSize: 13 }} />
                <button onClick={pushTask} disabled={pushing || !pushText.trim()} style={{ background: 'var(--manager-color)', border: 'none', color: '#fff', borderRadius: 'var(--radius)', padding: '0 16px', cursor: 'pointer', fontSize: 12.5, whiteSpace: 'nowrap', opacity: pushing || !pushText.trim() ? 0.5 : 1 }}>{pushing ? 'Pushing...' : 'Push'}</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10, borderTop: '1px solid var(--border)', paddingTop: 14 }}>Their queue</div>
              {queueLoading ? <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Loading...</div>
                : queueError ? <div data-queue-error style={{ fontSize: 13, color: 'var(--red)' }}>{queueError}<div style={{ marginTop: 8 }}><button style={btn} onClick={() => loadQueue(activeUserId)}>Try again</button></div></div>
                : activeQueue.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Queue clear.</div>
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {activeQueue.slice(0, 15).map((item) => {
                      const fromManager = !!item.assignedBy, color = fromManager ? 'var(--manager-color)' : 'var(--urgency-warm)'
                      return (
                        <div key={item.id} style={{ padding: '11px 14px', borderRadius: 12, border: `1px solid color-mix(in srgb, ${color} 40%, var(--border))`, background: `color-mix(in srgb, ${color} 8%, var(--bg-panel))` }}>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>
                            {displayName(item)}{displayCompany(item) ? ` · ${displayCompany(item)}` : ''}
                            {fromManager && <span style={{ fontSize: 10, color: 'var(--manager-color)', border: '1px solid var(--manager-color)', borderRadius: 10, padding: '1px 7px', marginLeft: 8 }}>From {item.assignedBy.split('@')[0]}</span>}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{item.whyTag}</div>
                        </div>
                      )
                    })}
                    {activeQueue.length > 15 && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', textAlign: 'center', paddingTop: 4 }}>+{activeQueue.length - 15} more</div>}
                  </div>
                )}
            </>
          ) : <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Select a rep to see details.</div>}
        </div>
      </div>
    </div>
  )
}
