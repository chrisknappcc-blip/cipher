import { useState, useEffect, useMemo, useCallback } from 'react'
import { apiFetch } from './api'

// DebriefsView.jsx: Cipher's window onto analyzed Gong calls.
//
// Reps see the calls they were on. People on the server's view all list (John)
// see everyone's, plus a team breakdown and a status view. That rule is enforced
// by the server; nothing here decides who may see what.
//
// The Recap is the weekly delivery: it unlocks Friday 4:00 PM Eastern, shows an
// unread badge on the tab until it is opened, and lists what each call left
// owed, so follow ups do not depend on anyone remembering.

const ET = 'America/New_York'
const BAND = { High: '#2E7D4F', Medium: '#B7791F', Low: '#C2410C', 'Very low': '#A63D40' }
const bandColor = (b) => BAND[b] || 'var(--text-tertiary)'
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: ET, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const fmtWeek = (wk) => new Date(`${wk}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
// Same rule as the server's shortOrgName (kept free of regex lookbehind for older Safari).
const shortOrg = (v) => { let cut = String(v || '').trim().split(/\s\(/)[0].trim(); if (cut.length > 60) { const first = cut.split(/[.;]\s/)[0].trim(); if (first.length >= 4) cut = first } return cut.length > 60 ? `${cut.slice(0, 57).trimEnd()}...` : cut }
const mins = (sec) => (sec ? `${Math.round(sec / 60)} min` : '')

const panel = { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }
const muted = { color: 'var(--text-tertiary)', fontSize: 12 }
const selStyle = { fontSize: 12, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }
// Same key as the server uses for a rep: their email if there is one, otherwise their name, in lower case.
const repKeyOf = (item) => String((item && (item.ownerEmail || item.ownerName)) || '').toLowerCase()
const NOT_IDENTIFIED = 'Gong could not tell whether the other person is outside the company, so this call was included to be safe.'

const STATUS_NOTE = {
  too_short: 'This call is counted, but not enough was said to analyze.',
  no_transcript: 'Gong never produced a transcript for this call, so there is nothing to analyze.',
  skipped: 'This call was skipped (no outside participant, or it could not be found in Gong).',
}

function Pill({ color, children }) {
  return <span style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap', color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{children}</span>
}

export function ScoreBadge({ engagement }) {
  if (!engagement) return null
  return <Pill color={bandColor(engagement.band)}>{engagement.score} {engagement.band}</Pill>
}

function H({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--accent-text)', margin: '20px 0 8px', paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>{children}</div>
}

function Bullets({ items, empty }) {
  if (!items || !items.length) return empty ? <div style={muted}>{empty}</div> : null
  return <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text)', lineHeight: 1.55 }}>{items.map((t, i) => <li key={i} style={{ marginBottom: 3, overflowWrap: 'anywhere' }}>{t}</li>)}</ul>
}

function Callout({ color = 'var(--accent)', children }) {
  return <div style={{ background: 'var(--bg-secondary)', borderLeft: `3px solid ${color}`, borderRadius: 6, padding: '10px 12px', fontSize: 13, color: 'var(--text)', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{children}</div>
}

function Table({ headers, rows, empty }) {
  if (!rows || !rows.length) return empty ? <div style={muted}>{empty}</div> : null
  // Short columns (ratings, times, names, statuses) stay on one line. Long text columns get a minimum
  // width. Text breaks at spaces (break-word); "anywhere" let the browser shrink a column to a few
  // letters, which is what split "Rating" into "Rati / ng" and names into "Roberso / n".
  const kinds = headers.map((_, j) => {
    const vals = rows.map((r) => r[j])
    if (vals.some((v) => v != null && typeof v !== 'string' && typeof v !== 'number')) return 'auto'
    return Math.max(0, ...vals.map((v) => String(v ?? '').length)) <= 24 ? 'narrow' : 'wide'
  })
  const kindStyle = (k) => (k === 'narrow' ? { whiteSpace: 'nowrap' } : k === 'wide' ? { minWidth: 170 } : {})
  const cell = { padding: '6px 8px', verticalAlign: 'top', fontSize: 12.5, lineHeight: 1.45, overflowWrap: 'break-word', borderTop: '1px solid var(--border)' }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{headers.map((h, i) => <th key={i} style={{ ...cell, borderTop: 'none', textAlign: 'left', fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ ...cell, color: 'var(--text)', ...kindStyle(kinds[j]) }}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

export function CallCard({ item, selected, unread, onClick }) {
  const failed = item.status === 'failed'
  const waiting = item.status === 'waiting' // found in Gong, not analyzed yet, so there is no debrief to open
  const Tag = waiting ? 'div' : 'button'
  return (
    <Tag onClick={waiting ? undefined : onClick} style={{ ...panel, textAlign: 'left', cursor: waiting ? 'default' : 'pointer', padding: '10px 12px', width: '100%', display: 'block', borderColor: selected ? 'var(--accent)' : 'var(--border)', background: selected ? 'var(--accent-light)' : 'var(--bg-panel)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        {unread && <span title="New" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />}
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', overflowWrap: 'anywhere', flex: 1 }}>{item.organization || item.title || 'Untitled call'}</div>
        <ScoreBadge engagement={item.engagement} />
        {failed && <Pill color="#A63D40">Failed</Pill>}
        {item.status === 'too_short' && <Pill color="#6B7280">Too short</Pill>}
        {item.status === 'no_transcript' && <Pill color="#6B7280">No transcript</Pill>}
        {waiting && <Pill color="#B7791F">Waiting</Pill>}
        {item.callKind === 'likely_external' && <span title={NOT_IDENTIFIED}><Pill color="#6B7280">Not identified</Pill></span>}
      </div>
      <div style={{ ...muted, marginBottom: item.verdict ? 4 : 0 }}>{fmtWhen(item.started)}{item.ownerName ? ` · ${item.ownerName}` : ''}{item.durationSec ? ` · ${mins(item.durationSec)}` : ''}</div>
      {item.verdict && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{item.verdict}</div>}
      {waiting && <div data-waiting-note style={{ ...muted, marginTop: 4, overflowWrap: 'anywhere' }}>{item.waitingReason === 'no_transcript' ? 'Waiting for Gong to produce the transcript. Cipher checks again, less often each time, and records it as having no transcript after about two days.' : 'Found in Gong and queued. It will be analyzed within the next few checks.'}{item.url ? <> <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-text)' }}>Open in Gong</a></> : null}</div>}
      {item.status === 'complete' && (
        <div style={{ ...muted, marginTop: 4 }}>
          {item.greenCount} green · {item.redCount} red{item.owedItems?.length ? ` · ${item.owedItems.length} owed` : ''}{item.openQuestions?.length ? ` · ${item.openQuestions.length} open questions` : ''}
        </div>
      )}
    </Tag>
  )
}

export function DebriefDetail({ record, viewAll, onReanalyze, busy, reanalyzing }) {
  const g = record.gong || {}
  const a = record.analysis
  const fullOrg = a?.prospect?.organization || ''
  const title = shortOrg(fullOrg) || g.title || 'Call debrief'
  return (
    <div className="debrief-print-area" style={{ ...panel, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', overflowWrap: 'anywhere' }}>{title}</div>
          {fullOrg && fullOrg !== title && <div style={{ ...muted, marginTop: 2, overflowWrap: 'anywhere' }}>{fullOrg}</div>}
          <div style={{ ...muted, marginTop: 3 }}>
            {[a?.prospect?.callTopic, fmtWhen(g.started), mins(g.durationSec), record.ownerName && `Rep: ${record.ownerName}`].filter(Boolean).join(' · ')}
          </div>
          {(record.internal || []).length > 0 && <div style={muted}>Care Continuity: {record.internal.map((p) => p.name || p.email).filter(Boolean).join(', ')}</div>}
          {record.callKind === 'likely_external' && <div style={muted}>{NOT_IDENTIFIED}</div>}
        </div>
        <ScoreBadge engagement={record.engagement} />
        <div className="debrief-no-print" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {g.url && <a href={g.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', color: 'var(--text)' }}>Open in Gong</a>}
          {a && <button onClick={() => window.print()} style={{ fontSize: 11.5, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer' }}>Print or save as PDF</button>}
          {viewAll && onReanalyze && <button disabled={busy || reanalyzing} onClick={onReanalyze} style={{ fontSize: 11.5, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: busy ? 'not-allowed' : 'pointer' }}>{busy || reanalyzing ? 'Queued' : 'Re-analyze'}</button>}
        </div>
      </div>

      {reanalyzing && (
        <div className="debrief-no-print" style={{ marginTop: 14 }}><Callout color="var(--accent)">Re-analysis in progress. This usually takes a minute or two, and this page will update by itself.</Callout></div>
      )}

      {!a && !reanalyzing && (
        <div style={{ marginTop: 14 }}>
          <Callout color={record.status === 'failed' ? '#A63D40' : '#6B7280'}>
            {record.status === 'failed'
              ? (viewAll && record.error ? `This call could not be analyzed: ${record.error}` : 'This call could not be analyzed. It will be retried automatically.')
              : (STATUS_NOTE[record.status] || 'This call has not been analyzed.')}
            {record.note && record.status !== 'failed' ? ` ${record.note}` : ''}
          </Callout>
        </div>
      )}

      {a && (<>
        {a.glance.length > 0 && <><H>At a glance</H><Callout><Bullets items={a.glance} /></Callout></>}

        <H>Follow ups for our side</H>
        <div style={{ display: 'grid', gap: 10 }}>
          <div><div style={{ ...muted, fontWeight: 600, marginBottom: 3 }}>WE OWE THEM</div>
            <Table headers={['Commitment', 'Who', 'When']} rows={a.followUps.weOwe.map((i) => [i.item, i.who, i.when])} empty="No commitments from our side were captured." /></div>
          <div><div style={{ ...muted, fontWeight: 600, marginBottom: 3 }}>THEY ASKED, NOT FULLY ANSWERED</div>
            <Table headers={['Question', 'Who', 'Status']} rows={a.followUps.theyAsked.map((i) => [i.item, i.who, i.status.replace('_', ' ')])} empty="Every question they asked was answered." /></div>
          <div><div style={{ ...muted, fontWeight: 600, marginBottom: 3 }}>OUR FOLLOW UP SHOULD INCLUDE</div>
            <Bullets items={a.followUps.infoNeeded} empty="Nothing specific was identified." /></div>
        </div>

        {record.engagement && (<>
          <H>Engagement score</H>
          <Table headers={['Factor', 'Rating', 'Points', 'Evidence']} rows={record.engagement.factors.map((f) => [f.label, `${f.rating} of 5`, `${f.points} of ${f.weight}`, f.evidence])} />
          <div style={{ ...muted, marginTop: 6 }}>The score is a starting point and has not yet been checked against what happened next (for example, whether a second meeting was booked).</div>
        </>)}

        <H>Sentiment</H>
        <Callout color={bandColor(record.engagement?.band)}><strong>{a.sentiment.verdict}</strong></Callout>
        {a.sentiment.evidence.length > 0 && <div style={{ marginTop: 8 }}><Bullets items={a.sentiment.evidence.map((e) => `${e.label}: ${e.text}`)} /></div>}
        {a.sentiment.bottomLine && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text)', overflowWrap: 'anywhere' }}><strong>Bottom line:</strong> {a.sentiment.bottomLine}</div>}

        <H>Who was on the call</H>
        <Table headers={['Name', 'Role', 'Notes']} rows={a.attendees.map((p) => [p.name, p.role, `${p.notes}${p.spoke ? '' : ' (did not speak)'}`])} empty="Not captured." />
        {a.absentInvitees.length > 0 && <div style={{ marginTop: 8 }}><div style={{ ...muted, fontWeight: 600, marginBottom: 3 }}>INVITED OR MENTIONED, NOT PRESENT</div><Table headers={['Name', 'Role', 'Reason']} rows={a.absentInvitees.map((p) => [p.name, p.role, p.reason])} /></div>}

        <H>The organization</H>
        {a.organization.summary && <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 6, overflowWrap: 'anywhere' }}>{a.organization.summary}</div>}
        <Bullets items={a.organization.facts} empty="Not discussed." />

        <H>Current approach</H>
        {a.currentApproach.summary && <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 6, overflowWrap: 'anywhere' }}>{a.currentApproach.summary}</div>}
        {a.currentApproach.sections.map((s, i) => <div key={i} style={{ marginBottom: 8 }}><div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>{s.heading}</div><Bullets items={s.points} /></div>)}
        {!a.currentApproach.summary && a.currentApproach.sections.length === 0 && <div style={muted}>Not discussed.</div>}

        <H>Gaps and unknowns</H>
        <Bullets items={a.gaps} empty="None identified." />

        <H>Questions asked by the prospect</H>
        <Table headers={['Who', 'Time', 'Question', 'Context or answer']} rows={a.questions.map((q) => [q.who, q.time, q.kind === 'logistics' ? `${q.question} (logistics)` : q.question, q.context])} empty="The prospect asked no questions." />
        {a.notAsked.length > 0 && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}><strong>Not asked:</strong> {a.notAsked.join('; ')}</div>}

        <H>Green flags and red flags</H>
        {a.peakEngagement.topic && <div style={{ marginBottom: 10 }}><Callout color="#2E7D4F"><strong>Peak engagement:</strong> {a.peakEngagement.topic}{a.peakEngagement.time ? ` (about ${a.peakEngagement.time})` : ''}{a.peakEngagement.who ? `, ${a.peakEngagement.who}` : ''}. {a.peakEngagement.evidence}{a.peakEngagement.runnersUp.length ? ` Runners up: ${a.peakEngagement.runnersUp.join('; ')}.` : ''}</Callout></div>}
        <div style={{ ...muted, fontWeight: 600, margin: '4px 0 3px', color: '#2E7D4F' }}>GREEN FLAGS</div>
        <Table headers={['Flag', 'Evidence', 'Strength']} rows={a.greenFlags.map((f) => [f.flag, [f.evidence, f.who && `${f.who}${f.time ? `, ${f.time}` : ''}`].filter(Boolean).join(' · '), f.strength])} empty="None found." />
        <div style={{ ...muted, fontWeight: 600, margin: '10px 0 3px', color: '#A63D40' }}>RED FLAGS</div>
        <Table headers={['Flag', 'Evidence', 'Strength', 'Type']} rows={a.redFlags.map((f) => [f.flag, [f.evidence, f.who && `${f.who}${f.time ? `, ${f.time}` : ''}`].filter(Boolean).join(' · '), f.strength, f.disqualifier])} empty="None found." />

        <H>Problem ownership and stakeholders</H>
        <Callout color="var(--accent)"><strong>Problem owner:</strong> {a.ownership.owner || 'Unclear or unowned'}{a.ownership.onCall === true ? ' (on the call)' : a.ownership.onCall === false ? ' (not on the call)' : ''}{a.ownership.saidBy ? `. Said by ${a.ownership.saidBy}${a.ownership.time ? ` at ${a.ownership.time}` : ''}.` : ''} {a.ownership.notes}</Callout>
        <div style={{ marginTop: 8 }}><Table headers={['Name', 'Title or team', 'Mentioned by', 'Likely role', 'Context']} rows={a.stakeholders.map((s) => [s.name, s.title, `${s.mentionedBy}${s.time ? `, ${s.time}` : ''}`, `${s.role} (${s.roleBasis})`, s.context])} empty="No other stakeholders were mentioned." /></div>
        {a.followUpContacts.length > 0 && <div style={{ marginTop: 8 }}><div style={{ ...muted, fontWeight: 600, marginBottom: 3 }}>OFFERED FOR FOLLOW UP</div><Bullets items={a.followUpContacts.map((c) => `${c.name}${c.title ? `, ${c.title}` : ''}${c.wording ? `: "${c.wording}"` : ''}`)} /></div>}
        {a.missingStakeholders.length > 0 && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}><strong>Missing stakeholders:</strong> {a.missingStakeholders.join('; ')}</div>}

        <H>Suggested questions for the next conversation</H>
        {a.nextQuestions.length ? <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text)', lineHeight: 1.55 }}>{a.nextQuestions.map((q, i) => <li key={i} style={{ marginBottom: 3, overflowWrap: 'anywhere' }}>{q}</li>)}</ol> : <div style={muted}>None suggested.</div>}

        {a.transcriptNotes.length > 0 && <><H>Transcript notes</H><Bullets items={a.transcriptNotes} /></>}
        <div style={{ ...muted, marginTop: 18, fontSize: 11 }}>
          {record.model ? `Analyzed by ${record.model}` : 'Analyzed'}{record.analyzedAt ? ` on ${fmtWhen(record.analyzedAt)}` : ''}{record.usage ? ` · ${record.usage.input_tokens} in, ${record.usage.output_tokens} out tokens` : ''}{record.promptVersion ? ` · rules ${record.promptVersion}` : ''}
        </div>
      </>)}
    </div>
  )
}

export function RecapPanel({ data, viewAll, onOpen }) {
  const r = data.recap
  const open = (id) => () => onOpen && onOpen(id)
  const link = (x) => <button onClick={open(x.callId)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-text)', fontSize: 13, textAlign: 'left', fontWeight: 600 }}>{x.organization || x.title}</button>
  return (
    <div style={{ ...panel, padding: '16px 18px' }}>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)' }}>Week of {fmtWeek(r.weekStart)}</div>
      <div style={{ ...muted, marginTop: 3 }}>{r.released ? 'Final recap, released Friday 4:00 PM Eastern.' : `Week in progress. The recap releases ${fmtWhen(r.releaseAt)} Eastern.`}</div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '14px 0' }}>
        {[['Calls', r.totals.calls], ['Analyzed', r.totals.analyzed], ['Avg engagement', r.totals.avgEngagement ?? 'n/a'], ['Too short', r.totals.tooShort], ['Failed', r.totals.failed]].map(([label, v]) => (
          <div key={label} style={{ ...panel, padding: '8px 14px', minWidth: 90 }}><div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)' }}>{v}</div><div style={muted}>{label}</div></div>
        ))}
        <div style={{ ...panel, padding: '8px 14px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {Object.entries(r.bands).map(([b, c]) => <Pill key={b} color={bandColor(b)}>{b} {c}</Pill>)}
        </div>
      </div>

      <H>Owed to prospects</H>
      {r.owed.length ? r.owed.map((x) => <div key={x.callId} style={{ marginBottom: 10 }}>{link(x)}<span style={muted}> · {x.ownerName} · {fmtWhen(x.started)}</span><Bullets items={x.items} /></div>) : <div style={muted}>Nothing owed from this week's calls.</div>}

      <H>Questions still open</H>
      {r.openQuestions.length ? r.openQuestions.map((x) => <div key={x.callId} style={{ marginBottom: 10 }}>{link(x)}<span style={muted}> · {x.ownerName}</span><Bullets items={x.items} /></div>) : <div style={muted}>No open questions.</div>}

      <H>Needs attention</H>
      {r.needsAttention.length ? <Table headers={['Call', 'Rep', 'Score', 'Why']} rows={r.needsAttention.map((x) => [link(x), x.ownerName, <ScoreBadge key="s" engagement={{ score: x.score, band: x.band }} />, x.topRedFlag || x.verdict])} /> : <div style={muted}>Nothing flagged.</div>}

      <H>Strongest calls</H>
      {r.topCalls.length ? <Table headers={['Call', 'Rep', 'Score', 'Verdict']} rows={r.topCalls.map((x) => [link(x), x.ownerName, <ScoreBadge key="s" engagement={{ score: x.score, band: x.band }} />, x.verdict])} /> : <div style={muted}>No analyzed calls yet.</div>}

      {viewAll && r.byRep && (<><H>By rep</H><Table headers={['Rep', 'Calls', 'Avg engagement', 'Items owed']} rows={r.byRep.map((x) => [x.ownerName, x.calls, x.avgEngagement ?? 'n/a', x.owedCount])} /></>)}
    </div>
  )
}

function StatusPanel({ data, onBackfill, onPoll, busy, notice, backfillDays = 7, onBackfillDays = () => {}, coverage = null, coverageDays = 14, onCoverageDays = () => {}, onCoverage = () => {}, onPull = () => {} }) {
  const c = data.config || {}
  const yes = (v) => <Pill color={v ? '#2E7D4F' : '#A63D40'}>{v ? 'set' : 'MISSING'}</Pill>
  return (
    <div style={{ ...panel, padding: '16px 18px' }}>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>Pipeline status</div>
      <H>Settings in Netlify</H>
      <Table headers={['Setting', 'State']} rows={[['Gong key, secret and base URL', yes(c.gong)], ['Anthropic key', yes(c.anthropic)], ['DEBRIEF_INTERNAL_SECRET', yes(c.internalSecret)], ['APP_URL', yes(c.appUrl)], ['Azure storage', yes(c.storage)], ['Model', c.model || 'unknown']]} />
      <H>Poller</H>
      <Table headers={['', '']} rows={[
        ['Last run', data.poll.lastPollAt ? fmtWhen(data.poll.lastPollAt) : 'has not run yet'],
        ['Last error', data.poll.lastPollError || 'none'],
        ['Last pass', data.poll.counts ? `${data.poll.counts.listed} listed, ${data.poll.counts.external} with an outside participant (${data.poll.counts.done ?? data.poll.counts.external - data.poll.counts.waiting} done, ${data.poll.counts.waiting} waiting), ${data.poll.counts.triggered} started, ${data.poll.counts.deferred} deferred` : 'n/a'],
        ['Waiting on a transcript', data.poll.waitingOnTranscript],
        ['Recent requests to the poller', (data.poll.ticks && data.poll.ticks.length) ? data.poll.ticks.slice(0, 5).map((t) => `${fmtWhen(t.at)} (${friendlyCaller(t.caller)})`).join(', ') : 'none yet'],
        ['Backfill', data.poll.backfillFrom ? `running from ${fmtWhen(data.poll.backfillFrom)}` : 'not running'],
        ['People listed from Gong', data.people ? (data.people.error ? `could not be read: ${data.people.error}` : data.people.fetchedAt ? `${data.people.count} active, updated ${fmtWhen(data.people.fetchedAt)}` : 'not read yet') : 'n/a'],
      ]} />
      <H>Coverage check against Gong</H>
      <div style={muted}>Compares what Gong has with what has been pulled in, rep by rep, so you can see who is missing and why. It only reads: nothing is analyzed or changed.</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
        <select aria-label="Days to check" value={coverageDays} onChange={(e) => onCoverageDays(Number(e.target.value))} style={selStyle}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option></select>
        <button disabled={busy || (coverage && coverage.loading)} onClick={onCoverage} style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer' }}>{coverage && coverage.loading ? 'Checking Gong...' : 'Check Gong'}</button>
      </div>
      {coverage && coverage.error && <Callout color="#A63D40">{coverage.error}</Callout>}
      {coverage && coverage.totals && (() => { const t = coverage.totals; return (
        <div data-coverage>
          <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.55, marginBottom: 8 }}>
            Gong has <strong>{t.calls}</strong> calls in the last {coverage.days} days. <strong>{t.outside + t.likely}</strong> have an outside participant{t.likely ? ` (${t.likely} where Gong could not identify the other person)` : ''}, and <strong>{t.internal}</strong> were left out as internal only. Of the outside calls: {t.analyzed} analyzed, {t.tooShort} too short, {t.noTranscript} with no transcript, {t.failed} failed, <strong>{t.waiting} waiting</strong>.
          </div>
          <Table headers={['Rep', 'In Gong', 'Outside', 'Not identified', 'Internal only', 'Analyzed', 'Too short', 'Waiting']} rows={coverage.byHost.map((h) => [<span key="n">{h.name}{h.email ? <div style={{ ...muted, fontSize: 11 }}>{h.email}</div> : null}</span>, h.calls, h.outside, h.likely, h.internal, h.analyzed, h.tooShort, h.waiting])} />
          {Array.isArray(coverage.noCalls) && (coverage.noCalls.length > 0
            ? <div data-no-calls style={{ ...muted, marginTop: 8, lineHeight: 1.5 }}><strong>People Gong lists as active with no calls in these {coverage.days} days:</strong> {coverage.noCalls.map((x) => x.name).join(', ')}. If one of them should have calls, check that their calls are being recorded in Gong.</div>
            : <div data-no-calls style={{ ...muted, marginTop: 8 }}>Everyone Gong lists as active has at least one call in these {coverage.days} days.</div>)}
          {coverage.noCalls === null && <div data-no-calls style={{ ...muted, marginTop: 8 }}>Gong's list of people could not be read, so people with no calls are not shown.</div>}
          {t.waiting > 0 && (
            <div style={{ marginTop: 10 }}>
              <button disabled={busy} onClick={onPull} style={{ fontSize: 12, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--accent-light)', color: 'var(--text)', cursor: 'pointer' }}>Pull in {t.waiting} waiting {t.waiting === 1 ? 'call' : 'calls'} (about ${coverage.estimatedCost.toFixed(2)})</button>
              <div style={{ ...muted, marginTop: 4 }}>A rough estimate at about 17 cents for each call that is analyzed; calls too short to analyze cost nothing. They are analyzed three at a time, every 15 minutes, so a large batch takes a while. Run the check again later to see it shrink.</div>
            </div>
          )}
          {coverage.skippedExamples.length > 0 && (<>
            <H>Calls left out as internal only</H>
            <Table headers={['Call', 'Rep', 'When', 'How Gong labeled it']} rows={coverage.skippedExamples.map((x) => [x.title, x.host, fmtWhen(x.started), `${x.scope ? `scope ${x.scope}` : 'no scope given'}${x.labels ? `: ${x.labels.internal} ours, ${x.labels.external} outside, ${x.labels.unknown} not identified` : ''}`])} />
            <div style={{ ...muted, marginTop: 4 }}>Gong labeled everyone on these as Care Continuity. If one of them was really a call with a prospect, that is worth knowing.</div>
          </>)}
        </div>) })()}
      <H>Calls, this week and last</H>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{Object.entries(data.byStatus).map(([s, n]) => <Pill key={s} color={s === 'failed' ? '#A63D40' : s === 'complete' ? '#2E7D4F' : '#6B7280'}>{s.replace('_', ' ')} {n}</Pill>)}{!Object.keys(data.byStatus).length && <span style={muted}>No calls yet.</span>}</div>
      {data.recentFailures.length > 0 && <><H>Recent failures</H><Table headers={['Call', 'Attempts', 'Reason']} rows={data.recentFailures.map((f) => [f.title || f.callId, f.attempts, f.error])} /></>}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={onPoll} style={{ fontSize: 12, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: busy ? 'not-allowed' : 'pointer' }}>{busy ? 'Working...' : 'Check Gong now'}</button>
          <select aria-label="Days to analyze" value={backfillDays} onChange={(e) => onBackfillDays(Number(e.target.value))} style={selStyle}><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={60}>60 days</option></select>
          <button disabled={busy} onClick={() => onBackfill(backfillDays)} style={{ fontSize: 12, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: busy ? 'not-allowed' : 'pointer' }}>Analyze the past {backfillDays} days of calls</button>
        </div>
        <div style={{ ...muted, marginTop: 4 }}>Both run a check straight away and report what they found, and start up to eight calls at once. The scheduled check then continues every 15 minutes, three calls at a time. If "Recent requests to the poller" never shows the Netlify scheduler, the schedule is not running.</div>
        {notice && <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-secondary)', fontSize: 12.5, color: 'var(--text)', overflowWrap: 'anywhere' }}>{notice}</div>}
      </div>
    </div>
  )
}

// Who asked the poller to run: Netlify's scheduler, a person in a browser, or the admin button.
export function friendlyCaller(c) {
  const t = String(c || '')
  if (/clockwork|scheduler/i.test(t)) return 'Netlify scheduler' // production reports "Netlify Functions Scheduler"
  if (/admin/i.test(t)) return 'admin button'
  if (/mozilla|chrome|safari|firefox|edge/i.test(t)) return 'a web browser'
  return t || 'unknown'
}

// What a "check Gong now" pass found, in plain words.
export function describePoll(p, lead = '') {
  const say = (t) => `${lead ? `${lead} ` : ''}${t}`
  if (!p) return say('Done.')
  if (p.error) return say(`The check against Gong failed: ${p.error}`)
  if (p.slow) return say('Gong is taking a while to answer. The scheduled check will pick it up within 15 minutes.')
  if (p.skipped) return say('A check ran a moment ago, so nothing new was started.')
  const errs = p.triggerErrors && p.triggerErrors.length ? ` ${p.triggerErrors.length} could not be started: ${p.triggerErrors[0]}` : ''
  if (!p.waiting) return say(`Gong has ${p.external} calls with an outside participant in that window, and all of them are already analyzed or counted.${errs}`)
  const doneN = p.done ?? p.external - p.waiting
  return say(`Gong has ${p.external} calls with an outside participant in that window: ${doneN} already done and ${p.waiting} waiting. ${p.triggered} started now, ${p.deferred} queued for the next passes (three at a time every 15 minutes; pressing Check Gong now starts up to eight at once).${errs}`)
}

export default function DebriefsView({ getToken, onUnreadChange, refreshMs = 8000, listRefreshMs = 30000 }) {
  const [days, setDays] = useState(14) // a real "last N days", counted from each call's start
  const [list, setList] = useState(null)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('calls') // calls | recap | status
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [recapWeek, setRecapWeek] = useState(null)
  const [recapData, setRecapData] = useState(null)
  const [statusData, setStatusData] = useState(null)
  const [repFilter, setRepFilter] = useState('')
  const [bandFilter, setBandFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const [statusTick, setStatusTick] = useState(0)
  const [reanalysis, setReanalysis] = useState(null) // { id, since, prev } while a re-analysis is running
  const [coverage, setCoverage] = useState(null)
  const [coverageDays, setCoverageDays] = useState(14)
  const [backfillDays, setBackfillDays] = useState(7)

  const api = useCallback((path, options) => apiFetch(path, getToken, options), [getToken])
  const pushUnread = useCallback((l) => onUnreadChange && onUnreadChange((l.unreadIds?.length || 0) + (l.recap?.unread ? 1 : 0)), [onUnreadChange])

  const loadList = useCallback(async () => {
    try {
      const l = await api(`/api/debriefs/list?days=${days}`)
      setList(l); setError(null); pushUnread(l)
      setRecapWeek((w) => w || l.recap.week)
    } catch (e) { setError(e.message) }
  }, [api, days, pushUnread])
  useEffect(() => { loadList() }, [loadList])
  // New results appear on their own while you are looking at the list.
  useEffect(() => {
    if (mode !== 'calls') return undefined
    const t = setInterval(loadList, listRefreshMs)
    return () => clearInterval(t)
  }, [mode, loadList, listRefreshMs])

  const markSeen = useCallback((ids) => {
    api('/api/debriefs/seen', { method: 'POST', body: JSON.stringify({ ids }) }).catch(() => {})
    setList((cur) => {
      if (!cur) return cur
      const next = { ...cur, unreadIds: cur.unreadIds.filter((i) => !ids.includes(i)), recap: ids.some((i) => i.startsWith('recap:')) ? { ...cur.recap, unread: false } : cur.recap }
      pushUnread(next)
      return next
    })
  }, [api, pushUnread])

  const openCall = useCallback(async (id) => {
    setMode('calls'); setSelectedId(id); setDetail(null); setDetailError(null); setNotice(null)
    try {
      const r = await api(`/api/debriefs/call/${encodeURIComponent(id)}`)
      setDetail(r.record)
      if (list?.unreadIds?.includes(id)) markSeen([id])
    } catch (e) { setDetailError(e.message) }
  }, [api, list, markSeen])

  useEffect(() => {
    if (mode !== 'recap' || !recapWeek) return
    let alive = true
    const rep = repFilter && repFilter.includes('@') ? repFilter : (repFilter && list ? (list.items.find((i) => repKeyOf(i) === repFilter)?.ownerEmail || '') : '')
    api(`/api/debriefs/recap?week=${recapWeek}${rep ? `&rep=${encodeURIComponent(rep)}` : ''}`).then((r) => {
      if (!alive) return
      setRecapData(r)
      if (r.unread) markSeen([`recap:${recapWeek}`])
    }).catch((e) => alive && setError(e.message))
    return () => { alive = false }
  }, [mode, recapWeek, repFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode !== 'status') return
    let alive = true
    api('/api/debriefs/status').then((r) => alive && setStatusData(r)).catch((e) => alive && setError(e.message))
    return () => { alive = false }
  }, [mode, statusTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const startReanalyze = async (record) => {
    setBusy(true); setNotice(null)
    try {
      await api('/api/debriefs/reanalyze', { method: 'POST', body: JSON.stringify({ callId: record.callId }) })
      setReanalysis({ id: record.callId, since: Date.now(), prev: record.analyzedAt || record.failedAt || null })
    } catch (e) { setNotice(e.message) } finally { setBusy(false) }
  }
  useEffect(() => {
    if (!reanalysis) return undefined
    let alive = true
    const check = async () => {
      try {
        const rec = (await api(`/api/debriefs/call/${encodeURIComponent(reanalysis.id)}`)).record
        const stamp = rec.analyzedAt || rec.failedAt || null
        if (!alive) return
        if (stamp && stamp !== reanalysis.prev) {
          setDetail((cur) => (cur && cur.callId === rec.callId ? rec : cur))
          loadList(); setReanalysis(null)
          setNotice(rec.status === 'complete' ? 'Re-analysis finished.' : 'Re-analysis ended with an error. The reason is shown on the call.')
        } else if (Date.now() - reanalysis.since > 5 * 60e3) {
          setReanalysis(null); setNotice('Still working. Check back in a minute or two.')
        }
      } catch { /* keep trying until the time is up */ }
    }
    const t = setInterval(check, refreshMs)
    return () => { alive = false; clearInterval(t) }
  }, [reanalysis, api, loadList, refreshMs])

  // message is text, or a function of the server's answer
  const post = async (path, body, message) => {
    setBusy(true); setNotice(null)
    try {
      const r = await api(path, { method: 'POST', body: JSON.stringify(body) })
      setNotice(typeof message === 'function' ? message(r) : message)
      setStatusTick((t) => t + 1)
    } catch (e) { setNotice(e.message) } finally { setBusy(false) }
  }

  // The server sends everyone who has had an outside call, including reps with no analyzed call yet. (If an older
  // server answers without that list, fall back to whoever owns a call on screen.)
  const reps = useMemo(() => {
    if (list?.reps) return list.reps
    const m = new Map()
    for (const i of list?.items || []) { const k = repKeyOf(i); if (k && !m.has(k)) m.set(k, { key: k, name: i.ownerName || i.ownerEmail, analyzed: (list.items || []).filter((x) => repKeyOf(x) === k && x.status === 'complete').length }) }
    return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }, [list])
  const items = useMemo(() => (list?.items || []).filter((i) => (!repFilter || repKeyOf(i) === repFilter) && (!bandFilter || i.engagement?.band === bandFilter)), [list, repFilter, bandFilter])
  const emptyWeeks = useMemo(() => (list?.weekCounts ? (list.weeks || []).filter((w) => !list.weekCounts[w]) : []), [list])
  const checkCoverage = async () => {
    setCoverage({ loading: true })
    try { setCoverage(await api(`/api/debriefs/coverage?days=${coverageDays}`)) } catch (e) { setCoverage({ error: e.message }) }
  }
  const viewAll = !!list?.viewAll
  const sel = { fontSize: 12, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }
  const tabBtn = (key, label, badge) => (
    <button key={key} onClick={() => setMode(key)} style={{ fontSize: 13, padding: '6px 14px', borderRadius: 8, cursor: 'pointer', border: '1px solid ' + (mode === key ? 'var(--accent)' : 'var(--border)'), background: mode === key ? 'var(--accent-light)' : 'transparent', color: mode === key ? 'var(--accent-text)' : 'var(--text-secondary)', fontWeight: mode === key ? 600 : 400 }}>
      {label}{badge ? <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 600, background: 'var(--red)', color: '#fff', borderRadius: 10, padding: '1px 6px' }}>new</span> : null}
    </button>
  )

  return (
    <div>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .debrief-print-area, .debrief-print-area * { visibility: visible; }
          .debrief-print-area { position: absolute; left: 0; top: 0; width: 100%; border: none !important;
            --text: #111; --text-secondary: #333; --text-tertiary: #555; --bg-panel: #fff; --bg-secondary: #f3f4f6; --border: #ccc; --accent-text: #1F3A5F; }
          .debrief-no-print { display: none !important; }
        }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', marginRight: 6 }}>Call debriefs</div>
        {tabBtn('calls', 'Calls', list?.unreadIds?.length)}
        {tabBtn('recap', 'Weekly recap', list?.recap?.unread)}
        {viewAll && tabBtn('status', 'Status')}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {mode === 'calls' && <select aria-label="Date range" value={days} onChange={(e) => setDays(Number(e.target.value))} style={sel}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option><option value={60}>Last 60 days</option></select>}
          {mode === 'recap' && list && <select value={recapWeek || ''} onChange={(e) => setRecapWeek(e.target.value)} style={sel}>{list.weeks.map((w) => <option key={w} value={w}>Week of {fmtWeek(w)}</option>)}</select>}
          {viewAll && mode !== 'status' && <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} style={sel}><option value="">All reps</option>{reps.map((r) => <option key={r.key} value={r.key}>{r.name} ({r.analyzed})</option>)}</select>}
          {mode === 'calls' && <select value={bandFilter} onChange={(e) => setBandFilter(e.target.value)} style={sel}><option value="">All scores</option><option>High</option><option>Medium</option><option>Low</option><option>Very low</option></select>}
        </div>
      </div>

      {error && <div style={{ ...panel, padding: 12, color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {list && mode === 'calls' && list.summary && (() => { const m = list.summary; const parts = [`${m.complete} analyzed`, m.tooShort ? `${m.tooShort} too short` : null, m.noTranscript ? `${m.noTranscript} with no transcript` : null, m.failed ? `${m.failed} failed` : null, m.skipped ? `${m.skipped} skipped` : null, m.waiting ? `${m.waiting} waiting to be analyzed` : null].filter(Boolean); return (
        <div data-summary style={{ fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>
          <strong>{m.total} {m.total === 1 ? 'call' : 'calls'}</strong>{list.days ? ` in the last ${list.days} days` : ' in these weeks'}: {parts.join(', ')}.
          {m.waiting > 0 && <div data-waiting-help style={{ ...muted, marginTop: 2 }}>Waiting calls were found in Gong and are analyzed three at a time, every 15 minutes. If Gong has not produced a transcript yet, Cipher checks again less often each time.{viewAll ? ' To start more now, open Status and press Check Gong now (it starts up to eight).' : ''}</div>}
        </div>) })()}
      {list && mode === 'calls' && list.weekCounts && (
        <div data-week-counts style={{ ...muted, marginBottom: 10 }}>
          Calls pulled in, by week: {(list.weeks || []).map((w, i) => <span key={w}>{i ? ' · ' : ''}{fmtWeek(w)}: {list.weekCounts[w] ?? 0}</span>)}
          {emptyWeeks.length > 0 && (
            <div data-empty-weeks style={{ marginTop: 3 }}>
              {viewAll
                ? <>Nothing has been pulled in for the {emptyWeeks.length > 1 ? 'weeks' : 'week'} of {emptyWeeks.map(fmtWeek).join(', ')}. Calls older than about a week are only pulled in when you ask. <button onClick={() => setMode('status')} style={{ ...muted, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-text)', textDecoration: 'underline' }}>Open Status to check Gong and pull them in.</button></>
                : <>No calls to show for the {emptyWeeks.length > 1 ? 'weeks' : 'week'} of {emptyWeeks.map(fmtWeek).join(', ')}.</>}
            </div>
          )}
        </div>
      )}
      {notice && mode !== 'status' && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>{notice}</div>}
      {!list && !error && <div style={muted}>Loading...</div>}

      {list && mode === 'calls' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 420px) 1fr', gap: 14, alignItems: 'start' }}>
          <div style={{ display: 'grid', gap: 8 }}>
            {items.length === 0 && <div style={{ ...panel, padding: 14, ...muted }}>{list.items.length ? 'No calls match these filters.' : 'No analyzed calls yet. Calls with an outside participant appear here once they have been analyzed.'}</div>}
            {items.map((it) => <CallCard key={it.callId} item={it} selected={it.callId === selectedId} unread={list.unreadIds.includes(it.callId)} onClick={() => openCall(it.callId)} />)}
          </div>
          <div>
            {!selectedId && <div style={{ ...panel, padding: 18, ...muted }}>Select a call to see its debrief.</div>}
            {selectedId && !detail && !detailError && <div style={muted}>Loading debrief...</div>}
            {detailError && <div style={{ ...panel, padding: 14, color: 'var(--red)', fontSize: 13 }}>{detailError}</div>}
            {detail && <DebriefDetail record={detail} viewAll={viewAll} busy={busy} reanalyzing={reanalysis?.id === detail.callId} onReanalyze={() => startReanalyze(detail)} />}
          </div>
        </div>
      )}

      {list && mode === 'recap' && (recapData ? <RecapPanel data={recapData} viewAll={viewAll} onOpen={openCall} /> : <div style={muted}>Loading recap...</div>)}
      {list && mode === 'status' && viewAll && (statusData ? <StatusPanel data={statusData} busy={busy} notice={notice} backfillDays={backfillDays} onBackfillDays={setBackfillDays} onBackfill={(days) => post('/api/debriefs/backfill', { days }, (r) => describePoll(r.poll, `Backfill of ${r.days} days saved.`))} coverage={coverage} coverageDays={coverageDays} onCoverageDays={setCoverageDays} onCoverage={checkCoverage} onPull={() => post('/api/debriefs/backfill', { days: coverageDays }, (r) => describePoll(r.poll, `Pulling in the last ${r.days} days.`))} onPoll={() => post('/api/debriefs/poll', {}, (r) => describePoll(r.poll))} /> : <div style={muted}>Loading status...</div>)}
    </div>
  )
}
