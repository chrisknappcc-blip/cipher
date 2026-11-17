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
  if (item.origin === 'account-intelligence') return item.cat === 'mna' ? 'deal' : item.cat === 'ed' ? 'new_site' : item.cat === 'lead' ? 'leadership' : item.cat === 'quality' || item.cat === 'market' ? 'policy' : 'growth'
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
  const own = item.origin === 'account-intelligence' && item.cat !== 'quality' && item.cat !== 'market'
  const key = own ? `alert_${item.cat === 'mna' ? 'mna' : item.cat === 'ed' ? 'ed' : item.cat === 'lead' ? 'lead' : 'growth'}` : item.type === 'readmissions' ? 'readmissions' : cls
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

// ---------- the four solutions: what each one is, and which news fits it ----------

// What each solution does is the prompt pack's wording. The proof points are the pack's approved set and nothing else, said as
// "customers have seen", never as a promise and never naming a customer. searchFor is what the daily scan should look for, so
// a thin solution points at its own fix.
export const PRODUCT_KIT = [
  { name: 'ED Connect', does: 'Connects ED and urgent care discharges to in network specialist and primary care follow up.', proof: 'Care Continuity has navigated 3M+ patients over 10+ years, working with 100+ health systems.',
    searchFor: 'ED closures, new EDs and urgent care, boarding and crowding, discharge follow up' },
  { name: 'Referral IQ', does: 'Scores open specialist referrals daily so limited capacity goes to the highest clinical risk and downstream value.', proof: 'Customers have seen an average 50% increase in in network referrals.',
    searchFor: 'specialist access, wait times, physician group moves, referral leakage' },
  { name: 'Readmission IQ', does: 'Post discharge navigation that catches barriers like home health, equipment, medications and transport before a readmission.', proof: 'Customers have seen an average 30% reduction in preventable readmissions.',
    searchFor: 'readmission penalties and measures, post acute and home health, hospital at home, care transitions' },
  { name: 'CarePath IQ', does: 'Market wide care journey analytics, out of network visits and procedure leakage.', proof: 'Care Continuity has navigated 3M+ patients over 10+ years, working with 100+ health systems.',
    searchFor: 'out of network visits, procedure leakage, market entry and exits, certificates of need' },
]
export const PRODUCT_NAMES = PRODUCT_KIT.map((p) => p.name)

// How each kind of news reads for each solution. Every line is an angle to ask about, never a claim about the hospital.
const ANGLES = {
  'ED Connect': {
    deal: 'Two systems, two discharge processes. Ask how ED and urgent care patients get booked into in network follow up after the combination.',
    closure: 'Patients from a closed ED land at neighbors that have never seen them. Ask how follow up appointments get booked before those patients leave.',
    new_site: 'A new ED or urgent care adds discharges. Ask how each one is connected to a follow up appointment.',
    ed_flow: 'ED volume or crowding is shifting. Ask how follow up is booked before discharge and how 30 day ED returns are tracked.',
    leadership: 'A new leader sets new priorities. Ask what they want to change about ED returns and follow up after discharge.',
    growth: 'Growth adds ED and urgent care visits. Ask how the system keeps those patients in network after discharge.',
    policy: 'Rules change who comes to the ED and who pays. Ask how follow up access is planned for those patients.',
  },
  'Referral IQ': {
    deal: 'A larger network needs one way to prioritize specialist referrals. Ask how open referrals are ranked across both systems.',
    closure: 'Specialist capacity moves with the patients. Ask how limited slots go to the highest risk referrals.',
    new_site: 'A competitor entering the market puts referral loyalty at stake. Ask how the system keeps referrals in network.',
    ed_flow: 'More ED patients need specialist follow up. Ask how referrals from the ED are prioritized.',
    leadership: 'A new leader often reviews access. Ask how open referrals and wait times are managed today.',
    growth: 'New capacity only helps if referrals reach it. Ask how referrals are matched to the new capacity.',
    policy: 'Access and payment rules shape referrals. Ask how the system watches referral leakage.',
  },
  'Readmission IQ': {
    deal: 'Integration changes post discharge handoffs. Ask how barriers like home health, equipment, medications and transport are caught early.',
    closure: 'More patients are discharged from busy units. Ask who catches post discharge barriers before a readmission.',
    new_site: 'More sites mean more discharges. Ask how post discharge barriers are caught across them.',
    ed_flow: 'Crowded EDs discharge faster. Ask how barriers are caught before a patient returns.',
    leadership: 'A new leader often reviews quality measures. Ask how readmissions are tracked and what is in place after discharge.',
    growth: 'Growth adds discharges. Ask how the team scales post discharge follow through.',
    policy: 'Quality and payment rules can change readmission exposure. Ask how the team is preparing.',
  },
  'CarePath IQ': {
    deal: 'A deal changes where patients go for care. Ask how the system tracks out of network visits and procedure leakage.',
    closure: 'A closure moves patients to other systems. Ask what the system can see about where they go next.',
    new_site: 'A new competitor site can pull patients out of network. Ask how leakage is measured by service area.',
    ed_flow: 'ED volume is shifting across the market. Ask how the system sees patient flow between hospitals.',
    leadership: 'A new leader needs a market picture. Ask what they can see today about care journeys and leakage.',
    growth: 'Growth plans depend on where patients really go. Ask what data guides where to add capacity.',
    policy: 'Certificate of need and payment rules shape the market. Ask how the system tracks leakage and market share.',
  },
}
export const angleFor = (product, cls) => (ANGLES[product] && (ANGLES[product][cls] || ANGLES[product].policy)) || null

// The words that show a piece of news is about a solution's own subject. Tight on purpose: "discharge" and "follow up" alone
// would match almost everything.
const THEME_WORDS = {
  'ED Connect': /\b(emergency (department|room|care|physician|medicine)|ED visits?|ER visits?|urgent care|freestanding (ED|ER|emergency|urgent care)|boarding|ED crowding|ED returns?)\b/i,
  'Referral IQ': /\b(referrals?|specialists?|specialty (care|access|clinics?)|wait times?|physician (groups?|practices?)|employed physicians?|scheduling)\b/i,
  'Readmission IQ': /readmission|post.?acute|home health|skilled nursing|\bSNF\b|transitions? of care|care transitions|hospital at home|discharge planning|\bHRRP\b|\bEDAC\b/i,
  'CarePath IQ': /out.of.network|leakage|care journey|market share|steer(ing)?|price transparency|network adequacy|service area|patient flow|outmigration|certificate of need|\bCON\b/i,
}
const ED_UPPER = /\b(ED|ER)\b/
// The Front Door Radar's own topic tags, chosen by whoever built it, are evidence too.
const THEME_TOPICS = { 'Referrals & leakage': ['Referral IQ', 'CarePath IQ'], Readmissions: ['Readmission IQ'], 'Emergency dept': ['ED Connect'], 'Urgent care': ['ED Connect'], 'CON & licensing': ['CarePath IQ'] }

// Which solutions a card fits, and why. A solution is the lead (from the source, or by rule for the kind of news), an also (the
// source's own second product), or a theme (the text or the Radar's topic is about its subject). A second product that only a
// rule supplied is not counted, so a menu never fills with news that has nothing to do with it.
export function productFit(item) {
  const prods = productsFor(item), cls = classOf(item), found = new Map()
  found.set(prods.lead, { role: 'lead', why: prods.derived ? 'Lead product by rule for this kind of news' : 'Lead product from the source' })
  if (prods.secondary && !prods.derived && !found.has(prods.secondary)) found.set(prods.secondary, { role: 'also', why: 'Second product from the source' })
  const text = `${item.title || ''} ${item.whatHappened || ''} ${item.whyItMatters || ''}`
  for (const p of PRODUCT_NAMES) {
    if (found.has(p)) continue
    const m = THEME_WORDS[p].exec(text) || (p === 'ED Connect' ? ED_UPPER.exec(text) : null)
    if (m) found.set(p, { role: 'theme', why: `Mentions ${m[0].toLowerCase()}` })
  }
  for (const t of item.topics || []) for (const p of THEME_TOPICS[t] || []) if (!found.has(p)) found.set(p, { role: 'theme', why: `Radar topic: ${t}` })
  return PRODUCT_NAMES.filter((p) => found.has(p)).map((p) => ({ product: p, ...found.get(p), angle: angleFor(p, cls) }))
}
