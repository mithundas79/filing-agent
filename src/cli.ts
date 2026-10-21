#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ollamaCaller, RecordingCaller, ReplayCaller, type ModelCaller } from "./caller.js";
import { classifyDocument, DEFAULT_MODEL, DEFAULT_CALL_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS } from "./loop.js";
import { AgentFailure, errorMessage, isObject } from "./runtime.js";
import type { Category, DocSource, Receipt } from "./types.js";

const HELP = `usage: filing-agent <docs-dir> [--categories file.json] [--model id]
  [--record out.json | --replay session.json] [--allow-legacy-replay]
  [--out receipts] [--host url] [--call-timeout-ms 120000]
  [--run-timeout-ms 600000] [--max-iterations 10] [--max-retries 3]
Exit codes: 0 all filed; 1 human review; 2 run/configuration/storage error.
SIGINT/SIGTERM cancel the active model call and persist its error receipt.`;

function argumentsFor(args: string[]): { dir: string; values: Map<string, string>; legacy: boolean } {
  const flags = new Set(["--categories", "--model", "--record", "--replay", "--out", "--host",
    "--call-timeout-ms", "--run-timeout-ms", "--max-iterations", "--max-retries"]);
  const values = new Map<string, string>();
  let legacy = false;
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--allow-legacy-replay") { legacy = true; continue; }
    if (flags.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--") || values.has(arg)) throw new Error(`missing or duplicate value for ${arg}\n${HELP}`);
      values.set(arg, value);
    } else if (arg.startsWith("--") || dir) throw new Error(`unexpected argument: ${arg}\n${HELP}`);
    else dir = arg;
  }
  if (!dir || (values.has("--record") && values.has("--replay")) || (legacy && !values.has("--replay"))) {
    throw new Error(HELP);
  }
  return { dir, values, legacy };
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
async function loadDocs(dir: string): Promise<DocSource[]> {
  const docs: DocSource[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const p = path.join(dir, name);
    if (name.endsWith(".txt")) {
      const text = await readFile(p, "utf8");
      docs.push({ name, text, sha256: sha256(text) });
    } else if (name.endsWith(".json")) {
      const side: unknown = JSON.parse(await readFile(p, "utf8"));
      if (isObject(side) && typeof side.text === "string") {
        docs.push({ name, text: side.text, sha256: sha256(side.text) });
      }
    }
  }
  return docs;
}

const DEFAULT_CATEGORIES: Category[] = [
  { key: "supplier-invoices", description: "Bills from vendors for goods or services, to be paid" },
  { key: "receipts", description: "Proof of a payment already made, card or cash" },
  { key: "bank-statements", description: "Periodic statements from a bank or card provider" },
  { key: "contracts", description: "Agreements, engagement letters, signed terms" },
  { key: "other", description: "Legitimate business documents that fit nothing above" },
];

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, file);
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) { console.log(HELP); return; }
  const { dir, values, legacy } = argumentsFor(process.argv.slice(2));
  const model = values.get("--model") ?? DEFAULT_MODEL;
  const outDir = values.get("--out") ?? "receipts";
  const categoriesFile = values.get("--categories");
  const recordFile = values.get("--record");
  const replayFile = values.get("--replay");
  const categories = categoriesFile ? JSON.parse(await readFile(categoriesFile, "utf8")) as Category[] : DEFAULT_CATEGORIES;
  let caller: ModelCaller;
  let recorder: RecordingCaller | undefined;
  let replay: ReplayCaller | undefined;
  if (replayFile) {
    replay = new ReplayCaller(JSON.parse(await readFile(replayFile, "utf8")), { allowLegacy: legacy });
    caller = replay;
    if (legacy) console.error("UNVERIFIED LEGACY REPLAY: request contents cannot be checked; filing is disabled.");
  } else {
    caller = ollamaCaller({ host: values.get("--host") });
    if (recordFile) { recorder = new RecordingCaller(caller, `filing-agent session over ${dir}, model ${model}`); caller = recorder; }
  }
  const docs = await loadDocs(dir);
  if (!docs.length) throw new Error(`no .txt documents or sidecars found in ${dir}`);
  await mkdir(outDir, { recursive: true });
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let exitCode = 0;
  let last: { receipt: Receipt; file: string; archive: string } | undefined;
  try {
    for (const doc of docs) {
      const { receipt } = await classifyDocument(doc, { caller, categories, model, signal: controller.signal,
        callTimeoutMs: Number(values.get("--call-timeout-ms") ?? DEFAULT_CALL_TIMEOUT_MS),
        runTimeoutMs: Number(values.get("--run-timeout-ms") ?? DEFAULT_RUN_TIMEOUT_MS),
        maxIterations: Number(values.get("--max-iterations") ?? 10), maxRetries: Number(values.get("--max-retries") ?? 3) });
      const file = path.join(outDir, `${doc.name}.receipt.json`);
      // Keep the familiar latest receipt and an immutable per-run archive.
      const archive = path.join(outDir, `${receipt.run_id}.receipt.json`);
      await atomicJson(archive, receipt);
      await atomicJson(file, receipt);
      last = { receipt, file, archive };
      const o = receipt.outcome;
      if (o.kind === "filed") console.log(`filed   ${doc.name} -> ${o.verdict.category} (confidence ${o.verdict.confidence}, ${receipt.calls.length} calls, ${receipt.retries} retries)`);
      else { console.log(`${o.kind.padEnd(7)} ${doc.name} (${o.reason})`); exitCode = Math.max(exitCode, o.kind === "error" ? 2 : 1); }
      if (controller.signal.aborted) break;
    }
    if (replay && exitCode !== 2) {
      try { replay.assertComplete(); }
      catch (error) {
        exitCode = 2;
        if (last) {
          const reason = errorMessage(error);
          last.receipt.outcome = { kind: "error", reason };
          last.receipt.diagnostics.push({ code: error instanceof AgentFailure ? error.code : "replay_error", stage: "replay", message: reason });
          await atomicJson(last.archive, last.receipt);
          await atomicJson(last.file, last.receipt);
        }
        console.error(errorMessage(error));
      }
    }
    if (recorder && recordFile) {
      await atomicJson(recordFile, recorder.session);
      console.log(`recorded session -> ${recordFile}`);
    }
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  process.exitCode = exitCode;
}
void main().catch((error) => { console.error(errorMessage(error)); process.exitCode = 2; });
