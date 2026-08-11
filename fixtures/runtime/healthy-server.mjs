import { createServer } from "node:http";

const port = Number(process.env.PORT);
const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fixture ready on ${port}`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
