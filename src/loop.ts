import { createHash, randomUUID } from "node:crypto";
import type { ModelCaller } from "./caller.js";
import type { Message, MessageCreateParams, MessageParam, ToolResultBlockParam, ToolUseBlock } from "./model.js";
import { requestFingerprint } from "./fingerprint.js";
import { validateMessage } from "./model-validation.js";
import { costUsd } from "./pricing.js";
import { AgentFailure, errorMessage, isObject, nonemptyString } from "./runtime.js";
import { EmptyFiledIndex, executeTool, TOOLS, type FiledIndex } from "./tools.js";
import type { CallTrace, Category, Diagnostic, DocSource, Outcome, Receipt, ToolTrace, Verdict } from "./types.js";
import { validateToolInput, validateVerdict } from "./validate.js";

export interface AgentOptions {
  caller: ModelCaller;
  categories: Category[];
  model?: string;
  filed?: FiledIndex;
  minConfidence?: number;
  maxIterations?: number;
  maxRetries?: number;
  /** Per-model-call timeout, including HTTP response body. Default 120 seconds. */
  callTimeoutMs?: number;
  /** Total run deadline. Default 10 minutes. */
  runTimeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_MODEL = "qwen2.5:7b";
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

export const SYSTEM = `You are a filing agent for business documents. Your job is to decide
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
export interface RunResult { receipt: Receipt }

/** Races even non-cooperating callers, and aborts fetch/recording when supported. */
async function boundedCall(caller: ModelCaller, params: MessageCreateParams, timeoutMs: number,
  timeoutCode: string, signal?: AbortSignal): Promise<Message> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    const stop = (failure: AgentFailure): void => { reject(failure); controller.abort(failure); };
    cancel = () => stop(new AgentFailure("cancelled", "run cancelled by caller"));
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => stop(new AgentFailure(timeoutCode,
      timeoutCode === "run_timeout" ? "run deadline exceeded" : `model call exceeded ${timeoutMs}ms timeout`)), timeoutMs);
  });
  try {
    if (signal?.aborted) return await stopped;
    return await Promise.race([stopped, Promise.resolve().then(() => caller.create(params, { signal: controller.signal }))]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}

export async function classifyDocument(doc: DocSource, opts: AgentOptions): Promise<RunResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const filed = opts.filed ?? new EmptyFiledIndex();
  const minConfidence = opts.minConfidence ?? 0.6;
  const maxIterations = opts.maxIterations ?? 10;
  const maxRetries = opts.maxRetries ?? 3;
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const runTimeoutMs = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const calls: CallTrace[] = [];
  const toolTraces: ToolTrace[] = [];
  const diagnostics: Diagnostic[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let retries = 0;
  let nudged = false;
  let outcome: Outcome | null = null;
  let iteration = 0;
  let requestHash: string | undefined;

  const diagnostic = (code: string, stage: Diagnostic["stage"], message: string, tool?: string): void => {
    diagnostics.push({ code, stage, message, iteration, ...(tool ? { tool } : {}),
      ...(requestHash ? { request_sha256: requestHash } : {}) });
  };
  const checkDeadline = (): void => {
    if (opts.signal?.aborted) throw new AgentFailure("cancelled", "run cancelled by caller");
    if (performance.now() - started >= runTimeoutMs) throw new AgentFailure("run_timeout", "run deadline exceeded");
  };
  const messages: MessageParam[] = [{ role: "user", content:
    `Classify the document named "${doc.name}". Use the tools, then finish with record_verdict or flag_for_human.` }];

  try {
    if (!nonemptyString(model) || !opts.caller || typeof opts.caller.create !== "function" ||
      !Array.isArray(opts.categories) || opts.categories.length === 0 ||
      !opts.categories.every((c) => isObject(c) && nonemptyString(c.key) && nonemptyString(c.description)) ||
      new Set(opts.categories.map((c) => c.key)).size !== opts.categories.length ||
      !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1 ||
      !Number.isSafeInteger(maxIterations) || maxIterations < 1 ||
      !Number.isSafeInteger(maxRetries) || maxRetries < 0 ||
      ![callTimeoutMs, runTimeoutMs].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647)) {
      throw new AgentFailure("configuration_error", "invalid model, categories, limits or caller; timeouts must be positive integer milliseconds");
    }
    if (opts.caller.replayVerification === "legacy-unverified") {
      diagnostic("legacy_unverified", "replay", "historical recording lacks request contents; any filing decision requires human review");
    }
    for (iteration = 1; iteration <= maxIterations && outcome === null; iteration++) {
      checkDeadline();
      const params: MessageCreateParams = {
        model, max_tokens: 4096, system: SYSTEM, tools: TOOLS, messages,
        context: { document: { ...doc }, categories: opts.categories, min_confidence: minConfidence,
          max_retries: maxRetries, max_iterations: maxIterations },
      };
      requestHash = requestFingerprint(params);
      const remaining = runTimeoutMs - (performance.now() - started);
      const response = await boundedCall(opts.caller, params, Math.max(1, Math.ceil(Math.min(callTimeoutMs, remaining))),
        remaining <= callTimeoutMs ? "run_timeout" : "call_timeout", opts.signal);
      validateMessage(response);
      checkDeadline();
      calls.push({ request_id: response.id, request_sha256: requestHash, model: response.model,
        stop_reason: response.stop_reason, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const flags = toolUses.filter((u) => u.name === "flag_for_human");
      const verdicts = toolUses.filter((u) => u.name === "record_verdict");

      // Resolve terminal intent before executing any tool. Escalation is sticky,
      // including a malformed escalation, and conflicting verdicts fail closed.
      if (flags.length) {
        const valid = flags.find((f) => validateToolInput(f.name, f.input).length === 0);
        outcome = { kind: "human", reason: valid ? (valid.input as { reason: string }).reason :
          "model requested human review with malformed flag_for_human arguments" };
      } else if (response.stop_reason === "refusal") {
        outcome = { kind: "human", reason: "the model declined to process this document; a person should look" };
      } else if (verdicts.length > 1) {
        outcome = { kind: "human", reason: "multiple record_verdict calls in one response; a person must resolve the conflict" };
        diagnostic("conflicting_terminal_calls", "validation", outcome.reason);
      } else if (response.stop_reason === "max_tokens") {
        throw new AgentFailure("token_limit", "response hit the token ceiling before finishing");
      } else if (response.stop_reason === "pause_turn") {
        if (toolUses.length) throw new AgentFailure("invalid_response", "pause_turn cannot contain unexecuted tool calls");
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      if (!toolUses.length) {
        if (outcome) break;
        if (!nudged) {
          nudged = true;
          messages.push({ role: "assistant", content: response.content },
            { role: "user", content: "You have not finished. Call record_verdict or flag_for_human." });
          continue;
        }
        throw new AgentFailure("unfinished", "the model ended twice without a verdict or a flag");
      }
      messages.push({ role: "assistant", content: response.content });
      const results: ToolResultBlockParam[] = [];
      let proposed: Verdict | undefined;
      let rejectedBatch = false;
      for (const use of toolUses) {
        let resultText: string;
        let isError = false;
        let status: NonNullable<ToolTrace["status"]> = "executed";
        const failures = use.name === "record_verdict" ?
          validateVerdict(use.input, opts.categories, doc.text, minConfidence) : validateToolInput(use.name, use.input);
        if (outcome !== null) {
          status = use.name === "flag_for_human" && failures.length === 0 ? "executed" :
            failures.length ? "rejected" : "suppressed";
          // No dependency can overturn a terminal escalation already selected.
          isError = failures.length > 0 || use.name === "record_verdict";
          resultText = use.name === "flag_for_human" && failures.length === 0 ?
            "Flagged. A person will review this document." : "Not executed: a terminal outcome has already been selected.";
          if (failures.length) diagnostic("invalid_tool_input", "validation", JSON.stringify(failures), use.name);
        } else if (failures.length) {
          status = "rejected";
          rejectedBatch = true;
          isError = true;
          diagnostic("invalid_tool_input", "validation", JSON.stringify(failures), use.name);
          if (retries < maxRetries) {
            retries++;
            resultText = JSON.stringify({ rejected: failures,
              note: `attempt ${retries} of ${maxRetries + 1}; fix the problems or call flag_for_human` });
          } else {
            outcome = { kind: "human", reason: `tool/verdict failed validation after ${retries + 1} attempts: ` +
              failures.map((f) => `${f.field}: ${f.problem}`).join("; ") };
            resultText = "Rejected; the document goes to a person.";
          }
        } else if (use.name === "record_verdict") {
          proposed = use.input as Verdict;
          resultText = "Verdict validated; final outcome is determined after all tools in this response.";
        } else {
          try {
            checkDeadline();
            resultText = executeTool(use.name, use.input, doc, opts.categories, filed);
            checkDeadline();
          } catch (error) {
            status = "failed";
            isError = true;
            const code = error instanceof AgentFailure ? error.code : "tool_error";
            const reason = `tool ${use.name} failed: ${errorMessage(error)}`;
            diagnostic(code, "tool", reason, use.name);
            outcome = { kind: "error", reason };
            resultText = JSON.stringify({ error: reason });
          }
        }
        toolTraces.push({ tool: use.name, status, input_sha256: sha256(JSON.stringify(use.input)),
          result_sha256: sha256(resultText), is_error: isError });
        results.push({ type: "tool_result", tool_use_id: use.id, content: resultText,
          ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      if (outcome === null && proposed && !rejectedBatch) outcome = { kind: "filed", verdict: proposed };
    }
    if (outcome === null) throw new AgentFailure("iteration_limit", "iteration limit reached without a verdict");
  } catch (error) {
    const code = error instanceof AgentFailure ? error.code : "provider_error";
    const reason = errorMessage(error);
    const stage = code === "configuration_error" ? "configuration" : code.startsWith("replay_") ? "replay" :
      code === "invalid_response" ? "validation" : ["cancelled", "run_timeout", "call_timeout", "unfinished", "iteration_limit", "token_limit"].includes(code) ? "controller" : "provider";
    diagnostic(code, stage, reason);
    // Once a human escalation has been chosen it cannot become filed or error.
    if (outcome?.kind !== "human") outcome = { kind: "error", reason };
  }
  if (outcome?.kind === "filed" && opts.caller?.replayVerification === "legacy-unverified") {
    outcome = { kind: "human", reason: "legacy replay cannot verify request contents; recorded verdict requires human review" };
  }
  const receipt: Receipt = {
    run_id: randomUUID(), started_at: startedAt, finished_at: new Date().toISOString(),
    document: { name: doc.name, sha256: doc.sha256 }, model, calls, tools: toolTraces,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost_usd: costUsd(model, inputTokens, outputTokens), retries, diagnostics,
    ...(opts.caller?.replayVerification ? { replay_verification: opts.caller.replayVerification } : {}),
    outcome: outcome!,
  };
  return { receipt };
}
