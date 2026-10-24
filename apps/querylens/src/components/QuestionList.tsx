import { fmtBytes, fmtMs, QUESTIONS } from '@labs/data-core'
import type { RunRecord } from '../lib/useLens'

interface Props {
  runs: Record<string, RunRecord>
  selected: string
  select: (id: string) => void
}

export function QuestionList({ runs, selected, select }: Props) {
  return (
    <nav className="questions" aria-label="Questions">
      <ol>
        {QUESTIONS.map((question, index) => {
          const run = runs[question.id]
          const state = run?.status ?? 'idle'
          const isSelected = selected === question.id
          return (
            <li key={question.id}>
              <button
                type="button"
                className={`question ${isSelected ? 'question--active' : ''}`}
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => select(question.id)}
              >
                <span className="question__index">{String(index + 1).padStart(2, '0')}</span>
                <span className="question__body">
                  <span className="question__title">{question.title}</span>
                  <span className="question__meta">
                    <span className={`dot dot--${state}`} aria-hidden="true" />
                    {state === 'done' && run?.metrics
                      ? `${fmtMs(run.metrics.engineMs)} · ${
                          run.metrics.bytesFetched === 0 && run.metrics.bytesFromCache > 0
                            ? '0 B cached'
                            : fmtBytes(run.metrics.bytesFetched)
                        }`
                      : state === 'running'
                        ? run?.progress
                          ? `${run.progress.done}/${run.progress.total} ${run.progress.label}`
                          : 'running…'
                        : state === 'failed'
                          ? 'failed'
                          : `${question.columns.length} column${question.columns.length === 1 ? '' : 's'}`}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
