import {
  DATA_BASE,
  probeEngine,
  probeFullBody,
  probeHyparquet,
  probeTransport,
  serverLog,
  sumBytes,
  type ProbeResult,
} from './probes'
import { probeHybrid } from './probe-engine'
import './style.css'

const report = document.querySelector<HTMLPreElement>('#report')!
const table = document.querySelector<HTMLDivElement>('#table')!
const hud = document.querySelector<HTMLDivElement>('#hud')!
const runButton = document.querySelector<HTMLButtonElement>('#run')!

const lines: string[] = []

/** Append one line to the <pre>, so the result is readable as plain text. */
function log(line = ''): void {
  lines.push(line)
  report.textContent = lines.join('\n')
  console.log(line)
}

function setHud(text: string): void {
  hud.textContent = text
}

function renderTable(results: ProbeResult[]): void {
  const rows = results
    .map(
      (r) => `
      <tr class="v-${r.verdict}">
        <td class="q"><strong>${r.id}</strong><br />${r.question}</td>
        <td class="verdict">${r.verdict.toUpperCase()}</td>
        <td>${r.rows
          .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`)
          .join('')}</td>
      </tr>`,
    )
    .join('')
  table.innerHTML = `<table><thead><tr><th>probe</th><th>verdict</th><th>measurements</th></tr></thead><tbody>${rows}</tbody></table>`
}

async function run(): Promise<void> {
  runButton.disabled = true
  lines.length = 0
  setHud('running…')

  const results: ProbeResult[] = []

  try {
    log('=== range-request spike ===')
    log(`object: ${DATA_BASE}/flights/year=2024/month=01/data.parquet`)
    log(`origin: ${location.origin}  (cross-origin by design — this is the point)`)
    log('')

    // --- A: does the transport support partial reads? -----------------------
    setHud('probe A/B: transport…')
    log('[A] ranged GET')
    const { result: transport, totalSize } = await probeTransport()
    results.push(transport)
    for (const [k, v] of transport.rows) log(`    ${k.padEnd(26)} ${v}`)
    log(`    verdict: ${transport.verdict.toUpperCase()}`)
    log('')

    // --- B2: control — full download ---------------------------------------
    setHud('probe B2: control…')
    log('[B2] full GET (control)')
    const full = await probeFullBody(totalSize)
    results.push(full)
    for (const [k, v] of full.rows) log(`    ${k.padEnd(26)} ${v}`)
    log('')

    // --- C/D: the engine over ranges ---------------------------------------
    log('[C/D] DuckDB-WASM over HTTP ranges')
    const engine = await probeEngine((msg) => {
      setHud(msg)
      log(`    ${msg}`)
    })
    results.push(engine.result)
    for (const [k, v] of engine.result.rows) log(`    ${k.padEnd(26)} ${v}`)
    log(`    verdict: ${engine.result.verdict.toUpperCase()}`)
    log('')

    log('  per-query table (bytes are server-side, from /__log):')
    log(
      `    ${'query'.padEnd(34)} ${'rows'.padStart(5)} ${'engine'.padStart(10)} ${'requests'.padStart(9)} ${'range 206'.padStart(10)} ${'bytes'.padStart(11)} ${'vs full'.padStart(8)}`,
    )
    for (const r of engine.runs) {
      const pct = totalSize ? ((r.serverBytes / totalSize) * 100).toFixed(1) + '%' : 'n/a'
      log(
        `    ${r.label.padEnd(34)} ${String(r.rowsReturned).padStart(5)} ${(r.engineMs.toFixed(1) + ' ms').padStart(10)} ${String(r.serverRequests).padStart(9)} ${String(r.rangeRequests).padStart(10)} ${r.serverBytes.toLocaleString().padStart(11)} ${pct.padStart(8)}`,
      )
    }
    log('')

    // --- E: the fallback engine that does real range reads ------------------
    log('[E] hyparquet over explicit byte ranges')
    const hy = await probeHyparquet((msg) => {
      setHud(msg)
      log(`    ${msg}`)
    })
    results.push(hy.result)
    for (const [k, v] of hy.result.rows) log(`    ${k.padEnd(30)} ${v}`)
    log(`    verdict: ${hy.result.verdict.toUpperCase()}`)
    log('')
    log('  per-query table (bytes are server-side, from /__log):')
    log(
      `    ${'query'.padEnd(34)} ${'rows'.padStart(8)} ${'engine'.padStart(10)} ${'requests'.padStart(9)} ${'range 206'.padStart(10)} ${'bytes'.padStart(11)} ${'of whole'.padStart(9)}`,
    )
    for (const r of hy.runs) {
      const pct = ((r.serverBytes / hy.totalSize) * 100).toFixed(2) + '%'
      log(
        `    ${r.label.padEnd(34)} ${String(r.rowsReturned).padStart(8)} ${(r.engineMs.toFixed(1) + ' ms').padStart(10)} ${String(r.serverRequests).padStart(9)} ${String(r.rangeRequests).padStart(10)} ${r.serverBytes.toLocaleString().padStart(11)} ${pct.padStart(9)}`,
      )
    }
    log('')

    // --- F/G: settle the engine question ----------------------------------
    log('[F/G] JS aggregate vs fetch-then-DuckDB-SQL')
    const cmp = await probeHybrid()
    results.push(cmp.result)
    for (const [k, v] of cmp.result.rows) log(`    ${k.padEnd(36)} ${v}`)
    log(`    verdict: ${cmp.result.verdict.toUpperCase()}`)
    log('')
    log(`    F  JS aggregate, top 3 by mean dep delay: ${cmp.topA.slice(0, 3).join('  ')}`)
    log(`    G  DuckDB SQL,   top 3 by mean dep delay: ${cmp.topB.slice(0, 3).join('  ')}`)
    log('')

    // --- summary ------------------------------------------------------------
    const log2 = await serverLog()
    const totalServed = sumBytes(log2)
    const transportOk = results[0].verdict === 'pass'
    const duckOk = results[2].verdict === 'pass'
    const hyOk = hy.result.verdict === 'pass'

    log('=== verdict ===')
    log(`  transport (range requests work cross-origin): ${transportOk ? 'YES' : 'NO'}`)
    log(`  DuckDB-WASM directIO issues range reads:       ${duckOk ? 'YES' : 'NO — buffers whole object'}`)
    log(`  hyparquet prunes columns over ranges:          ${hyOk ? 'YES' : 'NO'}`)
    log(`  probes passed:        ${results.filter((r) => r.verdict === 'pass').length}/${results.length}`)
    log(`  partition size:       ${totalSize.toLocaleString()} B`)
    log(`  narrowest query cost: ${Math.min(...engine.runs.map((r) => r.serverBytes)).toLocaleString()} B`)
    log(`  widest query cost:    ${Math.max(...engine.runs.map((r) => r.serverBytes)).toLocaleString()} B`)
    log(`  bytes served since last reset: ${totalServed.toLocaleString()} B`)
    log('')
    log(
      transportOk && hyOk
        ? 'RESULT: the architecture is viable, but NOT with DuckDB-WASM as written. The browser\n' +
          'can range-read and hyparquet prunes columns, so compute stays client-side. DuckDB-WASM\n' +
          'would download every published byte per visitor, so it cannot be the engine as specified.'
        : 'RESULT: a required capability is missing. Read the failures above before building further.',
    )

    setHud(`done — transport ${transportOk ? 'ok' : 'fail'} · duckdb ${duckOk ? 'ok' : 'buffers'} · hyparquet ${hyOk ? 'ok' : 'fail'}`)
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    log(`\nERROR ${message}`)
    if (err instanceof Error && err.stack) log(err.stack)
    setHud('failed — see log')
    results.push({
      id: 'ERR',
      question: 'uncaught error',
      verdict: 'fail',
      rows: [['message', message]],
    })
  } finally {
    renderTable(results)
    runButton.disabled = false
  }
}

runButton.addEventListener('click', () => void run())

// Auto-run on load: the preview pane cannot click, and a spike should be one click
// at most. Delay is purely cosmetic so the DOM paints first.
void new Promise((r) => setTimeout(r, 150)).then(run)
