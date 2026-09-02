#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiCaller, RecordingCaller, ReplayCaller, type ModelCaller, type RecordedSession } from "./caller.js";
import { classifyDocument, DEFAULT_MODEL } from "./loop.js";
import type { Category, DocSource } from "./types.js";

/*
 * filing-agent <docs-dir> [--categories <file>] [--model <id>]
 *              [--record <session.json>] [--replay <session.json>]
 *              [--out <dir>]
 *
 * Reads .txt documents (and doc-intake .json sidecars) from a directory,
 * runs the agent on each, and writes one receipt per document plus a
 * summary to stdout.
 *
 * Auth for live runs comes from the environment (ANTHROPIC_API_KEY, or
 * anything else the SDK resolves). --replay needs no credentials at all.
 */

function usage(): never {
  console.error(
    "usage: filing-agent <docs-dir> [--categories file.json] [--model id] [--record out.json] [--replay session.json] [--out receipts]",
  );
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

async function loadDocs(dir: string): Promise<DocSource[]> {
  const docs: DocSource[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const p = path.join(dir, name);
    if (name.endsWith(".txt")) {
      const text = await readFile(p, "utf8");
      docs.push({ name, text, sha256: sha256(text) });
    } else if (name.endsWith(".json")) {
      // a doc-intake sidecar: { text, record, ... }
      const side = JSON.parse(await readFile(p, "utf8")) as { text?: string };
      if (typeof side.text === "string") {
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) usage();

  const model = flag(args, "--model") ?? DEFAULT_MODEL;
  const outDir = flag(args, "--out") ?? "receipts";
  const categoriesFile = flag(args, "--categories");
  const recordFile = flag(args, "--record");
  const replayFile = flag(args, "--replay");

  const categories: Category[] = categoriesFile
    ? (JSON.parse(await readFile(categoriesFile, "utf8")) as Category[])
    : DEFAULT_CATEGORIES;

  let caller: ModelCaller;
  let recorder: RecordingCaller | null = null;

  if (replayFile) {
    const session = JSON.parse(await readFile(replayFile, "utf8")) as RecordedSession;
    caller = new ReplayCaller(session);
  } else {
    caller = apiCaller(new Anthropic());
    if (recordFile) {
      recorder = new RecordingCaller(caller, `filing-agent session over ${dir}`);
      caller = recorder;
    }
  }

  const docs = await loadDocs(dir);
  if (docs.length === 0) {
    console.error(`no .txt documents or sidecars found in ${dir}`);
    process.exit(2);
  }

  await mkdir(outDir, { recursive: true });
  let anyHuman = false;

  for (const doc of docs) {
    const { receipt } = await classifyDocument(doc, { caller, categories, model });
    const receiptPath = path.join(outDir, `${doc.name}.receipt.json`);
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");

    const o = receipt.outcome;
    if (o.kind === "filed") {
      console.log(
        `filed   ${doc.name} -> ${o.verdict.category}  (confidence ${o.verdict.confidence}, ` +
          `${receipt.calls.length} calls, $${receipt.cost_usd ?? "?"})`,
      );
    } else {
      anyHuman = true;
      console.log(`human   ${doc.name}  (${o.reason})`);
    }
  }

  if (recorder && recordFile) {
    await writeFile(recordFile, JSON.stringify(recorder.session, null, 2) + "\n", "utf8");
    console.log(`recorded session -> ${recordFile}`);
  }

  process.exit(anyHuman ? 1 : 0);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
