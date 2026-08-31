import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import fixedFleetBonus from '../ff-bonus.js';

const PERIOD_MONTH = process.argv[2] || '2026-07';
const COUNTED_STATUSES = new Set(['PLACA BIPADA', 'RESERVA BIPADA']);
const BASE_ALIASES = new Map([
  ['RIBEIRAO PRETO - SSP4', 'CRAVINHOS - SSP4'],
  ['CRAVINHOS - SSP4', 'CRAVINHOS - SSP4'],
  ['RIBEIRAO PRETO - SSP57', 'RIBEIRAO PRETO - SSP57']
].map(([from, to]) => [baseNorm(from), to]));
const XPT_BASES = new Set([
  'ARAPUTANGA - EMR14',
  'ARAXA - EMG34',
  'CACERES - EMR6',
  'CHAPADAO DO SUL - EGO17',
  'CONCEICAO DO MATO DENTRO - EMG26',
  'GUANHAES - EMG37',
  'GUAXUPE - EMG7',
  'MINACU - EDF10',
  'MOZARLANDIA - EGO11',
  'PONTES E LACERDA - EMR16',
  'SANTO ANTONIO DA PLATINA - EPR7'
].map(baseNorm));

function normalized(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [
    String(key).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    value
  ]));
}

function baseNorm(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function canonicalBase(value) {
  const raw = String(value ?? '').trim();
  return BASE_ALIASES.get(baseNorm(raw)) || raw;
}

function isXptBase(value) {
  return XPT_BASES.has(baseNorm(canonicalBase(value)));
}

function plateNorm(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function driverNorm(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function slashDateKey(value, defaultOrder = 'dmy') {
  const match = String(value ?? '').match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\D|$)/);
  if (!match) return '';
  const a = Number(match[1]);
  const b = Number(match[2]);
  const day = a > 12 ? a : b > 12 ? b : defaultOrder === 'mdy' ? b : a;
  const month = a > 12 ? b : b > 12 ? a : defaultOrder === 'mdy' ? a : b;
  return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function routeDayKey(value) {
  const raw = String(value ?? '').trim();
  const slash = slashDateKey(raw, 'dmy');
  if (slash) return slash;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function ddsDateKey(value) {
  const raw = String(value ?? '').trim();
  return slashDateKey(raw, 'mdy') || routeDayKey(raw);
}

function logicDate(value) {
  const raw = String(value ?? '').trim();
  return slashDateKey(raw, 'dmy') || routeDayKey(raw);
}

function invalidLogicValue(value) {
  return ['#N/D', '#N/A', 'N/D', 'N/A'].includes(String(value ?? '').trim().toUpperCase());
}

function parsePercent(value) {
  const number = Number(String(value ?? '').replace('%', '').replace(',', '.').trim());
  if (!Number.isFinite(number) || number < 0 || number > 100) return null;
  return number > 1 ? number / 100 : number;
}

function containsPeriod(date, part) {
  const key = routeDayKey(date);
  if (!key || key.slice(0, 7) !== PERIOD_MONTH) return false;
  const day = Number(key.slice(8, 10));
  return part === '1' ? day <= 15 : part === '2' ? day >= 16 : true;
}

function readLogicRows(rows) {
  return rows.map(raw => {
    const row = normalized(raw);
    return {
      base: canonicalBase(row.base),
      placa: String(row.placa || '').trim(),
      date: logicDate(row.data || row.date),
      status: String(row.rotas || row.status || '').trim().toUpperCase(),
      reserva: String(row.reservas || row.reserva || '').trim()
    };
  }).filter(row => row.base && row.placa && row.date && !invalidLogicValue(row.base) && !invalidLogicValue(row.placa));
}

function ddsRoutesFromRows(rows) {
  const unique = new Map();
  for (const raw of rows) {
    const row = normalized(raw);
    const route = {
      base: canonicalBase(row.base || 'Base sem nome'),
      date: ddsDateKey(row.data || row.date),
      placa: String(row.placa || '').trim(),
      motorista: String(row.motorista || row.nomemotorista || row.nomedomotorista || row.nomecondutor || row.driver || row.drivername || '').trim(),
      rota: String(row.rotalogistics || row.rota || row.route || '').trim(),
      cluster: String(row.cluster || '').trim(),
      ds: null
    };
    if (!route.base || !route.date || !route.placa) continue;
    const key = route.rota
      ? `${route.date}|rota|${route.rota}`
      : `${route.date}|${route.base}|${plateNorm(route.placa)}|${route.cluster}`;
    unique.set(key, route);
  }
  return [...unique.values()];
}

function mercadoKey(raw) {
  const row = normalized(raw);
  const date = logicDate(row.data || row.date || row.dataderota || row.datadarota || row.routedate || row.datadodispatch || row.datadispatch);
  const driver = driverNorm(row.motorista || row.nomemotorista || row.nomedomotorista || row.nomedotransportador || row.nometransportador || row.nomecondutor || row.driver || row.drivername || row.condutor || row.nome || row.transportador);
  const routeId = String(row.rotalogistics || row.iddarota || row.idrota || row.routeid || row.rota || '').trim();
  const plate = String(row.placa || row.plate || '').trim();
  return {
    row,
    date,
    driverKey: date && driver ? `driver|${date}|${driver}` : '',
    routeKey: date && routeId ? `route|${date}|${plateNorm(routeId)}` : '',
    plateKey: date && plate ? `plate|${date}|${plateNorm(plate)}` : ''
  };
}

function mercadoUpdates(rows) {
  const grouped = new Map();
  const seen = new Set();
  for (const raw of rows) {
    const {row, driverKey, routeKey, plateKey} = mercadoKey(raw);
    const keys = [driverKey, routeKey, plateKey].filter(Boolean);
    if (!keys.length) continue;
    const stable = JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
    if (seen.has(stable)) continue;
    seen.add(stable);
    const successRaw = row.entregacomsucesso ?? row.entregascomsucesso ?? row.entregassucesso ?? row.sucessos ?? row.successfuldeliveries ?? '';
    const explicitRaw = row.ds || row.dsrota || row.percentualds || row.deliverysuccessrate || row.performance || row.performanceds || successRaw;
    const explicit = parsePercent(explicitRaw);
    for (const key of keys) {
      const current = grouped.get(key) || {sum: 0, count: 0};
      if (Number.isFinite(explicit)) {
        current.sum += explicit;
        current.count += 1;
      }
      grouped.set(key, current);
    }
  }
  return new Map([...grouped].map(([key, value]) => [key, value.count ? value.sum / value.count : null]));
}

function buildAudit(rowsBySource, part, plannedDays) {
  const logicRows = readLogicRows(rowsBySource.LOGICA_FF || []);
  const logicKeys = new Set();
  for (const row of logicRows) {
    if (!COUNTED_STATUSES.has(row.status)) continue;
    logicKeys.add(`${row.date}|${plateNorm(row.placa)}`);
    if (row.reserva && !invalidLogicValue(row.reserva)) logicKeys.add(`${row.date}|${plateNorm(row.reserva)}`);
  }

  let ffRoutes;
  if (rowsBySource.SNAPSHOT_FF_ROUTES) {
    ffRoutes = rowsBySource.SNAPSHOT_FF_ROUTES.map(row => ({
      base: canonicalBase(row.base),
      date: excelDateKey(row.data_serial),
      placa: row.placa,
      motorista: row.motorista,
      rota: row.rota,
      cluster: row.cluster,
      ds: Number.isFinite(Number(row.ds)) ? Number(row.ds) / 100 : null
    }));
  } else {
    ffRoutes = ddsRoutesFromRows(rowsBySource.DDS || []).filter(route =>
      route.cluster.toUpperCase() !== 'ROTA' &&
      !isXptBase(route.base) &&
      logicKeys.has(`${route.date}|${plateNorm(route.placa)}`)
    );

    const updates = mercadoUpdates(rowsBySource.MERCADO_LIVRE || []);
    ffRoutes = ffRoutes.map(route => {
      const driverKey = `driver|${route.date}|${driverNorm(route.motorista)}`;
      const routeKey = `route|${route.date}|${plateNorm(route.rota)}`;
      const plateKey = `plate|${route.date}|${plateNorm(route.placa)}`;
      const ds = updates.get(driverKey) ?? updates.get(routeKey) ?? updates.get(plateKey) ?? null;
      return {...route, ds: Number.isFinite(ds) ? ds : null};
    });
  }
  ffRoutes = ffRoutes.filter(route => route.cluster?.toUpperCase() !== 'ROTA' && !isXptBase(route.base) && containsPeriod(route.date, part));

  const routeGroups = new Map();
  for (const route of ffRoutes) {
    const group = routeGroups.get(route.base) || {routes: 0, dsSum: 0, dsCount: 0};
    group.routes += 1;
    if (Number.isFinite(route.ds)) {
      group.dsSum += route.ds * 100;
      group.dsCount += 1;
    }
    routeGroups.set(route.base, group);
  }

  const logicGroups = new Map();
  for (const row of logicRows.filter(row => containsPeriod(row.date, part) && !isXptBase(row.base))) {
    const group = logicGroups.get(row.base) || {plates: new Set(), bipped: 0, sourceRows: 0};
    group.plates.add(plateNorm(row.placa));
    group.sourceRows += 1;
    if (COUNTED_STATUSES.has(row.status)) group.bipped += 1;
    logicGroups.set(row.base, group);
  }

  const bases = [...new Set([...logicGroups.keys(), ...routeGroups.keys()])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const detail = bases.map(base => {
    const logic = logicGroups.get(base) || {plates: new Set(), bipped: 0, sourceRows: 0};
    const routes = routeGroups.get(base) || {routes: 0, dsSum: 0, dsCount: 0};
    const expected = logic.plates.size * plannedDays;
    const utilization = expected ? logic.bipped / expected : null;
    const ds = routes.dsCount ? routes.dsSum / routes.dsCount : null;
    const bonus = Number.isFinite(ds) && ds >= 92 && Number.isFinite(utilization)
      ? fixedFleetBonus.payoutForUtilization(utilization)
      : 0;
    const band = fixedFleetBonus.bandForUtilization(utilization);
    return {
      base,
      routes: routes.routes,
      routesWithDs: routes.dsCount,
      ds: ds === null ? null : Number(ds.toFixed(4)),
      plates: logic.plates.size,
      bipped: logic.bipped,
      plannedDays,
      expected,
      utilization: utilization === null ? null : Number(utilization.toFixed(6)),
      band: band?.label || 'Nenhuma',
      bonus
    };
  });

  return {
    part,
    plannedDays,
    total: detail.reduce((sum, row) => sum + row.bonus, 0),
    rewardedBases: detail.filter(row => row.bonus > 0).length,
    detail: detail.filter(row => row.bonus > 0 || row.routes > 0 || row.bipped > 0)
  };
}

function excelDateKey(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return routeDayKey(value);
  return new Date(Date.UTC(1899, 11, 30) + number * 86400000).toISOString().slice(0, 10);
}

async function rowsFromDatabase() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' || process.env.DATABASE_URL.includes('railway.internal')
      ? false
      : {rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'},
    max: 1,
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000)
  });
  try {
    const result = await pool.query(`
      SELECT source_type, data
      FROM import_records
      WHERE deleted_at IS NULL
        AND source_type = ANY($1::text[])
    `, [['DDS', 'MERCADO_LIVRE', 'LOGICA_FF']]);
    const rowsBySource = {};
    for (const row of result.rows) (rowsBySource[row.source_type] ||= []).push(row.data);
    return rowsBySource;
  } finally {
    await pool.end();
  }
}

async function rowsFromApi() {
  const origin = String(process.env.AUDIT_ORIGIN || '').replace(/\/$/, '');
  const username = process.env.AUDIT_USERNAME;
  const password = process.env.AUDIT_PASSWORD;
  if (!origin || !username || !password) throw new Error('DATABASE_URL or AUDIT_ORIGIN/AUDIT_USERNAME/AUDIT_PASSWORD is required');
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin},
    body: JSON.stringify({username, password})
  });
  if (!login.ok) throw new Error(`Login failed with status ${login.status}`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Login did not return a session cookie');
  const response = await fetch(`${origin}/api/imports/latest`, {headers: {cookie}});
  if (!response.ok) throw new Error(`Import read failed with status ${response.status}`);
  const payload = await response.json();
  return Object.fromEntries(Object.entries(payload.sources || {}).map(([source, value]) => [source, value.rows || []]));
}

async function rowsFromSnapshot(directory) {
  const root = resolve(directory);
  const [logicRows, ffRoutes] = await Promise.all([
    readFile(resolve(root, 'ff_logic_rows.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'ff_routes.json'), 'utf8').then(JSON.parse)
  ]);
  return {LOGICA_FF: logicRows, SNAPSHOT_FF_ROUTES: ffRoutes};
}

const rowsBySource = process.env.AUDIT_SNAPSHOT_DIR
  ? await rowsFromSnapshot(process.env.AUDIT_SNAPSHOT_DIR)
  : process.env.DATABASE_URL ? await rowsFromDatabase() : await rowsFromApi();
if (process.env.AUDIT_INSPECT === 'true') {
  const inspected = Object.fromEntries(Object.entries(rowsBySource).map(([source, rows]) => [source, {
    months: rows.reduce((counts, raw) => {
      const row = normalized(raw);
      const month = logicDate(row.data || row.date || row.dataderota || row.datadarota || row.datadodispatch || row.datadispatch).slice(0, 7) || 'unknown';
      counts[month] = (counts[month] || 0) + 1;
      return counts;
    }, {}),
    samples: rows.slice(0, 5).map(raw => {
    const row = normalized(raw);
    return Object.fromEntries(Object.entries(row).filter(([key]) => [
      'data', 'date', 'dataderota', 'datadarota', 'datadodispatch', 'datadispatch',
      'base', 'placa', 'motorista', 'nomemotorista', 'rotas', 'status',
      'rotalogistics', 'rota', 'entregacomsucesso', 'ds', 'dsrota'
    ].includes(key)));
  })}]));
  console.log(JSON.stringify(inspected, null, 2));
  process.exit(0);
}
const periods = [
  buildAudit(rowsBySource, '1', 13),
  buildAudit(rowsBySource, '2', 13),
  buildAudit(rowsBySource, 'monthly', 26)
];
console.log(JSON.stringify({
  month: PERIOD_MONTH,
  sourceCounts: Object.fromEntries(Object.entries(rowsBySource).map(([key, rows]) => [key, rows.length])),
  periods
}, null, 2));
