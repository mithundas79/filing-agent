import { useMemo } from "react";
import type { RecordedSession } from "../../src/caller.js";
import type { ToolUseBlock } from "../../src/model.js";
import { EmptyFiledIndex, executeTool } from "../../src/tools.js";
import type { Category, Verdict } from "../../src/types.js";
import { validateVerdict } from "../../src/validate.js";
import { DOC_NAME, DOC_TEXT } from "./doc.js";
import sessionJson from "./session.live.json";

/*
 * A replay of one REAL recorded agent session. The model's turns come from
 * the recording; every tool result and every verdict decision is computed
 * live by the repo's actual modules - src/tools.ts and src/validate.ts -
 * the same code the CLI runs.
 */

const session = sessionJson as unknown as RecordedSession;

const CATEGORIES: Category[] = [
  { key: "supplier-invoices", description: "Bills from vendors for goods or services, to be paid" },
  { key: "receipts", description: "Proof of a payment already made, card or cash" },
  { key: "bank-statements", description: "Periodic statements from a bank or card provider" },
  { key: "contracts", description: "Agreements, engagement letters, signed terms" },
  { key: "other", description: "Legitimate business documents that fit nothing above" },
];

interface StepItem {
  kind: "text" | "tool" | "verdict-rejected" | "verdict-accepted" | "human";
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
  model: string;
}

function walk(): Walkthrough {
  const doc = { name: DOC_NAME, text: DOC_TEXT, sha256: "(computed by the CLI)" };
  const filed = new EmptyFiledIndex();
  const steps: Step[] = [];
  let retries = 0;
  let input = 0;
  let output = 0;
  let outcome = "unfinished";
  let model = "";

  for (const { response: r } of session.exchanges) {
    model = r.model;
    input += r.usage.input_tokens;
    output += r.usage.output_tokens;
    const items: StepItem[] = [];

    for (const block of r.content) {
      if (block.type === "text") {
        items.push({ kind: "text", title: "model", body: block.text });
      } else if (block.type === "tool_use") {
        const use = block as ToolUseBlock;
        if (use.name === "record_verdict") {
          const v = use.input as Verdict;
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
        } else if (use.name === "flag_for_human") {
          const reason = (use.input as { reason?: string }).reason ?? "no reason given";
          outcome = `human → ${reason}`;
          items.push({ kind: "human", title: "flag_for_human", body: reason });
        } else {
          const result = executeTool(use.name, use.input, doc, CATEGORIES, filed);
          items.push({
            kind: "tool",
            title: `${use.name}(${JSON.stringify(use.input)})`,
            body: result.length > 260 ? result.slice(0, 260) + " …" : result,
          });
        }
      }
    }
    steps.push({ requestId: r.id, items });
  }

  return { steps, retries, usage: { input, output }, outcome, model };
}

export function App(): JSX.Element {
  const w = useMemo(walk, []);
  const recordedOn = new Date(session.recorded_at).toUTCString();

  return (
    <div className="wrap">
      <style>{CSS}</style>
      <header>
        <h1>filing-agent</h1>
        <p className="lede">
          A tool-calling agent that classifies documents — and cannot mark its own work done. Below
          is a <b>real recorded session</b>: the model&apos;s turns are replayed from the recording,
          and every tool result and verdict decision is computed live by the repo&apos;s actual
          code.{" "}
          <a href="https://github.com/mithundas79/filing-agent">Source on GitHub</a>.
        </p>
        <p className="banner live">
          Recorded {recordedOn} from <b>{w.model}</b>, a local open-weights model served by Ollama —
          no API, no key, no cost. Reproduce it: <code>npx tsx src/cli.ts fixtures/docs --record
          session.json</code>
        </p>
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
                <tr><td>model</td><td><code>{w.model}</code></td></tr>
                <tr><td>API calls</td><td>{w.steps.length}</td></tr>
                <tr><td>response ids</td><td className="ids">{w.steps.map((s) => s.requestId).join(", ")}</td></tr>
                <tr><td>tokens</td><td>{w.usage.input} in / {w.usage.output} out</td></tr>
                <tr><td>cost</td><td>none — local inference</td></tr>
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
                Turn {i + 1} <span className="muted ids">({s.requestId})</span>
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
        The validation layer is load-bearing here: a 7B local model paraphrases, and when its
        evidence is not verbatim the verdict is refused with reasons until it corrects itself or a
        person takes over. MIT licensed.
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
  .banner { border-radius: 8px; padding: 8px 12px; font-size: 13px; max-width: 75ch; }
  .banner.live { background: #ecfdf5; border: 1.5px solid #6ee7b7; color: #065f46; }
  .cols { display: grid; grid-template-columns: 5fr 7fr; gap: 16px; }
  @media (max-width: 950px) { .cols { grid-template-columns: 1fr; } }
  .card { background: #fff; border: 1.5px solid #e2e8f0; border-radius: 10px;
          padding: 14px 16px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 10px; font-size: 15px; }
  pre { margin: 0; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
  table { font-size: 13.5px; border-collapse: collapse; }
  td { padding: 3px 12px 3px 0; vertical-align: top; }
  td:first-child { color: #64748b; }
  .ids { font-size: 11.5px; word-break: break-all; }
  .muted { color: #64748b; font-size: 13px; }
  code { background: #f1f5f9; border-radius: 6px; padding: 1px 6px; font-size: 12.5px; }
  .item { border-left: 3px solid #e2e8f0; padding: 6px 10px; margin: 8px 0; }
  .item .t { font-weight: 600; font-size: 13px; margin-bottom: 3px; }
  .item.tool { border-left-color: #0891b2; }
  .item.text { border-left-color: #cbd5e1; }
  .item.verdict-rejected { border-left-color: #b45309; background: #fff7ed; }
  .item.verdict-accepted { border-left-color: #0f766e; background: #ecfdf5; }
  .item.human { border-left-color: #7c3aed; background: #f5f3ff; }
`;
