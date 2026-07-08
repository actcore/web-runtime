import type { AuditRecord } from './types.js';

export type AuditSink = (r: AuditRecord) => void;

/**
 * Wraps the embedder's optional `onAudit` sink. Defaults to `console.debug`.
 * A throwing/absent sink must never break enforcement, so all calls are
 * swallowed defensively.
 */
export function makeAuditor(sink: AuditSink | undefined): AuditSink {
  const target: AuditSink =
    sink ?? ((r) => console.debug('[@actcore/web-runtime] policy', r));
  return (r: AuditRecord) => {
    try {
      target(r);
    } catch {
      /* audit failures must not affect the decision */
    }
  };
}
