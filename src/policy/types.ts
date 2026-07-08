export type Decision = 'allow' | 'deny' | 'ask';

export interface ResourceOp {
  capId: string;
  key: string;
  action: string;
  attrs: unknown;
}

export interface ConsentAsk {
  componentRef: string;
  digest: string;
  capId: string;
  op: ResourceOp;
  description?: string;
  risk?: 'low' | 'normal' | 'destructive';
}

export interface Verdict {
  allow: boolean;
  remember: 'once' | 'session' | 'always';
}

/** Operator PolicyConfig: `{ default?, "<capId|glob*>": mode | { mode, allow, deny } }`. */
export type PolicyConfig = Record<string, unknown>;

export interface AuditRecord {
  ts: number;
  componentRef: string;
  digest: string;
  capId: string;
  op: ResourceOp;
  decision: 'allow' | 'deny' | 'ask-allow' | 'ask-deny';
  mode?: string;
  actor: 'static' | 'user' | 'policy';
  reason?: string;
  transport: 'builtin';
}
