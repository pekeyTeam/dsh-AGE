/**
 * Measure what each preset actually delivers.
 *
 * A preset declares bands, and the scheduler turns them into a plan — so the
 * duty cycle a user feels is not the `budgetMsPerMinute` in the table. It is
 * whatever the plan happens to spend, and the two can differ by a factor of ten
 * in either direction. That gap is invisible from the source and only shows up
 * as "this doesn't feel as bad as it should", which is a bad way to find out.
 *
 * This is the tool that tuning is done *with*, rather than by reasoning about
 * the bands and hoping. The rule it exists to enforce: `worst 60s` should equal
 * the declared budget, because that means the ledger is the binding constraint
 * and the delivered figure is the promised one.
 *
 * Usage:
 *
 *     node scripts/measure-duty.ts [minutes]
 */

import { PRESETS, PRESET_ORDER, type PresetId } from '../src/client/presets.ts'
import { streamFor } from '../src/client/rng.ts'
import { AceScheduler } from '../src/client/scheduler.ts'
import {
  cadences, dutyCycle, SimulationHost, simulate, worstWindow,
} from '../tests/support/duty-simulation.ts'

/** Minutes of simulated time per preset. */
const MINUTES = Number(process.argv[2] ?? 30)

/** Simulate one preset and print what it delivered. */
function measure(id: PresetId): void {
  const preset = PRESETS[id]
  const host = new SimulationHost(preset.budgetMsPerMinute)
  const scheduler = new AceScheduler(preset, streamFor('measure', 'scan'), host)
  const report = simulate(scheduler, host, MINUTES * 60_000)

  const gaps = cadences(report)
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
  const longest = Math.max(0, ...report.spans.map((span) => span.end - span.start))

  console.log(
    [
      id.padEnd(7),
      `budget ${((preset.budgetMsPerMinute / 60_000) * 100).toFixed(0).padStart(3)}%`,
      `delivered ${(dutyCycle(report) * 100).toFixed(1).padStart(4)}%`,
      `hitches ${String(report.spans.length).padStart(4)}`,
      `cadence ${(mean(gaps) / 1000).toFixed(1).padStart(5)}s`,
      `longest ${(longest / 1000).toFixed(1)}s`,
      `worst 60s ${(worstWindow(report, 60_000) / 1000).toFixed(1).padStart(4)}s`,
      `refused ${String(report.refused).padStart(4)}`,
      `scans ${String(report.scans).padStart(4)}`,
      `bursts/scan ${(report.plannedHitches / Math.max(1, report.scans)).toFixed(1)}`,
    ].join('  '),
  )
}

console.log(`Simulating ${MINUTES} minutes per preset\n`)
for (const id of PRESET_ORDER) measure(id)
console.log('\nworst 60s == budget means the ledger is what binds at the peak.')
