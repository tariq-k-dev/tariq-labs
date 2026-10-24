/**
 * The ten canned questions.
 *
 * This is the product's ceiling: with no SQL engine (see docs/spike-r2-range.md,
 * probes F/G) each question is a named aggregation with real JavaScript behind it.
 * Ten good ones reads as a finished product; three reads as a demo.
 *
 * `columns` is load-bearing, not documentation: it is exactly the column list
 * handed to hyparquet, and therefore what determines how many bytes come off the
 * wire. Adding a column to a question costs every visitor real bandwidth.
 */

export const FLIGHT_COLUMNS = [
  'fl_date',
  'carrier',
  'origin',
  'dest',
  'crs_dep_hour',
  'day_of_week',
  'dep_delay',
  'arr_delay',
  'cancelled',
  'diverted',
  'crs_elapsed_time',
  'air_time',
  'distance',
] as const

export type FlightColumn = (typeof FLIGHT_COLUMNS)[number]

export interface QuestionMeta {
  id: string
  title: string
  /** One line: what the answer shows. Required by the acceptance gates. */
  caption: string
  columns: readonly FlightColumn[]
  chart: 'bar' | 'line' | 'table'
  /** Axis label for the numeric series. */
  valueLabel: string
  unit?: string
}

export const QUESTIONS: readonly QuestionMeta[] = [
  {
    id: 'carrier-delay',
    title: 'Which carriers run late, and how late?',
    caption:
      'Mean departure delay per carrier, with the share of flights more than 15 minutes late. Carriers are ordered by mean delay.',
    columns: ['carrier', 'dep_delay'],
    chart: 'bar',
    valueLabel: 'mean departure delay',
    unit: 'min',
  },
  {
    id: 'airport-delay',
    title: 'Which airports are the worst place to depart?',
    caption:
      'Mean departure delay by origin airport, top 12. Departure-side delay is where a bad day propagates into the rest of the network.',
    columns: ['origin', 'dep_delay'],
    chart: 'bar',
    valueLabel: 'mean departure delay',
    unit: 'min',
  },
  {
    id: 'hour-of-day',
    title: 'When in the day does the network break down?',
    caption:
      'Mean departure delay by scheduled departure hour. Delay accumulating through the day is the classic signature of a schedule with no slack.',
    columns: ['crs_dep_hour', 'dep_delay'],
    chart: 'line',
    valueLabel: 'mean departure delay',
    unit: 'min',
  },
  {
    id: 'day-of-week',
    title: 'Is Friday really the worst day to fly?',
    caption:
      'Mean departure delay by day of week. Weekday effects show up in schedule density more than in any single airport.',
    columns: ['day_of_week', 'dep_delay'],
    chart: 'bar',
    valueLabel: 'mean departure delay',
    unit: 'min',
  },
  {
    id: 'cancellations',
    title: 'Who cancels the most flights?',
    caption:
      'Cancellations per 1,000 scheduled flights, by carrier. A cancellation is a worse outcome for a passenger than a delay, and it moves differently.',
    columns: ['carrier', 'cancelled'],
    chart: 'bar',
    valueLabel: 'cancellations per 1,000 flights',
  },
  {
    id: 'routes',
    title: 'Where does the network actually fly?',
    caption:
      'The ten busiest origin→destination pairs by flight count, with the mean delay on each. Route volume is what makes a single delay expensive.',
    columns: ['origin', 'dest', 'dep_delay'],
    chart: 'table',
    valueLabel: 'flights',
  },
  {
    id: 'distance-bands',
    title: 'Do longer flights run later?',
    caption:
      'Mean arrival delay by great-circle distance band. Arrival rather than departure delay, because longer flights can recover time in the air.',
    columns: ['distance', 'arr_delay'],
    chart: 'bar',
    valueLabel: 'mean arrival delay',
    unit: 'min',
  },
  {
    id: 'daily',
    title: 'What were the worst days in the period?',
    caption:
      'Daily mean departure delay across every partition selected. The spikes are the days a visitor remembers, and the ones an operations team staffs against.',
    columns: ['fl_date', 'dep_delay', 'cancelled'],
    chart: 'line',
    valueLabel: 'mean departure delay',
    unit: 'min',
  },
  {
    id: 'carrier-share',
    title: 'How concentrated is the market?',
    caption:
      'Flights per carrier and share of the network. This one asks for a single column, so it is the cheapest question on the page.',
    columns: ['carrier'],
    chart: 'bar',
    valueLabel: 'flights',
  },
  {
    id: 'extreme-delays',
    title: 'How bad is the tail?',
    caption:
      'Share of flights delayed more than 60 and more than 120 minutes, by carrier, plus the mean delay among flights that were already late.',
    columns: ['carrier', 'dep_delay'],
    chart: 'bar',
    valueLabel: 'share of flights over 60 min late',
  },
]

export function questionById(id: string): QuestionMeta {
  const found = QUESTIONS.find((q) => q.id === id)
  if (!found) throw new Error(`unknown question: ${id}`)
  return found
}
