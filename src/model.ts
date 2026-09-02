/*
 * The message model the loop speaks - a deliberately small, local set of
 * types. No SDK dependency: the repo runs entirely against open-weights
 * models through Ollama, and the shapes below are all the loop ever needed.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  /** Synthesised by the backend; stable within a run. */
  id: string;
  name: string;
  input: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface ToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlock[] | ToolResultBlockParam[];
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface Message {
  /** For a local model there is no provider-issued id; backends derive one
   *  from a content digest so the receipt still pins what was said. */
  id: string;
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  usage: Usage;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  tools?: Tool[];
  messages: MessageParam[];
}
