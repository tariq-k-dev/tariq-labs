/**
 * The aggregation behind each question.
 *
 * Shape: `create()` gives an accumulator, `accumulate()` is fed one partition's
 * rows at a time, `finish()` renders a table + chart. Streaming per partition is
 * what keeps memory bounded: the worker never holds more than one month of rows,
 * however many months the visitor selects.
 *
 * Rows arrive from hyparquet as arrays in the *requested column order* — the same
 * contract the spike's probe F relied on — so index 0 is always `columns[0]`.
 */

import { QUESTIONS, questionById, type FlightColumn, type QuestionMeta } from './catalog.js'
import { fmt1, fmtInt } from './format.js'
import type { Cell, ChartData, ColumnSpec, QuestionResult, Table } from './types.js'

/** A row as hyparquet returns it: positional values in requested column order. */
export type Row = readonly unknown[]

export interface QuestionRunner<State = unknown> {
  meta: QuestionMeta
  create(): State
  accumulate(state: State, rows: readonly Row[]): void
  finish(state: State): QuestionResult
}

const LATE_MIN = 15

// ------------------------------------------------------------------ coercion
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  return null
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return String(value)
}

function flag(value: unknown): boolean {
  const n = num(value)
  return n != null && n > 0
}

/**
 * Reporting carrier code -> name, for the 15 codes present in the BTS corpus.
 *
 * The real data reports regional partners under their own two-letter code (`OH`,
 * `9E`, `MQ`), which means nothing to a visitor reading a headline. Names come from
 * the BTS carrier lookup; unknown codes fall through to the raw code rather than
 * being hidden, so a new entrant shows up as itself instead of as "Unknown".
 */
const CARRIER_NAMES: Record<string, string> = {
  AA: 'American Airlines',
  AS: 'Alaska Airlines',
  B6: 'JetBlue',
  DL: 'Delta Air Lines',
  F9: 'Frontier Airlines',
  G4: 'Allegiant Air',
  HA: 'Hawaiian Airlines',
  MQ: 'Envoy Air',
  NK: 'Spirit Airlines',
  OH: 'PSA Airlines',
  OO: 'SkyWest Airlines',
  UA: 'United Airlines',
  WN: 'Southwest Airlines',
  YX: 'Republic Airways',
  '9E': 'Endeavor Air',
}

/** Carrier code -> display name, falling back to the code itself. */
function carrierName(code: string): string {
  return CARRIER_NAMES[code] ?? code
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** `fl_date` decodes to a Date (Parquet timestamp). Normalise to a day number. */
const MS_PER_DAY = 86_400_000

/**
 * Day index from the epoch, not an ISO string. Building 540,000 date strings per
 * question cost 200 ms of pure formatting; integer keys cost almost nothing and the
 * label is produced once per distinct day at render time.
 */
function dayNumber(value: unknown): number | null {
  if (value instanceof Date) return Math.floor(value.getTime() / MS_PER_DAY)
  if (typeof value === 'bigint') return Math.floor(Number(value) / MS_PER_DAY)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value / MS_PER_DAY)
  return null
}

function isoFromDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

// ------------------------------------------------------------------- helpers
interface Acc {
  n: number
  sum: number
  late: number
}

function blank(): Acc {
  return { n: 0, sum: 0, late: 0 }
}

function accum(acc: Acc, value: number | null): void {
  if (value == null) return
  acc.n += 1
  acc.sum += value
  if (value > LATE_MIN) acc.late += 1
}

function mean(acc: Acc): number {
  return acc.n > 0 ? acc.sum / acc.n : 0
}

function meanOrNull(acc: Acc): number | null {
  return acc.n > 0 ? acc.sum / acc.n : null
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0
}

function tableFrom(columns: ColumnSpec[], rows: Cell[][]): Table {
  return { columns, rows }
}

interface GroupRow {
  key: string
  acc: Acc
}

function sortGroups(map: Map<string, Acc>, direction: 'asc' | 'desc'): GroupRow[] {
  const rows: GroupRow[] = []
  for (const [key, acc] of map) rows.push({ key, acc })
  rows.sort((a, b) => (direction === 'desc' ? mean(b.acc) - mean(a.acc) : mean(a.acc) - mean(b.acc)))
  return rows
}

const DELAY_COLUMNS: ColumnSpec[] = [
  { key: 'group', label: 'Group' },
  { key: 'n', label: 'Flights', format: 'int', align: 'right' },
  { key: 'mean', label: 'Mean delay', format: 'num1', align: 'right' },
  { key: 'late', label: '% > 15 min', format: 'pct1', align: 'right' },
]

function delayRows(rows: GroupRow[]): Cell[][] {
  return rows.map(({ key, acc }) => [key, acc.n, mean(acc), pct(acc.late, acc.n)] as Cell[])
}

function delayChart(
  meta: QuestionMeta,
  rows: GroupRow[],
  categoriesFrom: (key: string) => string = (k) => k,
): ChartData {
  return {
    kind: meta.chart === 'line' ? 'line' : 'bar',
    label: meta.valueLabel,
    unit: meta.unit,
    categories: rows.map((r) => categoriesFrom(r.key)),
    values: rows.map((r) => meanOrNull(r.acc)),
    highlight: 0,
  }
}

// -------------------------------------------------------------- 1. carrier
const carrierDelay: QuestionRunner<Map<string, Acc>> = {
  meta: questionById('carrier-delay'),
  create: () => new Map<string, Acc>(),
  accumulate(state, rows) {
    for (const row of rows) {
      const carrier = text(row[0])
      if (!carrier) continue
      let acc = state.get(carrier)
      if (!acc) {
        acc = blank()
        state.set(carrier, acc)
      }
      accum(acc, num(row[1]))
    }
  },
  finish(state) {
    const groups = sortGroups(state, 'desc').map((row) => ({ ...row, key: carrierName(row.key) }))
    const table = tableFrom(
      DELAY_COLUMNS.map((c) => (c.key === 'group' ? { ...c, label: 'Carrier' } : c)),
      delayRows(groups),
    )
    const worst = groups[0]
    const best = groups[groups.length - 1]
    return {
      table,
      chart: delayChart(this.meta, groups),
      headline: worst
        ? `${worst.key} averages ${fmt1(mean(worst.acc))} min late; ${best.key} averages ${fmt1(mean(best.acc))} min.`
        : 'No rows matched.',
      note: `Delays are departure delay. Cancelled flights carry no delay value and are excluded.`,
    }
  },
}

// -------------------------------------------------------------- 2. airport
/**
 * Airports below a minimum sample size are excluded from the ranking.
 *
 * Real BTS data made this necessary. Without a floor, the "worst airport" was DHN with
 * 52 flights and a 99-minute mean — one weather event, not an operational fact — and
 * even a fixed 1,000-flight floor let MGM in at n=1,114. The floor is a share of the
 * rows actually read, so it stays meaningful whether the visitor selects one month or
 * five years, and it is printed in the note so the exclusion is never hidden.
 */
const AIRPORT_MIN_SHARE = 0.002
const AIRPORT_MIN_ABSOLUTE = 1_000

interface AirportState {
  byAirport: Map<string, Acc>
  total: number
}

const airportDelay: QuestionRunner<AirportState> = {
  meta: questionById('airport-delay'),
  create: () => ({ byAirport: new Map<string, Acc>(), total: 0 }),
  accumulate(state, rows) {
    for (const row of rows) {
      const origin = text(row[0])
      if (!origin) continue
      state.total += 1
      let acc = state.byAirport.get(origin)
      if (!acc) {
        acc = blank()
        state.byAirport.set(origin, acc)
      }
      accum(acc, num(row[1]))
    }
  },
  finish(state) {
    const floor = Math.max(AIRPORT_MIN_ABSOLUTE, Math.round(state.total * AIRPORT_MIN_SHARE))
    const eligible = [...state.byAirport.entries()].filter(([, acc]) => acc.n >= floor)
    const ranked = eligible
      .sort((a, b) => mean(b[1]) - mean(a[1]))
      .slice(0, 12)
      .map(([key, acc]) => ({ key, acc }))
    const table = tableFrom(
      DELAY_COLUMNS.map((c) => (c.key === 'group' ? { ...c, label: 'Origin' } : c)),
      delayRows(ranked),
    )
    const worst = ranked[0]
    const excluded = state.byAirport.size - eligible.length
    return {
      table,
      chart: delayChart(this.meta, ranked),
      headline: worst
        ? `${worst.key} has the worst departures at ${fmt1(mean(worst.acc))} min mean delay across ${fmtInt(worst.acc.n)} flights.`
        : `No airport reached ${fmtInt(floor)} departures in this range.`,
      note: `Airports with fewer than ${fmtInt(floor)} departures are excluded (${excluded} of ${fmtInt(state.byAirport.size)}) — a low-volume airport with one storm day is noise, not a ranking. Top 12 shown.`,
    }
  },
}

// ----------------------------------------------------------- 3. hour of day
const hourOfDay: QuestionRunner<Map<number, Acc>> = {
  meta: questionById('hour-of-day'),
  create: () => new Map<number, Acc>(),
  accumulate(state, rows) {
    for (const row of rows) {
      const hour = num(row[0])
      if (hour == null) continue
      let acc = state.get(hour)
      if (!acc) {
        acc = blank()
        state.set(hour, acc)
      }
      accum(acc, num(row[1]))
    }
  },
  finish(state) {
    const hours = [...state.keys()].sort((a, b) => a - b)
    const rows = hours.map((h) => ({ key: h, acc: state.get(h)! }))
    const table = tableFrom(
      DELAY_COLUMNS.map((c) => (c.key === 'group' ? { ...c, label: 'Departure hour' } : c)),
      rows.map(({ key, acc }) => [`${String(key).padStart(2, '0')}:00`, acc.n, mean(acc), pct(acc.late, acc.n)] as Cell[]),
    )
    const peak = rows.reduce((best, r) => (mean(r.acc) > mean(best.acc) ? r : best), rows[0])
    // Compare the peak against the EARLY MORNING, not against the first row: real BTS
    // data starts at 00:00 with a handful of heavily delayed red-eyes, which is not a
    // baseline for "the day degrades". Hours 05:00–08:00 are where a schedule is honest.
    const morning = rows.filter((r) => r.key >= 5 && r.key <= 8 && r.acc.n > 0)
    const baseline = morning.length
      ? morning.reduce((best, r) => (mean(r.acc) < mean(best.acc) ? r : best))
      : rows[0]
    return {
      table,
      chart: {
        kind: 'line',
        label: this.meta.valueLabel,
        unit: this.meta.unit,
        categories: rows.map((r) => `${String(r.key).padStart(2, '0')}:00`),
        values: rows.map((r) => meanOrNull(r.acc)),
        highlight: rows.indexOf(peak),
      },
      headline: peak
        ? `Delay climbs from ${fmt1(mean(baseline.acc))} min at ${String(baseline.key).padStart(2, '0')}:00 to ${fmt1(mean(peak.acc))} min by ${String(peak.key).padStart(2, '0')}:00.`
        : 'No rows matched.',
      note: 'Scheduled local departure hour. Hours with no scheduled flights are omitted; the morning baseline is the least-delayed hour between 05:00 and 08:00.',
    }
  },
}

// ----------------------------------------------------------- 4. day of week
const dayOfWeek: QuestionRunner<Map<number, Acc>> = {
  meta: questionById('day-of-week'),
  create: () => new Map<number, Acc>(),
  accumulate(state, rows) {
    for (const row of rows) {
      const dow = num(row[0])
      if (dow == null || dow < 1 || dow > 7) continue
      let acc = state.get(dow)
      if (!acc) {
        acc = blank()
        state.set(dow, acc)
      }
      accum(acc, num(row[1]))
    }
  },
  finish(state) {
    const rows = [...state.keys()].sort((a, b) => a - b).map((d) => ({ key: d, acc: state.get(d)! }))
    const table = tableFrom(
      DELAY_COLUMNS.map((c) => (c.key === 'group' ? { ...c, label: 'Day' } : c)),
      rows.map(({ key, acc }) => [WEEKDAYS[key - 1] ?? String(key), acc.n, mean(acc), pct(acc.late, acc.n)] as Cell[]),
    )
    const worst = rows.reduce((best, r) => (mean(r.acc) > mean(best.acc) ? r : best), rows[0])
    return {
      table,
      chart: {
        kind: 'bar',
        label: this.meta.valueLabel,
        unit: this.meta.unit,
        categories: rows.map((r) => WEEKDAYS[r.key - 1] ?? String(r.key)),
        values: rows.map((r) => meanOrNull(r.acc)),
        highlight: rows.indexOf(worst),
      },
      headline: worst
        ? `${WEEKDAYS[worst.key - 1] ?? worst.key} is the worst day at ${fmt1(mean(worst.acc))} min mean departure delay.`
        : 'No rows matched.',
      note: 'Day of week from the flight date: 1 = Monday.',
    }
  },
}

// ---------------------------------------------------------- 5. cancellations
interface CancelAcc {
  n: number
  cancelled: number
}

const cancellations: QuestionRunner<Map<string, CancelAcc>> = {
  meta: questionById('cancellations'),
  create: () => new Map<string, CancelAcc>(),
  accumulate(state, rows) {
    for (const row of rows) {
      const carrier = text(row[0])
      if (!carrier) continue
      let acc = state.get(carrier)
      if (!acc) {
        acc = { n: 0, cancelled: 0 }
        state.set(carrier, acc)
      }
      acc.n += 1
      if (flag(row[1])) acc.cancelled += 1
    }
  },
  finish(state) {
    const rows = [...state.entries()]
      .map(([key, acc]) => ({ key, acc, rate: acc.n > 0 ? (acc.cancelled / acc.n) * 1000 : 0 }))
      .sort((a, b) => b.rate - a.rate)
    const table = tableFrom(
      [
        { key: 'carrier', label: 'Carrier' },
        { key: 'n', label: 'Flights', format: 'int', align: 'right' },
        { key: 'cancelled', label: 'Cancelled', format: 'int', align: 'right' },
        { key: 'rate', label: 'Per 1,000', format: 'per1k', align: 'right' },
      ],
      rows.map(({ key, acc, rate }) => [carrierName(key), acc.n, acc.cancelled, rate] as Cell[]),
    )
    const worst = rows[0]
    const network = rows.reduce(
      (acc, r) => ({ n: acc.n + r.acc.n, cancelled: acc.cancelled + r.acc.cancelled }),
      { n: 0, cancelled: 0 },
    )
    return {
      table,
      chart: {
        kind: 'bar',
        label: this.meta.valueLabel,
        categories: rows.map((r) => carrierName(r.key)),
        values: rows.map((r) => r.rate),
        highlight: 0,
      },
      headline: worst
        ? `${carrierName(worst.key)} cancels ${fmt1(worst.rate)} flights per 1,000 — network average ${fmt1((network.cancelled / Math.max(1, network.n)) * 1000)}.`
        : 'No rows matched.',
      note: 'Cancellation rate per 1,000 scheduled flights.',
    }
  },
}

// ------------------------------------------------------------------ 6. routes
interface RouteAcc {
  n: number
  acc: Acc
}

const routes: QuestionRunner<Map<string, RouteAcc>> = {
  meta: questionById('routes'),
  create: () => new Map<string, RouteAcc>(),
  accumulate(state, rows) {
    for (const row of rows) {
      const origin = text(row[0])
      const dest = text(row[1])
      if (!origin || !dest) continue
      const key = `${origin}\u0000${dest}`
      let entry = state.get(key)
      if (!entry) {
        entry = { n: 0, acc: blank() }
        state.set(key, entry)
      }
      entry.n += 1
      accum(entry.acc, num(row[2]))
    }
  },
  finish(state) {
    const all = [...state.entries()].map(([key, entry]) => ({ key, entry }))
    all.sort((a, b) => b.entry.n - a.entry.n)
    const top = all.slice(0, 10)
    const table = tableFrom(
      [
        { key: 'route', label: 'Route' },
        { key: 'n', label: 'Flights', format: 'int', align: 'right' },
        { key: 'mean', label: 'Mean dep. delay', format: 'num1', align: 'right' },
        { key: 'late', label: '% > 15 min', format: 'pct1', align: 'right' },
      ],
      top.map(({ key, entry }) => {
        const [o, d] = key.split('\u0000')
        return [`${o} → ${d}`, entry.n, mean(entry.acc), pct(entry.acc.late, entry.acc.n)] as Cell[]
      }),
    )
    const busiest = top[0]
    const totalFlights = all.reduce((sum, r) => sum + r.entry.n, 0)
    return {
      table,
      chart: null,
      headline: busiest
        ? `${busiest.key.split('\u0000').join(' → ')} is the busiest pair with ${fmtInt(busiest.entry.n)} flights; the network spans ${fmtInt(all.length)} pairs in total.`
        : 'No rows matched.',
      note: `Top 10 of ${fmtInt(all.length)} origin→destination pairs, covering ${fmt1(
        pct(top.reduce((s, r) => s + r.entry.n, 0), totalFlights),
      )}% of flights.`,
    }
  },
}

// ----------------------------------------------------------- 7. distance band
const DISTANCE_BANDS: { max: number; label: string }[] = [
  { max: 300, label: '< 300 mi' },
  { max: 600, label: '300–599' },
  { max: 1_000, label: '600–999' },
  { max: 1_500, label: '1,000–1,499' },
  { max: Number.POSITIVE_INFINITY, label: '1,500+' },
]

function bandFor(distance: number): number {
  for (let i = 0; i < DISTANCE_BANDS.length; i++) {
    if (distance < DISTANCE_BANDS[i].max) return i
  }
  return DISTANCE_BANDS.length - 1
}

const distanceBands: QuestionRunner<Acc[]> = {
  meta: questionById('distance-bands'),
  create: () => DISTANCE_BANDS.map(() => blank()),
  accumulate(state, rows) {
    for (const row of rows) {
      const distance = num(row[0])
      if (distance == null) continue
      accum(state[bandFor(distance)], num(row[1]))
    }
  },
  finish(state) {
    const table = tableFrom(
      DELAY_COLUMNS.map((c) => (c.key === 'group' ? { ...c, label: 'Distance' } : c)),
      state.map((acc, i) => [DISTANCE_BANDS[i].label, acc.n, mean(acc), pct(acc.late, acc.n)] as Cell[]),
    )
    const populated = state.map((acc, i) => ({ acc, i })).filter((r) => r.acc.n > 0)
    const longest = populated[populated.length - 1]
    const shortest = populated[0]
    return {
      table,
      chart: {
        kind: 'bar',
        label: this.meta.valueLabel,
        unit: this.meta.unit,
        categories: DISTANCE_BANDS.map((b) => b.label),
        values: state.map((acc) => meanOrNull(acc)),
        highlight: longest?.i,
      },
      headline:
        longest && shortest
          ? `${DISTANCE_BANDS[longest.i].label} flights average ${fmt1(mean(longest.acc))} min late on arrival; ${DISTANCE_BANDS[shortest.i].label} average ${fmt1(mean(shortest.acc))} min.`
          : 'No rows matched.',
      note: 'Great-circle distance in miles. Arrival delay, so time recovered in the air is included.',
    }
  },
}

// ------------------------------------------------------------------- 8. daily
interface DayAcc {
  acc: Acc
  cancelled: number
  flights: number
}

const daily: QuestionRunner<Map<number, DayAcc>> = {
  meta: questionById('daily'),
  create: () => new Map<number, DayAcc>(),
  accumulate(state, rows) {
    for (const row of rows) {
      const day = dayNumber(row[0])
      if (day == null) continue
      let entry = state.get(day)
      if (!entry) {
        entry = { acc: blank(), cancelled: 0, flights: 0 }
        state.set(day, entry)
      }
      entry.flights += 1
      if (flag(row[2])) entry.cancelled += 1
      accum(entry.acc, num(row[1]))
    }
  },
  finish(state) {
    const keys = [...state.keys()].sort((a, b) => a - b)
    const entries = keys.map((key) => ({ key: isoFromDay(key), entry: state.get(key)! }))
    const worst = entries.reduce(
      (best, e) => (mean(e.entry.acc) > mean(best.entry.acc) ? e : best),
      entries[0],
    )
    const table = tableFrom(
      [
        { key: 'date', label: 'Date' },
        { key: 'flights', label: 'Flights', format: 'int', align: 'right' },
        { key: 'mean', label: 'Mean dep. delay', format: 'num1', align: 'right' },
        { key: 'cancelled', label: 'Cancelled', format: 'int', align: 'right' },
        { key: 'late', label: '% > 15 min', format: 'pct1', align: 'right' },
      ],
      entries
        .slice()
        .sort((a, b) => mean(b.entry.acc) - mean(a.entry.acc))
        .slice(0, 10)
        .map(({ key, entry }) => [key, entry.flights, mean(entry.acc), entry.cancelled, pct(entry.acc.late, entry.acc.n)] as Cell[]),
    )
    return {
      table,
      chart: {
        kind: 'line',
        label: this.meta.valueLabel,
        unit: this.meta.unit,
        categories: entries.map((e) => e.key),
        values: entries.map((e) => meanOrNull(e.entry.acc)),
        highlight: entries.indexOf(worst),
      },
      headline: worst
        ? `Worst day: ${worst.key} at ${fmt1(mean(worst.entry.acc))} min mean departure delay across ${fmtInt(worst.entry.flights)} flights.`
        : 'No rows matched.',
      note: 'Table shows the ten worst days; the chart shows every day in the selected range.',
    }
  },
}

// ----------------------------------------------------------- 9. carrier share
const carrierShare: QuestionRunner<Map<string, number>> = {
  meta: questionById('carrier-share'),
  create: () => new Map<string, number>(),
  accumulate(state, rows) {
    for (const row of rows) {
      const carrier = text(row[0])
      if (!carrier) continue
      state.set(carrier, (state.get(carrier) ?? 0) + 1)
    }
  },
  finish(state) {
    const total = [...state.values()].reduce((a, b) => a + b, 0)
    const rows = [...state.entries()].sort((a, b) => b[1] - a[1])
    const table = tableFrom(
      [
        { key: 'carrier', label: 'Carrier' },
        { key: 'flights', label: 'Flights', format: 'int', align: 'right' },
        { key: 'share', label: 'Share', format: 'pct1', align: 'right' },
      ],
      rows.map(([key, n]) => [carrierName(key), n, pct(n, total)] as Cell[]),
    )
    const top = rows[0]
    return {
      table,
      chart: {
        kind: 'bar',
        label: this.meta.valueLabel,
        categories: rows.map(([k]) => carrierName(k)),
        values: rows.map(([, n]) => n),
        highlight: 0,
      },
      headline: top
        ? `${carrierName(top[0])} operates ${fmt1(pct(top[1], total))}% of ${fmtInt(total)} flights.`
        : 'No rows matched.',
      note: 'Reads a single column (carrier), which is why it is the cheapest query on the page.',
    }
  },
}

// --------------------------------------------------------- 10. extreme delays
interface TailAcc {
  n: number
  over60: number
  over120: number
  lateSum: number
  lateN: number
}

const extremeDelays: QuestionRunner<Map<string, TailAcc>> = {
  meta: questionById('extreme-delays'),
  create: () => new Map<string, TailAcc>(),
  accumulate(state, rows) {
    for (const row of rows) {
      const carrier = text(row[0])
      if (!carrier) continue
      const delay = num(row[1])
      if (delay == null) continue
      let acc = state.get(carrier)
      if (!acc) {
        acc = { n: 0, over60: 0, over120: 0, lateSum: 0, lateN: 0 }
        state.set(carrier, acc)
      }
      acc.n += 1
      if (delay > 60) acc.over60 += 1
      if (delay > 120) acc.over120 += 1
      if (delay > LATE_MIN) {
        acc.lateSum += delay
        acc.lateN += 1
      }
    }
  },
  finish(state) {
    const rows = [...state.entries()]
      .map(([key, acc]) => ({ key, acc, over60: pct(acc.over60, acc.n) }))
      .sort((a, b) => b.over60 - a.over60)
    const table = tableFrom(
      [
        { key: 'carrier', label: 'Carrier' },
        { key: 'n', label: 'Flights', format: 'int', align: 'right' },
        { key: 'o60', label: '% > 60 min', format: 'pct1', align: 'right' },
        { key: 'o120', label: '% > 120 min', format: 'pct1', align: 'right' },
        {
          key: 'lateMean',
          label: `Mean delay when late`,
          format: 'num1',
          align: 'right',
        },
      ],
      rows.map(({ key, acc }) => [
        carrierName(key),
        acc.n,
        pct(acc.over60, acc.n),
        pct(acc.over120, acc.n),
        acc.lateN > 0 ? acc.lateSum / acc.lateN : null,
      ] as Cell[]),
    )
    const worst = rows[0]
    return {
      table,
      chart: {
        kind: 'bar',
        label: this.meta.valueLabel,
        categories: rows.map((r) => carrierName(r.key)),
        values: rows.map((r) => r.over60),
        highlight: 0,
      },
      headline: worst
        ? `${carrierName(worst.key)} puts ${fmt1(worst.over60)}% of flights more than an hour late.`
        : 'No rows matched.',
      note: `"Late" means more than ${LATE_MIN} minutes. Delays are departure delay; cancelled flights are excluded.`,
    }
  },
}

// ------------------------------------------------------------------ registry
const RUNNERS = new Map<string, QuestionRunner<never>>([
  [carrierDelay.meta.id, carrierDelay as QuestionRunner<never>],
  [airportDelay.meta.id, airportDelay as QuestionRunner<never>],
  [hourOfDay.meta.id, hourOfDay as QuestionRunner<never>],
  [dayOfWeek.meta.id, dayOfWeek as QuestionRunner<never>],
  [cancellations.meta.id, cancellations as QuestionRunner<never>],
  [routes.meta.id, routes as QuestionRunner<never>],
  [distanceBands.meta.id, distanceBands as QuestionRunner<never>],
  [daily.meta.id, daily as QuestionRunner<never>],
  [carrierShare.meta.id, carrierShare as QuestionRunner<never>],
  [extremeDelays.meta.id, extremeDelays as QuestionRunner<never>],
])

/**
 * Every catalog entry must have an implementation. Checked at module load so the
 * worker fails loudly instead of silently rendering an empty card.
 */
export const IMPLEMENTED_IDS: readonly string[] = [...RUNNERS.keys()]

export function runnerFor(id: string): QuestionRunner<unknown> {
  const runner = RUNNERS.get(id)
  if (!runner) throw new Error(`no aggregation implemented for question "${id}"`)
  return runner as QuestionRunner<unknown>
}

export function assertCatalogComplete(): void {
  const missing = QUESTIONS.filter((q) => !RUNNERS.has(q.id)).map((q) => q.id)
  if (missing.length > 0) throw new Error(`questions without an aggregation: ${missing.join(', ')}`)
  if (RUNNERS.size !== QUESTIONS.length) {
    throw new Error(`runner registry (${RUNNERS.size}) does not match catalog (${QUESTIONS.length})`)
  }
}

/** What a question costs, stated before it runs: which columns it needs. */
export function columnFootprint(meta: QuestionMeta, totalColumns: number): string {
  return `${meta.columns.length} of ${totalColumns} columns, ${meta.columns.join(', ')}`
}

export type { FlightColumn }
