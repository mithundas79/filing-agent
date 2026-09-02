/*
 * USD per million tokens, by model. Local open-weights models served by
 * Ollama have no per-token price, so the table is empty by default and the
 * receipt's cost_usd is null - which is the honest value: an unknown cost
 * is information, a wrong cost is a lie. Point the caller seam at a hosted
 * API and this table is where its prices go.
 */

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING: Record<string, Pricing> = {};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const usd = (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
  return Number(usd.toFixed(6));
}
