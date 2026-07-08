/**
 * Shared timing helpers for the run pipeline.
 *
 * Every phase logs a `console.debug` line with a duration and records a User
 * Timing `measure` — Baseline, worker-available — so the phase shows in the
 * DevTools Performance panel and is readable via
 * `performance.getEntriesByType('measure')` / a `PerformanceObserver`.
 */

/** Compact duration: `85ms` under 1s, else `9.2s`. */
export function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Record a User Timing `measure` named `name` spanning `start`→now. `labels`
 * become string `detail` fields; `numbers` become numeric `detail` fields and
 * are shown (formatted) as track properties. Best-effort — never throws (an
 * engine may lack `measure`, or reject a `detail` that isn't structured-
 * cloneable); the caller's `console.debug` still carries the duration.
 *
 * `detail.devtools` is Chrome's Performance-panel extensibility API: it groups
 * these into a labeled "@actcore/web-runtime" track. Other engines ignore it.
 */
export function measurePhase(
  name: string,
  start: number,
  labels: Record<string, string>,
  numbers?: Record<string, number>,
): void {
  try {
    const properties: Array<[string, string]> = [
      ...Object.entries(labels),
      ...Object.entries(numbers ?? {}).map(([k, v]): [string, string] => [k, fmtDuration(v)]),
    ];
    performance.measure(name, {
      start,
      detail: {
        ...labels,
        ...numbers,
        devtools: {
          dataType: 'track-entry',
          track: '@actcore/web-runtime',
          color: 'primary',
          properties,
          tooltipText: name,
        },
      },
    });
  } catch {
    // User Timing unavailable or `detail` not cloneable — ignore.
  }
}
