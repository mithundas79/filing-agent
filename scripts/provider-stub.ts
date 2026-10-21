/** A deterministic HTTP provider stub, never a live-model recording. */
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

export interface StubRequest { scenario: string; body: Record<string, unknown> }
export interface ProviderStub {
  host: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

export async function startProviderStub(port = 0): Promise<ProviderStub> {
  const requests: StubRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    let scenario = req.url?.split("/")[1] || "success";
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push({ scenario, body });
    if (scenario === "mixed") {
      scenario = JSON.stringify(body.messages).includes("second.txt") ? "failure" : "human";
    }
    res.setHeader("content-type", "application/json");
    if (scenario === "failure") { res.statusCode = 503; res.end(JSON.stringify({ error: "stub provider unavailable" })); return; }
    if (scenario === "disconnect") { req.socket.destroy(); return; }
    if (scenario === "timeout") return;
    if (scenario === "body-timeout") { res.writeHead(200); res.write('{"model":'); return; }
    if (scenario === "malformed") { res.end(JSON.stringify({ model: body.model, message: null })); return; }
    if (scenario === "invalid-json") { res.end("this is not JSON"); return; }
    if (scenario === "null") { res.end("null"); return; }
    if (scenario === "wrong-tool-shape") { res.end(JSON.stringify({ model: body.model,
      message: { role: "assistant", content: "", tool_calls: [null] } })); return; }
    const messages = body.messages as Array<{ role: string; content: string }>;
    const read = messages.find((m) => m.role === "tool");
    const functionCall = (name: string, args: unknown): unknown => ({ function: { name, arguments: args } });
    let toolCalls: unknown[];
    if (!read) {
      toolCalls = [functionCall("read_document", {}), functionCall("list_categories", {})];
    } else {
      const evidence = read.content.split(/\r?\n/).find((line) => line.includes("Total Due")) ?? read.content.split(/\r?\n/)[0]!;
      const verdict = { category: "supplier-invoices", vendor: "Example Supplies", summary: "Example supplier invoice for review",
        confidence: 0.9, evidence: [evidence] };
      if (scenario === "validation") toolCalls = [functionCall("record_verdict", { ...verdict, summary: 42, evidence: [null] })];
      else if (scenario === "human") toolCalls = [functionCall("flag_for_human", { reason: "stub requested manual review" }), functionCall("record_verdict", verdict)];
      else toolCalls = [functionCall("record_verdict", verdict)];
    }
    res.end(JSON.stringify({ model: body.model, done: true, done_reason: "stop",
      message: { role: "assistant", content: "", tool_calls: toolCalls }, prompt_eval_count: 100, eval_count: 25 }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind a TCP port");
  return { host: `http://127.0.0.1:${address.port}`, requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf("--port");
  const port = index >= 0 ? Number(process.argv[index + 1]) : 11435;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");
  const stub = await startProviderStub(port);
  console.log(`Deterministic HTTP stub (no model): ${stub.host}/{success,validation,human,malformed,failure,timeout}`);
  const stop = (): void => { void stub.close().then(() => { process.exitCode = 0; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
