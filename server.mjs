import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('railway.internal') ? false : {rejectUnauthorized: false}, max: 5}) : null;
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

async function initDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_batches (
      id BIGSERIAL PRIMARY KEY,
      source_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      file_size BIGINT NOT NULL DEFAULT 0,
      row_count INTEGER NOT NULL DEFAULT 0,
      file_data BYTEA,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS import_records (
      source_type TEXT NOT NULL,
      record_key TEXT NOT NULL,
      batch_id BIGINT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_type, record_key)
    );
    CREATE INDEX IF NOT EXISTS import_records_batch_idx ON import_records(batch_id);
    CREATE INDEX IF NOT EXISTS import_batches_imported_at_idx ON import_batches(imported_at DESC);
  `);
}

function sendJson(res, status, body) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('payload-too-large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function recordKey(row, index) {
  const value = row?.['Rota Logistics'] ?? row?.['ROTA LOGISTICS'] ?? row?.rotaLogistics ?? row?.rotalogistics ?? row?.rota;
  const date = row?.Data ?? row?.data ?? row?.Date ?? row?.date ?? row?.['Data da rota'] ?? '';
  const plate = row?.PLACA ?? row?.Placa ?? row?.placa ?? row?.Plate ?? row?.plate ?? '';
  const delivery = row?.['ID Entrega'] ?? row?.idEntrega ?? row?.identrega ?? row?.Pedido ?? row?.pedido ?? row?.shipment ?? '';
  const route = String(value ?? '').trim();
  const raw = delivery ? `${route}|${date}|${plate}|${delivery}` : route ? `${route}|${date}|${plate}` : JSON.stringify(row) || String(index);
  return createHash('sha256').update(raw.toUpperCase()).digest('hex');
}

async function persistImport(payload) {
  if (!pool) throw new Error('database-not-configured');
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const sourceType = String(payload.sourceType || 'DDS').slice(0, 50);
  const fileName = String(payload.fileName || 'importacao').slice(0, 255);
  const fileData = payload.fileBase64 ? Buffer.from(payload.fileBase64, 'base64') : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = await client.query('INSERT INTO import_batches (source_type,file_name,mime_type,file_size,row_count,file_data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [sourceType,fileName,payload.mimeType || null,fileData?.length || 0,rows.length,fileData]);
    const batchId = batch.rows[0].id;
    let upserted = 0;
    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      const values = [];
      const placeholders = chunk.map((row, i) => {
        const p = i * 4;
        values.push(sourceType, recordKey(row, offset + i), batchId, JSON.stringify(row));
        return `($${p+1},$${p+2},$${p+3},$${p+4},NOW())`;
      });
      await client.query(`INSERT INTO import_records (source_type,record_key,batch_id,data,imported_at) VALUES ${placeholders.join(',')} ON CONFLICT (source_type,record_key) DO UPDATE SET batch_id=EXCLUDED.batch_id,data=EXCLUDED.data,imported_at=NOW()`, values);
      upserted += chunk.length;
    }
    await client.query('COMMIT');
    return {batchId, rowsReceived: rows.length, recordsUpserted: upserted};
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/health') {
    sendJson(res, 200, {status: 'ok', database: pool ? 'configured' : 'not-configured'});
    return;
  }
  if (pathname === '/api/db-health') {
    if (!pool) return sendJson(res, 503, {status: 'not-configured'});
    try { await pool.query('SELECT 1'); sendJson(res, 200, {status: 'ok'}); }
    catch { sendJson(res, 503, {status: 'error'}); }
    return;
  }
  if (pathname === '/api/imports' && req.method === 'POST') {
    try { sendJson(res, 201, await persistImport(await readJson(req))); }
    catch (error) { sendJson(res, error.message === 'payload-too-large' ? 413 : 500, {error: error.message}); }
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
});

initDatabase().then(() => server.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on ${port}`))).catch(error => {
  console.error('Database initialization failed:', error.message);
  server.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on ${port} (database unavailable)`));
});
