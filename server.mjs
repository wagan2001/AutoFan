import http from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function resolvePath(url) {
  const requested = new URL(url, `http://localhost:${port}`).pathname;
  const relative = requested === "/" ? "/index.html" : requested;
  const path = normalize(join(root, relative));
  if (!path.startsWith(root)) return null;
  return path;
}

const server = http.createServer((req, res) => {
  const path = resolvePath(req.url || "/");

  if (!path || !existsSync(path)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": contentTypes[extname(path)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  createReadStream(path).pipe(res);
});

server.listen(port, () => {
  console.log(`Automatic Fan Tuner is running at http://localhost:${port}`);
});
