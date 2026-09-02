import type { Tool } from "./model.js";
import type { Category, DocSource } from "./types.js";

/*
 * The tool surface. Two terminal tools end the run - record_verdict
 * (validated by code) and flag_for_human (always accepted; asking
 * for help is never wrong). Everything else is how the model looks at the
 * world instead of hallucinating it.
 */

export const TOOLS: Tool[] = [
  {
    name: "read_document",
    description:
      "Read the full text of the document being classified. Call this before anything else; never classify from the filename.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_categories",
    description:
      "List the filing categories that exist, with a description of what belongs in each. The verdict category must be one of these keys.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "check_duplicates",
    description:
      "Check whether a document from this vendor with this number has been filed before. Returns matches; a match means the document should be flagged, not filed again.",
    input_schema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "Vendor name as it appears on the document" },
        number: { type: "string", description: "Document number, if any" },
      },
      required: ["vendor"],
      additionalProperties: false,
    },
  },
  {
    name: "flag_for_human",
    description:
      "Send the document to a person instead of filing it. Use when the category is unclear, the document is a duplicate, confidence is low, or anything looks wrong. This ends the run.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why a person needs to look, one or two sentences" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "record_verdict",
    description:
      "File the document. Every evidence entry must be a verbatim quote from the document text; the verdict is validated by code and refused if the category does not exist, confidence is out of range, or a quote is not found in the document. This ends the run when accepted.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "One of the category keys from list_categories" },
        vendor: { type: ["string", "null"], description: "Vendor or counterparty named on the document" },
        summary: { type: "string", description: "One line saying what this document is" },
        confidence: { type: "number", description: "0 to 1" },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Verbatim quotes from the document that ground the classification",
        },
      },
      required: ["category", "vendor", "summary", "confidence", "evidence"],
      additionalProperties: false,
    },
  },
];

/** Past filings the duplicate check consults. */
export interface FiledIndex {
  find(vendor: string, number?: string | null): Array<{ vendor: string; number: string | null; category: string }>;
}

export class EmptyFiledIndex implements FiledIndex {
  find(): [] {
    return [];
  }
}

/** Execute a non-terminal tool. Terminal tools are handled by the loop. */
export function executeTool(
  name: string,
  input: unknown,
  doc: DocSource,
  categories: Category[],
  filed: FiledIndex,
): string {
  switch (name) {
    case "read_document":
      return doc.text;
    case "list_categories":
      return JSON.stringify(categories, null, 2);
    case "check_duplicates": {
      const q = input as { vendor: string; number?: string | null };
      const matches = filed.find(q.vendor, q.number ?? null);
      return matches.length
        ? JSON.stringify({ matches })
        : JSON.stringify({ matches: [], note: "no prior filing matches" });
    }
    default:
      return JSON.stringify({ error: `unknown tool: ${name}` });
  }
}
