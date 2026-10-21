import type { RecordedSession } from "../../src/caller.js";
import type { ToolUseBlock } from "../../src/model.js";
import { validateMessage } from "../../src/model-validation.js";
import { EmptyFiledIndex, executeTool } from "../../src/tools.js";
import type { Category, Verdict } from "../../src/types.js";
import { validateToolInput, validateVerdict } from "../../src/validate.js";
import { DOC_NAME, DOC_TEXT } from "./doc.js";
import sessionJson from "./session.live.json";

export const CATEGORIES: Category[] = [
  { key: "supplier-invoices", description: "Bills from vendors for goods or services, to be paid" },
  { key: "receipts", description: "Proof of a payment already made, card or cash" },
  { key: "bank-statements", description: "Periodic statements from a bank or card provider" },
  { key: "contracts", description: "Agreements, engagement letters, signed terms" },
  { key: "other", description: "Legitimate business documents that fit nothing above" },
];

export interface WalkthroughItem {
  tool: string;
  input: unknown;
  result: string;
  rejected: boolean;
}
export interface WalkthroughStep {
  id: string;
  title: string;
  explanation: string;
  items: WalkthroughItem[];
}

const GUIDANCE: Record<string, { title: string; explanation: string }> = {
  read_document: { title: "Read the source", explanation: "The recorded model asks to read the document. The browser returns the fictional invoice text using the same read_document tool as the CLI." },
  list_categories: { title: "See the choices", explanation: "The recorded model asks which categories exist. Current tool code returns the configured categories; an invented category would fail validation." },
  record_verdict: { title: "Check the proposal", explanation: "The recorded model proposes supplier-invoices and quotes the document. Current validation checks that proposal. Passing this check does not authorize filing from an unverified recording." },
  flag_for_human: { title: "Ask for review", explanation: "The recorded model asks a person to review the document. This viewer shows that request without creating a review queue." },
};

/** Historical response inspection plus real shared tools/validation, not the controller. */
export function buildWalkthrough() {
  const session = sessionJson as unknown as RecordedSession;
  const doc = { name: DOC_NAME, text: DOC_TEXT, sha256: "not computed by this viewer" };
  let verdict: Verdict | undefined;
  let rejected = 0;
  const steps: WalkthroughStep[] = session.exchanges.map(({ response }) => {
    validateMessage(response);
    const uses = response.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
    const guidance = GUIDANCE[uses[0]?.name ?? ""];
    const items = uses.map((use): WalkthroughItem => {
      if (use.name === "record_verdict") {
        const failures = validateVerdict(use.input, CATEGORIES, DOC_TEXT, 0.6);
        if (failures.length) rejected++;
        else verdict = use.input as Verdict;
        const proposal = use.input as Verdict;
        return { tool: use.name, input: use.input, rejected: failures.length > 0,
          result: failures.length ? failures.map((failure) => `${failure.field}: ${failure.problem}`).join("\n") :
            `Category exists. Confidence ${proposal.confidence} meets the 0.60 threshold. All ${proposal.evidence.length} evidence quotes appear in the document after whitespace/case normalization.` };
      }
      if (use.name === "flag_for_human") {
        const failures = validateToolInput(use.name, use.input);
        return { tool: use.name, input: use.input, rejected: failures.length > 0,
          result: failures.length ? "Human review requested with malformed arguments." : "Human review requested by the recorded model." };
      }
      return { tool: use.name, input: use.input, rejected: false,
        result: executeTool(use.name, use.input, doc, CATEGORIES, new EmptyFiledIndex()) };
    });
    return { id: response.id, title: guidance?.title ?? "Inspect the response",
      explanation: guidance?.explanation ?? "Inspect the recorded call and the current code's result.", items };
  });
  if (!verdict) throw new Error("The bundled historical recording has no valid verdict to inspect.");
  return { steps, verdict, rejected, recordedAt: session.recorded_at, model: session.exchanges[0]!.response.model,
    usage: session.exchanges.reduce((total, { response }) => ({ input: total.input + response.usage.input_tokens,
      output: total.output + response.usage.output_tokens }), { input: 0, output: 0 }) };
}
