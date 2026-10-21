import { createHash } from "node:crypto";
import type { ModelCaller } from "../src/caller.js";
import type { ContentBlock, Message, MessageCreateParams, ToolUseBlock } from "../src/model.js";

export const TEXT = "Northwind Supplies\nInvoice No: NW-2026-0481\nTotal Due 677.04";
export const DOC = { name: "northwind.txt", text: TEXT, sha256: createHash("sha256").update(TEXT).digest("hex") };
export const CATS = [{ key: "supplier-invoices", description: "Bills to pay" }];
export const VERDICT = { category: "supplier-invoices", vendor: "Northwind Supplies",
  summary: "Vendor invoice for 677.04", confidence: 0.9, evidence: ["Total Due 677.04"] };
let seq = 0;
export function tool(name: string, input: unknown): ToolUseBlock {
  return { type: "tool_use", id: `test_${++seq}`, name, input };
}
export function message(content: ContentBlock[], stop_reason: Message["stop_reason"] = "tool_use"): Message {
  return { id: `response_${++seq}`, role: "assistant", model: "test-model", content, stop_reason,
    usage: { input_tokens: 10, output_tokens: 5 } };
}
export function scripted(responses: unknown[]): ModelCaller & { requests: MessageCreateParams[] } {
  const requests: MessageCreateParams[] = [];
  return { requests, async create(params) {
    requests.push(structuredClone(params));
    if (!responses.length) throw new Error("test script exhausted");
    return responses.shift() as Message;
  } };
}
