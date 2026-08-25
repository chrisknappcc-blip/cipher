// src/RightNowView.jsx
// REPLACE — path from repo root: src/RightNowView.jsx
//
// Real, working version of the Right Now Queue design we iterated on all
// session. Wired to actual endpoints: GET /right-now, GET/POST/DELETE /pin,
// GET /top5, and the existing /todo endpoints for manual tasks.
//
// Changes this pass, based on real usability feedback:
//   - Pin button now shows explicit text state ("Pin to Top 5" vs "Pinned")
//     instead of relying on an icon + hover tooltip to communicate a toggle.
//   - Every queue row's reason ("why it's here") is now labeled explicitly
//     rather than shown as an unlabeled line of gray text.
//   - Checking a box now shows an inline confirmation of what happened and
//     where the item went ("Marked complete" / "Dismissed"), and there's a
//     Done toggle to actually go look at that log.
//
// Known limitations, still true from before:
//   1. The queue mixes real to-do records (source: "todo") with DERIVED
//      items — signals, HubSpot tasks, meetings. Only to-dos have a real
//      "mark complete" action on the backend; everything else is a
//      session-only dismiss (see the Done log note below).
//   2. The Done log below is SESSION-ONLY — it resets on page reload. Todo
//      completions are real and permanent on the backend; what resets is
//      just this view's record of "what did I action in this browser tab
//      today." Building true persisted history for dismissed signals/tasks/
//      meetings would need a new backend log, not built yet.
//   3. The "@ tag a contact" typeahead and full email timeline are still
//      not wired in — same gaps as last pass, no dedicated endpoints yet.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from './api'

function urgencyColor(score) {
  if (score >= 90) return 'var(--urgency-hot)'
  if (score >= 50) return 'var(--urgency-warm)'
  return 'var(--urgency-cooling)'
}

// Single source of truth for "when was this email actually sent." sentAt is
// the real send-time signal; timestamp/createdAt just means "when the
// engagement record was logged in HubSpot," which can genuinely diverge
// from the real send time (sync delays, imports, marketing automation).
// Both the summary and the list below call this so they can't silently
// disagree on date priority the way they once did.
function emailDate(e) {
  return e.sentAt || e.timestamp || null
}

// 12-hour meeting time range, e.g. "2:00 – 2:30 PM"
function meetingTimeRange(startIso, endIso) {
  if (!startIso) return null
  const start = new Date(startIso)
  const startStr = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  if (!endIso) return startStr
  const end = new Date(endIso)
  const endStr = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return `${startStr} – ${endStr}`
}

function displayName(item) {
  return item.contact?.name || item.label || 'Untitled'
}
function displayCompany(item) {
  return item.contact?.companyName || item.contact?.company || ''
}

function NameCompanyLine({ item }) {
  const name = displayName(item)
  const company = displayCompany(item)
  const contact = item.contact
  const linkStyle = { color: 'inherit', textDecoration: 'underline', textDecorationColor: 'var(--border-strong)' }
  return (
    <>
      {contact?.contactUrl ? (
        <a href={contact.contactUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={linkStyle}>{name}</a>
      ) : name}
      {company && (
        <>
          {' · '}
          {contact?.companyUrl ? (
            <a href={contact.companyUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={linkStyle}>{company}</a>
          ) : company}
        </>
      )}
    </>
  )
}

function RepInfoLine({ item }) {
  const c = item.contact
  if (!c) return null
  const parts = []
  if (c.assignedBdr) parts.push(`BDR: ${c.assignedBdr}`)
  if (c.ownerName) parts.push(`Owner: ${c.ownerName}`)
  if (c.primaryOutreachRep) parts.push(`Outreach: ${c.primaryOutreachRep}`)
  if (parts.length === 0) return null
  return (
    <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
      {parts.join(' · ')}
    </div>
  )
}

function sourceLabel(source) {
  if (source === 'todo') return 'To-do'
  if (source === 'signal') return 'Email activity'
  if (source === 'task') return 'HubSpot task'
  if (source === 'meeting') return 'Meeting'
  return 'Item'
}

function timeAgo(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  const hours = ms / 3600000
  if (hours < 1) return 'under an hour ago'
  if (hours < 24) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// 12-hour absolute timestamp — pairs with timeAgo() so "3d ago" always has
// a real date/time next to it, removing any doubt about what it means.
function absoluteTime(iso) {
  if (!iso) return null
  const d = new Date(iso)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

// Time between two ISO timestamps, in the same relative style as timeAgo —
// used for "opened 10 minutes after sending" vs "opened 3 weeks later."
function timeBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime()
  if (ms < 0) return null
  const mins = ms / 60000
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`
  const hours = mins / 60
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

// Lightweight frontend mirror of the backend's bounce/OOO detection — used
// only for display labeling here, not scoring (the real filtering already
// happens server-side before an item is ever scored as a reply).
function isBounceLike(subject, body) {
  const s = (subject || '').toLowerCase()
  const b = (body || '').toLowerCase()
  return /^(undeliverable|delivery status notification|mail delivery|returned mail|delivery failed|message (could not|was not) delivered|failure notice)/.test(s)
    || /mailer-daemon|postmaster@|could not be delivered|permanent failure/.test(b)
}
function isOooLike(subject, body) {
  const s = (subject || '').toLowerCase()
  const b = (body || '').toLowerCase()
  return /^(automatic reply|auto.?reply|out of (the )?office|ooo\s*:|on vacation|away from)/.test(s)
    || /i('m| am) (currently )?(out|away|on vacation)|i('ll| will) be back/.test(b)
}

// Cheap keyword heuristic, NOT AI content understanding — flags that a reply
// might be waiting on an answer because it contains a question mark. Real
// detection would need an actual model call reading the email body, which is
// the same cost tradeoff as the gap-search AI feature this version is
// deliberately not running. This is the free, honest middle ground.
function looksLikeItNeedsAReply(body) {
  return !!body && body.includes('?')
}

export default function RightNowView({ getToken, user }) {
  const [queue, setQueue] = useState([])
  const [highEngagement, setHighEngagement] = useState([])
  const [top5Picks, setTop5Picks] = useState([]) // raw {id, rank, rationale} from the scheduled job
  const [pinnedIds, setPinnedIds] = useState(new Set())
  const [dismissedIds, setDismissedIds] = useState(new Set())
  const [persistedDismissed, setPersistedDismissed] = useState([]) // from GET /dismissed — real, survives reload
  const [completedTodos, setCompletedTodos] = useState([]) // from GET /todo, filtered completed — real, survives reload
  const [view, setView] = useState('queue') // 'queue' | 'done'
  const [toast, setToast] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [addText, setAddText] = useState('')
  const [adding, setAdding] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [visibleCount, setVisibleCount] = useState(10)
  const [contactDetail, setContactDetail] = useState(null) // { contact, engagements } from GET /contacts/:id, fetched on select
  const [contactDetailLoading, setContactDetailLoading] = useState(false)

  // Team viewing — read-only look at a teammate's queue. Only shows up if
  // GET /team succeeds (i.e. this user has a TEAM_HIERARCHY entry granting
  // them scoped access to specific teammates, or full access to everyone).
  const [teamRoster, setTeamRoster] = useState([]) // [{userId, email}] this user can view
  const [viewingUserId, setViewingUserId] = useState(null) // null = viewing own queue

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(t => (t === msg ? null : t)), 2500)
  }, [])

  const load = useCallback(async () => {
    try {
      setError(null)
      if (viewingUserId) {
        // Read-only teammate view — team/queue only returns the raw queue,
        // no top5/pins/discussed/focus state (those are per-viewer concepts
        // that don't apply when just looking at someone else's list).
        const queueRes = await apiFetch(`/api/hubspot/team/queue?userId=${encodeURIComponent(viewingUserId)}`, getToken)
        setQueue(queueRes.queue || [])
        setHighEngagement([])
        setTop5Picks([])
        setPinnedIds(new Set())
        setPersistedDismissed([])
        setCompletedTodos([])
        if ((queueRes.queue || []).length > 0) setSelectedId(queueRes.queue[0].id)
        return
      }
      const [queueRes, top5Res, pinRes, dismissedRes, todoRes] = await Promise.all([
        apiFetch('/api/hubspot/right-now', getToken),
        apiFetch('/api/hubspot/top5', getToken).catch(() => ({ picks: [] })),
        apiFetch('/api/hubspot/pin', getToken).catch(() => ({ pinnedIds: [] })),
        apiFetch('/api/hubspot/dismissed', getToken).catch(() => ({ items: [] })),
        apiFetch('/api/hubspot/todo', getToken).catch(() => ({ items: [] })),
      ])
      setQueue(queueRes.queue || [])
      setHighEngagement(queueRes.highSequenceEngagement || [])
      setTop5Picks(top5Res.picks || [])
      setPinnedIds(new Set(pinRes.pinnedIds || []))
      setPersistedDismissed(dismissedRes.items || [])
      setCompletedTodos((todoRes.items || []).filter(t => t.completed))
      if (!selectedId && (queueRes.queue || []).length > 0) {
        setSelectedId(queueRes.queue[0].id)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [getToken, selectedId, viewingUserId])

  // Fetch the team roster once on mount — if this 403s, the user simply
  // has no TEAM_HIERARCHY access, and the switcher just doesn't render.
  useEffect(() => {
    apiFetch('/api/hubspot/team', getToken)
      .then(data => setTeamRoster(data.roster || []))
      .catch(() => setTeamRoster([]))
  }, [getToken])

  useEffect(() => {
    setLoading(true)
    load()
    const interval = setInterval(load, 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, [viewingUserId]) // eslint-disable-line react-hooks/exhaustive-deps

  const visibleQueue = useMemo(
    () => queue.filter(item => !dismissedIds.has(item.id)),
    [queue, dismissedIds]
  )

  // Meetings happening today get their own always-visible slot — they don't
  // compete for one of the 5 Top 5 spots, and they're never hidden by the
  // score threshold below, since "you have a meeting today" is important
  // regardless of how the formula would otherwise score it.
  const todaysMeetings = useMemo(() => {
    const todayStr = new Date().toDateString()
    return visibleQueue
      .filter(item =>
        item.source === 'meeting' && item.raw?.startTime && new Date(item.raw.startTime).toDateString() === todayStr
      )
      .sort((a, b) => new Date(a.raw.startTime) - new Date(b.raw.startTime))
  }, [visibleQueue])
  const todaysMeetingIds = useMemo(() => new Set(todaysMeetings.map(i => i.id)), [todaysMeetings])

  const top5Combined = useMemo(() => {
    const eligible = visibleQueue.filter(item => !todaysMeetingIds.has(item.id))
    const pinnedItems = eligible
      .filter(item => pinnedIds.has(item.id))
      .map(item => ({ ...item, isPinned: true }))

    const slotsLeft = Math.max(5 - pinnedItems.length, 0)
    const aiItems = top5Picks
      .filter(p => !pinnedIds.has(p.id))
      .slice(0, slotsLeft)
      .map(p => {
        const match = eligible.find(item => item.id === p.id)
        return match ? { ...match, rationale: p.rationale, isPinned: false } : null
      })
      .filter(Boolean)

    return [...pinnedItems, ...aiItems]
  }, [visibleQueue, todaysMeetingIds, pinnedIds, top5Picks])

  const top5Ids = useMemo(() => new Set(top5Combined.map(i => i.id)), [top5Combined])

  // Free, zero-cost filter: below this score, a signal has cooled off enough
  // that it's not really "act on this now" material — but manual to-dos and
  // meetings always show regardless, since those are explicit asks, not
  // formula-derived urgency.
  const MIN_SCORE_TO_SHOW = 45
  const restOfQueue = useMemo(
    () => visibleQueue.filter(item =>
      !top5Ids.has(item.id) &&
      !todaysMeetingIds.has(item.id) &&
      (item.queueScore >= MIN_SCORE_TO_SHOW || item.source === 'todo')
    ),
    [visibleQueue, top5Ids, todaysMeetingIds]
  )
  const pagedQueue = restOfQueue.slice(0, visibleCount)

  const completedItems = useMemo(() => {
    const fromTodos = completedTodos.map(t => ({
      id: `todo-${t.id}`,
      name: t.text || 'Untitled',
      company: null,
      whyTag: t.subtext || 'Manual to-do',
      action: 'completed',
      at: t.completedAt || t.createdAt || new Date().toISOString(),
    }))
    const fromDismissed = persistedDismissed.map(d => ({
      id: d.id,
      name: d.name,
      company: d.company,
      whyTag: d.whyTag,
      action: 'dismissed',
      at: d.dismissedAt,
    }))
    return [...fromTodos, ...fromDismissed].sort((a, b) => new Date(b.at) - new Date(a.at))
  }, [completedTodos, persistedDismissed])

  const togglePin = async (itemId, itemName) => {
    const isPinned = pinnedIds.has(itemId)
    setPinnedIds(prev => {
      const next = new Set(prev)
      isPinned ? next.delete(itemId) : next.add(itemId)
      return next
    })
    showToast(isPinned ? `Unpinned ${itemName}` : `Pinned ${itemName} to Top 5`)
    try {
      if (isPinned) {
        await apiFetch(`/api/hubspot/pin/${encodeURIComponent(itemId)}`, getToken, { method: 'DELETE' })
      } else {
        await apiFetch('/api/hubspot/pin', getToken, {
          method: 'POST',
          body: JSON.stringify({ itemId }),
        })
      }
    } catch (e) {
      setPinnedIds(prev => {
        const next = new Set(prev)
        isPinned ? next.add(itemId) : next.delete(itemId)
        return next
      })
      setError(`Couldn't update pin: ${e.message}`)
    }
  }

  const markDone = async (item) => {
    const name = displayName(item)
    if (item.source === 'todo') {
      setQueue(prev => prev.filter(i => i.id !== item.id))
      showToast(`Marked "${name}" complete — see Completed Items`)
      try {
        const rawId = item.raw?.id || item.id.replace(/^todo-/, '')
        await apiFetch(`/api/hubspot/todo/${rawId}`, getToken, {
          method: 'PATCH',
          body: JSON.stringify({ completed: true }),
        })
        setCompletedTodos(prev => [{ ...item.raw, completed: true, completedAt: new Date().toISOString() }, ...prev])
      } catch (e) {
        setError(`Couldn't mark complete: ${e.message}`)
        load()
      }
    } else {
      setDismissedIds(prev => new Set(prev).add(item.id))
      showToast(`Dismissed "${name}" — see Completed Items`)
      const entry = { id: item.id, name, company: displayCompany(item), whyTag: item.whyTag, source: item.source }
      setPersistedDismissed(prev => [{ ...entry, dismissedAt: new Date().toISOString() }, ...prev])
      try {
        await apiFetch('/api/hubspot/dismissed', getToken, {
          method: 'POST',
          body: JSON.stringify(entry),
        })
      } catch (e) {
        setError(`Couldn't save dismissal: ${e.message}`)
      }
    }
  }

  const [regenerating, setRegenerating] = useState(false)
  const regenerateTop5 = async () => {
    setRegenerating(true)
    try {
      const data = await apiFetch('/api/hubspot/top5/regenerate', getToken, { method: 'POST' })
      setTop5Picks(data.picks || [])
      showToast('Top 5 refreshed')
    } catch (e) {
      setError(`Couldn't refresh Top 5: ${e.message}`)
    } finally {
      setRegenerating(false)
    }
  }

  const addTask = async () => {
    const text = addText.trim()
    if (!text) return
    setAdding(true)
    try {
      if (viewingUserId) {
        // Explicitly the one write allowed in read-only team-viewing mode.
        const { item } = await apiFetch('/api/hubspot/team/push', getToken, {
          method: 'POST',
          body: JSON.stringify({ targetUserId: viewingUserId, text }),
        })
        setAddText('')
        setQueue(prev => [{
          source: 'todo',
          id: `todo-${item.id}`,
          contactId: item.contactId || null,
          contact: null,
          label: item.text,
          queueScore: 100,
          whyTag: `From ${user?.user_metadata?.full_name || user?.email || 'you'}`,
          raw: item,
        }, ...prev])
        showToast('Task added to their queue')
        return
      }
      const { item } = await apiFetch('/api/hubspot/todo', getToken, {
        method: 'POST',
        body: JSON.stringify({ text, autoDetected: false, priority: 'HIGH' }),
      })
      setAddText('')
      setQueue(prev => [{
        source: 'todo',
        id: `todo-${item.id}`,
        contactId: item.contactId || null,
        contact: null,
        label: item.text,
        queueScore: 90,
        whyTag: 'Manual to-do',
        raw: item,
      }, ...prev])
      showToast('Added to queue')
    } catch (e) {
      setError(`Couldn't add task: ${e.message}`)
    } finally {
      setAdding(false)
    }
  }

  const selectedItem = queue.find(i => i.id === selectedId) || highEngagement.find(i => i.id === selectedId) || null

  useEffect(() => {
    if (!selectedItem?.contactId) {
      setContactDetail(null)
      return
    }
    let cancelled = false
    setContactDetailLoading(true)
    apiFetch(`/api/hubspot/contacts/${selectedItem.contactId}`, getToken)
      .then(data => { if (!cancelled) setContactDetail(data) })
      .catch(() => { if (!cancelled) setContactDetail(null) })
      .finally(() => { if (!cancelled) setContactDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedItem?.contactId, getToken])

  const emailEngagements = useMemo(() => {
    if (!contactDetail?.engagements) return []
    return contactDetail.engagements
      // Strictly EMAIL type — the old `|| e.subject` fallback was the bug:
      // a Gong-logged MEETING engagement has a subject too, so it was
      // slipping in and displaying as if it were an email.
      .filter(e => e.type === 'EMAIL' && !/^\[Gong\]/i.test(e.subject || ''))
      .map(e => ({
        ...e,
        bounced: isBounceLike(e.subject, e.body),
        automated: isOooLike(e.subject, e.body),
      }))
      .sort((a, b) => new Date(emailDate(b) || 0) - new Date(emailDate(a) || 0))
      .slice(0, 5)
  }, [contactDetail])

  // Compares marketing-system "last send" against the most recent actual
  // engagement send, and shows whichever genuinely happened more recently —
  // marketing campaigns can go stale for months while 1:1 outreach keeps
  // moving, so defaulting to the marketing field alone was misleading.
  const mostRecentEmail = useMemo(() => {
    const marketing = selectedItem?.contact?.lastSendDate
      ? {
          name: selectedItem.contact.lastEmailName,
          at: selectedItem.contact.lastSendDate,
          system: 'Marketing',
          // Marketing's own opened/clicked properties genuinely correspond
          // to this same marketing-send record, so they're safe to use here.
          openedAt: selectedItem.contact.lastOpenDate || null,
          numOpens: selectedItem.contact.lastOpenDate ? 1 : 0, // marketing props don't expose a count, only last-opened
        }
      : null
    const latestEngagement = emailEngagements
      .filter(e => !e.bounced)
      .sort((a, b) => new Date(emailDate(b) || 0) - new Date(emailDate(a) || 0))[0]
    const oneToOne = latestEngagement
      ? {
          name: latestEngagement.subject,
          at: emailDate(latestEngagement),
          system: '1:1 / logged',
          // Tied to THIS specific engagement's own open data, not a
          // disconnected global "have they ever opened anything" property —
          // that mismatch is exactly what produced the confusing "sent 2d
          // ago / opened 162d ago" display.
          openedAt: latestEngagement.openedAt || null,
          numOpens: latestEngagement.numOpens || 0,
        }
      : null
    if (!marketing && !oneToOne) return null
    if (!marketing) return oneToOne
    if (!oneToOne) return marketing
    return new Date(oneToOne.at) > new Date(marketing.at) ? oneToOne : marketing
  }, [selectedItem, emailEngagements])

  const lastIncomingBody = useMemo(() => {
    const reply = contactDetail?.engagements?.find(e => e.replied || e.type === 'INCOMING_EMAIL')
    return reply?.body || null
  }, [contactDetail])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, background: 'var(--bg)', color: 'var(--text)', minHeight: '100%', position: 'relative', padding: 4 }}>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-panel)', border: '1px solid var(--border)', color: 'var(--text)', padding: '11px 20px', borderRadius: 'var(--radius-lg)', fontSize: 13, boxShadow: 'var(--shadow-soft)', zIndex: 100 }}>
          {toast}
        </div>
      )}

      <div style={{ padding: '22px 26px', background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          {teamRoster.length > 0 ? (
            <>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Viewing</span>
              <select value={viewingUserId || ''} onChange={e => { setSelectedId(null); setViewingUserId(e.target.value || null) }}
                style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '5px 10px' }}>
                <option value="">{user?.user_metadata?.full_name || user?.email || 'You'} (me)</option>
                {teamRoster.filter(r => r.userId).map(r => (
                  <option key={r.userId} value={r.userId}>{r.email}</option>
                ))}
              </select>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>'s Right Now Queue</span>
            </>
          ) : (
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              Viewing <strong style={{ color: 'var(--text-secondary)' }}>{user?.user_metadata?.full_name || user?.email || 'your'}</strong>'s Right Now Queue
            </span>
          )}
        </div>

        {viewingUserId && (
          <div style={{ fontSize: 11.5, background: 'var(--manager-color)', color: '#fff', padding: '7px 12px', borderRadius: 8, marginBottom: 14, display: 'inline-block' }}>
            Read-only — you can add tasks to their queue below, but can't pin, dismiss, or mark items complete on their behalf.
          </div>
        )}

        {error && (
          <div style={{ background: 'var(--red-light)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: '1px solid var(--border)' }}>
          <button onClick={() => setView('queue')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 4px', marginRight: 16, fontSize: 13, fontWeight: view === 'queue' ? 600 : 400, color: view === 'queue' ? 'var(--text)' : 'var(--text-tertiary)', borderBottom: view === 'queue' ? '2px solid var(--accent)' : '2px solid transparent' }}>
            Queue
          </button>
          <button onClick={() => setView('done')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 4px', fontSize: 13, fontWeight: view === 'done' ? 600 : 400, color: view === 'done' ? 'var(--text)' : 'var(--text-tertiary)', borderBottom: view === 'done' ? '2px solid var(--accent)' : '2px solid transparent', display: 'flex', alignItems: 'center', gap: 6 }}>
            Completed Items
            {completedItems.length > 0 && (
              <span style={{ fontSize: 10, background: 'var(--bg-secondary)', color: 'var(--text-tertiary)', borderRadius: 10, padding: '1px 6px' }}>{completedItems.length}</span>
            )}
          </button>
        </div>

        {view === 'done' ? (
          <>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 14 }}>
              Everything completed or dismissed — this persists across reloads.
            </div>
            {completedItems.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>Nothing completed yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {completedItems.map((entry, i) => (
                  <div key={entry.id + i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderRadius: 14, border: '1px solid var(--border)', background: 'var(--bg-panel)', opacity: 0.85 }}>
                    <span style={{ fontSize: 14 }}>{entry.action === 'completed' ? '✓' : '—'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, textDecoration: 'line-through', textDecorationColor: 'var(--border-strong)' }}>
                        {entry.name}{entry.company ? ` · ${entry.company}` : ''}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {entry.action === 'completed' ? 'Marked complete' : 'Dismissed'} · {entry.whyTag}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {new Date(entry.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {todaysMeetings.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '.3px', color: 'var(--urgency-warm)' }}>TODAY'S MEETINGS</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>· always shown, doesn't count against Top 5</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 22 }}>
                  {todaysMeetings.map(item => (
                    <div key={item.id} onClick={() => setSelectedId(item.id)} style={{
                      borderRadius: 14, padding: '13px 16px', display: 'flex', gap: 11, alignItems: 'center', cursor: 'pointer',
                      background: 'color-mix(in srgb, var(--urgency-warm) 10%, var(--bg-panel))',
                      border: '1px solid color-mix(in srgb, var(--urgency-warm) 40%, var(--border))',
                      boxShadow: 'var(--shadow-soft)',
                    }}>
                      <span style={{ fontSize: 15 }}>📅</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--urgency-warm)', whiteSpace: 'nowrap' }}>
                            {meetingTimeRange(item.raw?.startTime, item.raw?.endTime)}
                          </span>
                          <div style={{ fontSize: 13, fontWeight: 500 }}><NameCompanyLine item={item} /></div>
                        </div>
                        <RepInfoLine item={item} />
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{item.whyTag}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {top5Combined.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '.3px', color: 'var(--accent)' }}>TOP 5 RIGHT NOW</span>
                  {!viewingUserId && (
                    <button onClick={regenerateTop5} disabled={regenerating}
                      style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent-text)', background: 'none', border: 'none', cursor: regenerating ? 'default' : 'pointer', padding: 0 }}>
                      {regenerating ? 'Refreshing…' : 'Refresh Top 5 now'}
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginBottom: 10 }}>
                  These items refresh automatically once an hour — use "Refresh Top 5 now" for an immediate update.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 22 }}>
                  {top5Combined.map((item, idx) => {
                    const color = item.isPinned ? 'var(--pin-color)' : urgencyColor(item.queueScore)
                    const name = displayName(item)
                    return (
                      <div key={item.id} onClick={() => setSelectedId(item.id)} style={{
                        borderRadius: 14, padding: '13px 16px', display: 'flex', gap: 11, alignItems: 'flex-start', cursor: 'pointer',
                        background: `color-mix(in srgb, ${color} 10%, var(--bg-panel))`,
                        border: `1px solid color-mix(in srgb, ${color} 40%, var(--border))`,
                        boxShadow: 'var(--shadow-soft)',
                        outline: selectedId === item.id ? '2px solid var(--accent)' : 'none',
                        outlineOffset: 1,
                      }}>
                        {item.isPinned ? (
                          <div style={{ width: 20, height: 20, borderRadius: '50%', background: color, color: 'var(--bg)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            📌
                          </div>
                        ) : (
                          <div style={{ width: 20, height: 20, borderRadius: '50%', background: color, color: 'var(--bg)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {idx + 1}
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500 }}><NameCompanyLine item={item} /></div>
                        <RepInfoLine item={item} />
                          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                            <span style={{ color: 'var(--text-tertiary)' }}>Why: </span>{item.rationale || item.whyTag}
                          </div>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); if (!viewingUserId) togglePin(item.id, name) }}
                          disabled={!!viewingUserId}
                          title={viewingUserId ? 'Read-only — viewing a teammate\'s queue' : undefined}
                          style={{
                            flexShrink: 0, fontSize: 11, padding: '5px 10px', borderRadius: 8, cursor: viewingUserId ? 'not-allowed' : 'pointer',
                            background: item.isPinned ? color : 'none',
                            color: item.isPinned ? 'var(--bg)' : 'var(--text-tertiary)',
                            border: item.isPinned ? 'none' : '1px solid var(--border-strong)',
                            opacity: viewingUserId ? 0.4 : 1,
                          }}>
                          {item.isPinned ? 'Remove pin' : 'Pin here'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {highEngagement.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '.3px', color: 'var(--pin-color)' }}>HIGH ENGAGEMENT — 3+ SEQUENCE OPENS</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>· opened repeatedly, no reply yet</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 22 }}>
                  {highEngagement.map(item => (
                    <div key={item.id} onClick={() => setSelectedId(item.id)} style={{
                      borderRadius: 14, padding: '13px 16px', display: 'flex', gap: 11, alignItems: 'center', cursor: 'pointer',
                      background: 'color-mix(in srgb, var(--pin-color) 8%, var(--bg-panel))',
                      border: '1px solid color-mix(in srgb, var(--pin-color) 35%, var(--border))',
                      boxShadow: 'var(--shadow-soft)',
                    }}>
                      <div style={{
                        flexShrink: 0, width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'var(--pin-color)', color: '#fff', fontSize: 15, fontWeight: 700,
                      }}>
                        {item.opens}&times;
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}><NameCompanyLine item={{ contact: item.contact }} /></div>
                        <RepInfoLine item={{ contact: item.contact }} />
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                          Opened {item.opens} times{item.clicks > 0 ? ` · clicked ${item.clicks}x` : ''}{item.replies > 0 ? ` · ${item.replies} repl${item.replies === 1 ? 'y' : 'ies'}` : ' · no reply yet'}
                        </div>
                      </div>
                      {item.contact?.contactUrl && (
                        <a href={item.contact.contactUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                          style={{ flexShrink: 0, fontSize: 11, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border-strong)', color: 'var(--text-tertiary)', textDecoration: 'none' }}>
                          View
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input
                value={addText}
                onChange={e => setAddText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addTask() }}
                placeholder="Add a task and hit enter"
                disabled={adding}
                style={{ flex: 1, background: 'var(--bg-panel)', border: '1px solid var(--border-strong)', color: 'var(--text)', borderRadius: 'var(--radius)', padding: '9px 12px', fontSize: 13 }}
              />
              <button onClick={addTask} disabled={adding || !addText.trim()}
                style={{ background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: 'var(--radius)', padding: '0 14px', cursor: 'pointer', opacity: adding || !addText.trim() ? 0.5 : 1 }}>
                +
              </button>
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              Full queue · {restOfQueue.length} items{restOfQueue.length > 10 ? ` · showing ${Math.min(visibleCount, restOfQueue.length)}` : ''}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {restOfQueue.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>Queue clear.</div>
              )}
              {pagedQueue.map(item => {
                const color = urgencyColor(item.queueScore)
                const isPinned = pinnedIds.has(item.id)
                const name = displayName(item)
                return (
                  <div key={item.id} onClick={() => setSelectedId(item.id)} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', cursor: 'pointer',
                    borderRadius: 14, border: `1px solid color-mix(in srgb, ${color} 40%, var(--border))`,
                    background: `color-mix(in srgb, ${color} 8%, var(--bg-panel))`,
                    boxShadow: 'var(--shadow-soft)',
                    outline: selectedId === item.id ? '2px solid var(--accent)' : 'none',
                    outlineOffset: 1,
                  }}>
                    <button onClick={e => { e.stopPropagation(); if (!viewingUserId) markDone(item) }}
                      title={viewingUserId ? 'Read-only — viewing a teammate\'s queue' : (item.source === 'todo' ? 'Mark complete' : 'Dismiss from this session')}
                      disabled={!!viewingUserId}
                      style={{ width: 17, height: 17, borderRadius: 6, border: '1.5px solid var(--border-strong)', background: 'var(--bg)', cursor: viewingUserId ? 'not-allowed' : 'pointer', opacity: viewingUserId ? 0.4 : 1, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}><NameCompanyLine item={item} /></div>
                        <RepInfoLine item={item} />
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                        <span style={{ color: 'var(--text-tertiary)' }}>{sourceLabel(item.source)} · </span>{item.whyTag || 'No reason recorded'}
                      </div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); togglePin(item.id, name) }}
                      style={{
                        flexShrink: 0, fontSize: 11, padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
                        background: isPinned ? 'var(--pin-color)' : 'none',
                        color: isPinned ? 'var(--bg)' : 'var(--text-tertiary)',
                        border: isPinned ? 'none' : '1px solid var(--border-strong)',
                      }}>
                      {isPinned ? 'Pinned' : 'Pin to Top 5'}
                    </button>
                  </div>
                )
              })}
            </div>

            {restOfQueue.length > visibleCount && (
              <button onClick={() => setVisibleCount(c => c + 10)}
                style={{ width: '100%', marginTop: 12, padding: '10px', background: 'var(--bg-panel)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 'var(--radius)', fontSize: 12.5, cursor: 'pointer' }}>
                Show 10 more ({restOfQueue.length - visibleCount} remaining)
              </button>
            )}
            {visibleCount > 10 && restOfQueue.length <= visibleCount && (
              <button onClick={() => setVisibleCount(10)}
                style={{ width: '100%', marginTop: 12, padding: '10px', background: 'none', border: 'none', color: 'var(--text-tertiary)', fontSize: 12.5, cursor: 'pointer' }}>
                Show less
              </button>
            )}
          </>
        )}
      </div>

      <div style={{ padding: 22, background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)', position: 'sticky', top: 76, maxHeight: 'calc(100vh - 96px)', overflowY: 'auto' }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>Context</div>
        {selectedItem ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>
              {selectedItem.contact?.contactUrl ? (
                <a href={selectedItem.contact.contactUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline', textDecorationColor: 'var(--border-strong)' }}>
                  {displayName(selectedItem)}
                </a>
              ) : displayName(selectedItem)}
            </div>
            {displayCompany(selectedItem) && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                {selectedItem.contact?.companyUrl ? (
                  <a href={selectedItem.contact.companyUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline', textDecorationColor: 'var(--border-strong)' }}>
                    {displayCompany(selectedItem)}
                  </a>
                ) : displayCompany(selectedItem)}
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <RepInfoLine item={selectedItem} />
            </div>
            {contactDetail?.lastSequenceName && (
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 14 }}>
                Last sequence: {contactDetail.lastSequenceName}
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              Why it's in the queue
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 14 }}>
              {selectedItem.whyTag || 'No reason recorded'}
            </div>

            {looksLikeItNeedsAReply(lastIncomingBody) && (
              <div style={{ fontSize: 11.5, background: 'var(--amber-light)', color: 'var(--amber)', padding: '7px 10px', borderRadius: 8, marginBottom: 14 }}>
                Their last reply contains a question — might be waiting on you. (Keyword check, not a real read of the email.)
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              Email activity
            </div>

            {mostRecentEmail ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.9, marginBottom: 14 }}>
                <div><strong style={{ color: 'var(--text)' }}>Last email:</strong> {mostRecentEmail.name || '(no subject)'}</div>
                <div>
                  <strong style={{ color: 'var(--text)' }}>Sent:</strong> {timeAgo(mostRecentEmail.at)}
                  {absoluteTime(mostRecentEmail.at) && <span style={{ color: 'var(--text-tertiary)' }}> ({absoluteTime(mostRecentEmail.at)})</span>}
                  <span style={{ color: 'var(--text-tertiary)' }}> · {mostRecentEmail.system}</span>
                </div>
                {mostRecentEmail.openedAt ? (
                  <div>
                    <strong style={{ color: 'var(--text)' }}>Opened:</strong> yes, {timeAgo(mostRecentEmail.openedAt)}
                    {absoluteTime(mostRecentEmail.openedAt) && <span style={{ color: 'var(--text-tertiary)' }}> ({absoluteTime(mostRecentEmail.openedAt)})</span>}
                    {timeBetween(mostRecentEmail.at, mostRecentEmail.openedAt) && (
                      <span style={{ color: 'var(--text-tertiary)' }}> — {timeBetween(mostRecentEmail.at, mostRecentEmail.openedAt)} after sending</span>
                    )}
                    {mostRecentEmail.numOpens > 1 ? ` (${mostRecentEmail.numOpens}x)` : ''}
                  </div>
                ) : (
                  <div><strong style={{ color: 'var(--text)' }}>Opened:</strong> not yet</div>
                )}
                {selectedItem.contact?.lastReplyDate && (
                  <div><strong style={{ color: 'var(--text)' }}>Replied:</strong> {timeAgo(selectedItem.contact.lastReplyDate)}</div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>No email activity found for this contact.</div>
            )}

            {contactDetailLoading && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Loading recent emails…</div>
            )}

            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>
              Last meeting
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 14 }}>
              {contactDetailLoading ? (
                <span style={{ color: 'var(--text-tertiary)' }}>Loading…</span>
              ) : contactDetail?.lastMeeting ? (
                <>
                  {contactDetail.lastMeeting.subject} — {timeAgo(contactDetail.lastMeeting.timestamp)}
                  {absoluteTime(contactDetail.lastMeeting.timestamp) && (
                    <span style={{ color: 'var(--text-tertiary)' }}> ({absoluteTime(contactDetail.lastMeeting.timestamp)})</span>
                  )}
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginLeft: 6 }}>
                    (via {contactDetail.lastMeeting.source === 'outlook' ? 'Outlook' : 'HubSpot'})
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--text-tertiary)' }}>No meeting found in HubSpot or Outlook.</span>
              )}
            </div>

            {!contactDetailLoading && emailEngagements.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>
                  Recent emails <span style={{ textTransform: 'none', letterSpacing: 0 }}>(1:1 / logged activity — separate from the marketing send above)</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {emailEngagements.map((e, i) => (
                    <div key={i} style={{ fontSize: 11.5, padding: '9px 10px', borderRadius: 8, border: e.bounced ? '1px solid var(--red)' : '1px solid var(--border)' }}>
                      <div style={{ fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>{e.subject || '(no subject)'}</div>
                      <div style={{ color: e.bounced ? 'var(--red)' : 'var(--text-tertiary)' }}>
                        {e.bounced ? 'Bounced, undelivered' : (
                          <>
                            Sent {timeAgo(emailDate(e))}
                            {absoluteTime(emailDate(e)) && (
                              <span style={{ color: 'var(--text-tertiary)', opacity: 0.75 }}> ({absoluteTime(emailDate(e))})</span>
                            )}
                            {e.numOpens > 0 && (
                              <>
                                {' · opened'}
                                {timeBetween(emailDate(e), e.openedAt) && ` ${timeBetween(emailDate(e), e.openedAt)} later`}
                                {e.numOpens > 1 && ` (${e.numOpens}x)`}
                              </>
                            )}
                            {e.numClicks > 0 && ` · clicked ${e.numClicks}x`}
                            {e.replied && e.automated && ' · auto-reply (OOO, not a real response)'}
                            {e.replied && !e.automated && ' · replied'}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Select an item to see details.</div>
        )}
      </div>
    </div>
  )
}
