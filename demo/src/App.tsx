import type Anthropic from "@anthropic-ai/sdk";
import { useMemo } from "react";
import { costUsd } from "../../src/pricing.js";
import { EmptyFiledIndex, executeTool } from "../../src/tools.js";
import type { Category, Verdict } from "../../src/types.js";
import { validateVerdict } from "../../src/validate.js";
import { DOC_NAME, DOC_TEXT, RESPONSES, SESSION_NOTE } from "./session.sample";

/*
 * A walkthrough of one agent session, executed against the REAL modules:
 * tool results come from src/tools.ts and verdict decisions from
 * src/validate.ts - the same code the CLI runs. Only the model's turns are
 * scripted, and the banner says so.
 */

const CATEGORIES: Category[] = [
  { key: "supplier-invoices", description: "Bills from vendors for goods or services, to be paid" },
  { key: "receipts", description: "Proof of a payment already made, card or cash" },
  { key: "bank-statements", description: "Periodic statements from a bank or card provider" },
  { key: "contracts", description: "Agreements, engagement letters, signed terms" },
  { key: "other", description: "Legitimate business documents that fit nothing above" },
];

interface StepItem {
  kind: "text" | "tool" | "verdict-rejected" | "verdict-accepted";
  title: string;
  body: string;
}

interface Step {
  requestId: string;
  items: StepItem[];
}

interface Walkthrough {
  steps: Step[];
  retries: number;
  usage: { input: number; output: number };
  outcome: string;
}

function walk(): Walkthrough {
  const doc = { name: DOC_NAME, text: DOC_TEXT, sha256: "(computed by the CLI)" };
  const filed = new EmptyFiledIndex();
  const steps: Step[] = [];
  let retries = 0;
  let input = 0;
  let output = 0;
  let outcome = "unfinished";

  for (const r of RESPONSES) {
    input += r.usage.input_tokens;
    output += r.usage.output_tokens;
    const items: StepItem[] = [];

    for (const block of r.content) {
      if (block.type === "text") {
        items.push({ kind: "text", title: "model", body: block.text });
      } else if (block.type === "tool_use") {
        if (block.name === "record_verdict") {
          const v = block.input as Verdict;
          const failures = validateVerdict(v, CATEGORIES, DOC_TEXT, 0.6);
          if (failures.length > 0) {
            retries++;
            items.push({
              kind: "verdict-rejected",
              title: "record_verdict → REJECTED by code",
              body: failures.map((f) => `${f.field}: ${f.problem}`).join("\n"),
            });
          } else {
            outcome = `filed → ${v.category} (confidence ${v.confidence})`;
            items.push({
              kind: "verdict-accepted",
              title: "record_verdict → accepted",
              body: `category: ${v.category}\nevidence: ${v.evidence.join(" | ")}`,
            });
          }
        } else {
          const result = executeTool(block.name, block.input, doc, CATEGORIES, filed);
          items.push({
            kind: "tool",
            title: `${block.name}(${JSON.stringify(block.input)})`,
            body: result.length > 260 ? result.slice(0, 260) + " …" : result,
          });
        }
      }
    }
    steps.push({ requestId: r.id, items });
  }

  return { steps, retries, usage: { input, output }, outcome };
}

export function App(): JSX.Element {
  const w = useMemo(walk, []);
  const cost = costUsd("claude-opus-5", w.usage.input, w.usage.output);

  return (
    <div className="wrap">
      <style>{CSS}</style>
      <header>
        <h1>filing-agent</h1>
        <p className="lede">
          A tool-calling agent that classifies documents — and cannot mark its own work done. The
          walkthrough below runs the repo&apos;s <b>real</b> tool and validation code; only the
          model&apos;s turns are scripted.{" "}
          <a href="https://github.com/mithundas79/filing-agent">Source on GitHub</a>.
        </p>
        <p className="banner">{SESSION_NOTE}</p>
      </header>

      <div className="cols">
        <div>
          <div className="card">
            <h2>The document</h2>
            <pre>{DOC_TEXT}</pre>
          </div>
          <div className="card">
            <h2>Run summary — what the receipt records</h2>
            <table>
              <tbody>
                <tr><td>model</td><td><code>claude-opus-5</code></td></tr>
                <tr><td>API calls</td><td>{w.steps.length}, ids {w.steps.map((s) => s.requestId).join(", ")}</td></tr>
                <tr><td>tokens</td><td>{w.usage.input} in / {w.usage.output} out</td></tr>
                <tr><td>cost</td><td>${cost}</td></tr>
                <tr><td>verdict retries</td><td>{w.retries}</td></tr>
                <tr><td>outcome</td><td><b>{w.outcome}</b></td></tr>
              </tbody>
            </table>
            <p className="muted">
              Written by the loop <i>around</i> the model, never by it. A self-reported
              &ldquo;done&rdquo; is not evidence.
            </p>
          </div>
        </div>

        <div>
          {w.steps.map((s, i) => (
            <div className="card" key={s.requestId}>
              <h2>
                Turn {i + 1} <span className="muted">({s.requestId})</span>
              </h2>
              {s.items.map((it, j) => (
                <div key={j} className={`item ${it.kind}`}>
                  <div className="t">{it.title}</div>
                  <pre>{it.body}</pre>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <footer className="muted">
        The rejected verdict in turn 3 is the point: the model quoted &ldquo;Total Due
        999.99&rdquo;, the document says 677.04, and deterministic code refused it with reasons.
        Bounded retries; after that, a person takes over. MIT licensed.
      </footer>
    </div>
  );
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f8fa; color: #0f172a;
         font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 1150px; margin: 0 auto; padding: 28px 20px 40px; }
  h1 { margin: 0; font-size: 28px; }
  .lede { color: #475569; max-width: 75ch; }
  a { color: #0891b2; }
  .banner { background: #fff7ed; border: 1.5px solid #fdba74; color: #9a3412;
            border-radius: 8px; padding: 8px 12px; font-size: 13px; max-width: 75ch; }
  .cols { display: grid; grid-template-columns: 5fr 7fr; gap: 16px; }
  @media (max-width: 950px) { .cols { grid-template-columns: 1fr; } }
  .card { background: #fff; border: 1.5px solid #e2e8f0; border-radius: 10px;
          padding: 14px 16px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 10px; font-size: 15px; }
  pre { margin: 0; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
  table { font-size: 13.5px; border-collapse: collapse; }
  td { padding: 3px 12px 3px 0; vertical-align: top; }
  td:first-child { color: #64748b; }
  .muted { color: #64748b; font-size: 13px; }
  code { background: #f1f5f9; border-radius: 6px; padding: 1px 6px; font-size: 12.5px; }
  .item { border-left: 3px solid #e2e8f0; padding: 6px 10px; margin: 8px 0; }
  .item .t { font-weight: 600; font-size: 13px; margin-bottom: 3px; }
  .item.tool { border-left-color: #0891b2; }
  .item.text { border-left-color: #cbd5e1; }
  .item.verdict-rejected { border-left-color: #b45309; background: #fff7ed; }
  .item.verdict-accepted { border-left-color: #0f766e; background: #ecfdf5; }
`;
