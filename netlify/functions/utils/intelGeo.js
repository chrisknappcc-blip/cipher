// netlify/functions/utils/intelGeo.js
//
// Puts a city on the Market Intel map. HubSpot gives a city and a state, never coordinates, so the position comes from
// cityIndex.js (about 34,000 US places from the team's Market Map). A city is looked up the way the Market Map does it:
// lower case, punctuation removed, "Saint" as "St", "Ft" as "Fort", "Mt" as "Mount". If the exact name is not there it
// tries without "City" or "Township", then without a leading compass word. If nothing fits it says null, and the
// screen reports how many accounts it could not place instead of guessing a spot.

import CITY from './cityIndex.js'

export const normCity = (s) => String(s || '').toLowerCase().replace(/[.'\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^saint /, 'st ').replace(/^ft /, 'fort ').replace(/^mt /, 'mount ')

const tables = new Map()
function table(st) {
  if (tables.has(st)) return tables.get(st)
  const m = new Map()
  const raw = CITY[st]
  if (raw) for (const e of raw.split(';')) { const i = e.lastIndexOf(':'); const [x, y] = e.slice(i + 1).split(','); m.set(e.slice(0, i), [Number(x) / 10, Number(y) / 10]) }
  tables.set(st, m)
  return m
}

export function locate(city, state) {
  if (!city || !state) return null
  const m = table(state)
  if (!m.size) return null
  const k = normCity(city)
  const hit = m.get(k) || m.get(k.replace(/ (city|township|twp)$/, '')) || m.get(k.replace(/^(north|south|east|west) /, ''))
  return hit ? { x: hit[0], y: hit[1] } : null
}
