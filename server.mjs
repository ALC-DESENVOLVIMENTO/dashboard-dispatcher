import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);
const maxImportPayload = 90 * 1024 * 1024;
const maxImportFile = 25 * 1024 * 1024;
const maxInvoiceFile = 10 * 1024 * 1024;
const maxRows = 200_000;
const authCookieName = 'bonus_control_session';
const authSessionTtlSeconds = Math.min(86400, Math.max(900, Number(process.env.AUTH_SESSION_TTL_SECONDS || 28800)));
const runDbMigrations = !isProduction || process.env.DB_RUN_MIGRATIONS === 'true';
const allowedSources = new Set(['DDS', 'MERCADO_LIVRE', 'LOGICA_FF', 'FF_LOCADORA']);
const xptBases = new Set(['ARAPUTANGA - EMR14', 'ARAXA - EMG34', 'CACERES - EMR6', 'CHAPADAO DO SUL - EGO17', 'CONCEICAO DO MATO DENTRO - EMG26', 'GUANHAES - EMG37', 'GUAXUPE - EMG7', 'MINACU - EDF10', 'MOZARLANDIA - EGO11', 'PONTES E LACERDA - EMR16', 'SANTO ANTONIO DA PLATINA - EPR7'].map(value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()));
const publicFiles = new Set(['index.html', 'styles.css', 'layout-overrides.css', 'period-utils.js', 'app.js', 'alc-logo.png', 'favicon.png', 'login.html', 'login.js']);
const publicOutputFiles = new Set(['dispatcher_bases.json', 'ff_logic_rows.json', 'ff_logic_summary.json', 'ff_routes.json', 'ff_summary.json', 'fleet_reference.json', 'spot_routes.json', 'spot_summary.json', 'xpt_bases.json']);
const mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.csv': 'text/csv; charset=utf-8'};
const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : process.env.DATABASE_URL.includes('railway.internal') ? false : {rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'},
  max: Number(process.env.DB_POOL_MAX || 5), connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000), idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000)
}) : null;

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

const rateBuckets = new Map();
const rateLimits = {read: {limit: 120, windowMs: 60000}, mutation: {limit: 10, windowMs: 60000}, import: {limit: 5, windowMs: 600000}, auth: {limit: Math.min(300, Math.max(10, Number(process.env.AUTH_RATE_LIMIT_PER_15_MIN || 120))), windowMs: 900000}};
const memorySessions = new Map();
let lastSessionCleanupAt = 0;
function clientIp(req) {
  if (process.env.TRUST_PROXY === 'true') { const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (forwarded) return forwarded.slice(0, 80); }
  return String(req.socket.remoteAddress || 'unknown').slice(0, 80);
}
function consumeRateLimit(req, category) {
  const policy = rateLimits[category] || rateLimits.read, sessionToken = category === 'auth' ? '' : cookieValue(req, authCookieName), identity = /^[A-Za-z0-9_-]{40,}$/.test(sessionToken) ? `session:${sessionHash(sessionToken)}` : `ip:${clientIp(req)}`, key = `${category}:${identity}`, now = Date.now(), current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= policy.windowMs) { rateBuckets.set(key, {startedAt: now, count: 1}); return true; }
  current.count += 1; return current.count <= policy.limit;
}
setInterval(() => { const cutoff = Date.now() - 600000; for (const [key, value] of rateBuckets) if (value.startedAt < cutoff) rateBuckets.delete(key); }, 60000).unref();

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()'); res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', ["default-src 'self'", "script-src 'self' https://cdn.sheetjs.com", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "img-src 'self' data:", "connect-src 'self'", "font-src 'self' data: https://fonts.gstatic.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join('; '));
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function sendJson(res, status, body, requestId) { if (requestId) res.setHeader('X-Request-Id', requestId); res.setHeader('content-type', 'application/json; charset=utf-8'); res.statusCode = status; res.end(JSON.stringify(body)); }
function sendError(res, error, requestId) { const status = error instanceof HttpError ? error.status : 500, code = error instanceof HttpError ? error.code : 'internal-error'; if (!(error instanceof HttpError)) console.error(JSON.stringify({requestId, error: error?.message || 'unknown-error'})); sendJson(res, status, {error: code, requestId}, requestId); }
function normalizeKey(value) { return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function safeText(value, name, max = 255, required = false) { if (typeof value !== 'string' && value !== undefined && value !== null) throw new HttpError(400, `${name}-invalid`); const text = String(value ?? '').normalize('NFC').trim(); if (required && !text) throw new HttpError(400, `${name}-required`); if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new HttpError(400, `${name}-invalid`); return text; }
function safeFileName(value, fallback) { const raw = safeText(value, 'file-name', 255, false), name = raw.split(/[\\/]/).pop() || fallback; if (!name || name === '.' || name === '..' || name.startsWith('.')) throw new HttpError(400, 'file-name-invalid'); return name; }
function fileExtension(fileName) { return String(fileName).slice(String(fileName).lastIndexOf('.')).toLowerCase(); }
function decodeBase64(value, maxBytes) { if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 1.4)) throw new HttpError(413, 'file-too-large'); const clean = value.trim(); if (!clean || clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new HttpError(400, 'file-invalid'); const data = Buffer.from(clean, 'base64'); if (!data.length || data.length > maxBytes) throw new HttpError(413, 'file-too-large'); return data; }
function normalizeRow(row) { if (!row || typeof row !== 'object' || Array.isArray(row)) throw new HttpError(400, 'row-invalid'); const output = {}, entries = Object.entries(row); if (entries.length > 120) throw new HttpError(400, 'row-too-many-fields'); for (const [key, value] of entries) { const cleanKey = safeText(key, 'column', 150, true); if (value !== null && typeof value === 'object') throw new HttpError(400, 'row-nested-value'); if (typeof value === 'number' && !Number.isFinite(value)) throw new HttpError(400, 'row-number-invalid'); output[cleanKey] = typeof value === 'string' ? safeText(value, 'row-value', 10000) : value; } if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 100000) throw new HttpError(400, 'row-too-large'); return output; }
async function readJson(req, maxBytes) { const declared = Number(req.headers['content-length'] || 0); if (declared && declared > maxBytes) throw new HttpError(413, 'payload-too-large'); if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'json-required'); const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new HttpError(413, 'payload-too-large'); chunks.push(chunk); } try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid'); return body; } catch { throw new HttpError(400, 'invalid-json'); } }

function recordKey(row, index) { const value = row?.['Rota Logistics'] ?? row?.['ROTA LOGISTICS'] ?? row?.rotaLogistics ?? row?.rotalogistics ?? row?.rota, date = row?.Data ?? row?.data ?? row?.Date ?? row?.date ?? row?.['Data da rota'] ?? '', plate = row?.PLACA ?? row?.Placa ?? row?.placa ?? row?.Plate ?? row?.plate ?? '', delivery = row?.['ID Entrega'] ?? row?.idEntrega ?? row?.identrega ?? row?.Pedido ?? row?.pedido ?? row?.shipment ?? '', route = String(value ?? '').trim(), raw = delivery ? `${route}|${date}|${plate}|${delivery}` : route ? `${route}|${date}|${plate}` : stableJson(row) || String(index); return createHash('sha256').update(raw.toUpperCase()).digest('hex'); }
function importPeriod(value) { const text = String(value ?? '').trim(); if (!text) return ''; const iso = text.match(/^(\d{4})[-/](\d{1,2})/); if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}`; const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/); if (slash) return `${slash[3]}-${String(Number(slash[2])).padStart(2, '0')}`; const parsed = new Date(text); return Number.isNaN(parsed.getTime()) ? '' : `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`; }
function operationPeriod(value) { const match = String(value || '').match(/^(\d{4}-(?:0[1-9]|1[0-2]))(?::([12]))?$/); return match ? {key: match[0], month: match[1], part: match[2] || 'monthly'} : null; }
function operationPeriodContains(date, selected) { const key = String(date || '').slice(0, 10); if (!selected || !/^\d{4}-\d{2}-\d{2}$/.test(key) || key.slice(0, 7) !== selected.month) return false; const day = Number(key.slice(8, 10)); return selected.part === '1' ? day <= 15 : selected.part === '2' ? day >= 16 : true; }
function operationPeriodDays(selected) { if (!selected) return 0; if (selected.part === '1') return 15; const [year, month] = selected.month.split('-').map(Number); const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate(); return selected.part === '2' ? Math.max(0, daysInMonth - 15) : daysInMonth; }
function importedRowPeriod(row) { for (const [key, value] of Object.entries(row || {})) { const normalized = normalizeKey(key); if (normalized === 'data' || normalized === 'date' || normalized.includes('datadarota') || normalized.includes('datadodispatch') || normalized.includes('datadispatch')) { const period = importPeriod(value); if (period) return period; } } return ''; }
function publicPath(urlPath) { let decoded; try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; } const clean = (decoded === '/' ? '/index.html' : decoded).replace(/^\/+/, ''); if (clean.includes('..') || clean.includes('\\') || clean.startsWith('.')) return null; if (publicFiles.has(clean)) return join(root, clean); const prefix = 'outputs/thread-01/'; if (clean.startsWith(prefix) && publicOutputFiles.has(clean.slice(prefix.length))) return join(root, clean); return null; }
function ipAllowlistAllows(req) { const allowlist = String(process.env.ADMIN_IP_ALLOWLIST || '').split(',').map(value => value.trim()).filter(Boolean); return !allowlist.length || allowlist.includes('*') || allowlist.includes(clientIp(req)); }
function mutationAllowed(req) { if (!isProduction) return process.env.ADMIN_MUTATIONS_ENABLED !== 'false'; if (process.env.ADMIN_MUTATIONS_ENABLED !== 'true') return false; return ipAllowlistAllows(req); }
function privateAdminReadAllowed(req) { if (!isProduction) return true; if (process.env.ADMIN_READ_ENABLED !== 'true') return false; return ipAllowlistAllows(req); }
function cookieValue(req, name) { const cookies = String(req.headers.cookie || '').split(';').map(item => item.trim()); const prefix = `${name}=`; return cookies.find(item => item.startsWith(prefix))?.slice(prefix.length) || ''; }
const rolePermissions = Object.freeze({
  manager: Object.freeze({views: ['dashboard', 'rotas', 'bases', 'comparativo', 'regras', 'importar', 'notas'], canUploadInvoice: true, canManageTeams: true, canManageImports: true, canViewInvoices: true}),
  coordinator: Object.freeze({views: ['dashboard', 'rotas', 'bases', 'comparativo'], canUploadInvoice: true, canManageTeams: false, canManageImports: false, canViewInvoices: false}),
  dispatcher: Object.freeze({views: ['dashboard', 'rotas', 'bases', 'comparativo'], canUploadInvoice: false, canManageTeams: false, canManageImports: false, canViewInvoices: false})
});
function configuredUsers() {
  return [
    {username: process.env.AUTH_USERNAME, passwordHash: process.env.AUTH_PASSWORD_HASH, role: 'manager'},
    {username: process.env.AUTH_COORDINATION_USERNAME, passwordHash: process.env.AUTH_COORDINATION_PASSWORD_HASH, role: 'coordinator'},
    {username: process.env.AUTH_DISPATCHER_USERNAME, passwordHash: process.env.AUTH_DISPATCHER_PASSWORD_HASH, role: 'dispatcher'}
  ].filter(user => user.username && user.passwordHash);
}
function authPasswordConfigured() { return configuredUsers().length > 0; }
function safeUsername(value) { return safeText(value, 'username', 120, true); }
function passwordDigest(password, salt, parameters = {}) { const N = Number(parameters.N || 16384), r = Number(parameters.r || 8), p = Number(parameters.p || 1); return scryptSync(String(password), Buffer.from(salt, 'hex'), 64, {N, r, p, maxmem: 32 * 1024 * 1024}); }
function verifyPassword(password, passwordHash) {
  const parts = String(passwordHash || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, encoded] = parts, expected = Buffer.from(encoded, 'hex');
  if (!/^\d+$/.test(n) || !/^\d+$/.test(r) || !/^\d+$/.test(p) || !/^[a-f0-9]{32,128}$/i.test(salt) || expected.length !== 64) return false;
  try { const actual = passwordDigest(password, salt, {N: Number(n), r: Number(r), p: Number(p)}); return timingSafeEqual(actual, expected); } catch { return false; }
}
function constantTimeTextEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
function configuredUser(username) { return configuredUsers().find(user => constantTimeTextEqual(username, user.username)) || null; }
function publicSession(session) {
  const permissions = rolePermissions[session.role] || rolePermissions.dispatcher;
  return {authenticated: true, username: session.username, role: session.role, permissions};
}
function sessionHash(token) { return createHash('sha256').update(token).digest('hex'); }
async function cleanupExpiredSessions() { const now = Date.now(); if (!pool || now - lastSessionCleanupAt < 300000) return; lastSessionCleanupAt = now; await pool.query('DELETE FROM auth_sessions WHERE expires_at <= NOW()'); }
async function createSession(req, username) {
  const token = randomBytes(32).toString('base64url'), hash = sessionHash(token), expiresAt = new Date(Date.now() + authSessionTtlSeconds * 1000);
  if (pool) await pool.query('INSERT INTO auth_sessions (token_hash, username, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)', [hash, username, expiresAt, clientIp(req), safeText(String(req.headers['user-agent'] || ''), 'user-agent', 512, false)]);
  else memorySessions.set(hash, {username, expiresAt: expiresAt.getTime()});
  return {token, expiresAt};
}
async function currentSession(req) {
  const token = cookieValue(req, authCookieName); if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const hash = sessionHash(token);
  if (pool) { await cleanupExpiredSessions(); const session = await pool.query('SELECT username, expires_at FROM auth_sessions WHERE token_hash=$1 AND expires_at > NOW()', [hash]); if (!session.rowCount) return null; const user = configuredUser(session.rows[0].username); if (!user) return null; return {username: user.username, role: user.role, tokenHash: hash, expiresAt: session.rows[0].expires_at}; }
  const session = memorySessions.get(hash); if (!session || session.expiresAt <= Date.now()) { memorySessions.delete(hash); return null; } const user = configuredUser(session.username); if (!user) return null; return {username: user.username, role: user.role, tokenHash: hash, expiresAt: new Date(session.expiresAt)};
}
async function requireAuth(req) { const session = await currentSession(req); if (!session) throw new HttpError(401, 'authentication-required'); req.auth = session; return session; }
async function requireRole(req, allowedRoles) { const session = req.auth || await requireAuth(req); if (!allowedRoles.includes(session.role)) throw new HttpError(403, 'access-denied'); return session; }
function sameOriginAllowed(req) { const origin = String(req.headers.origin || ''), appOrigin = String(process.env.APP_ORIGIN || '').replace(/\/$/, ''); if (isProduction && !appOrigin) throw new HttpError(503, 'origin-not-configured'); if (origin && appOrigin && origin !== appOrigin) throw new HttpError(403, 'origin-not-allowed'); }
async function checkPrivateRead(req, allowedRoles) { await requireRole(req, allowedRoles); if (!privateAdminReadAllowed(req)) throw new HttpError(403, 'administrative-read-restricted'); if (!consumeRateLimit(req, 'read')) throw new HttpError(429, 'rate-limit-exceeded'); }
async function checkMutation(req, res, allowedRoles = ['manager']) { await requireRole(req, allowedRoles); sameOriginAllowed(req); if (!mutationAllowed(req)) { res.setHeader('Retry-After', '3600'); throw new HttpError(403, 'administrative-operation-restricted'); } if (!consumeRateLimit(req, 'mutation')) throw new HttpError(429, 'rate-limit-exceeded'); }
async function audit(client, action, resourceType, resourceKey, req, details = {}) { await client.query('INSERT INTO audit_events (id,action,resource_type,resource_key,request_id,ip,details) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [randomUUID(), action, resourceType, String(resourceKey || ''), req.requestId, clientIp(req), JSON.stringify({...details, username: req.auth?.username || null, role: req.auth?.role || null})]); }

async function initDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_batches (id BIGSERIAL PRIMARY KEY, source_type TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT, file_size BIGINT NOT NULL DEFAULT 0, row_count INTEGER NOT NULL DEFAULT 0, file_data BYTEA, content_hash TEXT, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS content_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS import_batches_content_idx ON import_batches(source_type, content_hash) WHERE content_hash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS import_records (source_type TEXT NOT NULL, record_key TEXT NOT NULL, batch_id BIGINT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE, data JSONB NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, PRIMARY KEY (source_type, record_key));
    ALTER TABLE import_records ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS import_records_batch_idx ON import_records(batch_id);
    CREATE INDEX IF NOT EXISTS import_batches_imported_at_idx ON import_batches(imported_at DESC);
    CREATE TABLE IF NOT EXISTS base_team_configs (base TEXT PRIMARY KEY, coordinator TEXT NOT NULL DEFAULT '', dispatchers JSONB NOT NULL DEFAULT '[]'::jsonb, ff_recipient TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS invoices (id BIGSERIAL PRIMARY KEY, period TEXT NOT NULL, mode TEXT NOT NULL, base TEXT NOT NULL, dispatcher TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT, file_size BIGINT NOT NULL DEFAULT 0, amount NUMERIC(12,2) NOT NULL DEFAULT 0, file_data BYTEA, public_token TEXT, deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(period, mode, base, dispatcher));
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_token TEXT;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_public_token_idx ON invoices(public_token) WHERE public_token IS NOT NULL;
    CREATE INDEX IF NOT EXISTS invoices_period_idx ON invoices(period, mode, base);
    CREATE TABLE IF NOT EXISTS audit_events (id UUID PRIMARY KEY, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_key TEXT NOT NULL DEFAULT '', request_id TEXT, ip TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);
    CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, ip TEXT, user_agent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
  `);
  let missing;
  do {
    missing = await pool.query('SELECT id FROM invoices WHERE public_token IS NULL LIMIT 1000');
    for (const row of missing.rows) await pool.query('UPDATE invoices SET public_token=$1 WHERE id=$2 AND public_token IS NULL', [randomUUID(), row.id]);
  } while (missing.rowCount);
}

async function login(payload, req, res) {
  if (!authPasswordConfigured()) throw new HttpError(503, 'authentication-not-configured');
  if (!consumeRateLimit(req, 'auth')) throw new HttpError(429, 'rate-limit-exceeded');
  sameOriginAllowed(req);
  const username = safeUsername(payload.username), password = typeof payload.password === 'string' ? payload.password : '';
  const user = configuredUser(username);
  const fallbackHash = configuredUsers()[0]?.passwordHash || '';
  if (!password || !verifyPassword(password, user?.passwordHash || fallbackHash) || !user) throw new HttpError(401, 'invalid-credentials');
  const session = await createSession(req, user.username);
  const secure = isProduction ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${authCookieName}=${session.token}; Path=/; Max-Age=${authSessionTtlSeconds}; HttpOnly; SameSite=Strict${secure}`);
  return {...publicSession(user), expiresAt: session.expiresAt.toISOString()};
}
async function logout(req, res) {
  const session = await currentSession(req);
  if (session) {
    if (pool) await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [session.tokenHash]);
    else memorySessions.delete(session.tokenHash);
  }
  res.setHeader('Set-Cookie', `${authCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${isProduction ? '; Secure' : ''}`);
  return {authenticated: false};
}

async function importPeriodSummary(period) { if (!pool) return {period, sources: {}}; if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new HttpError(400, 'period-invalid'); const result = await pool.query("SELECT source_type, data FROM import_records WHERE deleted_at IS NULL AND source_type = ANY($1::text[])", [['DDS', 'MERCADO_LIVRE', 'LOGICA_FF']]); const sources = {}; for (const row of result.rows) if (importedRowPeriod(row.data) === period) sources[row.source_type] = (sources[row.source_type] || 0) + 1; return {period, sources: Object.fromEntries(Object.entries(sources).map(([source, records]) => [source, {records}]))}; }
async function removeImportPeriod(period, req) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new HttpError(400, 'period-invalid'); if (!pool) throw new HttpError(503, 'database-not-configured'); const client = await pool.connect(); try { await client.query('BEGIN'); const result = await client.query("SELECT source_type, record_key, data FROM import_records WHERE deleted_at IS NULL AND source_type = ANY($1::text[])", [['DDS', 'MERCADO_LIVRE', 'LOGICA_FF']]); const grouped = {}; for (const row of result.rows) if (importedRowPeriod(row.data) === period) (grouped[row.source_type] ||= []).push(row.record_key); for (const [source, keys] of Object.entries(grouped)) if (keys.length) await client.query('UPDATE import_records SET deleted_at=NOW() WHERE source_type=$1 AND record_key=ANY($2::text[])', [source, keys]); await audit(client, 'archive-import-period', 'import-period', period, req, {counts: Object.fromEntries(Object.entries(grouped).map(([source, keys]) => [source, keys.length]))}); await client.query('COMMIT'); return {period, archived: Object.fromEntries(Object.entries(grouped).map(([source, keys]) => [source, keys.length]))}; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }

async function persistImport(payload, req) {
  if (!pool) throw new HttpError(503, 'database-not-configured');
  const sourceType = safeText(payload.sourceType, 'source-type', 50, true).toUpperCase(); if (!allowedSources.has(sourceType)) throw new HttpError(400, 'source-type-invalid');
  const fileName = safeFileName(payload.fileName, 'importacao.xlsx'), extension = fileExtension(fileName); if (!['.xlsx', '.csv'].includes(extension)) throw new HttpError(400, 'file-extension-invalid');
  const fileData = decodeBase64(payload.fileBase64, maxImportFile), rows = Array.isArray(payload.rows) ? payload.rows.map(normalizeRow) : []; if (!rows.length || rows.length > maxRows) throw new HttpError(400, 'rows-invalid');
  const unique = new Map(); rows.forEach((row, index) => unique.set(recordKey(row, index), row)); const uniqueRows = [...unique.entries()];
  const contentHash = createHash('sha256').update(sourceType).update(fileData).update(stableJson(uniqueRows.map(([, row]) => row))).digest('hex'); if (!consumeRateLimit(req, 'import')) throw new HttpError(429, 'rate-limit-exceeded');
  const client = await pool.connect(); try { await client.query('BEGIN'); const existing = await client.query('SELECT id FROM import_batches WHERE source_type=$1 AND content_hash=$2', [sourceType, contentHash]); if (existing.rowCount) { await client.query('COMMIT'); return {batchId: Number(existing.rows[0].id), rowsReceived: rows.length, recordsUpserted: 0, idempotent: true}; }
    const batch = await client.query('INSERT INTO import_batches (source_type,file_name,mime_type,file_size,row_count,file_data,content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [sourceType, fileName, extension === '.csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileData.length, rows.length, fileData, contentHash]); const batchId = Number(batch.rows[0].id); let upserted = 0;
    for (let offset = 0; offset < uniqueRows.length; offset += 250) { const chunk = uniqueRows.slice(offset, offset + 250), values = [], placeholders = chunk.map(([key, row], index) => { const p = index * 4; values.push(sourceType, key, batchId, JSON.stringify(row)); return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},NOW(),NULL)`; }); await client.query(`INSERT INTO import_records (source_type,record_key,batch_id,data,imported_at,deleted_at) VALUES ${placeholders.join(',')} ON CONFLICT (source_type,record_key) DO UPDATE SET batch_id=EXCLUDED.batch_id,data=EXCLUDED.data,imported_at=NOW(),deleted_at=NULL`, values); upserted += chunk.length; }
    await audit(client, 'import-upsert', 'import-batch', batchId, req, {sourceType, rowsReceived: rows.length, recordsUpserted: upserted, contentHash}); await client.query('COMMIT'); return {batchId, rowsReceived: rows.length, recordsUpserted: upserted, idempotent: false};
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function latestImports() { if (!pool) return {sources: {}}; const result = await pool.query(`WITH latest AS (SELECT DISTINCT ON (source_type) id, source_type, file_name, imported_at FROM import_batches WHERE source_type = ANY($1::text[]) ORDER BY source_type, imported_at DESC, id DESC) SELECT l.source_type, l.file_name, l.imported_at, COALESCE(json_agg(r.data ORDER BY r.record_key) FILTER (WHERE r.data IS NOT NULL), '[]'::json) AS rows FROM latest l LEFT JOIN import_records r ON r.source_type=l.source_type AND r.deleted_at IS NULL GROUP BY l.source_type, l.file_name, l.imported_at`, [['DDS', 'MERCADO_LIVRE', 'LOGICA_FF', 'FF_LOCADORA']]); return {sources: Object.fromEntries(result.rows.map(row => [row.source_type, {fileName: row.file_name, importedAt: row.imported_at, rows: row.rows}]))}; }
async function latestImportStatus() { if (!pool) return {sources: {}}; const result = await pool.query(`SELECT DISTINCT ON (source_type) source_type, file_name, imported_at, row_count FROM import_batches WHERE source_type = ANY($1::text[]) ORDER BY source_type, imported_at DESC, id DESC`, [['DDS', 'MERCADO_LIVRE', 'LOGICA_FF', 'FF_LOCADORA']]); return {sources: Object.fromEntries(result.rows.map(row => [row.source_type, {fileName: row.file_name, importedAt: row.imported_at, rowCount: row.row_count}]))}; }
async function listTeamConfigs() { if (!pool) return {bases: {}}; const result = await pool.query('SELECT base, coordinator, dispatchers, ff_recipient FROM base_team_configs ORDER BY base'); return {bases: Object.fromEntries(result.rows.map(row => [row.base, {coordinator: row.coordinator, dispatchers: row.dispatchers || [], ffRecipient: row.ff_recipient || ''}]))}; }
async function saveTeamConfig(payload, req) { if (!pool) throw new HttpError(503, 'database-not-configured'); const base = safeText(payload.base, 'base', 160, true), coordinator = safeText(payload.coordinator, 'coordinator', 160, false); if (!Array.isArray(payload.dispatchers) || payload.dispatchers.length > 100) throw new HttpError(400, 'dispatchers-invalid'); const dispatchers = [...new Set(payload.dispatchers.map(value => safeText(value, 'dispatcher', 160, true)))], ffRecipient = safeText(payload.ffRecipient, 'ff-recipient', 160, false); if (ffRecipient && !dispatchers.includes(ffRecipient)) throw new HttpError(400, 'ff-recipient-invalid'); const client = await pool.connect(); try { await client.query('BEGIN'); await client.query(`INSERT INTO base_team_configs (base,coordinator,dispatchers,ff_recipient,updated_at) VALUES ($1,$2,$3::jsonb,$4,NOW()) ON CONFLICT (base) DO UPDATE SET coordinator=EXCLUDED.coordinator,dispatchers=EXCLUDED.dispatchers,ff_recipient=EXCLUDED.ff_recipient,updated_at=NOW()`, [base, coordinator, JSON.stringify(dispatchers), ffRecipient]); await audit(client, 'team-config-upsert', 'base', base, req, {dispatcherCount: dispatchers.length, hasFfRecipient: Boolean(ffRecipient)}); await client.query('COMMIT'); return {base, coordinator, dispatchers, ffRecipient}; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }

function allowedBonusCents(mode) { if (mode === 'ff') return new Set([0, 35000, 70000, 100000]); return new Set([0, 25000, 33333, 37500, 50000, 66667, 75000, 100000, 125000, 133333, 150000, 166667, 175000, 200000, 225000, 233333, 250000, 266667, 300000, 333333, 350000, 400000, 450000, 500000, 600000, 700000, 800000, 900000, 1000000]); }
function bonusCents(value, mode) { const number = typeof value === 'number' ? value : Number(value); if (!Number.isFinite(number) || number < 0 || number > 10000 || Math.abs(number * 100 - Math.round(number * 100)) > 1e-6) throw new HttpError(400, 'bonus-amount-invalid'); const cents = Math.round(number * 100); if (!allowedBonusCents(mode).has(cents)) throw new HttpError(400, 'bonus-amount-not-in-policy'); return cents; }
function recordNormalized(row) { return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [normalizeKey(key), value])); }
function routeDate(row) { const raw = row.data ?? row.date ?? row.datadarota ?? row.datadispatch ?? row.datadodispatch ?? row.routedate; if (typeof raw === 'number' && raw > 20_000) return new Date(Date.UTC(1899, 11, 30 + raw)).toISOString().slice(0, 10); const text = String(raw ?? '').trim(); const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/); if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}-${String(Number(iso[3])).padStart(2, '0')}`; const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/); if (dmy) return `${dmy[3]}-${String(Number(dmy[2])).padStart(2, '0')}-${String(Number(dmy[1])).padStart(2, '0')}`; const parsed = new Date(text); return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10); }
function routePeriod(date) { return String(date || '').slice(0, 7); }
function normalizedPerson(value) { return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function normalizedPlate(value) { return normalizedPerson(value); }
function canonicalServerBase(value) { const base = String(value ?? '').trim(); const normalized = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(); if (normalized === 'RIBEIRAO PRETO - SSP4') return 'CRAVINHOS - SSP4'; return base; }
function isXptServerBase(value) { return xptBases.has(canonicalServerBase(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()); }
function parsePercentValue(value) { const n = Number(String(value ?? '').replace('%', '').replace(',', '.').trim()); if (!Number.isFinite(n) || n < 0 || n > 100) return null; return n > 1 ? n / 100 : n; }
function routeIdentity(row) { const r = recordNormalized(row); return {base: canonicalServerBase(r.base || 'Base sem nome'), date: routeDate(r), plate: String(r.placa || r.plate || '').trim(), driver: String(r.motorista || r.nomemotorista || r.nomedomotorista || r.nomecondutor || r.driver || r.drivername || '').trim(), route: String(r.rotalogistics || r.rota || r.route || '').trim(), cluster: String(r.cluster || '').trim()}; }
function mercadoIdentity(row) { const r = recordNormalized(row); return {date: routeDate(r), driver: normalizedPerson(r.motorista || r.nomemotorista || r.nomedomotorista || r.nomedotransportador || r.nometransportador || r.nomecondutor || r.driver || r.drivername || r.condutor || r.nome || r.transportador), route: normalizedPerson(r.rotalogistics || r.iddarota || r.idrota || r.routeid || r.rota), plate: normalizedPlate(r.placa || r.plate), ds: parsePercentValue(r.ds || r.dsrota || r.percentualds || r.deliverysuccessrate || r.performance || r.performanceds || r.entregacomsucesso || r.entregascomsucesso || r.entregassucesso || r.sucessos || r.successfuldeliveries)}; }
async function authoritativeBonusCents(period, mode, base, dispatcher) {
  if (!pool) return null;
  const selectedPeriod = operationPeriod(period); if (!selectedPeriod) throw new HttpError(400, 'period-invalid');
  const result = await pool.query("SELECT source_type, data FROM import_records WHERE deleted_at IS NULL AND source_type = ANY($1::text[])", [['DDS', 'MERCADO_LIVRE', 'LOGICA_FF', 'FF_LOCADORA']]);
  const rows = {DDS: [], MERCADO_LIVRE: [], LOGICA_FF: [], FF_LOCADORA: []}; result.rows.forEach(row => rows[row.source_type]?.push(row.data));
  const canonicalBase = canonicalServerBase(base);
  const dds = rows.DDS.map(routeIdentity).filter(row => operationPeriodContains(row.date, selectedPeriod) && row.base === canonicalBase && !isXptServerBase(row.base) && row.plate && row.date && row.cluster.toUpperCase() !== 'ROTA');
  const mercado = new Map(); rows.MERCADO_LIVRE.map(mercadoIdentity).filter(row => operationPeriodContains(row.date, selectedPeriod) && row.date).forEach(row => { const keys = [`driver|${row.date}|${row.driver}`, `route|${row.date}|${row.route}`, `plate|${row.date}|${row.plate}`].filter(key => !key.endsWith('|')); if (row.ds === null) return; keys.forEach(key => mercado.set(key, row.ds)); });
  const logic = rows.LOGICA_FF.map(routeIdentity).map((row, index) => { const raw = recordNormalized(rows.LOGICA_FF[index]); return {...row, status: String(raw.rotas || raw.status || '').trim().toUpperCase(), reserve: String(raw.reservas || raw.reserva || '').trim()}; }).filter(row => operationPeriodContains(row.date, selectedPeriod) && row.base && row.plate);
  const counted = new Set(['PLACA BIPADA', 'RESERVA BIPADA']);
  const ffKeys = new Set(); const logicByBase = new Map();
  logic.forEach(row => { row.base = canonicalServerBase(row.base); const group = logicByBase.get(row.base) || {plates: new Set(), bipped: 0}; group.plates.add(normalizedPlate(row.plate)); if (counted.has(row.status)) { group.bipped += 1; ffKeys.add(`${row.date}|${normalizedPlate(row.plate)}`); if (row.reserve) ffKeys.add(`${row.date}|${normalizedPlate(row.reserve)}`); } logicByBase.set(row.base, group); });
  const fleetPlates = new Set(rows.FF_LOCADORA.map(row => recordNormalized(row)).map(row => normalizedPlate(row.placa || row.plate)).filter(Boolean));
  const withDs = dds.map(row => { const keys = [`driver|${row.date}|${normalizedPerson(row.driver)}`, `route|${row.date}|${normalizedPerson(row.route)}`, `plate|${row.date}|${normalizedPlate(row.plate)}`]; const ds = keys.map(key => mercado.get(key)).find(value => Number.isFinite(value)); return {...row, ds}; });
  if (mode === 'ff') {
    const ffRoutes = withDs.filter(row => ffKeys.has(`${row.date}|${normalizedPlate(row.plate)}`));
    const average = ffRoutes.filter(row => Number.isFinite(row.ds)).reduce((sum, row) => sum + row.ds, 0) / (ffRoutes.filter(row => Number.isFinite(row.ds)).length || 1);
    const plannedDays = selectedPeriod.part === 'monthly' ? 26 : 13; const group = logicByBase.get(canonicalBase); const share = group?.plates.size ? group.bipped / (group.plates.size * plannedDays) : null; const payout = average >= .92 && Number.isFinite(share) ? (share >= 1 ? 100000 : share >= .95 ? 70000 : share >= .9 ? 35000 : 0) : 0;
    const team = await pool.query('SELECT ff_recipient FROM base_team_configs WHERE base=$1', [canonicalBase]); return team.rows[0]?.ff_recipient && team.rows[0].ff_recipient === dispatcher ? payout : 0;
  }
  const spotRoutes = withDs.filter(row => !ffKeys.has(`${row.date}|${normalizedPlate(row.plate)}`) && !fleetPlates.has(normalizedPlate(row.plate)) && Number.isFinite(row.ds) && row.ds >= .92);
  const days = operationPeriodDays(selectedPeriod); const cars = days ? spotRoutes.length / days : 0; const bands = [[105, 1000000], [95, 900000], [85, 800000], [75, 700000], [65, 600000], [55, 500000], [45, 400000], [35, 300000], [25, 200000], [15, 150000], [10, 100000]]; const band = bands.find(([minimum]) => cars >= minimum); if (!band) return 0; const team = await pool.query('SELECT dispatchers FROM base_team_configs WHERE base=$1', [canonicalBase]); const count = Math.min(4, Math.max(1, Array.isArray(team.rows[0]?.dispatchers) ? team.rows[0].dispatchers.length : 1)); const columns = {1: band[1], 2: Math.round(band[1] / 2), 3: Math.round(band[1] / 3), 4: Math.round(band[1] / 4)}; return team.rows[0]?.dispatchers?.includes(dispatcher) ? columns[count] : 0;
}
async function listInvoices() { if (!pool) return {invoices: []}; const result = await pool.query('SELECT public_token AS file_token, period, mode, base, dispatcher, file_name, mime_type, file_size, amount, created_at FROM invoices WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC'); return {invoices: result.rows}; }
async function saveInvoice(payload, req) { if (!pool) throw new HttpError(503, 'database-not-configured'); const period = safeText(payload.period, 'period', 9, true), mode = String(payload.mode || '').toLowerCase(), base = safeText(payload.base, 'base', 160, true), dispatcher = safeText(payload.dispatcher, 'dispatcher', 160, true); if (!operationPeriod(period) || !['ff', 'spot'].includes(mode)) throw new HttpError(400, 'invoice-fields-invalid'); const fileName = safeFileName(payload.fileName, 'nota-fiscal.pdf'), extension = fileExtension(fileName), mimeType = new Map([['.pdf', 'application/pdf'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg']]).get(extension); if (!mimeType) throw new HttpError(400, 'invoice-extension-invalid'); if (payload.mimeType && !['application/octet-stream', mimeType].includes(String(payload.mimeType).toLowerCase())) throw new HttpError(400, 'invoice-mime-invalid'); const fileData = decodeBase64(payload.fileBase64, maxInvoiceFile), claimedCents = bonusCents(payload.amount, mode), calculatedCents = await authoritativeBonusCents(period, mode, base, dispatcher), amountCents = calculatedCents === null ? claimedCents : calculatedCents; if ((isProduction || process.env.STRICT_SERVER_BONUS === 'true') && calculatedCents !== null && claimedCents !== calculatedCents) throw new HttpError(409, 'bonus-amount-mismatch'); const client = await pool.connect(); try { await client.query('BEGIN'); const result = await client.query(`INSERT INTO invoices (period,mode,base,dispatcher,file_name,mime_type,file_size,amount,file_data,public_token,deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL) ON CONFLICT (period,mode,base,dispatcher) DO UPDATE SET file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,file_size=EXCLUDED.file_size,amount=EXCLUDED.amount,file_data=EXCLUDED.file_data,deleted_at=NULL,created_at=NOW() RETURNING public_token AS file_token,period,mode,base,dispatcher,file_name,mime_type,file_size,amount,created_at`, [period, mode, base, dispatcher, fileName, mimeType, fileData.length, amountCents / 100, fileData, randomUUID()]); await audit(client, 'invoice-upsert', 'invoice', `${period}:${mode}:${base}:${dispatcher}`, req, {amountCents, fileSize: fileData.length, serverCalculated: calculatedCents !== null}); await client.query('COMMIT'); return result.rows[0]; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
async function downloadInvoice(token, res) { if (!pool) throw new HttpError(503, 'database-not-configured'); if (!/^[a-f0-9-]{36}$/i.test(token)) throw new HttpError(400, 'file-token-invalid'); const result = await pool.query('SELECT mime_type, file_data FROM invoices WHERE public_token=$1 AND deleted_at IS NULL', [token]); if (!result.rowCount) throw new HttpError(404, 'not-found'); const row = result.rows[0]; res.setHeader('content-type', row.mime_type || 'application/octet-stream'); res.setHeader('content-disposition', 'attachment; filename="nota-fiscal"'); res.setHeader('cache-control', 'private, no-store'); res.end(row.file_data); }
async function archiveInvoice(token, req) { if (!pool) throw new HttpError(503, 'database-not-configured'); if (!/^[a-f0-9-]{36}$/i.test(token)) throw new HttpError(400, 'file-token-invalid'); const client = await pool.connect(); try { await client.query('BEGIN'); const result = await client.query('UPDATE invoices SET deleted_at=NOW() WHERE public_token=$1 AND deleted_at IS NULL RETURNING public_token', [token]); if (!result.rowCount) throw new HttpError(404, 'not-found'); await audit(client, 'invoice-archive', 'invoice', token, req); await client.query('COMMIT'); return {archived: true}; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }

async function routeRequest(req, res) {
  const requestId = randomUUID(); req.requestId = requestId; const url = new URL(req.url || '/', 'http://localhost'), pathname = url.pathname; if (!consumeRateLimit(req, 'read')) throw new HttpError(429, 'rate-limit-exceeded');
  if (pathname === '/health' && req.method === 'GET') return sendJson(res, 200, {status: 'ok'}, requestId);
  if (pathname === '/api/db-health') throw new HttpError(404, 'not-found');
  if (pathname === '/api/auth/login' && req.method === 'POST') return sendJson(res, 200, await login(await readJson(req, 16 * 1024), req, res), requestId);
  if (pathname === '/api/auth/logout' && req.method === 'POST') { sameOriginAllowed(req); return sendJson(res, 200, await logout(req, res), requestId); }
  if (pathname === '/api/auth/session' && req.method === 'GET') return sendJson(res, 200, publicSession(await requireAuth(req)), requestId);
  if (pathname.startsWith('/api/')) await requireAuth(req);
  if (pathname === '/api/imports' && req.method === 'POST') { await checkMutation(req, res); return sendJson(res, 201, await persistImport(await readJson(req, maxImportPayload), req), requestId); }
  if (pathname === '/api/imports/status' && req.method === 'GET') return sendJson(res, 200, await latestImportStatus(), requestId);
  if (pathname === '/api/imports/latest' && req.method === 'GET') return sendJson(res, 200, await latestImports(), requestId);
  if (pathname === '/api/imports/period-summary' && req.method === 'GET') return sendJson(res, 200, await importPeriodSummary(url.searchParams.get('period') || ''), requestId);
  if (pathname === '/api/imports/remove-period' && req.method === 'POST') { await checkMutation(req, res); const body = await readJson(req, 1024); return sendJson(res, 200, await removeImportPeriod(safeText(body.period, 'period', 7, true), req), requestId); }
  if (pathname === '/api/teams' && req.method === 'GET') { await requireRole(req, ['manager', 'coordinator', 'dispatcher']); return sendJson(res, 200, await listTeamConfigs(), requestId); }
  if (pathname === '/api/teams' && req.method === 'POST') { await checkMutation(req, res); return sendJson(res, 201, await saveTeamConfig(await readJson(req, 2 * 1024 * 1024), req), requestId); }
  if (pathname === '/api/invoices' && req.method === 'GET') { await checkPrivateRead(req, ['manager', 'coordinator']); return sendJson(res, 200, await listInvoices(), requestId); }
  if (pathname === '/api/invoices' && req.method === 'POST') { await checkMutation(req, res, ['manager', 'coordinator']); return sendJson(res, 201, await saveInvoice(await readJson(req, 15 * 1024 * 1024), req), requestId); }
  const invoiceMatch = pathname.match(/^\/api\/invoices\/([a-f0-9-]{36})\/file$/i); if (invoiceMatch && req.method === 'GET') { await checkPrivateRead(req, ['manager', 'coordinator']); return downloadInvoice(invoiceMatch[1], res); }
  const invoiceArchiveMatch = pathname.match(/^\/api\/invoices\/([a-f0-9-]{36})$/i); if (invoiceArchiveMatch && req.method === 'DELETE') { await checkMutation(req, res); return sendJson(res, 200, await archiveInvoice(invoiceArchiveMatch[1], req), requestId); }
  const file = publicPath(pathname); if (!file) throw new HttpError(404, 'not-found');
  if ((pathname === '/' || pathname === '/index.html') && !(await currentSession(req))) { res.statusCode = 302; res.setHeader('Location', '/login.html'); return res.end(); }
  const publicWithoutAuth = new Set(['/login.html', '/login.js', '/alc-logo.png', '/favicon.png']);
  if (!publicWithoutAuth.has(pathname) && !(await currentSession(req))) throw new HttpError(401, 'authentication-required');
  const data = await readFile(file); res.setHeader('content-type', mime[fileExtension(file)] || 'application/octet-stream'); res.setHeader('cache-control', pathname.endsWith('.json') ? 'no-store' : 'public, max-age=300'); res.end(data);
}

const server = createServer((req, res) => { securityHeaders(res); req.setTimeout(30000); routeRequest(req, res).catch(error => sendError(res, error, req.requestId || randomUUID())); });
server.headersTimeout = 15000; server.requestTimeout = 60000; server.keepAliveTimeout = 5000;
async function start() { if (pool) pool.on('error', error => console.error(JSON.stringify({event: 'database-pool-error', message: error.message}))); if (pool && runDbMigrations) { try { await initDatabase(); } catch (error) { console.error(JSON.stringify({event: 'database-initialization-failed', message: error.message})); } } server.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on ${port}${pool ? '' : ' (database unavailable)'}`)); }
export { allowedBonusCents, bonusCents, decodeBase64, normalizeRow, publicPath, recordKey, safeFileName };
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) start();
