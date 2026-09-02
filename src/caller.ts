import { createHash } from "node:crypto";
import type {
  ContentBlock,
  Message,
  MessageCreateParams,
  MessageParam,
  StopReason,
  ToolResultBlockParam,
  ToolUseBlock,
} from "./model.js";

/*
 * The loop talks to "a thing that answers a request" - not to a vendor SDK.
 * That one seam gives us three modes from the same loop code:
 *
 *   live    - a local open-weights model served by Ollama
 *   record  - live, while writing every exchange to a session file
 *   replay  - a recorded session played back: no model, no GPU, no wait
 *
 * Replay is not a mock. It is a real session, re-run - which is what makes
 * the demo and CI honest.
 */

export interface ModelCaller {
  create(params: MessageCreateParams): Promise<Message>;
}

/* ------------------------------ Ollama ---------------------------------- */

interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string; tool_calls?: OllamaToolCall[] };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Translate the loop's conversation into Ollama /api/chat messages. */
function toOllamaMessages(params: MessageCreateParams): unknown[] {
  const out: unknown[] = [];
  if (params.system) out.push({ role: "system", content: params.system });

  for (const m of params.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const blocks = m.content as ContentBlock[];
      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const calls = blocks
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ function: { name: b.name, arguments: b.input ?? {} } }));
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const blocks = m.content as Array<ToolResultBlockParam | ContentBlock>;
      let pushedTool = false;
      for (const b of blocks) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", content: b.content });
          pushedTool = true;
        } else if (b.type === "text") {
          out.push({ role: "user", content: b.text });
        }
      }
      if (!pushedTool && blocks.length === 0) out.push({ role: "user", content: "" });
    }
  }
  return out;
}

export interface OllamaOptions {
  /** Base URL of the Ollama server. Default http://127.0.0.1:11434 */
  host?: string;
}

export function ollamaCaller(opts: OllamaOptions = {}): ModelCaller {
  const host = (opts.host ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  let seq = 0;

  return {
    async create(params: MessageCreateParams): Promise<Message> {
      const body = {
        model: params.model,
        stream: false,
        messages: toOllamaMessages(params),
        tools: (params.tools ?? []).map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
        options: { num_predict: params.max_tokens },
      };

      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`ollama ${res.status} at ${host}: ${detail.slice(0, 300)}`);
      }
      const r = (await res.json()) as OllamaChatResponse;

      const content: ContentBlock[] = [];
      if (r.message.content?.trim()) content.push({ type: "text", text: r.message.content });
      for (const c of r.message.tool_calls ?? []) {
        seq += 1;
        content.push({ type: "tool_use", id: `tu_${seq}`, name: c.function.name, input: c.function.arguments });
      }

      const stop: StopReason =
        (r.message.tool_calls?.length ?? 0) > 0
          ? "tool_use"
          : r.done_reason === "length"
            ? "max_tokens"
            : "end_turn";

      // No provider-issued id exists for a local model; pin the response by
      // its own content digest so the receipt still identifies exactly what
      // was said.
      return {
        id: `sha256:${sha256(JSON.stringify(r.message)).slice(0, 24)}`,
        role: "assistant",
        model: r.model,
        content,
        stop_reason: stop,
        usage: { input_tokens: r.prompt_eval_count ?? 0, output_tokens: r.eval_count ?? 0 },
      };
    },
  };
}

/* --------------------------- record / replay ----------------------------- */

export interface RecordedSession {
  recorded_at: string;
  note: string;
  exchanges: Array<{
    /** Only what replay needs to stay honest about what was asked. */
    request_digest: { model: string; message_count: number; tool_names: string[] };
    response: Message;
  }>;
}

export class RecordingCaller implements ModelCaller {
  readonly session: RecordedSession;
  constructor(
    private inner: ModelCaller,
    note: string,
  ) {
    this.session = { recorded_at: new Date().toISOString(), note, exchanges: [] };
  }

  async create(params: MessageCreateParams): Promise<Message> {
    const response = await this.inner.create(params);
    this.session.exchanges.push({
      request_digest: {
        model: params.model,
        message_count: params.messages.length,
        tool_names: (params.tools ?? []).map((t) => t.name),
      },
      response,
    });
    return response;
  }
}

export class ReplayCaller implements ModelCaller {
  private cursor = 0;
  constructor(private sessionData: RecordedSession) {}

  async create(params: MessageCreateParams): Promise<Message> {
    const exchange = this.sessionData.exchanges[this.cursor];
    if (!exchange) {
      throw new Error(
        `replay session exhausted after ${this.cursor} exchanges - the code now makes more calls than the recording did`,
      );
    }
    if (exchange.request_digest.message_count !== params.messages.length) {
      throw new Error(
        `replay drift at exchange ${this.cursor}: recorded request had ` +
          `${exchange.request_digest.message_count} messages, this run built ${params.messages.length}`,
      );
    }
    this.cursor++;
    return exchange.response;
  }
}
