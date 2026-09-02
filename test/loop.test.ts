import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ModelCaller } from "../src/caller.js";
import { classifyDocument } from "../src/loop.js";
import type { Category, DocSource } from "../src/types.js";

/*
 * The loop is tested with a scripted caller: each entry is the next
 * assistant message the "model" produces. That keeps the tests
 * deterministic and free, and it pins the loop's contract precisely -
 * including the parts that only matter when the model misbehaves.
 */

const CATS: Category[] = [
  { key: "supplier-invoices", description: "Bills to pay" },
  { key: "receipts", description: "Payments made" },
];

const TEXT = `Northwind Supplies
Invoice No: NW-2026-0481
Total Due 677.04`;

const doc: DocSource = {
  name: "northwind.txt",
  text: TEXT,
  sha256: createHash("sha256").update(TEXT).digest("hex"),
};

let msgSeq = 0;
function msg(content: Anthropic.ContentBlock[], stop_reason: Anthropic.Message["stop_reason"] = "tool_use"): Anthropic.Message {
  msgSeq++;
  return {
    id: `msg_test_${msgSeq}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 } as Anthropic.Usage,
  } as Anthropic.Message;
}

const toolUse = (name: string, input: unknown, id?: string): Anthropic.ToolUseBlock =>
  ({ type: "tool_use", id: id ?? `tu_${name}_${++msgSeq}`, name, input }) as Anthropic.ToolUseBlock;

const text = (t: string): Anthropic.TextBlock =>
  ({ type: "text", text: t, citations: null }) as Anthropic.TextBlock;

class ScriptedCaller implements ModelCaller {
  requests: Anthropic.MessageCreateParams[] = [];
  constructor(private script: Anthropic.Message[]) {}
  async create(params: Anthropic.MessageCreateParams): Promise<Anthropic.Message> {
    this.requests.push(structuredClone(params));
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted - the loop called more often than scripted");
    return next;
  }
}

const GOOD_VERDICT = {
  category: "supplier-invoices",
  vendor: "Northwind Supplies",
  summary: "Vendor invoice from Northwind for 677.04",
  confidence: 0.9,
  evidence: ["Total Due 677.04"],
};

describe("classifyDocument", () => {
  it("runs tools, accepts a grounded verdict, and writes a full receipt", async () => {
    const caller = new ScriptedCaller([
      msg([text("Reading."), toolUse("read_document", {}), toolUse("list_categories", {})]),
      msg([toolUse("record_verdict", GOOD_VERDICT)]),
    ]);

    const { receipt } = await classifyDocument(doc, { caller, categories: CATS });

    expect(receipt.outcome.kind).toBe("filed");
    expect(receipt.calls).toHaveLength(2);
    expect(receipt.calls[0]!.request_id).toMatch(/^msg_test_/);
    expect(receipt.retries).toBe(0);
    expect(receipt.usage).toEqual({ input_tokens: 200, output_tokens: 100 });
    expect(receipt.cost_usd).toBeCloseTo((200 * 5 + 100 * 25) / 1_000_000, 6);
    expect(receipt.document.sha256).toBe(doc.sha256);
    expect(receipt.tools.map((t) => t.tool)).toEqual([
      "read_document",
      "list_categories",
      "record_verdict",
    ]);
    for (const t of receipt.tools) {
      expect(t.input_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(t.result_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("answers parallel tool calls in one user message", async () => {
    const caller = new ScriptedCaller([
      msg([toolUse("read_document", {}), toolUse("list_categories", {})]),
      msg([toolUse("record_verdict", GOOD_VERDICT)]),
    ]);

    await classifyDocument(doc, { caller, categories: CATS });

    const second = caller.requests[1]!;
    const lastUser = second.messages[second.messages.length - 1]!;
    expect(lastUser.role).toBe("user");
    const blocks = lastUser.content as Anthropic.ToolResultBlockParam[];
    expect(blocks.filter((b) => b.type === "tool_result")).toHaveLength(2);
  });

  it("rejects fabricated evidence, lets the model correct itself, and counts the retry", async () => {
    const caller = new ScriptedCaller([
      msg([toolUse("read_document", {})]),
      msg([toolUse("record_verdict", { ...GOOD_VERDICT, evidence: ["Total Due 999.99"] })]),
      msg([toolUse("record_verdict", GOOD_VERDICT)]),
    ]);

    const { receipt } = await classifyDocument(doc, { caller, categories: CATS });

    expect(receipt.outcome.kind).toBe("filed");
    expect(receipt.retries).toBe(1);

    // the rejection went back as a tool error, not as acceptance
    const third = caller.requests[2]!;
    const lastUser = third.messages[third.messages.length - 1]!;
    const blocks = lastUser.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]!.is_error).toBe(true);
    expect(String(blocks[0]!.content)).toContain("not found in the document");
  });

  it("hands the document to a person when retries are exhausted", async () => {
    const bad = { ...GOOD_VERDICT, evidence: ["Total Due 999.99"] };
    const caller = new ScriptedCaller([
      msg([toolUse("read_document", {})]),
      msg([toolUse("record_verdict", bad)]),
      msg([toolUse("record_verdict", bad)]),
      msg([toolUse("record_verdict", bad)]),
    ]);

    const { receipt } = await classifyDocument(doc, { caller, categories: CATS, maxRetries: 2 });

    expect(receipt.outcome.kind).toBe("human");
    expect(receipt.outcome.kind === "human" && receipt.outcome.reason).toContain("3 attempts");
  });

  it("treats flag_for_human as a correct terminal outcome", async () => {
    const caller = new ScriptedCaller([
      msg([toolUse("flag_for_human", { reason: "looks like a duplicate" })]),
    ]);
    const { receipt } = await classifyDocument(doc, { caller, categories: CATS });
    expect(receipt.outcome).toEqual({ kind: "human", reason: "looks like a duplicate" });
  });

  it("nudges once when the model stops without finishing, then gives up", async () => {
    const caller = new ScriptedCaller([
      msg([text("I think this is an invoice.")], "end_turn"),
      msg([text("Indeed.")], "end_turn"),
    ]);
    const { receipt } = await classifyDocument(doc, { caller, categories: CATS });
    expect(receipt.outcome.kind).toBe("error");
    expect(caller.requests).toHaveLength(2);
  });

  it("routes a model refusal to a person, never to another model", async () => {
    const caller = new ScriptedCaller([msg([], "refusal")]);
    const { receipt } = await classifyDocument(doc, { caller, categories: CATS });
    expect(receipt.outcome.kind).toBe("human");
    expect(receipt.calls[0]!.stop_reason).toBe("refusal");
  });

  it("stops at the iteration limit instead of looping forever", async () => {
    const endless = Array.from({ length: 10 }, () => msg([toolUse("read_document", {})]));
    const caller = new ScriptedCaller(endless);
    const { receipt } = await classifyDocument(doc, { caller, categories: CATS, maxIterations: 4 });
    expect(receipt.outcome.kind).toBe("error");
    expect(receipt.calls).toHaveLength(4);
  });
});
