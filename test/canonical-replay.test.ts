import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RecordingCaller, ReplayCaller } from "../src/caller.js";
import { requestFingerprint } from "../src/fingerprint.js";
import { classifyDocument } from "../src/loop.js";
import type { MessageCreateParams } from "../src/model.js";
import { TOOLS } from "../src/tools.js";
import { CATS, DOC, VERDICT, message, scripted, tool } from "./helpers.js";

const params: MessageCreateParams = {
  model: "test-model", max_tokens: 123, system: "You are a filing agent.", tools: structuredClone(TOOLS),
  messages: [{ role: "user", content: "Classify northwind.txt" }],
  context: { document: DOC, categories: CATS, min_confidence: 0.6, max_retries: 3, max_iterations: 10 },
};
const mutations: Array<[string, (p: MessageCreateParams) => void]> = [
  ["model", (p) => { p.model = "other-model"; }],
  ["token limit", (p) => { p.max_tokens++; }],
  ["system prompt", (p) => { p.system += " Changed"; }],
  ["same-count conversation text", (p) => { p.messages[0]!.content = "Classify altered.txt"; }],
  ["document text", (p) => { p.context!.document.text += "\nMATERIAL CHANGE"; }],
  ["document name", (p) => { p.context!.document.name = "other.txt"; }],
  ["document hash", (p) => { p.context!.document.sha256 = "other"; }],
  ["categories", (p) => { p.context!.categories[0]!.description += "changed"; }],
  ["confidence policy", (p) => { p.context!.min_confidence = 0.8; }],
  ["tool schema property", (p) => { p.tools![2]!.input_schema.properties.vendor = { type: "number" }; }],
  ["tool schema required", (p) => { p.tools![2]!.input_schema.required = ["vendor", "number"]; }],
  ["tool schema extra fields", (p) => { p.tools![2]!.input_schema.additionalProperties = true; }],
  ["tool description", (p) => { p.tools![0]!.description += " changed"; }],
  ["tool name", (p) => { p.tools![0]!.name = "another_name"; }],
];

describe("canonical request replay", () => {
  it.each(mutations)("rejects drift in %s alone", async (_label, mutate) => {
    const recorder = new RecordingCaller(scripted([message([tool("record_verdict", VERDICT)])]), "scripted unit test");
    await recorder.create(structuredClone(params));
    const changed = structuredClone(params); mutate(changed);
    await expect(new ReplayCaller(recorder.session).create(changed)).rejects.toThrow(/replay drift/);
  });
  it("normalizes object key order without discarding array order", () => {
    const reordered = { messages: params.messages, context: params.context, tools: params.tools,
      system: params.system, max_tokens: params.max_tokens, model: params.model };
    expect(requestFingerprint(reordered)).toBe(requestFingerprint(params));
    const changed = structuredClone(params); changed.tools!.reverse();
    expect(requestFingerprint(changed)).not.toBe(requestFingerprint(params));
  });
  it("snapshots both responses and replay inputs against mutation", async () => {
    const response = message([tool("record_verdict", VERDICT)]);
    const recorder = new RecordingCaller(scripted([response]), "scripted unit test");
    await recorder.create(params); response.id = "mutated";
    const replay = new ReplayCaller(recorder.session);
    recorder.session.exchanges[0]!.request_sha256 = "0".repeat(64);
    const result = await replay.create(params);
    expect(result.id).not.toBe("mutated");
    replay.assertComplete();
    await expect(replay.create(params)).rejects.toThrow(/exhausted/);
  });
  it("detects unused exchanges at the session boundary", async () => {
    const recorder = new RecordingCaller(scripted([message([tool("record_verdict", VERDICT)])]), "scripted unit test");
    await recorder.create(params);
    expect(() => new ReplayCaller(recorder.session).assertComplete()).toThrow(/unused exchanges/);
  });
  it("rejects a changed document at the first loop call before tools read it", async () => {
    const recorder = new RecordingCaller(scripted([message([tool("record_verdict", VERDICT)])]), "scripted unit test");
    await classifyDocument(DOC, { caller: recorder, categories: CATS });
    const { receipt } = await classifyDocument({ ...DOC, text: DOC.text + " changed" },
      { caller: new ReplayCaller(recorder.session), categories: CATS });
    expect(receipt.outcome.kind).toBe("error");
    expect(receipt.diagnostics[0]?.code).toBe("replay_drift");
    expect(receipt.calls).toHaveLength(0);
  });
});

describe("honest legacy compatibility", () => {
  it("requires opt-in for both untouched historical recordings", async () => {
    for (const file of ["fixtures/session.northwind.json", "demo/src/session.live.json"]) {
      const legacy: unknown = JSON.parse(await readFile(file, "utf8"));
      expect(() => new ReplayCaller(legacy)).toThrow(/legacy recording/);
      expect(new ReplayCaller(legacy, { allowLegacy: true }).replayVerification).toBe("legacy-unverified");
    }
  });
  it("routes an accepted historical verdict to human review and labels its receipt", async () => {
    const response = message([tool("record_verdict", VERDICT)]);
    const replay = new ReplayCaller({ recorded_at: new Date().toISOString(), note: "synthetic legacy test",
      exchanges: [{ request_digest: { model: "qwen2.5:7b", message_count: 1, tool_names: TOOLS.map((t) => t.name) }, response }] },
      { allowLegacy: true });
    const { receipt } = await classifyDocument(DOC, { caller: replay, categories: CATS });
    expect(receipt.outcome.kind).toBe("human");
    expect(receipt.replay_verification).toBe("legacy-unverified");
    expect(receipt.diagnostics[0]?.code).toBe("legacy_unverified");
    replay.assertComplete();
  });
  it.each([null, {}, { format_version: 3, recorded_at: "date", note: "", exchanges: [] },
    { format_version: 2, fingerprint_algorithm: "wrong", recorded_at: "date", note: "", exchanges: [] }])(
    "rejects an invalid recording %#", (recording) => expect(() => new ReplayCaller(recording)).toThrow());
});
