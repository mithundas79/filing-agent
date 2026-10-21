import type { Message } from "./model.js";
import { AgentFailure, isJson, isObject, nonemptyString, tokenCount } from "./runtime.js";

/** A caller's TypeScript return type is not a runtime trust boundary. */
export function validateMessage(value: unknown): asserts value is Message {
  const fail = (field: string): never => {
    throw new AgentFailure("invalid_response", `malformed model response: ${field}`);
  };
  if (!isObject(value)) fail("expected an object");
  const r = value as Record<string, unknown>;
  if (!nonemptyString(r.id)) fail("id must be a nonempty string");
  if (r.role !== "assistant") fail("role must be assistant");
  if (!nonemptyString(r.model)) fail("model must be a nonempty string");
  if (r.stop_reason !== null && !["end_turn", "tool_use", "max_tokens", "refusal", "pause_turn"].includes(r.stop_reason as string)) {
    fail("unknown stop_reason");
  }
  if (!isObject(r.usage) || !tokenCount(r.usage.input_tokens) || !tokenCount(r.usage.output_tokens)) {
    fail("usage must contain nonnegative safe integer token counts");
  }
  if (!Array.isArray(r.content)) fail("content must be an array");
  const ids = new Set<string>();
  let toolCount = 0;
  for (const block of r.content as unknown[]) {
    if (!isObject(block)) fail("content blocks must be objects");
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      if (typeof b.text !== "string") fail("text block text must be a string");
    } else if (b.type === "tool_use") {
      if (!nonemptyString(b.id) || !nonemptyString(b.name)) fail("tool id/name must be nonempty strings");
      if (ids.has(b.id as string)) fail("duplicate tool id");
      ids.add(b.id as string);
      if (!Object.hasOwn(b, "input") || !isJson(b.input)) fail("tool input must be a JSON value");
      toolCount++;
    } else {
      fail("unknown content block type");
    }
  }
  if (r.stop_reason === "tool_use" && toolCount === 0) fail("tool_use stop reason requires a tool call");
}
