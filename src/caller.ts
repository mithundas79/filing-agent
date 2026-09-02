import type Anthropic from "@anthropic-ai/sdk";

/*
 * The loop talks to "a thing that answers a Messages request" - not to the
 * SDK directly. That one seam gives us three modes from the same loop code:
 *
 *   live    - the Anthropic SDK client
 *   record  - live, while writing every exchange to a session file
 *   replay  - a recorded session played back: no key, no network, no cost
 *
 * Replay is not a mock. It is a real session, re-run - which is what makes
 * the demo and CI honest.
 */

export interface ModelCaller {
  create(params: Anthropic.MessageCreateParams): Promise<Anthropic.Message>;
}

export function apiCaller(client: Anthropic): ModelCaller {
  return {
    create: (params) => client.messages.create({ ...params, stream: false }),
  };
}

export interface RecordedSession {
  recorded_at: string;
  note: string;
  exchanges: Array<{
    /** Only what replay needs to stay honest about what was asked. */
    request_digest: { model: string; message_count: number; tool_names: string[] };
    response: Anthropic.Message;
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

  async create(params: Anthropic.MessageCreateParams): Promise<Anthropic.Message> {
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

  async create(params: Anthropic.MessageCreateParams): Promise<Anthropic.Message> {
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
