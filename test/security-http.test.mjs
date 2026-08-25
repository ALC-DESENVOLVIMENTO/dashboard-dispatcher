import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 4387;
const base = `http://127.0.0.1:${port}`;

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { const response = await fetch(`${base}/health`); if (response.ok) return; } catch { /* process is starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server-start-timeout');
}

test('production server blocks admin mutation and internal files', async () => {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {...process.env, PORT: String(port), NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: '', ADMIN_MUTATIONS_ENABLED: 'false', ADMIN_READ_ENABLED: 'false', APP_ORIGIN: base, DATABASE_URL: '', AUTH_USERNAME: 'gerencia', AUTH_PASSWORD_HASH: 'scrypt$16384$8$1$706468c7d5d3623149f36c0b08e78dba$7ac2d8d1f827f2fc57c0bf3c85b31633d0d68be617b92845c30a60d4fec5a45d3113d7f776e4752892aa024759abe0f06c0f198b0ece50d2ad8514c2ae84d1c6'},
    stdio: 'ignore'
  });
  try {
    await waitForServer();
    const health = await fetch(`${base}/health`);
    assert.equal(health.headers.get('content-security-policy')?.includes("default-src 'self'"), true);
    const internal = await fetch(`${base}/server.mjs`);
    assert.equal(internal.status, 404);
    const unauthenticated = await fetch(`${base}/api/auth/session`);
    assert.equal(unauthenticated.status, 401);
    const login = await fetch(`${base}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json', origin: base}, body: JSON.stringify({username: 'gerencia', password: 'Gerencia#ALC2026!'})});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const dashboard = await fetch(`${base}/`, {headers: {cookie}});
    assert.equal(dashboard.status, 200);
    const mutation = await fetch(`${base}/api/imports`, {method: 'POST', headers: {'content-type': 'application/json', origin: base, cookie}, body: JSON.stringify({sourceType: 'DDS'})});
    assert.equal(mutation.status, 403);
    assert.equal((await mutation.json()).error, 'administrative-operation-restricted');
    const privateRead = await fetch(`${base}/api/invoices`, {headers: {cookie}});
    assert.equal(privateRead.status, 403);
    assert.equal((await privateRead.json()).error, 'administrative-read-restricted');
  } finally {
    child.kill();
  }
});
