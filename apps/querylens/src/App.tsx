import { useEffect, useMemo, useState } from 'react'
import { fmt1, fmtBytes, fmtInt, fmtMs, QUESTIONS, questionById } from '@labs/data-core'
import { Chart } from './components/Chart'
import { Hud } from './components/Hud'
import { QuestionList } from './components/QuestionList'
import { ResultTable } from './components/ResultTable'
import { RANGES, useLens } from './lib/useLens'

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = () => setReduced(query.matches)
    query.addEventListener('change', handler)
    return () => query.removeEventListener('change', handler)
  }, [])
  return reduced
}

export default function App() {
  const lens = useLens()
  const question = questionById(lens.selected)
  const run = lens.runs[lens.selected]
  const reducedMotion = usePrefersReducedMotion()

  const completed = useMemo(
    () =>
      QUESTIONS.map((q) => ({ question: q, run: lens.runs[q.id] }))
        .filter((entry) => entry.run?.status === 'done' && entry.run.metrics)
        .map((entry) => ({ question: entry.question, run: entry.run! })),
    [lens.runs],
  )

  const totalBytes = completed.reduce((sum, entry) => sum + (entry.run.metrics?.bytesFetched ?? 0), 0)
  const totalMs = completed.reduce((sum, entry) => sum + (entry.run.metrics?.engineMs ?? 0), 0)

  return (
    <div className="page">
      <header className="masthead">
        <p className="eyebrow">querylens · client-side analytics</p>
        <h1>Ten questions about US domestic flights, answered inside your browser.</h1>
        <p className="lede">
          No server runs a query here. This page reads byte ranges out of partitioned Parquet files
          in Cloudflare R2 and aggregates the rows in a Web Worker. Every answer reports what it
          cost: bytes transferred, requests issued, engine time, and how much of the dataset it
          touched.
        </p>
        <p className="lede lede--small">
          Watch the <strong>transfer</strong> line under each answer. A two-column question over
          three months reads about 5% of this corpus; a one-column question reads less, and fewer
          partitions read fewer bytes still. That is Parquet column pruning and partitioning,
          measured per query rather than claimed on a slide.
        </p>

        <div className="pills">
          {lens.manifest ? (
            <>
              <span className="pill pill--strong">{lens.manifest.dataset.name}</span>
              <span className="pill">{fmtInt(lens.manifest.totals.rows)} rows</span>
              <span className="pill">{lens.manifest.totals.files} files</span>
              <span className="pill">{fmtBytes(lens.manifest.totals.bytes)}</span>
              <span className="pill">
                {lens.manifest.dataset.columns.length} columns
              </span>
              {lens.manifest.dataset.synthetic ? (
                <span className="pill pill--warn">synthetic fixture — not real flight records</span>
              ) : null}
            </>
          ) : lens.manifestError ? (
            <span className="pill pill--warn">dataset unreachable: {lens.manifestError}</span>
          ) : (
            <span className="pill">loading dataset manifest…</span>
          )}
        </div>
      </header>

      <section className="controls" aria-label="Query scope">
        <div className="controls__group">
          <span className="controls__label">partitions</span>
          {RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`toggle ${lens.range === option.key ? 'toggle--on' : ''}`}
              onClick={() => lens.setRange(option.key)}
              aria-pressed={lens.range === option.key}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="controls__group controls__group--right">
          <span className="controls__label">{lens.rangeSummary}</span>
          <button
            type="button"
            className="button"
            onClick={() => void lens.runAll()}
            disabled={lens.busy || !lens.manifest}
          >
            {lens.busy ? 'running…' : 'Run all ten'}
          </button>
          <button type="button" className="button button--ghost" onClick={lens.reset}>
            Reset
          </button>
        </div>
      </section>

      <div className="layout">
        <aside className="sidebar">
          <QuestionList runs={lens.runs} selected={lens.selected} select={lens.select} />
        </aside>

        <main className="panel">
          <header className="panel__head">
            <h2>{question.title}</h2>
            <p className="caption">{question.caption}</p>
            <p className="footprint">
              reads {question.columns.length} of {lens.manifest?.dataset.columns.length ?? 13}{' '}
              columns:{' '}
              {question.columns.map((column) => (
                <code key={column}>{column}</code>
              ))}
            </p>
          </header>

          <div className="panel__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => void lens.runOne(question.id)}
              disabled={lens.busy || !lens.manifest}
            >
              {run?.status === 'done' ? 'Run again' : 'Run this question'}
            </button>
            {run?.rangeLabel ? <span className="muted">scope: {run.rangeLabel}</span> : null}
          </div>

          {run?.status === 'running' ? (
            <p className="progress">
              reading {run.progress?.done ?? 0}/{run.progress?.total ?? 0} partitions ·{' '}
              {run.progress?.label ?? 'starting'}
            </p>
          ) : null}

          {run?.status === 'failed' ? (
            <p className="error">
              Query failed: {run.error}. If this is the first run, check that the data origin is
              serving <code>{question.columns[0]}</code> from{' '}
              <code>VITE_DATA_BASE</code>.
            </p>
          ) : null}

          {run?.status === 'done' && run.result ? (
            <>
              <p className="headline">{run.result.headline}</p>
              {run.result.chart ? <Chart chart={run.result.chart} /> : null}
              <ResultTable table={run.result.table} />
              {run.result.note ? <p className="note">{run.result.note}</p> : null}
              {run.metrics ? <Hud metrics={run.metrics} renderMs={run.renderMs} /> : null}
            </>
          ) : null}

          {!run && reducedMotion ? (
            <div className="poster">
              <p className="note">
                Reduced motion is on, so nothing has been queried. Run it to execute the real one.
              </p>
              {question.chart === 'table' ? (
                <p className="empty">This question renders a table, so there is no precomputed chart.</p>
              ) : (
                <img
                  src={`/fallback/${question.id}.svg`}
                  alt={`${question.title} — precomputed result`}
                />
              )}
            </div>
          ) : null}

          {!run && !reducedMotion ? (
            <p className="empty">
              Nothing has run yet. The Parquet reader is not downloaded until you ask a question.
            </p>
          ) : null}
        </main>
      </div>

      <section className="log" aria-label="Query log">
        <header className="log__head">
          <h2>Query log</h2>
          <p className="muted">
            {completed.length}/{QUESTIONS.length} answered · {fmtBytes(totalBytes)} transferred ·{' '}
            {fmtMs(totalMs)} engine time
          </p>
        </header>
        {completed.length === 0 ? (
          <p className="empty">Run a question to populate the log.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">question</th>
                  <th scope="col" className="right">transfer</th>
                  <th scope="col" className="right">% of corpus</th>
                  <th scope="col" className="right">engine</th>
                  <th scope="col" className="right">render</th>
                  <th scope="col" className="right">rows</th>
                  <th scope="col" className="right">requests</th>
                </tr>
              </thead>
              <tbody>
                {completed.map(({ question: q, run: record }) => {
                  const metrics = record.metrics!
                  const pct =
                    metrics.corpusBytes > 0 ? (metrics.bytesFetched / metrics.corpusBytes) * 100 : 0
                  return (
                    <tr key={q.id} onClick={() => lens.select(q.id)} className="log__row">
                      <td>{q.title}</td>
                      <td className="right">{fmtBytes(metrics.bytesFetched)}</td>
                      <td className="right">{fmt1(pct)}%</td>
                      <td className="right">{fmtMs(metrics.engineMs)}</td>
                      <td className="right">{record.renderMs == null ? '—' : fmtMs(record.renderMs)}</td>
                      <td className="right">{fmtInt(metrics.rowsRead)}</td>
                      <td className="right">{fmtInt(metrics.requests)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="footer">
        <h2>How this works, and what it does not claim</h2>
        <ul>
          <li>
            <strong>Architecture.</strong> Partitioned Parquet (SNAPPY) in object storage, a static
            front end on Cloudflare Pages, one Web Worker holding a pure-JavaScript Parquet reader
            (<code>hyparquet</code>, ~65 kB). No WebAssembly engine, no query server, no database.
          </li>
          <li>
            <strong>Why there is no SQL box.</strong> The SQL path (DuckDB-WASM) cost +6.45 MiB of
            WebAssembly and +101.6 ms per query against JavaScript aggregation on identical input,
            measured in this repo's spike. It buys syntax only, so it is not shipped. Querylens is a
            query engine with canned questions, not “SQL in the browser”.
          </li>
          <li>
            <strong>What is measured.</strong> Bytes and request counts come from this app's own
            range source, which counts each response's <code>Content-Length</code> and its status
            (206 vs 200) — not from client resource timing, which under-reported the engine bundle
            by two orders of magnitude in the spike.
          </li>
          <li>
            <strong>The data.</strong> The current corpus is a synthetic fixture shaped like the
            BTS On-Time Performance schema, published so the architecture can be measured without
            shipping a 400 MB download. Numbers on this page are real measurements of this fixture.
          </li>
          <li>
            <strong>Published bad number.</strong> Under 4× CPU throttling and an 8 Mbps profile the
            same queries degrade by roughly 7×. Volunteering the slow number is more useful than
            hiding it.
          </li>
        </ul>
      </footer>
    </div>
  )
}
