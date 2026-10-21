import { createHash } from "node:crypto";
import type { ContentBlock, Message, MessageCreateParams, ToolResultBlockParam, ToolUseBlock } from "./model.js";
import { requestFingerprint } from "./fingerprint.js";
import { validateMessage } from "./model-validation.js";
import { AgentFailure, isJson, isObject, nonemptyString, tokenCount } from "./runtime.js";

export interface CallOptions {
  /** Backends should honor this signal; the controller also enforces its deadline. */
  signal?: AbortSignal;
}

export interface ModelCaller {
  create(params: MessageCreateParams, options?: CallOptions): Promise<Message>;
  readonly replayVerification?: "canonical-v2" | "legacy-unverified";
}

function toOllamaMessages(params: MessageCreateParams): unknown[] {
  const out: unknown[] = [];
  if (params.system) out.push({ role: "system", content: params.system });
  for (const m of params.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      const blocks = m.content as ContentBlock[];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ function: { name: b.name, arguments: b.input } }));
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content as Array<ToolResultBlockParam | ContentBlock>) {
        if (b.type === "tool_result") out.push({ role: "tool", content: b.content });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

export interface OllamaOptions {
  /** Base URL of the Ollama server. Default http://127.0.0.1:11434 */
  host?: string;
}

/** Validate Ollama's untrusted wire response before translating it. */
function translateOllama(value: unknown, nextId: () => string): Message {
  const invalid = (detail: string): never => {
    throw new AgentFailure("invalid_response", `malformed Ollama response: ${detail}`);
  };
  if (!isObject(value)) invalid("expected an object");
  const r = value as Record<string, unknown>;
  if (typeof r.error === "string") throw new AgentFailure("provider_error", r.error);
  if (!nonemptyString(r.model) || !isObject(r.message)) invalid("missing model/message");
  const m = r.message as Record<string, unknown>;
  if (m.role !== "assistant" || typeof m.content !== "string") invalid("assistant message/content required");
  if (r.done_reason !== undefined && r.done_reason !== "stop" && r.done_reason !== "length") invalid("unknown done_reason");
  if (r.done !== undefined && r.done !== true) invalid("non-streaming response must be complete");
  if (r.prompt_eval_count !== undefined && !tokenCount(r.prompt_eval_count)) invalid("invalid prompt_eval_count");
  if (r.eval_count !== undefined && !tokenCount(r.eval_count)) invalid("invalid eval_count");
  if (m.tool_calls !== undefined && !Array.isArray(m.tool_calls)) invalid("tool_calls must be an array");
  const content: ContentBlock[] = [];
  if ((m.content as string).trim()) content.push({ type: "text", text: m.content as string });
  for (const call of (m.tool_calls ?? []) as unknown[]) {
    if (!isObject(call) || !isObject(call.function)) invalid("tool call function must be an object");
    const fn = (call as { function: Record<string, unknown> }).function;
    if (!nonemptyString(fn.name) || !Object.hasOwn(fn, "arguments") || !isJson(fn.arguments)) {
      invalid("tool call requires a name and JSON arguments");
    }
    content.push({ type: "tool_use", id: nextId(), name: fn.name as string, input: fn.arguments });
  }
  return {
    id: `sha256:${createHash("sha256").update(JSON.stringify(m)).digest("hex")}`,
    role: "assistant",
    model: r.model as string,
    content,
    stop_reason: r.done_reason === "length" ? "max_tokens" : content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: (r.prompt_eval_count ?? 0) as number, output_tokens: (r.eval_count ?? 0) as number },
  };
}

export function ollamaCaller(opts: OllamaOptions = {}): ModelCaller {
  const host = (opts.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  let seq = 0;
  return {
    async create(params, options): Promise<Message> {
      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        signal: options?.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: params.model,
          stream: false,
          messages: toOllamaMessages(params),
          tools: (params.tools ?? []).map((t) => ({ type: "function", function: {
            name: t.name, description: t.description, parameters: t.input_schema,
          } })),
          options: { num_predict: params.max_tokens },
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new AgentFailure("provider_error", `ollama HTTP ${res.status}: ${detail.slice(0, 300)}`);
      }
      let raw: unknown;
      try { raw = await res.json(); }
      catch (error) {
        if (options?.signal?.aborted) throw error;
        throw new AgentFailure("invalid_response", "Ollama returned invalid JSON");
      }
      const response = translateOllama(raw, () => `tu_${++seq}`);
      validateMessage(response);
      return response;
    },
  };
}

export interface CanonicalRecordedSession {
  format_version: 2;
  fingerprint_algorithm: "sha256-canonical-json-v1";
  recorded_at: string;
  note: string;
  exchanges: Array<{ request_sha256: string; response: Message }>;
}

/** Historical recordings cannot recover request contents that were never saved. */
export interface LegacyRecordedSession {
  recorded_at: string;
  note: string;
  exchanges: Array<{
    request_digest: { model: string; message_count: number; tool_names: string[] };
    response: Message;
  }>;
}
export type RecordedSession = CanonicalRecordedSession | LegacyRecordedSession;

export class RecordingCaller implements ModelCaller {
  readonly session: CanonicalRecordedSession;
  constructor(private inner: ModelCaller, note: string) {
    this.session = { format_version: 2, fingerprint_algorithm: "sha256-canonical-json-v1",
      recorded_at: new Date().toISOString(), note, exchanges: [] };
  }
  async create(params: MessageCreateParams, options?: CallOptions): Promise<Message> {
    const request_sha256 = requestFingerprint(params);
    const response = await this.inner.create(params, options);
    if (options?.signal?.aborted) throw options.signal.reason;
    validateMessage(response);
    this.session.exchanges.push({ request_sha256, response: structuredClone(response) });
    return response;
  }
}

export interface ReplayOptions {
  /** Explicit historical inspection only; the loop downgrades filing to human review. */
  allowLegacy?: boolean;
}

export class ReplayCaller implements ModelCaller {
  private cursor = 0;
  private sessionData: RecordedSession;
  readonly replayVerification: "canonical-v2" | "legacy-unverified";
  constructor(session: unknown, options: ReplayOptions = {}) {
    if (!isObject(session) || typeof session.recorded_at !== "string" || typeof session.note !== "string" ||
      !Array.isArray(session.exchanges)) throw new AgentFailure("invalid_recording", "invalid replay session");
    const legacy = session.format_version === undefined;
    if (!legacy && (session.format_version !== 2 || session.fingerprint_algorithm !== "sha256-canonical-json-v1")) {
      throw new AgentFailure("invalid_recording", "unsupported recording format/fingerprint algorithm");
    }
    if (legacy && !options.allowLegacy) {
      throw new AgentFailure("legacy_recording", "legacy recording has no canonical request fingerprints; use --allow-legacy-replay only for unverified historical inspection");
    }
    for (const exchange of session.exchanges) {
      if (!isObject(exchange)) throw new AgentFailure("invalid_recording", "invalid recorded exchange");
      validateMessage(exchange.response);
      if (legacy) {
        const d = exchange.request_digest;
        if (!isObject(d) || !nonemptyString(d.model) || !tokenCount(d.message_count) ||
          !Array.isArray(d.tool_names) || !d.tool_names.every(nonemptyString)) {
          throw new AgentFailure("invalid_recording", "invalid legacy request digest");
        }
      } else if (typeof exchange.request_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(exchange.request_sha256)) {
        throw new AgentFailure("invalid_recording", "invalid canonical request fingerprint");
      }
    }
    this.sessionData = structuredClone(session) as unknown as RecordedSession;
    this.replayVerification = legacy ? "legacy-unverified" : "canonical-v2";
  }
  async create(params: MessageCreateParams): Promise<Message> {
    const exchange = this.sessionData.exchanges[this.cursor];
    if (!exchange) throw new AgentFailure("replay_exhausted", `replay session exhausted after ${this.cursor} exchanges`);
    if ("request_sha256" in exchange) {
      if (exchange.request_sha256 !== requestFingerprint(params)) {
        throw new AgentFailure("replay_drift", `replay drift at exchange ${this.cursor}: canonical request differs`);
      }
    } else {
      const d = exchange.request_digest;
      if (d.model !== params.model || d.message_count !== params.messages.length ||
        JSON.stringify(d.tool_names) !== JSON.stringify((params.tools ?? []).map((t) => t.name))) {
        throw new AgentFailure("replay_drift", `replay drift at exchange ${this.cursor}: legacy metadata differs (contents unverified)`);
      }
    }
    this.cursor++;
    return structuredClone(exchange.response);
  }
  /** Call at the end of a complete session, which may span several documents. */
  assertComplete(): void {
    if (this.cursor !== this.sessionData.exchanges.length) {
      throw new AgentFailure("replay_unused", `replay has ${this.sessionData.exchanges.length - this.cursor} unused exchanges`);
    }
  }
}
