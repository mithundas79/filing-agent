import type { Category, ValidationFailure } from "./types.js";
import { isObject } from "./runtime.js";

const squash = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function closestLine(quote: string, documentText: string): string | null {
  const words = new Set(squash(quote).split(" ").filter((w) => w.length > 2));
  let best: string | null = null;
  let score = 0;
  for (const line of documentText.split(/\r?\n/)) {
    const candidate = squash(line).split(" ").filter((w) => words.has(w)).length;
    if (candidate > score) { best = line.trim(); score = candidate; }
  }
  return best;
}

/** The boundary accepts unknown so invalid runtime input is a normal rejection. */
export function validateVerdict(
  value: unknown, categories: Category[], documentText: string, minConfidence: number,
): ValidationFailure[] {
  if (!isObject(value)) return [{ field: "verdict", problem: "verdict must be an object" }];
  const v = value;
  const failures: ValidationFailure[] = [];
  const fields = ["category", "vendor", "summary", "confidence", "evidence"];
  for (const key of Object.keys(v)) {
    if (!fields.includes(key)) failures.push({ field: key, problem: "unexpected verdict field" });
  }
  if (typeof v.category !== "string" || !categories.some((c) => c.key === v.category)) {
    failures.push({ field: "category", problem: `category must be one of: ${categories.map((c) => c.key).join(", ")}` });
  }
  if (v.vendor !== null && (typeof v.vendor !== "string" || !v.vendor.trim())) {
    failures.push({ field: "vendor", problem: "vendor must be a nonempty string or null" });
  }
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) {
    failures.push({ field: "confidence", problem: "confidence must be a finite number between 0 and 1" });
  } else if (v.confidence < minConfidence) {
    failures.push({ field: "confidence", problem: `confidence ${v.confidence} is below the ${minConfidence} threshold - call flag_for_human instead of forcing a verdict` });
  }
  if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
    failures.push({ field: "evidence", problem: "at least one verbatim quote from the document is required" });
  } else {
    const haystack = squash(documentText);
    for (const quote of v.evidence) {
      if (typeof quote !== "string" || squash(quote).length < 3) {
        failures.push({ field: "evidence", problem: "every evidence entry must be a nonempty string of at least three characters" });
      } else if (!haystack.includes(squash(quote))) {
        const hint = closestLine(quote, documentText);
        failures.push({ field: "evidence", problem: `quote not found in the document: "${quote}" - evidence must be verbatim` +
          (hint ? `. Closest line in the document is: "${hint}"` : "") });
      }
    }
  }
  if (typeof v.summary !== "string" || v.summary.trim().length < 5 || /[\r\n]/.test(v.summary)) {
    failures.push({ field: "summary", problem: "a one-line summary of at least five characters is required" });
  }
  return failures;
}

/** Runtime enforcement of the tool schemas exposed to the model. */
export function validateToolInput(name: string, value: unknown): ValidationFailure[] {
  if (!isObject(value)) return [{ field: "input", problem: "tool arguments must be an object" }];
  const fields: Record<string, string[]> = {
    read_document: [], list_categories: [], check_duplicates: ["vendor", "number"],
    flag_for_human: ["reason"], record_verdict: ["category", "vendor", "summary", "confidence", "evidence"],
  };
  const allowed = Object.hasOwn(fields, name) ? fields[name] : undefined;
  if (!allowed) return [{ field: "tool", problem: `unknown tool: ${name}` }];
  const failures = Object.keys(value).filter((key) => !allowed.includes(key))
    .map((key) => ({ field: key, problem: "unexpected tool argument" }));
  if (name === "check_duplicates") {
    if (typeof value.vendor !== "string" || !value.vendor.trim()) {
      failures.push({ field: "vendor", problem: "vendor must be a nonempty string" });
    }
    if (value.number !== undefined && (typeof value.number !== "string" || !value.number.trim())) {
      failures.push({ field: "number", problem: "number must be a nonempty string when present" });
    }
  }
  if (name === "flag_for_human" && (typeof value.reason !== "string" || !value.reason.trim())) {
    failures.push({ field: "reason", problem: "reason must be a nonempty string" });
  }
  return failures;
}
