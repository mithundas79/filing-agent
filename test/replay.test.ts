import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RecordingCaller, ReplayCaller, type ModelCaller } from "../src/caller.js";
import { classifyDocument } from "../src/loop.js";
import type { Category, DocSource } from "../src/types.js";

const CATS: Category[] = [{ key: "supplier-invoices", description: "Bills to pay" }];

const TEXT = "Northwind Supplies\nInvoice No: NW-2026-0481\nTotal Due 677.04";
const doc: DocSource = {
  name: "northwind.txt",
  text: TEXT,
  sha256: createHash("sha256").update(TEXT).digest("hex"),
};

let seq = 0;
function msg(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: `msg_r_${++seq}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
  } as Anthropic.Message;
}

const script: Anthropic.Message[] = [
  msg([{ type: "tool_use", id: "tu_1", name: "read_document", input: {} } as Anthropic.ToolUseBlock]),
  msg([
    {
      type: "tool_use",
      id: "tu_2",
      name: "record_verdict",
      input: {
        category: "supplier-invoices",
        vendor: "Northwind Supplies",
        summary: "Vendor invoice for 677.04",
        confidence: 0.9,
        evidence: ["Total Due 677.04"],
      },
    } as Anthropic.ToolUseBlock,
  ]),
];

class OnceCaller implements ModelCaller {
  private s = [...script];
  async create(): Promise<Anthropic.Message> {
    const m = this.s.shift();
    if (!m) throw new Error("exhausted");
    return m;
  }
}

describe("record and replay", () => {
  it("a recorded session replays to the identical outcome with no live caller", async () => {
    const recorder = new RecordingCaller(new OnceCaller(), "test session");
    const live = await classifyDocument(doc, { caller: recorder, categories: CATS });
    expect(live.receipt.outcome.kind).toBe("filed");
    expect(recorder.session.exchanges).toHaveLength(2);

    const replay = new ReplayCaller(structuredClone(recorder.session));
    const replayed = await classifyDocument(doc, { caller: replay, categories: CATS });
    expect(replayed.receipt.outcome).toEqual(live.receipt.outcome);
    expect(replayed.receipt.calls.map((c) => c.request_id)).toEqual(
      live.receipt.calls.map((c) => c.request_id),
    );
  });

  it("replay refuses to continue when the conversation drifts from the recording", async () => {
    const recorder = new RecordingCaller(new OnceCaller(), "test session");
    await classifyDocument(doc, { caller: recorder, categories: CATS });

    const replay = new ReplayCaller(structuredClone(recorder.session));
    // different retry budget changes the conversation shape mid-run
    await expect(async () => {
      // consume first exchange normally, then force a mismatched second request
      await replay.create({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] });
      await replay.create({
        model: "m",
        max_tokens: 1,
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: "y" },
        ],
      });
    }).rejects.toThrow(/drift/);
  });
});
