import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const requested = decoded === '/' ? '/index.html' : decoded;
  const resolved = normalize(join(root, requested));
  return resolved.startsWith(root) ? resolved : null;
}

createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/health') {
    res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify({status: 'ok'}));
    return;
  }
  const file = safePath(pathname);
  if (!file) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const stat = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file).toLowerCase()] || 'application/octet-stream'});
    res.end(stat);
  } catch {
    res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    res.end('Not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`Dashboard listening on ${port}`));
