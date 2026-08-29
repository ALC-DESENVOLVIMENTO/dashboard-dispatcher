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
    const renewedSession = await fetch(`${base}/api/auth/session`, {headers: {cookie}});
    assert.equal(renewedSession.status, 200);
    assert.match(renewedSession.headers.get('set-cookie') || '', /Max-Age=\d+/);
    assert.ok((await renewedSession.json()).expiresAt);
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

test('server enforces manager, coordination and dispatcher roles independently', async () => {
  const rolePort = 4388;
  const roleBase = `http://127.0.0.1:${rolePort}`;
  const sharedTestHash = 'scrypt$16384$8$1$706468c7d5d3623149f36c0b08e78dba$7ac2d8d1f827f2fc57c0bf3c85b31633d0d68be617b92845c30a60d4fec5a45d3113d7f776e4752892aa024759abe0f06c0f198b0ece50d2ad8514c2ae84d1c6';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {...process.env, PORT: String(rolePort), NODE_ENV: 'production', RAILWAY_ENVIRONMENT_NAME: '', APP_ORIGIN: roleBase, DATABASE_URL: '', ADMIN_MUTATIONS_ENABLED: 'true', ADMIN_READ_ENABLED: 'true', ADMIN_IP_ALLOWLIST: '*', AUTH_USERNAME: 'gerencia', AUTH_PASSWORD_HASH: sharedTestHash, AUTH_COORDINATION_USERNAME: 'coordenacao', AUTH_COORDINATION_PASSWORD_HASH: sharedTestHash, AUTH_DISPATCHER_USERNAME: 'dispatcher', AUTH_DISPATCHER_PASSWORD_HASH: sharedTestHash},
    stdio: 'ignore'
  });
  async function wait() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { if ((await fetch(`${roleBase}/health`)).ok) return; } catch { /* process is starting */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('role-server-start-timeout');
  }
  async function signIn(username) {
    const response = await fetch(`${roleBase}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json', origin: roleBase}, body: JSON.stringify({username, password: 'Gerencia#ALC2026!'})});
    assert.equal(response.status, 200);
    const body = await response.json();
    return {body, cookie: response.headers.get('set-cookie')?.split(';')[0]};
  }
  try {
    await wait();
    const manager = await signIn('gerencia');
    const coordinator = await signIn('coordenacao');
    const dispatcher = await signIn('dispatcher');
    const secondDispatcherSession = await signIn('dispatcher');
    assert.equal(manager.body.role, 'manager');
    assert.equal(coordinator.body.role, 'coordinator');
    assert.equal(coordinator.body.permissions.canUploadInvoice, true);
    assert.equal(dispatcher.body.role, 'dispatcher');
    assert.equal(dispatcher.body.permissions.canUploadInvoice, false);
    assert.notEqual(dispatcher.cookie, secondDispatcherSession.cookie);

    const dispatcherTeams = await fetch(`${roleBase}/api/teams`, {headers: {cookie: dispatcher.cookie}});
    assert.equal(dispatcherTeams.status, 200);
    const secondDispatcherTeams = await fetch(`${roleBase}/api/teams`, {headers: {cookie: secondDispatcherSession.cookie}});
    assert.equal(secondDispatcherTeams.status, 200);
    const dispatcherImport = await fetch(`${roleBase}/api/imports`, {method: 'POST', headers: {'content-type': 'application/json', origin: roleBase, cookie: dispatcher.cookie}, body: JSON.stringify({sourceType: 'DDS'})});
    assert.equal(dispatcherImport.status, 403);
    assert.equal((await dispatcherImport.json()).error, 'access-denied');
    const coordinatorImport = await fetch(`${roleBase}/api/imports`, {method: 'POST', headers: {'content-type': 'application/json', origin: roleBase, cookie: coordinator.cookie}, body: JSON.stringify({sourceType: 'DDS'})});
    assert.equal(coordinatorImport.status, 403);
    const coordinatorInvoices = await fetch(`${roleBase}/api/invoices`, {headers: {cookie: coordinator.cookie}});
    assert.equal(coordinatorInvoices.status, 200);
    const dispatcherInvoices = await fetch(`${roleBase}/api/invoices`, {headers: {cookie: dispatcher.cookie}});
    assert.equal(dispatcherInvoices.status, 403);
    const coordinatorUpload = await fetch(`${roleBase}/api/invoices`, {method: 'POST', headers: {'content-type': 'application/json', origin: roleBase, cookie: coordinator.cookie}, body: JSON.stringify({})});
    assert.equal(coordinatorUpload.status, 503);
    const dispatcherUpload = await fetch(`${roleBase}/api/invoices`, {method: 'POST', headers: {'content-type': 'application/json', origin: roleBase, cookie: dispatcher.cookie}, body: JSON.stringify({})});
    assert.equal(dispatcherUpload.status, 403);
  } finally {
    child.kill();
  }
});
