import { createHash } from "node:crypto";
import type { MessageCreateParams } from "./model.js";
import { AgentFailure, isJson } from "./runtime.js";

/** JSON object keys are sorted; array order and every scalar are material. */
export function canonicalJson(value: unknown): string {
  if (!isJson(value)) throw new AgentFailure("invalid_request", "request must contain only finite JSON values");
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, sort(item)]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function requestFingerprint(params: MessageCreateParams): string {
  // Normalize absent optional fields; transport cancellation is deliberately
  // passed separately and is never part of a model request.
  return createHash("sha256").update(canonicalJson({
    model: params.model,
    max_tokens: params.max_tokens,
    system: params.system ?? null,
    tools: params.tools ?? [],
    messages: params.messages,
    context: params.context ?? null,
  })).digest("hex");
}
