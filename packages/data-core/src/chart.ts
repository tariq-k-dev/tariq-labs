/**
 * Chart geometry, shared by the React renderer and the static-poster generator.
 *
 * Kept as pure math on purpose: `scripts/precompute.mjs` renders the same geometry
 * to an SVG file at build time for the reduced-motion / no-JS path, so the poster and
 * the interactive chart cannot drift apart. No chart library — a bar chart plus a
 * line chart is less code than the dependency, and the dependency would outweigh the
 * whole Parquet reader it is describing.
 */

import { fmtCompact, fmtShortDate } from './format.js'
import type { ChartData } from './types.js'

export interface ChartOptions {
  width?: number
  height?: number
  /** Minimum x-axis label spacing in px. Used to thin dense line charts. */
  minLabelGap?: number
}

export interface PlotBox {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

export interface AxisTick {
  y: number
  label: string
}

export interface XLabel {
  x: number
  text: string
}

export interface BarMark {
  x: number
  y: number
  width: number
  height: number
  category: string
  value: number
  index: number
  highlight: boolean
}

export interface PointMark {
  x: number
  y: number
  category: string
  value: number
  index: number
  highlight: boolean
}

export interface BaseGeometry {
  width: number
  height: number
  plot: PlotBox
  baseline: number
  yTicks: AxisTick[]
  xLabels: XLabel[]
  label: string
  unit?: string
  empty: boolean
  domain: [number, number]
}

export interface BarGeometry extends BaseGeometry {
  kind: 'bar'
  bars: BarMark[]
}

export interface LineGeometry extends BaseGeometry {
  kind: 'line'
  points: PointMark[]
  /** One or more `M… L…` subpaths; gaps in the data break the path. */
  path: string
  areaPath: string
  highlightPoint: PointMark | null
}

export type Geometry = BarGeometry | LineGeometry

const DEFAULT_WIDTH = 760
const DEFAULT_HEIGHT = 250
const MARGIN = { left: 46, right: 14, top: 18, bottom: 36 }

function niceStep(span: number, targetTicks: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1
  const raw = span / Math.max(1, targetTicks)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

function yDomain(values: (number | null)[]): [number, number] {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  const lo = Math.min(0, min)
  const hi = Math.max(0, max)
  if (hi === lo) return [lo, lo + 1]
  const pad = (hi - lo) * 0.08
  return [lo - (lo < 0 ? pad : 0), hi + pad]
}

function axisTicks(domain: [number, number], box: PlotBox): AxisTick[] {
  const [lo, hi] = domain
  const step = niceStep(hi - lo, 5)
  const first = Math.ceil(lo / step) * step
  const ticks: AxisTick[] = []
  for (let value = first; value <= hi + step * 0.001; value += step) {
    // Kill floating-point dust like -0.000000000001 before formatting.
    const clean = Math.abs(value) < step * 1e-9 ? 0 : value
    const y = box.top + box.height - ((clean - lo) / (hi - lo)) * box.height
    ticks.push({ y, label: fmtCompact(clean) })
  }
  return ticks
}

function categoriesToLabels(categories: string[], box: PlotBox, minGap: number): XLabel[] {
  const n = categories.length
  if (n === 0) return []
  const slot = box.width / n
  const maxLabels = Math.max(2, Math.min(n, Math.floor(box.width / minGap)))
  const stride = Math.max(1, Math.ceil(n / maxLabels))
  const labels: XLabel[] = []
  for (let i = 0; i < n; i += stride) {
    const x = box.width === 0 ? box.left : box.left + slot * (i + 0.5)
    labels.push({ x, text: /^\d{4}-\d{2}-\d{2}$/.test(categories[i]) ? fmtShortDate(categories[i]) : categories[i] })
  }
  return labels
}

function plotBox(width: number, height: number): PlotBox {
  const left = MARGIN.left
  const top = MARGIN.top
  const right = width - MARGIN.right
  const bottom = height - MARGIN.bottom
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

export function barGeometry(chart: ChartData, options: ChartOptions = {}): BarGeometry {
  const width = options.width ?? DEFAULT_WIDTH
  const height = options.height ?? DEFAULT_HEIGHT
  const box = plotBox(width, height)
  const domain = yDomain(chart.values)
  const [lo, hi] = domain
  const scaleY = (value: number) => box.top + box.height - ((value - lo) / (hi - lo)) * box.height
  const baseline = scaleY(0)

  const n = chart.categories.length
  const slot = n > 0 ? box.width / n : box.width
  const barWidth = Math.max(2, slot * 0.62)

  const bars: BarMark[] = []
  for (let i = 0; i < n; i++) {
    const value = chart.values[i]
    if (value == null || !Number.isFinite(value)) continue
    const y = scaleY(value)
    bars.push({
      x: box.left + slot * i + (slot - barWidth) / 2,
      y: Math.min(y, baseline),
      width: barWidth,
      height: Math.max(1, Math.abs(baseline - y)),
      category: chart.categories[i],
      value,
      index: i,
      highlight: chart.highlight === i,
    })
  }

  return {
    kind: 'bar',
    width,
    height,
    plot: box,
    baseline,
    yTicks: axisTicks(domain, box),
    xLabels: categoriesToLabels(chart.categories, box, 42),
    label: chart.label,
    unit: chart.unit,
    empty: bars.length === 0,
    domain,
    bars,
  }
}

export function lineGeometry(chart: ChartData, options: ChartOptions = {}): LineGeometry {
  const width = options.width ?? DEFAULT_WIDTH
  const height = options.height ?? DEFAULT_HEIGHT
  const box = plotBox(width, height)
  const domain = yDomain(chart.values)
  const [lo, hi] = domain
  const scaleY = (value: number) => box.top + box.height - ((value - lo) / (hi - lo)) * box.height
  const baseline = scaleY(0)
  const n = chart.categories.length
  const step = n > 1 ? box.width / (n - 1) : 0

  const points: PointMark[] = []
  let path = ''
  let areaPath = ''
  let runStart: PointMark | null = null
  let runStartIndex = -1
  let previous: PointMark | null = null

  for (let i = 0; i < n; i++) {
    const value = chart.values[i]
    if (value == null || !Number.isFinite(value)) {
      // Break the line rather than implying a value we do not have.
      if (previous) areaPath += ` L ${previous.x.toFixed(2)} ${baseline.toFixed(2)} Z`
      previous = null
      runStart = null
      continue
    }
    const x = n > 1 ? box.left + step * i : box.left + box.width / 2
    const point: PointMark = {
      x,
      y: scaleY(value),
      category: chart.categories[i],
      value,
      index: i,
      highlight: chart.highlight === i,
    }
    points.push(point)

    if (!previous) {
      path += ` M ${x.toFixed(2)} ${point.y.toFixed(2)}`
      areaPath += ` M ${x.toFixed(2)} ${point.y.toFixed(2)}`
      runStart = point
      runStartIndex = i
    } else {
      path += ` L ${x.toFixed(2)} ${point.y.toFixed(2)}`
      areaPath += ` L ${x.toFixed(2)} ${point.y.toFixed(2)}`
    }
    previous = point
  }
  if (previous) areaPath += ` L ${previous.x.toFixed(2)} ${baseline.toFixed(2)} Z`
  void runStart
  void runStartIndex

  const highlightPoint = points.find((p) => p.highlight) ?? null

  return {
    kind: 'line',
    width,
    height,
    plot: box,
    baseline,
    yTicks: axisTicks(domain, box),
    xLabels: categoriesToLabels(chart.categories, box, 64),
    label: chart.label,
    unit: chart.unit,
    empty: points.length === 0,
    domain,
    points,
    path: path.trim(),
    areaPath: areaPath.trim(),
    highlightPoint,
  }
}

export function geometryFor(chart: ChartData, options: ChartOptions = {}): Geometry {
  return chart.kind === 'line' ? lineGeometry(chart, options) : barGeometry(chart, options)
}
