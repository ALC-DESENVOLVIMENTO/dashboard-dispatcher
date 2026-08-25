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
    CREATE TABLE IF NOT EXISTS base_team_configs (
      base TEXT PRIMARY KEY,
      coordinator TEXT NOT NULL DEFAULT '',
      dispatchers JSONB NOT NULL DEFAULT '[]'::jsonb,
      ff_recipient TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id BIGSERIAL PRIMARY KEY,
      period TEXT NOT NULL,
      mode TEXT NOT NULL,
      base TEXT NOT NULL,
      dispatcher TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      file_size BIGINT NOT NULL DEFAULT 0,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      file_data BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(period, mode, base, dispatcher)
    );
    CREATE INDEX IF NOT EXISTS invoices_period_idx ON invoices(period, mode, base);
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

async function latestImports() {
  if (!pool) return {sources: {}};
  const result = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (source_type) id, source_type, file_name, imported_at
      FROM import_batches
      WHERE source_type IN ('DDS','MERCADO_LIVRE','LOGICA_FF','FF_LOCADORA')
      ORDER BY source_type, imported_at DESC, id DESC
    )
    SELECT l.source_type, l.file_name, l.imported_at,
           COALESCE(json_agg(r.data ORDER BY r.record_key) FILTER (WHERE r.data IS NOT NULL), '[]'::json) AS rows
    FROM latest l
    LEFT JOIN import_records r ON r.source_type = l.source_type
    GROUP BY l.source_type, l.file_name, l.imported_at
  `);
  return {sources: Object.fromEntries(result.rows.map(row => [row.source_type, {fileName: row.file_name, importedAt: row.imported_at, rows: row.rows}]))};
}

async function latestImportStatus() {
  if (!pool) return {sources: {}};
  const result = await pool.query(`
    SELECT DISTINCT ON (source_type) source_type, file_name, imported_at, row_count
    FROM import_batches
    WHERE source_type IN ('DDS','MERCADO_LIVRE','LOGICA_FF','FF_LOCADORA')
    ORDER BY source_type, imported_at DESC, id DESC
  `);
  return {sources: Object.fromEntries(result.rows.map(row => [row.source_type, {fileName: row.file_name, importedAt: row.imported_at, rowCount: row.row_count}]))};
}

async function listTeamConfigs() {
  if (!pool) return {bases: {}};
  const result = await pool.query('SELECT base, coordinator, dispatchers, ff_recipient FROM base_team_configs ORDER BY base');
  return {bases: Object.fromEntries(result.rows.map(row => [row.base, {coordinator: row.coordinator, dispatchers: row.dispatchers || [], ffRecipient: row.ff_recipient || ''}]))};
}

async function saveTeamConfig(payload) {
  if (!pool) throw new Error('database-not-configured');
  const base = String(payload.base || '').trim();
  if (!base) throw new Error('base-required');
  const coordinator = String(payload.coordinator || '').trim();
  const dispatchers = Array.isArray(payload.dispatchers) ? payload.dispatchers.map(value => String(value || '').trim()).filter(Boolean) : [];
  const ffRecipient = String(payload.ffRecipient || '').trim();
  await pool.query(`INSERT INTO base_team_configs (base,coordinator,dispatchers,ff_recipient,updated_at)
    VALUES ($1,$2,$3::jsonb,$4,NOW())
    ON CONFLICT (base) DO UPDATE SET coordinator=EXCLUDED.coordinator,dispatchers=EXCLUDED.dispatchers,ff_recipient=EXCLUDED.ff_recipient,updated_at=NOW()`, [base, coordinator, JSON.stringify(dispatchers), ffRecipient]);
  return {base, coordinator, dispatchers, ffRecipient};
}

async function listInvoices() {
  if (!pool) return {invoices: []};
  const result = await pool.query('SELECT id, period, mode, base, dispatcher, file_name, mime_type, file_size, amount, created_at FROM invoices ORDER BY created_at DESC, id DESC');
  return {invoices: result.rows};
}

async function saveInvoice(payload) {
  if (!pool) throw new Error('database-not-configured');
  const period = String(payload.period || '').trim();
  const mode = ['ff','spot'].includes(String(payload.mode || '').toLowerCase()) ? String(payload.mode).toLowerCase() : '';
  const base = String(payload.base || '').trim();
  const dispatcher = String(payload.dispatcher || '').trim();
  const fileName = String(payload.fileName || 'nota-fiscal').trim().slice(0,255);
  const amount = Number(payload.amount || 0);
  if (!/^\d{4}-\d{2}$/.test(period) || !mode || !base || !dispatcher || !payload.fileBase64) throw new Error('invoice-fields-required');
  const fileData = Buffer.from(payload.fileBase64, 'base64');
  const result = await pool.query(`INSERT INTO invoices (period,mode,base,dispatcher,file_name,mime_type,file_size,amount,file_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (period,mode,base,dispatcher) DO UPDATE SET file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,file_size=EXCLUDED.file_size,amount=EXCLUDED.amount,file_data=EXCLUDED.file_data,created_at=NOW()
    RETURNING id,period,mode,base,dispatcher,file_name,mime_type,file_size,amount,created_at`, [period, mode, base, dispatcher, fileName, payload.mimeType || null, fileData.length, Number.isFinite(amount) ? amount : 0, fileData]);
  return result.rows[0];
}

async function downloadInvoice(id, res) {
  if (!pool) return sendJson(res, 503, {error: 'database-not-configured'});
  const result = await pool.query('SELECT file_name, mime_type, file_data FROM invoices WHERE id=$1', [id]);
  if (!result.rowCount) { res.writeHead(404); res.end('Not found'); return; }
  const row = result.rows[0];
  res.writeHead(200, {'content-type': row.mime_type || 'application/octet-stream', 'content-disposition': `attachment; filename="${String(row.file_name).replace(/"/g, '')}"`});
  res.end(row.file_data);
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
  if (pathname === '/api/imports/status' && req.method === 'GET') {
    try { sendJson(res, 200, await latestImportStatus()); }
    catch (error) { sendJson(res, 500, {error: error.message}); }
    return;
  }
  if (pathname === '/api/imports/latest' && req.method === 'GET') {
    try { sendJson(res, 200, await latestImports()); }
    catch (error) { sendJson(res, 500, {error: error.message}); }
    return;
  }
  if (pathname === '/api/teams' && req.method === 'GET') {
    try { sendJson(res, 200, await listTeamConfigs()); }
    catch (error) { sendJson(res, 500, {error: error.message}); }
    return;
  }
  if (pathname === '/api/teams' && req.method === 'POST') {
    try { sendJson(res, 201, await saveTeamConfig(await readJson(req, 2 * 1024 * 1024))); }
    catch (error) { sendJson(res, 400, {error: error.message}); }
    return;
  }
  if (pathname === '/api/invoices' && req.method === 'GET') {
    try { sendJson(res, 200, await listInvoices()); }
    catch (error) { sendJson(res, 500, {error: error.message}); }
    return;
  }
  if (pathname === '/api/invoices' && req.method === 'POST') {
    try { sendJson(res, 201, await saveInvoice(await readJson(req, 20 * 1024 * 1024))); }
    catch (error) { sendJson(res, error.message === 'payload-too-large' ? 413 : 400, {error: error.message}); }
    return;
  }
  const invoiceMatch = pathname.match(/^\/api\/invoices\/(\d+)\/file$/);
  if (invoiceMatch && req.method === 'GET') {
    await downloadInvoice(invoiceMatch[1], res);
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
