import { describe, expect, it, vi } from "vitest";
import { classifyDocument } from "../src/loop.js";
import { validateVerdict, validateToolInput } from "../src/validate.js";
import { executeTool, EmptyFiledIndex } from "../src/tools.js";
import type { Message } from "../src/model.js";
import { CATS, DOC, VERDICT, message, scripted, tool } from "./helpers.js";

describe("runtime verdict validation", () => {
  it.each([null, undefined, [], "invoice", 4, true])("rejects a non-object verdict: %j", (v) => {
    expect(validateVerdict(v, CATS, DOC.text, 0.6).length).toBeGreaterThan(0);
  });
  it.each([
    ["category", null], ["category", 1], ["vendor", undefined], ["vendor", 2], ["vendor", ""],
    ["summary", null], ["summary", 12], ["summary", []], ["summary", "  "], ["summary", "first\nsecond"],
    ["confidence", NaN], ["confidence", Infinity], ["confidence", -Infinity], ["confidence", "0.9"],
    ["evidence", null], ["evidence", "Total Due 677.04"], ["evidence", []], ["evidence", [null]],
    ["evidence", [4]], ["evidence", [{}]], ["evidence", [""]], ["evidence", ["   "]],
    ["evidence", ["Total Due 677.04", null]],
  ])("rejects malformed %s=%j without throwing", (field, value) => {
    expect(validateVerdict({ ...VERDICT, [field as string]: value }, CATS, DOC.text, 0.6)
      .some((f) => f.field === field)).toBe(true);
  });
  it("rejects unexpected properties and accepts a null vendor", () => {
    expect(validateVerdict({ ...VERDICT, vendor: null }, CATS, DOC.text, 0.6)).toEqual([]);
    expect(validateVerdict({ ...VERDICT, done: true }, CATS, DOC.text, 0.6)).not.toEqual([]);
  });
});

describe("model response validation in the real controller", () => {
  const good = message([tool("record_verdict", VERDICT)]);
  it.each([
    null, [], 5, {}, { ...good, content: null }, { ...good, content: [null] },
    { ...good, content: [{ type: "text", text: 2 }] }, { ...good, content: [{ type: "mystery" }] },
    { ...good, id: null }, { ...good, model: 4 }, { ...good, role: "user" },
    { ...good, stop_reason: "unknown" }, { ...good, usage: null },
    { ...good, usage: { input_tokens: NaN, output_tokens: 1 } },
    { ...good, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...good, usage: { input_tokens: 1.5, output_tokens: 1 } },
    { ...good, content: [{ type: "tool_use", id: "a", name: 3, input: {} }] },
    { ...good, content: [{ type: "tool_use", id: "a", name: "read_document" }] },
    { ...good, content: [{ type: "tool_use", id: "a", name: "read_document", input: { x: Infinity } }] },
    { ...good, content: [] },
  ])("returns a diagnostic receipt for malformed response %#", async (response) => {
    const { receipt } = await classifyDocument(DOC, { caller: scripted([response]), categories: CATS });
    expect(receipt.outcome.kind).toBe("error");
    expect(receipt.diagnostics[0]?.code).toBe("invalid_response");
    expect(receipt.diagnostics[0]?.request_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.finished_at).toBeTruthy();
  });
  it("rejects duplicate call IDs, cycles and non-JSON inputs", async () => {
    const use = tool("read_document", {});
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const blocks of [[use, use], [tool("read_document", cycle)], [tool("read_document", 1n)]]) {
      const { receipt } = await classifyDocument(DOC, { caller: scripted([message(blocks)]), categories: CATS });
      expect(receipt.diagnostics[0]?.code).toBe("invalid_response");
    }
  });
});

describe("tool inputs and failures", () => {
  it.each([
    ["read_document", null], ["read_document", []], ["read_document", { unexpected: 1 }],
    ["list_categories", { extra: true }], ["check_duplicates", {}], ["check_duplicates", { vendor: 2 }],
    ["check_duplicates", { vendor: "a", number: null }], ["check_duplicates", { vendor: "a", number: 4 }],
    ["flag_for_human", null], ["flag_for_human", { reason: 2 }], ["flag_for_human", { reason: "" }],
    ["unknown", {}], ["__proto__", {}], ["constructor", {}], ["toString", {}],
  ])("checks %s arguments before executing", (name, input) => {
    expect(validateToolInput(name as string, input).length).toBeGreaterThan(0);
  });
  it("validates exported executeTool too", () => {
    expect(() => executeTool("check_duplicates", null, DOC, CATS, new EmptyFiledIndex())).toThrow(/object/);
    expect(() => executeTool("unknown", {}, DOC, CATS, new EmptyFiledIndex())).toThrow(/unknown tool/);
  });
  it("allows a malformed tool input to be corrected with bounded feedback", async () => {
    const find = vi.fn(() => []);
    const caller = scripted([message([tool("check_duplicates", null)]), message([tool("record_verdict", VERDICT)])]);
    const { receipt } = await classifyDocument(DOC, { caller, categories: CATS, filed: { find } });
    expect(receipt.outcome.kind).toBe("filed");
    expect(receipt.retries).toBe(1);
    expect(find).not.toHaveBeenCalled();
    expect(receipt.tools[0]?.is_error).toBe(true);
    expect(receipt.tools[0]?.status).toBe("rejected");
    expect(JSON.stringify(caller.requests[1]?.messages)).toContain("tool arguments must be an object");
  });
  it("cannot accept a same-response verdict alongside rejected tool arguments", async () => {
    const caller = scripted([message([tool("read_document", null), tool("record_verdict", VERDICT)]),
      message([tool("flag_for_human", { reason: "review the malformed response" })])]);
    const { receipt } = await classifyDocument(DOC, { caller, categories: CATS });
    expect(receipt.outcome.kind).toBe("human");
    expect(caller.requests).toHaveLength(2);
  });
  it("returns a terminal receipt and error trace for a throwing tool", async () => {
    const caller = scripted([message([tool("check_duplicates", { vendor: "Northwind" })])]);
    const { receipt } = await classifyDocument(DOC, { caller, categories: CATS,
      filed: { find() { throw new Error("index unavailable"); } } });
    expect(receipt.outcome).toEqual({ kind: "error", reason: "tool check_duplicates failed: index unavailable" });
    expect(receipt.diagnostics[0]?.code).toBe("tool_error");
    expect(receipt.tools[0]?.is_error).toBe(true);
    expect(receipt.tools[0]?.status).toBe("failed");
  });
});

describe("terminal precedence", () => {
  it.each([false, true])("always honors escalation regardless of call order: %s", async (reverse) => {
    const uses = [tool("flag_for_human", { reason: "possible duplicate" }), tool("record_verdict", VERDICT)];
    const { receipt } = await classifyDocument(DOC, { caller: scripted([message(reverse ? uses.reverse() : uses)]), categories: CATS });
    expect(receipt.outcome).toEqual({ kind: "human", reason: "possible duplicate" });
    expect(receipt.tools).toHaveLength(2);
  });
  it.each([null, { reason: 7 }, { reason: "" }])("fails closed on malformed escalation %j", async (input) => {
    const { receipt } = await classifyDocument(DOC, { categories: CATS,
      caller: scripted([message([tool("flag_for_human", input), tool("record_verdict", VERDICT)])]) });
    expect(receipt.outcome.kind).toBe("human");
    expect(receipt.diagnostics[0]?.code).toBe("invalid_tool_input");
  });
  it("multiple verdicts route to a human even if both would validate", async () => {
    const { receipt } = await classifyDocument(DOC, { categories: CATS,
      caller: scripted([message([tool("record_verdict", VERDICT), tool("record_verdict", { ...VERDICT, vendor: null })])]) });
    expect(receipt.outcome.kind).toBe("human");
    expect(receipt.diagnostics[0]?.code).toBe("conflicting_terminal_calls");
  });
  it("uses the first valid reason and suppresses unrelated dependency execution", async () => {
    const find = vi.fn(() => { throw new Error("must not execute"); });
    const { receipt } = await classifyDocument(DOC, { categories: CATS, filed: { find },
      caller: scripted([message([tool("check_duplicates", { vendor: "Northwind" }),
        tool("flag_for_human", { reason: 2 }), tool("flag_for_human", { reason: "first valid" }),
        tool("flag_for_human", { reason: "second valid" })])]) });
    expect(receipt.outcome).toEqual({ kind: "human", reason: "first valid" });
    expect(find).not.toHaveBeenCalled();
    expect(receipt.tools[0]?.status).toBe("suppressed");
  });
  it.each(["refusal", "max_tokens"] as const)("does not overwrite human intent on %s", async (stop) => {
    const { receipt } = await classifyDocument(DOC, { categories: CATS,
      caller: scripted([message([tool("flag_for_human", { reason: "review" }), tool("record_verdict", VERDICT)], stop)]) });
    expect(receipt.outcome).toEqual({ kind: "human", reason: "review" });
  });
});

describe("bounded failures and cancellation", () => {
  it("returns a receipt when a provider throws", async () => {
    const { receipt } = await classifyDocument(DOC, { categories: CATS,
      caller: { async create() { throw new Error("provider unavailable"); } } });
    expect(receipt.outcome).toEqual({ kind: "error", reason: "provider unavailable" });
    expect(receipt.diagnostics[0]?.code).toBe("provider_error");
    expect(receipt.calls).toHaveLength(0);
  });
  it.each([[15, 1000, "call_timeout"], [1000, 15, "run_timeout"]] as const)("bounds calls %s/%s", async (callTimeoutMs, runTimeoutMs, code) => {
    let signal: AbortSignal | undefined;
    const { receipt } = await classifyDocument(DOC, { categories: CATS, callTimeoutMs, runTimeoutMs,
      caller: { create(_params, options) { signal = options?.signal; return new Promise<Message>(() => {}); } } });
    expect(receipt.diagnostics[0]?.code).toBe(code);
    expect(signal?.aborted).toBe(true);
  });
  it("handles pre-cancellation without invoking a provider", async () => {
    const abort = new AbortController(); abort.abort();
    const create = vi.fn();
    const { receipt } = await classifyDocument(DOC, { categories: CATS, signal: abort.signal, caller: { create } });
    expect(receipt.diagnostics[0]?.code).toBe("cancelled");
    expect(create).not.toHaveBeenCalled();
  });
  it("handles cancellation while a non-cooperative caller is pending", async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15);
    try {
      const { receipt } = await classifyDocument(DOC, { categories: CATS, signal: abort.signal,
        caller: { create() { return new Promise<Message>(() => {}); } } });
      expect(receipt.diagnostics[0]?.code).toBe("cancelled");
    } finally { clearTimeout(timer); }
  });
  it.each([{ maxIterations: Infinity }, { maxIterations: 0 }, { maxRetries: -1 }, { maxRetries: 0.5 },
    { callTimeoutMs: 0 }, { runTimeoutMs: NaN }, { minConfidence: NaN }])("rejects invalid bounds %j", async (limits) => {
    const { receipt } = await classifyDocument(DOC, { categories: CATS, caller: scripted([]), ...limits });
    expect(receipt.diagnostics[0]?.code).toBe("configuration_error");
  });
});
