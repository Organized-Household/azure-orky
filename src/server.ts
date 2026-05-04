import http from "http";

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "orky-api" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Orky API is running");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Orky API listening on port ${port}`);
});