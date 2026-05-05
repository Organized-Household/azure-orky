import "dotenv/config";
import http from "http";
import sql from "mssql";
import { handleJiraWebhook } from "./webhooks/jiraWebhookController";
import { ExecutionTraceService } from "./observability/executionTraceService";

const port = Number(process.env.PORT || 3000);

const config: sql.config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER || "",
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
};

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (pathname === "/webhooks/jira") {
    await handleJiraWebhook(req, res);
    return;
  }

  if (pathname === "/db") {
    try {
      const pool = await sql.connect(config);
      const result = await pool.request().query("SELECT GETDATE() as now");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.recordset));
    } catch (err) {
      console.error("DB connection failed:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(
        `DB connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "orky-api" }));
    return;
  }

  const executionTraceMatch = pathname.match(
    /^\/executions\/([0-9a-f-]{36})$/i,
  );
  if (executionTraceMatch) {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const executionId = executionTraceMatch[1];
    try {
      const traceService = new ExecutionTraceService();
      const trace = await traceService.getTrace(executionId);
      if (!trace) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Execution not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(trace));
    } catch (err) {
      console.error("Execution trace query failed:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to retrieve execution trace" }));
    }
    return;
  }

  res.writeHead(200);
  res.end("Orky running");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Running on port ${port}`);
});