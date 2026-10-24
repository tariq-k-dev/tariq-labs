/** A single rendered table cell. Numbers stay numbers until render time. */
export type Cell = string | number | null

/** How a column should be formatted. Data stays numeric; formatting is a view concern. */
export type CellFormat = 'text' | 'int' | 'num1' | 'pct1' | 'per1k' | 'date'

export interface ColumnSpec {
  key: string
  label: string
  format?: CellFormat
  align?: 'left' | 'right'
}

export interface Table {
  columns: ColumnSpec[]
  rows: Cell[][]
}

/**
 * What the chart layer needs, and nothing more: a category axis and one numeric
 * series. `null` means "no value for this category" (a gap), not zero.
 */
export interface ChartData {
  kind: 'bar' | 'line'
  /** What the numbers are, e.g. "mean departure delay". Used for the axis label. */
  label: string
  unit?: string
  categories: string[]
  values: (number | null)[]
  /** Index of the category the headline refers to, drawn highlighted. */
  highlight?: number
}

export interface QuestionResult {
  table: Table
  chart: ChartData | null
  /** One sentence a visitor can read without the table. */
  headline: string
  /** Caveat shown under the table (row limits, null handling). */
  note?: string
}
