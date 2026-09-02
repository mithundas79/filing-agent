/*
 * A hand-scripted walkthrough session, clearly labelled as such in the UI.
 * It exists to show the loop's contract - including a verdict being
 * REJECTED for fabricated evidence - without spending anyone's tokens.
 * A live `--record` capture drops in with the identical shape.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const DOC_NAME = "northwind-invoice.txt";

export const DOC_TEXT = `Northwind Supplies
14 Harbour Road, Portland
INVOICE
Invoice No: NW-2026-0481
Invoice Date: 12 Aug 2026
Due Date: 11 Sep 2026
Filter cartridges 10 in    24    408.00
Sealing rings box of 50     6    171.00
Delivery                    1     45.00
Subtotal 624.00
Tax 8.5% 53.04
Total Due 677.04
Payment terms: Net 30. Please quote the invoice number.`;

export const SESSION_NOTE =
  "Hand-scripted walkthrough session - not a live model recording. It shows the " +
  "loop's contract, including a rejected verdict. Record a real one with: " +
  "npx tsx src/cli.ts fixtures/docs --record session.json";

const tu = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock =>
  ({ type: "tool_use", id, name, input }) as Anthropic.ToolUseBlock;

const text = (t: string): Anthropic.TextBlock =>
  ({ type: "text", text: t, citations: null }) as Anthropic.TextBlock;

function msg(n: number, content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: `msg_sample_${n}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 700 + n * 120, output_tokens: 60 + n * 15 } as Anthropic.Usage,
  } as Anthropic.Message;
}

export const RESPONSES: Anthropic.Message[] = [
  msg(1, [
    text("I will read the document before classifying anything."),
    tu("tu_1", "read_document", {}),
  ]),
  msg(2, [
    text("An invoice from Northwind Supplies. Checking the categories and any prior filing in parallel."),
    tu("tu_2", "list_categories", {}),
    tu("tu_3", "check_duplicates", { vendor: "Northwind Supplies", number: "NW-2026-0481" }),
  ]),
  msg(3, [
    tu("tu_4", "record_verdict", {
      category: "supplier-invoices",
      vendor: "Northwind Supplies",
      summary: "Vendor invoice from Northwind Supplies, net 30",
      confidence: 0.95,
      evidence: ["Invoice No: NW-2026-0481", "Total Due 999.99"],
    }),
  ]),
  msg(4, [
    text("The second quote was wrong - correcting it against the document text."),
    tu("tu_5", "record_verdict", {
      category: "supplier-invoices",
      vendor: "Northwind Supplies",
      summary: "Vendor invoice from Northwind Supplies, net 30",
      confidence: 0.95,
      evidence: ["Invoice No: NW-2026-0481", "Total Due 677.04"],
    }),
  ]),
];
