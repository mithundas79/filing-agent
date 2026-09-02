/*
 * USD per million tokens, by model. Receipts must state what a run cost;
 * when the model is not in this table the receipt says null rather than
 * guessing - an unknown cost is information, a wrong cost is a lie.
 *
 * Prices as published June 2026; update alongside the model default.
 */

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING: Record<string, Pricing> = {
  "claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  "claude-sonnet-5": { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const usd = (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
  return Number(usd.toFixed(6));
}
