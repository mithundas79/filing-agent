import { createHash, randomUUID } from "node:crypto";
import type { ModelCaller } from "./caller.js";
import type { MessageParam, ToolResultBlockParam, ToolUseBlock } from "./model.js";
import { costUsd } from "./pricing.js";
import { EmptyFiledIndex, executeTool, TOOLS, type FiledIndex } from "./tools.js";
import type { CallTrace, Category, DocSource, Outcome, Receipt, ToolTrace, Verdict } from "./types.js";
import { validateVerdict } from "./validate.js";

/*
 * The agent loop. The model decides which tools to call and what the
 * document is; this code decides everything else - what a verdict must
 * look like, how many chances the model gets, when a person takes over,
 * and what goes in the receipt.
 *
 * Design rules the loop enforces:
 *   - the receipt is written here, around the model, never by it
 *   - a rejected verdict comes back as a tool error with the reasons,
 *     bounded by maxRetries; after that, a person takes over
 *   - a refusal or an unproductive run routes to a person, never to a
 *     silent fallback model: a different model is a different provenance
 *     record
 *   - all parallel tool calls are answered in a single user message
 */

export interface AgentOptions {
  caller: ModelCaller;
  categories: Category[];
  model?: string;
  filed?: FiledIndex;
  minConfidence?: number;
  maxIterations?: number;
  maxRetries?: number;
}

export const DEFAULT_MODEL = "qwen2.5:7b";

const SYSTEM = `You are a filing agent for business documents. Your job is to decide
which category one document belongs to, or to hand it to a person.

Rules you work under:
- Read the document with read_document before anything else.
- The category must be one of the keys returned by list_categories.
- Every evidence entry in your verdict must be a VERBATIM quote from the
  document: copy the exact characters of a line you saw, do not paraphrase,
  do not fix spelling, do not merge lines. Your verdict is checked by code;
  a quote that is not in the document is rejected.
- If you are not confident, or anything looks wrong, call flag_for_human.
  Asking for help is a correct outcome, not a failure.
- You must finish by calling record_verdict or flag_for_human.`;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface RunResult {
  receipt: Receipt;
}

export async function classifyDocument(doc: DocSource, opts: AgentOptions): Promise<RunResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const filed = opts.filed ?? new EmptyFiledIndex();
  const minConfidence = opts.minConfidence ?? 0.6;
  const maxIterations = opts.maxIterations ?? 10;
  const maxRetries = opts.maxRetries ?? 3;

  const startedAt = new Date().toISOString();
  const calls: CallTrace[] = [];
  const toolTraces: ToolTrace[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let retries = 0;
  let nudged = false;
  let outcome: Outcome | null = null;

  const messages: MessageParam[] = [
    {
      role: "user",
      content:
        `Classify the document named "${doc.name}". Use the tools, then finish ` +
        `with record_verdict or flag_for_human.`,
    },
  ];

  for (let i = 0; i < maxIterations && outcome === null; i++) {
    const response = await opts.caller.create({
      model,
      max_tokens: 4096,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    calls.push({
      request_id: response.id,
      model: response.model,
      stop_reason: response.stop_reason,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      outcome = { kind: "human", reason: "the model declined to process this document; a person should look" };
      break;
    }
    if (response.stop_reason === "max_tokens") {
      outcome = { kind: "error", reason: "response hit the token ceiling before finishing" };
      break;
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      if (!nudged) {
        nudged = true;
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: "You have not finished. Call record_verdict or flag_for_human.",
        });
        continue;
      }
      outcome = { kind: "error", reason: "the model ended twice without a verdict or a flag" };
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const results: ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      let resultText: string;
      let isError = false;

      if (use.name === "flag_for_human") {
        const reason = (use.input as { reason?: string }).reason ?? "no reason given";
        outcome = { kind: "human", reason };
        resultText = "Flagged. A person will review this document.";
      } else if (use.name === "record_verdict") {
        const verdict = use.input as Verdict;
        const failures = validateVerdict(verdict, opts.categories, doc.text, minConfidence);
        if (failures.length === 0) {
          outcome = { kind: "filed", verdict };
          resultText = "Verdict accepted.";
        } else if (retries < maxRetries) {
          retries++;
          isError = true;
          resultText = JSON.stringify({
            rejected: failures,
            note: `attempt ${retries} of ${maxRetries + 1}; fix the problems or call flag_for_human`,
          });
        } else {
          outcome = {
            kind: "human",
            reason:
              "verdict failed validation after " +
              `${retries + 1} attempts: ` +
              failures.map((f) => `${f.field}: ${f.problem}`).join("; "),
          };
          resultText = "Verdict rejected; the document goes to a person.";
        }
      } else {
        resultText = executeTool(use.name, use.input, doc, opts.categories, filed);
      }

      toolTraces.push({
        tool: use.name,
        input_sha256: sha256(JSON.stringify(use.input ?? {})),
        result_sha256: sha256(resultText),
        is_error: isError,
      });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: resultText,
        ...(isError ? { is_error: true } : {}),
      });
    }

    // Every tool_use answered in ONE user message, errors included.
    messages.push({ role: "user", content: results });
  }

  if (outcome === null) {
    outcome = { kind: "error", reason: "iteration limit reached without a verdict" };
  }

  const receipt: Receipt = {
    run_id: randomUUID(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    document: { name: doc.name, sha256: doc.sha256 },
    model,
    calls,
    tools: toolTraces,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost_usd: costUsd(model, inputTokens, outputTokens),
    retries,
    outcome,
  };

  return { receipt };
}
