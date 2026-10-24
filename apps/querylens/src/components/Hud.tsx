import { fmt1, fmtBytes, fmtInt, fmtMs } from '@labs/data-core'
import type { RunMetrics } from '../lib/protocol'

/**
 * Share of the corpus, at enough precision to stay honest.
 *
 * `fmt1` renders a real 0.017% as "0.0%", which reads as "this read nothing". Anything
 * under 1% gets significant digits instead, so a 2,822-byte query says 0.006% rather than
 * claiming zero.
 */
function formatShare(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return '0'
  if (pct < 0.01) return pct.toFixed(4)
  if (pct < 0.1) return pct.toFixed(3)
  if (pct < 1) return pct.toFixed(2)
  return fmt1(pct)
}

export function Hud({ metrics, renderMs }: { metrics: RunMetrics; renderMs?: number }) {
  const corpusPct =
    metrics.corpusBytes > 0 ? (metrics.bytesFetched / metrics.corpusBytes) * 100 : 0
  const headRequests = Math.max(0, metrics.requests - metrics.rangedResponses)

  return (
    <div className="hud" aria-live="off">
      <div className="hud__grid">
        <div className="hud__cell hud__cell--lead">
          <span className="hud__label">transfer</span>
          <span className="hud__value">{fmtBytes(metrics.bytesFetched)}</span>
          <span className="hud__hint">
            {formatShare(corpusPct)}% of {fmtBytes(metrics.corpusBytes)} corpus
          </span>
        </div>
        <div className="hud__cell">
          <span className="hud__label">requests</span>
          <span className="hud__value">{fmtInt(metrics.requests)}</span>
          <span className="hud__hint">
            {metrics.rangedResponses} × 206 · {headRequests} × head
          </span>
        </div>
        <div className="hud__cell">
          <span className="hud__label">engine</span>
          <span className="hud__value">{fmtMs(metrics.engineMs)}</span>
          <span className="hud__hint">
            {fmtMs(metrics.fetchParseMs)} fetch+parse · {fmtMs(metrics.aggregateMs)} aggregate
          </span>
        </div>
        <div className="hud__cell">
          <span className="hud__label">render</span>
          <span className="hud__value">{renderMs == null ? '…' : fmtMs(renderMs)}</span>
          <span className="hud__hint">result → painted frame</span>
        </div>
        <div className="hud__cell">
          <span className="hud__label">rows read</span>
          <span className="hud__value">{fmtInt(metrics.rowsRead)}</span>
          <span className="hud__hint">
            {metrics.files} partition{metrics.files === 1 ? '' : 's'}
          </span>
        </div>
        <div className="hud__cell">
          <span className="hud__label">columns</span>
          <span className="hud__value">
            {metrics.columnsRead}/{metrics.columnsTotal}
          </span>
          <span className="hud__hint">column pruning</span>
        </div>
      </div>

      <div className="hud__notes">
        {metrics.bytesFromCache > 0 ? (
          <span className="chip chip--good">
            + {fmtBytes(metrics.bytesFromCache)} served from cache
          </span>
        ) : null}
        {metrics.footerCacheHits > 0 ? (
          <span className="chip">footer cached ×{metrics.footerCacheHits}</span>
        ) : (
          <span className="chip">footer fetched</span>
        )}
        {metrics.fullBodyResponses > 0 ? (
          <span className="chip chip--bad">
            {metrics.fullBodyResponses} full-object response(s) — the origin ignored Range
          </span>
        ) : (
          <span className="chip chip--good">every data request was a byte range</span>
        )}
      </div>
    </div>
  )
}
