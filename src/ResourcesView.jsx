import { useState, useEffect, useMemo } from 'react'
import { apiFetch } from './api'

// ResourcesView.jsx — Cipher's read-only window into the same content
// library the Onboarding tool authors into (Azure Blob container
// "onboarding-cc"). Block rendering logic (link/file/text/video/table,
// folder grouping, search) is ported from Onboarding's own
// ContentSection.jsx — same shapes, same behavior — but rebuilt with
// Cipher's inline-style + CSS-variable convention instead of Tailwind,
// since Cipher doesn't have Tailwind configured.
//
// One deliberate simplification from the source: Onboarding's search can
// look *inside* uploaded .docx files by extracting their text client-side
// (via the `mammoth` library). That's left out here — Resources is meant
// for consuming already-organized reference links and short docs, not
// searching inside long uploaded files, and skipping it avoids adding a
// new dependency for what's likely a rare case in these three specific
// sections. Search still matches on label/description/url/fileName.
//
// NOTE ON THE FETCH PATH: this calls `/.netlify/functions/get-resources`
// directly (Netlify's default function path) rather than `/api/hubspot/...`
// like the rest of Cipher, since get-resources.js is a separate function,
// not a route inside hubspot.js. If there's already a broader `/api/*`
// redirect configured in netlify.toml, this could be simplified to
// `/api/get-resources` to match the rest of the app's convention — I
// didn't have netlify.toml in front of me to confirm one way or the other.

const SECTIONS = [
  { key: 'gong-library', label: 'Insightful Gong Recordings' },
  { key: 'app-walkthroughs', label: 'Tools We Use' },
  { key: 'intranet', label: 'Valuable Links' },
]

export default function ResourcesView({ getToken }) {
  const [activeSection, setActiveSection] = useState(SECTIONS[0].key)
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [collapsedPaths, setCollapsedPaths] = useState(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setQuery('')
    apiFetch(`/.netlify/functions/get-resources?section=${activeSection}`, getToken)
      .then(data => { if (!cancelled) setContent(data) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [activeSection, getToken])

  const filteredBlocks = useMemo(() => {
    if (!content?.blocks) return []
    const q = query.trim().toLowerCase()
    if (!q) return content.blocks
    return content.blocks.filter(b => {
      const haystack = [b.text, b.label, b.url, b.description, b.fileName].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [content, query])

  const folderTree = useMemo(() => {
    if (query.trim()) return null
    return buildFolderTree(content?.blocks || [])
  }, [content, query])

  const toggleFolder = (path) => {
    setCollapsedPaths(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  const hasContent = content?.blocks?.length > 0

  return (
    <div style={{ padding: '22px 26px', background: 'var(--bg-panel)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-soft)', maxWidth: 860 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 22, borderBottom: '1px solid var(--border)', paddingBottom: 14 }}>
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => setActiveSection(s.key)}
            style={{
              padding: '8px 14px', borderRadius: 'var(--radius)', fontSize: 12.5, cursor: 'pointer',
              background: activeSection === s.key ? 'var(--nav-resources)' : 'var(--bg-secondary)',
              color: activeSection === s.key ? '#fff' : 'var(--text-secondary)',
              border: '1px solid ' + (activeSection === s.key ? 'var(--nav-resources)' : 'var(--border)'),
            }}>
            {s.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ background: 'var(--red-light)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 16 }}>
          Couldn't load this section: {error}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Loading…</div>
      ) : !error && (
        <>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 14 }}>{content?.title}</h2>

          {hasContent && (
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <input value={query} onChange={e => setQuery(e.target.value)}
                placeholder={`Search ${(content?.title || '').toLowerCase()}...`}
                style={{ width: '100%', padding: '9px 14px', borderRadius: 'var(--radius)', border: '1px solid var(--border-strong)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13 }} />
            </div>
          )}

          {!hasContent ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius)', color: 'var(--text-tertiary)', fontSize: 13 }}>
              Content for this section is on the way.
            </div>
          ) : query.trim() ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredBlocks.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No matches for "{query}".</div>
              ) : (
                filteredBlocks.map((b, i) => <ContentBlock key={b.id || i} block={b} />)
              )}
            </div>
          ) : (
            <FolderContents node={folderTree} path="" collapsedPaths={collapsedPaths} onToggle={toggleFolder} />
          )}
        </>
      )}
    </div>
  )
}

// Groups blocks by their optional `folder` field (slash-separated for
// nesting, e.g. "Discovery Calls/Q3") — same grouping logic as Onboarding.
function buildFolderTree(blocks) {
  const root = { name: null, folders: {}, items: [] }
  blocks.forEach(b => {
    const path = (b.folder || '').split('/').map(p => p.trim()).filter(Boolean)
    let node = root
    for (const part of path) {
      if (!node.folders[part]) node.folders[part] = { name: part, folders: {}, items: [] }
      node = node.folders[part]
    }
    node.items.push(b)
  })
  return root
}

function FolderContents({ node, path, collapsedPaths, onToggle }) {
  if (!node) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {node.items.map((b, i) => <ContentBlock key={b.id || i} block={b} />)}

      {Object.keys(node.folders).map(name => {
        const child = node.folders[name]
        const fullPath = path ? `${path}/${name}` : name
        const expanded = !collapsedPaths.has(fullPath)
        return (
          <div key={name}>
            <button onClick={() => onToggle(fullPath)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
              <span style={{ display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
              {name}
            </button>
            {expanded && (
              <div style={{ paddingLeft: 18, marginTop: 6 }}>
                <FolderContents node={child} path={fullPath} collapsedPaths={collapsedPaths} onToggle={onToggle} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ContentBlock({ block }) {
  if (block.type === 'text') {
    return <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{block.text}</p>
  }

  if (block.type === 'link') {
    let domain = ''
    try { domain = new URL(block.url).hostname } catch {}
    return (
      <a href={block.url} target="_blank" rel="noreferrer" style={{
        display: 'flex', gap: 12, padding: 14, background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', textDecoration: 'none',
      }}>
        <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {block.thumbnail ? (
            <img src={block.thumbnail} alt="" style={{ width: 22, height: 22, objectFit: 'contain' }} onError={e => { e.target.style.display = 'none' }} />
          ) : <LinkIcon />}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>{block.label || block.url}</div>
          {block.description && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{block.description}</div>}
          {domain && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{domain}</div>}
        </div>
      </a>
    )
  }

  if (block.type === 'file') {
    const displayLabel = block.label && block.label !== block.fileName ? block.label : (block.fileName || 'Document')
    const downloadUrl = block.url ? `${block.url}&download=1` : null
    return (
      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 14, display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <FileIcon />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{displayLabel}</div>
          {block.description && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{block.description}</div>}
        </div>
        {downloadUrl && (
          <a href={downloadUrl} style={{ fontSize: 11.5, color: 'var(--accent)', textDecoration: 'none', fontWeight: 600, flexShrink: 0 }}>
            Download
          </a>
        )}
      </div>
    )
  }

  if (block.type === 'video') {
    return (
      <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0, borderRadius: 'var(--radius)', overflow: 'hidden', background: '#000' }}>
        <iframe src={block.embedUrl} title={block.label || 'video'} allowFullScreen
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }} />
      </div>
    )
  }

  if (block.type === 'table') {
    return (
      <div>
        {block.title && (
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 6 }}>
            {block.title}
          </div>
        )}
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {(block.rows || []).map((row, i) => (
            <div key={i} style={{ padding: '12px 14px', borderBottom: i !== block.rows.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{row.label}</div>
              {row.sublabel && <div style={{ fontSize: 11.5, color: 'var(--accent)', fontWeight: 600, marginTop: 2 }}>{row.sublabel}</div>}
              {row.description && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>{row.description}</div>}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return null
}

function LinkIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2"><path d="M10 13a5 5 0 007.07 0l2.83-2.83a5 5 0 00-7.07-7.07L11.5 4.5"/><path d="M14 11a5 5 0 00-7.07 0L4.1 13.83a5 5 0 007.07 7.07l1.36-1.36"/></svg>
}
function FileIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
}
