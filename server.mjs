// Minimal test server for the iOS WebKit fetch() streaming stall.
// No dependencies. Serves index.html and a streaming endpoint that sends a
// short burst of frames, stays silent, then sends one marker frame.
//
//   node server.mjs                       HTTPS + HTTP/2 on :8443 (cert.pem, key.pem)
//   node server.mjs --http                plain HTTP/1.1 on :8080
//   node server.mjs --port 9000
//
// Every report the page sends is appended to results.log and printed.

import { createServer as createHttpServer } from "node:http";
import { createSecureServer } from "node:http2";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const usePlainHttp = args.includes("--http");
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : usePlainHttp ? 8080 : 8443;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function intParam(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// Sends: headers, (lead ms), count frames (gap ms apart), (tail ms), one marker frame, end.
// The reader is already waiting when the burst starts, as with a long-lived
// notification stream. The silent tail is what exposes the stall: frames still
// held back during the tail only reach the reader when the marker frame arrives.
async function handleBurst(req, res, url) {
  const count = intParam(url, "count", 10);
  const size = intParam(url, "size", 256);
  const gap = intParam(url, "gap", 4);
  const lead = intParam(url, "lead", 300);
  const tail = intParam(url, "tail", 2500);

  let aborted = false;
  res.on("close", () => {
    aborted = true;
  });

  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "cache-control": "no-store",
  });
  res.flushHeaders?.();

  await sleep(lead);
  const frame = Buffer.alloc(size, 0x00);
  for (let i = 0; i < count && !aborted; i++) {
    res.write(frame);
    await sleep(gap);
  }
  await sleep(tail);
  if (!aborted) {
    res.write(Buffer.alloc(size, 0xff));
    await sleep(200);
    res.end();
  }
}

function handleReport(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const line = `${new Date().toISOString()} ${Buffer.concat(chunks).toString("utf8").slice(0, 8000)}`;
    console.log(line);
    appendFileSync(join(root, "results.log"), line + "\n");
    res.writeHead(204);
    res.end();
  });
}

async function onRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(join(root, "index.html")));
    } else if (url.pathname === "/burst") {
      await handleBurst(req, res, url);
    } else if (req.method === "POST" && url.pathname === "/report") {
      handleReport(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch (error) {
    console.error(error);
    res.destroy?.();
  }
}

const server = usePlainHttp
  ? createHttpServer(onRequest)
  : createSecureServer(
      {
        allowHTTP1: true,
        cert: readFileSync(join(root, "cert.pem")),
        key: readFileSync(join(root, "key.pem")),
      },
      onRequest,
    );

server.on("tlsClientError", (error, socket) => {
  console.log(`TLS error from ${socket.remoteAddress}: ${error.code ?? error.message}`);
});

server.listen(port, () => {
  console.log(`Listening on ${usePlainHttp ? "http" : "https"}://0.0.0.0:${port}/`);
});
