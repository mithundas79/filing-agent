import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ollamaCaller } from "../src/caller.js";
import { classifyDocument } from "../src/loop.js";
import type { Receipt } from "../src/types.js";
import { startProviderStub, type ProviderStub } from "../scripts/provider-stub.js";
import { CATS, DOC } from "./helpers.js";

let stub: ProviderStub;
let temporary: string;
beforeAll(async () => { stub = await startProviderStub(); temporary = await mkdtemp(path.join(process.cwd(), ".test-http-")); });
afterAll(async () => { await stub.close(); await rm(temporary, { recursive: true, force: true }); });

async function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI test exceeded 10 seconds")); }, 10_000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

async function inputDir(label: string): Promise<string> {
  const dir = path.join(temporary, label); await mkdir(dir);
  await writeFile(path.join(dir, DOC.name), DOC.text); return dir;
}

const scenarios = [
  ["success", "filed", undefined, 0], ["validation", "human", "invalid_tool_input", 1],
  ["human", "human", undefined, 1], ["malformed", "error", "invalid_response", 2],
  ["invalid-json", "error", "invalid_response", 2], ["null", "error", "invalid_response", 2],
  ["wrong-tool-shape", "error", "invalid_response", 2], ["failure", "error", "provider_error", 2],
  ["disconnect", "error", "provider_error", 2], ["timeout", "error", "call_timeout", 2],
  ["body-timeout", "error", "call_timeout", 2],
] as const;

describe("real loop through local HTTP Ollama protocol stub (not live model)", () => {
  it.each(scenarios)("handles %s", async (scenario, outcome, code) => {
    const { receipt } = await classifyDocument(DOC, { categories: CATS,
      caller: ollamaCaller({ host: `${stub.host}/${scenario}` }), callTimeoutMs: 100, maxRetries: 1 });
    expect(receipt.outcome.kind).toBe(outcome);
    if (code) expect(receipt.diagnostics.some((d) => d.code === code)).toBe(true);
    if (scenario === "success") {
      expect(receipt.calls).toHaveLength(2);
      expect(receipt.usage).toEqual({ input_tokens: 200, output_tokens: 50 });
      expect(receipt.tools.map((t) => t.tool)).toEqual(["read_document", "list_categories", "record_verdict"]);
      const request = stub.requests.find((r) => r.scenario === scenario)!;
      expect(request.body.stream).toBe(false);
      expect(request.body.tools).toHaveLength(5);
      expect((request.body.messages as Array<{ role: string }>)[0]?.role).toBe("system");
      expect(request.body).not.toHaveProperty("context");
    }
  });
});

describe("separate-process CLI with local HTTP provider stub", () => {
  it.each(scenarios)("persists receipts and documented exit code for %s", async (scenario, outcome, code, exitCode) => {
    const dir = await inputDir(`cli-${scenario}`); const out = path.join(temporary, `out-${scenario}`);
    const result = await cli([dir, "--out", out, "--host", `${stub.host}/${scenario}`, "--call-timeout-ms", "200", "--max-retries", "1"]);
    expect(result.code, result.stderr).toBe(exitCode);
    const receipt: Receipt = JSON.parse(await readFile(path.join(out, `${DOC.name}.receipt.json`), "utf8"));
    expect(receipt.outcome.kind).toBe(outcome);
    if (code) expect(receipt.diagnostics.some((d) => d.code === code)).toBe(true);
    const archived: Receipt = JSON.parse(await readFile(path.join(out, `${receipt.run_id}.receipt.json`), "utf8"));
    expect(archived).toEqual(receipt);
    expect((await readdir(out)).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(result.stdout).toContain(outcome);
  });
  it("records real stub exchanges, replays with the provider unavailable, and rejects changed content", async () => {
    const dir = await inputDir("record-docs"); const record = path.join(temporary, "stub-session.json");
    const first = await cli([dir, "--out", path.join(temporary, "record-out"), "--host", `${stub.host}/success`, "--record", record]);
    expect(first.code, first.stderr).toBe(0);
    const recorded = JSON.parse(await readFile(record, "utf8"));
    expect(recorded.format_version).toBe(2);
    expect(recorded.exchanges).toHaveLength(2);
    const replayOut = path.join(temporary, "replay-out");
    const replay = await cli([dir, "--out", replayOut, "--host", "http://127.0.0.1:1", "--replay", record]);
    expect(replay.code, replay.stderr).toBe(0);
    const receipt = JSON.parse(await readFile(path.join(replayOut, `${DOC.name}.receipt.json`), "utf8"));
    expect(receipt.replay_verification).toBe("canonical-v2");
    await writeFile(path.join(dir, DOC.name), DOC.text + "\nCHANGED TOTAL");
    const changedOut = path.join(temporary, "changed-out");
    const changed = await cli([dir, "--out", changedOut, "--replay", record]);
    expect(changed.code, changed.stderr).toBe(2);
    const rejected = JSON.parse(await readFile(path.join(changedOut, `${DOC.name}.receipt.json`), "utf8"));
    expect(rejected.diagnostics[0].code).toBe("replay_drift");
    expect(rejected.calls).toHaveLength(0);
  });
  it("keeps earlier receipts when a batch later fails and gives errors exit-code precedence", async () => {
    const dir = await inputDir("batch-docs"); await writeFile(path.join(dir, "second.txt"), DOC.text);
    const out = path.join(temporary, "batch-out");
    const result = await cli([dir, "--out", out, "--host", `${stub.host}/mixed`]);
    expect(result.code).toBe(2);
    expect(JSON.parse(await readFile(path.join(out, `${DOC.name}.receipt.json`), "utf8")).outcome.kind).toBe("human");
    expect(JSON.parse(await readFile(path.join(out, "second.txt.receipt.json"), "utf8")).outcome.kind).toBe("error");
  });
  it("rejects historical sessions by default and explicitly labels legacy inspection", async () => {
    const dir = await inputDir("legacy-docs");
    await writeFile(path.join(dir, "northwind-invoice.txt"), await readFile("fixtures/docs/northwind-invoice.txt"));
    await rm(path.join(dir, DOC.name));
    const strict = await cli([dir, "--out", path.join(temporary, "strict-legacy"), "--replay", "fixtures/session.northwind.json"]);
    expect(strict.code).toBe(2); expect(strict.stderr).toContain("legacy recording");
    const out = path.join(temporary, "legacy-out");
    const permissive = await cli([dir, "--out", out, "--replay", "fixtures/session.northwind.json", "--allow-legacy-replay"]);
    expect(permissive.code, permissive.stderr).toBe(1); expect(permissive.stderr).toContain("UNVERIFIED");
    const receipt = JSON.parse(await readFile(path.join(out, "northwind-invoice.txt.receipt.json"), "utf8"));
    expect(receipt.outcome.kind).toBe("human"); expect(receipt.replay_verification).toBe("legacy-unverified");
  });
  it("preserves each run's receipt when the same document is processed again", async () => {
    const dir = await inputDir("repeated-docs"); const out = path.join(temporary, "repeated-out");
    for (let n = 0; n < 2; n++) expect((await cli([dir, "--out", out, "--host", `${stub.host}/success`])).code).toBe(0);
    const files = await readdir(out); expect(files.filter((f) => f.endsWith(".receipt.json"))).toHaveLength(3);
  });
  it("persists a total-run deadline receipt independently of the call timeout", async () => {
    const dir = await inputDir("run-timeout-docs"); const out = path.join(temporary, "run-timeout-out");
    const result = await cli([dir, "--out", out, "--host", `${stub.host}/timeout`,
      "--call-timeout-ms", "5000", "--run-timeout-ms", "50"]);
    expect(result.code).toBe(2);
    const receipt = JSON.parse(await readFile(path.join(out, `${DOC.name}.receipt.json`), "utf8"));
    expect(receipt.diagnostics[0].code).toBe("run_timeout");
  });
  it("persists invalid runtime-limit configuration as a diagnostic without contacting the provider", async () => {
    const dir = await inputDir("config-docs"); const out = path.join(temporary, "config-out");
    const before = stub.requests.length;
    expect((await cli([dir, "--out", out, "--host", `${stub.host}/success`, "--max-iterations", "Infinity"])).code).toBe(2);
    const receipt = JSON.parse(await readFile(path.join(out, `${DOC.name}.receipt.json`), "utf8"));
    expect(receipt.diagnostics[0].code).toBe("configuration_error");
    expect(stub.requests).toHaveLength(before);
  });
  it("rejects unused recorded exchanges and updates the persisted receipt", async () => {
    const dir = await inputDir("unused-docs"); const record = path.join(temporary, "unused-session.json");
    expect((await cli([dir, "--out", path.join(temporary, "unused-first"), "--host", `${stub.host}/success`, "--record", record])).code).toBe(0);
    const session = JSON.parse(await readFile(record, "utf8"));
    session.exchanges.push(session.exchanges[0]); await writeFile(record, JSON.stringify(session));
    const out = path.join(temporary, "unused-out");
    expect((await cli([dir, "--out", out, "--replay", record])).code).toBe(2);
    const receipt = JSON.parse(await readFile(path.join(out, `${DOC.name}.receipt.json`), "utf8"));
    expect(receipt.outcome.kind).toBe("error");
    expect(receipt.diagnostics.at(-1).code).toBe("replay_unused");
  });
  it.skipIf(process.platform === "win32")("persists cancellation after SIGTERM interrupts an in-flight CLI request", async () => {
    const dir = await inputDir("cancel-docs"); const out = path.join(temporary, "cancel-out");
    const before = stub.requests.length;
    const child = spawn(process.execPath, ["dist/cli.js", dir, "--out", out, "--host", `${stub.host}/timeout`],
      { cwd: process.cwd(), stdio: "ignore" });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    try {
      await expect.poll(() => stub.requests.length, { timeout: 5000 }).toBeGreaterThan(before);
      child.kill("SIGTERM");
      expect(await closed).toBe(2);
      const receipt = JSON.parse(await readFile(path.join(out, `${DOC.name}.receipt.json`), "utf8"));
      expect(receipt.diagnostics[0].code).toBe("cancelled");
    } finally { child.kill(); }
  });
});
