import { describe, expect, it } from "vitest";
import type { Category, Verdict } from "../src/types.js";
import { validateVerdict } from "../src/validate.js";

const CATS: Category[] = [
  { key: "supplier-invoices", description: "Bills to pay" },
  { key: "receipts", description: "Payments made" },
];

const DOC = `Northwind Supplies
Invoice No: NW-2026-0481
Total Due 677.04`;

const good: Verdict = {
  category: "supplier-invoices",
  vendor: "Northwind Supplies",
  summary: "Vendor invoice from Northwind Supplies for 677.04",
  confidence: 0.92,
  evidence: ["Invoice No: NW-2026-0481", "Total Due 677.04"],
};

describe("validateVerdict", () => {
  it("accepts a grounded verdict", () => {
    expect(validateVerdict(good, CATS, DOC, 0.6)).toEqual([]);
  });

  it("rejects a category that does not exist", () => {
    const fails = validateVerdict({ ...good, category: "misc" }, CATS, DOC, 0.6);
    expect(fails.map((f) => f.field)).toContain("category");
  });

  it("rejects confidence out of range and below threshold", () => {
    expect(validateVerdict({ ...good, confidence: 1.4 }, CATS, DOC, 0.6).map((f) => f.field)).toContain(
      "confidence",
    );
    const below = validateVerdict({ ...good, confidence: 0.4 }, CATS, DOC, 0.6);
    expect(below[0]?.problem).toContain("flag_for_human");
  });

  it("rejects evidence that is not verbatim from the document", () => {
    const fails = validateVerdict(
      { ...good, evidence: ["Total Due 999.99"] },
      CATS,
      DOC,
      0.6,
    );
    expect(fails[0]?.problem).toContain("not found in the document");
  });

  it("is whitespace- and case-insensitive, nothing more", () => {
    const fails = validateVerdict(
      { ...good, evidence: ["invoice no:   nw-2026-0481"] },
      CATS,
      DOC,
      0.6,
    );
    expect(fails).toEqual([]);
  });

  it("requires at least one quote", () => {
    const fails = validateVerdict({ ...good, evidence: [] }, CATS, DOC, 0.6);
    expect(fails.map((f) => f.field)).toContain("evidence");
  });
});
