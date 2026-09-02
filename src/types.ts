/** A category the agent may file a document under. */
export interface Category {
  key: string;
  description: string;
}

/** The document being classified. */
export interface DocSource {
  /** Basename shown in receipts and prompts. */
  name: string;
  /** Full text of the document (from OCR or a sidecar). */
  text: string;
  /** sha256 of the text, computed by us - never by the model. */
  sha256: string;
}

/** What the model must produce to finish successfully. */
export interface Verdict {
  category: string;
  vendor: string | null;
  summary: string;
  /** 0..1; below the configured threshold the document goes to a person. */
  confidence: number;
  /** Verbatim quotes from the document that ground the classification. */
  evidence: string[];
}

/** Why a verdict was refused by deterministic validation. */
export interface ValidationFailure {
  field: string;
  problem: string;
}

export type Outcome =
  | { kind: "filed"; verdict: Verdict }
  | { kind: "human"; reason: string }
  | { kind: "error"; reason: string };

/** One tool invocation as observed by the loop - inputs and results are hashed. */
export interface ToolTrace {
  tool: string;
  input_sha256: string;
  result_sha256: string;
  is_error: boolean;
}

/** One API call as observed by the loop. */
export interface CallTrace {
  /** Provider-issued message id - the model cannot forge this. */
  request_id: string;
  model: string;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
}

/**
 * The receipt is written by the controller around the model, never by the
 * model. A self-reported "done" is not evidence.
 */
export interface Receipt {
  run_id: string;
  started_at: string;
  finished_at: string;
  document: { name: string; sha256: string };
  model: string;
  calls: CallTrace[];
  tools: ToolTrace[];
  usage: { input_tokens: number; output_tokens: number };
  /** USD, computed from the pricing table; null when the model is unknown. */
  cost_usd: number | null;
  retries: number;
  outcome: Outcome;
}
