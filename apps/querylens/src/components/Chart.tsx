import { useMemo } from 'react'
import {
  barGeometry,
  fmtCompact,
  fmt1,
  lineGeometry,
  type ChartData,
  type Geometry,
} from '@labs/data-core'

function describe(chart: ChartData, geo: Geometry): string {
  if (geo.empty) return `${chart.label}: no data`
  const best = chart.values.reduce<{ value: number; index: number } | null>((acc, value, index) => {
    if (value == null || !Number.isFinite(value)) return acc
    if (!acc) return { value, index }
    return value > acc.value ? { value, index } : acc
  }, null)
  if (!best) return `${chart.label}: no data`
  return `${chart.label}, highest at ${chart.categories[best.index]} (${fmt1(best.value)}${chart.unit ? ` ${chart.unit}` : ''})`
}

export function Chart({ chart }: { chart: ChartData }) {
  const geo = useMemo(
    () => (chart.kind === 'line' ? lineGeometry(chart) : barGeometry(chart)),
    [chart],
  )

  if (geo.empty) return <p className="empty">No rows matched for this range.</p>

  const { plot, width, height } = geo
  const valueLabels = geo.kind === 'bar' && geo.bars.length <= 14

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={describe(chart, geo)}>
        {geo.yTicks.map((tick) => (
          <g key={`y-${tick.y.toFixed(2)}-${tick.label}`}>
            <line
              x1={plot.left}
              x2={plot.right}
              y1={tick.y}
              y2={tick.y}
              className="grid"
            />
            <text x={plot.left - 8} y={tick.y} className="axis-label" textAnchor="end" dy="0.32em">
              {tick.label}
            </text>
          </g>
        ))}

        <line
          x1={plot.left}
          x2={plot.right}
          y1={geo.baseline}
          y2={geo.baseline}
          className="baseline"
        />

        {geo.kind === 'bar'
          ? geo.bars.map((bar) => (
              <g key={`bar-${bar.index}`}>
                <rect
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  rx={2}
                  className={bar.highlight ? 'bar bar--highlight' : 'bar'}
                >
                  <title>
                    {`${bar.category}: ${fmt1(bar.value)}${chart.unit ? ` ${chart.unit}` : ''}`}
                  </title>
                </rect>
                {valueLabels ? (
                  <text
                    x={bar.x + bar.width / 2}
                    y={bar.value >= 0 ? bar.y - 5 : bar.y + bar.height + 12}
                    className="value-label"
                    textAnchor="middle"
                  >
                    {fmtCompact(bar.value)}
                  </text>
                ) : null}
              </g>
            ))
          : null}

        {geo.kind === 'line' ? (
          <>
            <path d={geo.areaPath} className="area" />
            <path d={geo.path} className="line" />
            {geo.highlightPoint ? (
              <circle
                cx={geo.highlightPoint.x}
                cy={geo.highlightPoint.y}
                r={3.5}
                className="marker"
              >
                <title>
                  {`${geo.highlightPoint.category}: ${fmt1(geo.highlightPoint.value)}${
                    chart.unit ? ` ${chart.unit}` : ''
                  }`}
                </title>
              </circle>
            ) : null}
          </>
        ) : null}

        {geo.xLabels.map((label) => (
          <text
            key={`x-${label.x.toFixed(1)}-${label.text}`}
            x={label.x}
            y={plot.bottom + 18}
            className="axis-label"
            textAnchor="middle"
          >
            {label.text}
          </text>
        ))}
      </svg>
      <figcaption>
        {chart.label}
        {chart.unit ? ` · ${chart.unit}` : ''}
      </figcaption>
    </figure>
  )
}
