import type { Category, ValidationFailure, Verdict } from "./types.js";

/*
 * Deterministic validation of the model's verdict. Judgment belongs to the
 * model; whether the judgment is acceptable belongs to code.
 *
 * The evidence check is the important one: every quote must literally
 * appear in the document. A model that fabricates its supporting evidence
 * is not overruled or corrected - it is refused, told why, and given a
 * bounded chance to try again.
 */

const squash = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The document line sharing the most words with the quote - a correction
 *  hint that makes rejections actionable for smaller models. */
function closestLine(quote: string, documentText: string): string | null {
  const words = new Set(squash(quote).split(" ").filter((w) => w.length > 2));
  if (words.size === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const line of documentText.split(/\r?\n/)) {
    const lw = squash(line).split(" ");
    const score = lw.filter((w) => words.has(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = line.trim();
    }
  }
  return bestScore > 0 ? best : null;
}

export function validateVerdict(
  v: Verdict,
  categories: Category[],
  documentText: string,
  minConfidence: number,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];

  if (!categories.some((c) => c.key === v.category)) {
    failures.push({
      field: "category",
      problem: `"${v.category}" is not one of the configured categories: ${categories.map((c) => c.key).join(", ")}`,
    });
  }

  if (!(typeof v.confidence === "number") || v.confidence < 0 || v.confidence > 1) {
    failures.push({ field: "confidence", problem: "confidence must be a number between 0 and 1" });
  } else if (v.confidence < minConfidence) {
    failures.push({
      field: "confidence",
      problem: `confidence ${v.confidence} is below the ${minConfidence} threshold - call flag_for_human instead of forcing a verdict`,
    });
  }

  if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
    failures.push({ field: "evidence", problem: "at least one verbatim quote from the document is required" });
  } else {
    const haystack = squash(documentText);
    for (const quote of v.evidence) {
      if (squash(quote).length < 3 || !haystack.includes(squash(quote))) {
        const hint = closestLine(quote, documentText);
        failures.push({
          field: "evidence",
          problem:
            `quote not found in the document: "${quote}" - evidence must be verbatim` +
            (hint ? `. Closest line in the document is: "${hint}"` : ""),
        });
      }
    }
  }

  if (!v.summary || v.summary.trim().length < 5) {
    failures.push({ field: "summary", problem: "a one-line summary is required" });
  }

  return failures;
}
