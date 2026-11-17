// netlify/functions/utils/intelFeed.js
//
// The rules that turn one news item into the prompt pack's four part card, file it under a service line and an event
// class, and decide whether a deal is still one to watch. Plain keyword rules, so every answer can be explained. Nothing
// here calls HubSpot or an AI, and nothing here invents a fact: where a card has no product, contact or opening line from
// its source, the rule fills the gap and the card says it is suggested.

export const SERVICE_LINES = [
  { key: 'ed', label: 'ED and urgent care' }, { key: 'cardio', label: 'Cardiology' }, { key: 'ortho', label: 'Orthopedics' }, { key: 'neuro', label: 'Neurology' },
  { key: 'gi', label: 'GI' }, { key: 'derm', label: 'Dermatology' }, { key: 'onc', label: 'Oncology' }, { key: 'womens', label: "Women's and maternity" },
  { key: 'behavioral', label: 'Behavioral health' }, { key: 'peds', label: 'Pediatrics' },
]
const LINE_RULES = {
  cardio: /cardi|heart|vascular|cath lab/i, ortho: /orthop|joint replacement|spine|musculoskeletal|sports medicine/i, neuro: /neuro|stroke|brain|epilep/i,
  gi: /gastro|digestive|endoscop|colorectal|\bgi\b/i, derm: /dermat|skin care|skin cancer/i, onc: /oncolog|cancer|tumor|infusion center/i,
  womens: /maternity|obstetric|labor and delivery|women's|birthing|ob-?gyn/i, behavioral: /behavioral|psychiatr|mental health|substance use|addiction/i, peds: /pediatric|children's|childrens|neonatal|nicu/i,
}

export function serviceLinesOf(item) {
  const text = `${item.title || ''} ${item.whatHappened || ''}`
  const keys = new Set()
  if (item.ed || item.type === 'ed_driver' || /emergency (department|room|care|services)|urgent care|freestanding/i.test(text) || /\b(ED|ER)\b/.test(text)) keys.add('ed')
  for (const [k, re] of Object.entries(LINE_RULES)) if (re.test(text)) keys.add(k)
  return SERVICE_LINES.map((l) => l.key).filter((k) => keys.has(k))
}

// ---------- what kind of event, and is it still pending ----------

export const CLASS_LABEL = { deal: 'Deal', closure: 'Closure', new_site: 'New site', ed_flow: 'ED volume', leadership: 'Leadership', growth: 'Growth', policy: 'Policy' }
const DEAL = /acqui|merge|affiliat|take ?over|takes over|took over|\bjoins?\b|joined|\bsells?\b|\bsold\b|sale of|purchase|absorb|combine|letter of intent|definitive agreement|agreement to|\bdeal\b/i
const CLOSURE = /\bclos(e|es|ed|ing|ure)\b|suspend|shut|diversion|bypass|ends? inpatient|stops? (accepting|providing)/i
const NEW_SITE = /urgent care|freestanding|\bopens?\b|\bopening\b|new (emergency|er|ed|hospital)/i

// News about a law, rule or payment is policy even when it is filed under Emergency dept, so it stays off the competitive timeline.
const POLICY_STATUS = /enacted|legislature|rule|introduced|pre-?filed|adopted|lawsuit|court|in effect|expiring|awarded/i
const POLICY_TEXT = /\b(law|bill|act|legislat\w*|tax credit|payment rates?|medicaid|cms|regulation|treat in place|treat-in-place)\b|\b(hb|sb)\s?\d+/i

export function classOf(item) {
  if (item.origin === 'account-intelligence') return item.cat === 'mna' ? 'deal' : item.cat === 'ed' ? 'new_site' : item.cat === 'lead' ? 'leadership' : 'growth'
  const t = String(item.title || '')
  if (POLICY_STATUS.test(String(item.dealStatus || ''))) return 'policy'
  if (item.type === 'ed_driver') return CLOSURE.test(t) ? 'closure' : NEW_SITE.test(t) || /break(s)? ground|tops? off|expansion|relocat/i.test(t) ? 'new_site' : POLICY_TEXT.test(t) ? 'policy' : 'ed_flow'
  if (item.type === 'competitive') return DEAL.test(t) ? 'deal' : CLOSURE.test(t) ? 'closure' : NEW_SITE.test(t) ? 'new_site' : 'deal'
  return 'policy'
}

// A deal or a planned site is Watch while it is pending, and Closed once it has happened. A closure announced for later is Watch
// too. Anything the words do not settle is left as Reported rather than guessed.
export function phaseOf(item) {
  const cls = classOf(item)
  if (cls !== 'deal' && cls !== 'new_site' && cls !== 'closure') return 'event'
  const status = String(item.dealStatus || ''), t = String(item.title || '')
  if (cls === 'closure') return /\b(will|plans? to|to close|propos\w*|scheduled|intends?)\b/i.test(t) || /announce|pending|propos/i.test(status) ? 'watch' : 'event'
  if (/complet|closed/i.test(status)) return 'closed'
  if (/pending|announce|definitive|propos|agreement|schedul|verify|filed|approv|under construction/i.test(status)) return 'watch'
  if (/\b(completes?|completed|finali[sz]es?|finali[sz]ed|opens?|opened|took over|takes over|joined|acquires|acquired)\b/i.test(t)) return 'closed'
  if (/\b(to (acquire|join|merge|sell|add|take over|open|build|buy)|agrees?|agreed|plans?|will|signs?|signed|letter of intent|expected|propos\w*|seeks?|announces?|breaks? ground|tops? off|relocating|expansion)\b/i.test(t)) return 'watch'
  return 'event'
}
export const PHASE_LABEL = { watch: 'Watch', closed: 'Closed', event: 'Reported' }

// ---------- the four part card ----------

const ED = 'ED Connect', REF = 'Referral IQ', READ = 'Readmission IQ', PATH = 'CarePath IQ'
// From the news type to product table carried over from Account Intelligence, with the pack's own product descriptions for
// the kinds it did not cover (market wide leakage and out of network visits are CarePath IQ).
const PRODUCTS = {
  alert_ed: [ED, READ], alert_mna: [ED, REF], alert_lead: [ED, null], alert_growth: [REF, PATH],
  deal: [ED, REF], new_site: [REF, PATH], closure: [ED, READ], ed_flow: [ED, READ], readmissions: [READ, ED], policy: [PATH, REF],
}
export function productsFor(item) {
  if (item.leadProduct) return { lead: item.leadProduct, secondary: item.secondaryProduct || null, derived: false }
  const cls = classOf(item)
  const key = item.origin === 'account-intelligence' ? `alert_${item.cat === 'mna' ? 'mna' : item.cat === 'ed' ? 'ed' : item.cat === 'lead' ? 'lead' : 'growth'}` : item.type === 'readmissions' ? 'readmissions' : cls
  const [lead, secondary] = PRODUCTS[key] || PRODUCTS.policy
  return { lead, secondary, derived: true }
}

const TITLES = {
  deal: [['VP Strategy/Growth', 'Usually owns integration and network decisions after a deal'], ['VP Access', 'Usually owns referral and scheduling access across the combined system']],
  new_site: [['VP Strategy/Growth', 'Usually owns market and growth plans'], ['Service Line Director', 'Usually owns the service line the new site competes in']],
  closure: [['ED Medical Director/Chair', 'Leads the ED that may take on the extra volume'], ['Director of Care Management', 'Usually owns follow up for ED patients after discharge']],
  ed_flow: [['ED Medical Director/Chair', 'Leads the ED where the volume lands'], ['Director of Care Management', 'Usually owns follow up for ED patients after discharge']],
  readmissions: [['CNO', 'Usually owns nursing and discharge quality'], ['Director of Care Management', 'Usually owns readmission reduction work']],
  policy: [['CFO', 'Usually owns payment and coverage planning'], ['VP Strategy/Growth', 'Usually owns market and policy response']],
}
export function titlesFor(item) {
  if (item.contacts && item.contacts.length) return { list: item.contacts, derived: false }
  const cls = item.type === 'readmissions' ? 'readmissions' : classOf(item)
  return { list: (TITLES[cls] || TITLES.policy).map(([title, why]) => ({ name: null, title, why })), derived: true }
}

const short = (t) => { const s = String(t || '').replace(/\.$/, ''); if (s.length <= 84) return s; const cut = s.slice(0, 84); return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 84)}` }
// The pack says to frame impact as a question unless a source shows it. This is built from the headline and never states
// an effect on anyone.
export function questionFor(item) {
  const t = short(item.title)
  const cls = item.type === 'readmissions' ? 'readmissions' : classOf(item)
  if (cls === 'closure' || cls === 'ed_flow') return `With ${t}, how are nearby EDs lining up follow up care for patients they have never seen?`
  if (cls === 'deal') return `With ${t}, how are you thinking about keeping patients connected to follow up care across the network?`
  if (cls === 'new_site') return `Could ${t} draw ED and referral volume away from your system, and how are you planning for it?`
  if (cls === 'readmissions') return `With ${t}, how is your team preparing for readmission exposure?`
  return `With ${t}, how are you planning for the effect on ED visits and follow up care?`
}

export function fourPartOf(item) {
  const p = productsFor(item), c = titlesFor(item)
  return {
    happened: item.whatHappened || '', why: item.whyItMatters || '',
    product: p, contacts: c,
    opening: item.openingLine ? { text: item.openingLine, derived: false } : { text: questionFor(item), derived: true },
    sourced: (item.sources || []).some((s) => s && s.url),
  }
}

// ---------- the same event reported twice ----------

export const normUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '')
const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2))
const jaccard = (a, b) => { const inter = [...a].filter((w) => b.has(w)).length; return inter / Math.max(1, new Set([...a, ...b]).size) }

// The Account Intelligence duplicate rule: the same source link, or a headline that is mostly the same words, and the same
// organization when both name one.
export function isDuplicateNews(a, b) {
  const ua = normUrl(a.url || (a.sources && a.sources[0] && a.sources[0].url)), ub = normUrl(b.url || (b.sources && b.sources[0] && b.sources[0].url))
  if (ua && ub && ua === ub) return true
  const j = jaccard(words(a.title), words(b.title))
  const oa = String(a.org || '').toLowerCase(), ob = String(b.org || '').toLowerCase()
  return j >= 0.55 && (!oa || !ob || oa === ob || j >= 0.75)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const monthKey = (iso) => (/^\d{4}-\d{2}/.test(String(iso || '')) ? String(iso).slice(0, 7) : 'undated')
export const monthLabel = (key) => (key === 'undated' ? 'Undated' : `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`)
