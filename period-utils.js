(function attachPeriodUtils(global) {
  function bounds(month, part) {
    const [year, monthNumber] = String(month || '').split('-').map(Number);
    const daysInMonth = year && monthNumber ? new Date(Date.UTC(year, monthNumber, 0)).getUTCDate() : 0;
    const selectedPart = part === 'monthly' ? 'monthly' : part === '2' ? '2' : '1';
    const start = selectedPart === '2' ? 16 : 1;
    const end = selectedPart === 'monthly' || selectedPart === '2' ? daysInMonth : Math.min(15, daysInMonth);
    return { month, part: selectedPart, start, end, days: Math.max(0, end - start + 1) };
  }

  function contains(dateKey, month, part) {
    const key = String(dateKey || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key.slice(0, 7) !== month) return false;
    const range = bounds(month, part);
    const day = Number(key.slice(8, 10));
    return day >= range.start && day <= range.end;
  }

  function utilization(bipped, uniquePlates, days) {
    const numerator = Number(bipped);
    const denominator = Number(uniquePlates) * Number(days);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : null;
  }

  function fixedFleetPlannedDays(monthlyDays, part) {
    const total = Number(monthlyDays);
    if (!Number.isFinite(total) || total < 2) return null;
    if (part === 'monthly') return total;
    const firstPart = Math.floor(total / 2);
    return part === '2' ? total - firstPart : firstPart;
  }

  function showsFinancialDetails(part) {
    return part === 'monthly';
  }

  function normalizedLabel(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isFinancialColumnLabel(value) {
    return /^(faixa|bonus|valor)\b/.test(normalizedLabel(value));
  }

  function isFinancialStatusLabel(value) {
    return /^faixa (atingida|nao atingida)$/.test(normalizedLabel(value));
  }

  function baseRouteCounts(rows) {
    const grouped = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const base = String(row?.base || 'Base sem nome').trim() || 'Base sem nome';
      const current = grouped[base] ||= { base, routes: 0, eligible: 0, notEligible: 0, awaiting: 0, ambulances: 0 };
      const ambulance = row?.isAmb === true || String(row?.cluster || '').trim().toUpperCase() === 'ROTA';
      if (ambulance) {
        current.ambulances += 1;
        continue;
      }
      current.routes += 1;
      const ds = row?.ds === null || row?.ds === undefined || row?.ds === '' ? NaN : Number(row.ds);
      if (!Number.isFinite(ds)) current.awaiting += 1;
      else if (ds >= 0.92) current.eligible += 1;
      else current.notEligible += 1;
    }
    return grouped;
  }

  function routeIdentifier(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return /^\d+\.0+$/.test(text) ? text.slice(0, text.indexOf('.')) : text.toUpperCase();
  }

  function confirmedAmbulanceRows(ddsRows, confirmedRouteIds) {
    const confirmed = new Set(Array.from(confirmedRouteIds || [], routeIdentifier).filter(Boolean));
    const seen = new Set();
    return (Array.isArray(ddsRows) ? ddsRows : []).filter(row => {
      const ambulance = row?.isAmb === true || String(row?.cluster || '').trim().toUpperCase() === 'ROTA';
      const route = routeIdentifier(row?.rota ?? row?.rotalogistics ?? row?.route);
      if (!ambulance || !route || !confirmed.has(route) || seen.has(route)) return false;
      seen.add(route);
      return true;
    });
  }

  global.BonusPeriod = Object.freeze({ bounds, contains, utilization, fixedFleetPlannedDays, showsFinancialDetails, isFinancialColumnLabel, isFinancialStatusLabel, baseRouteCounts, routeIdentifier, confirmedAmbulanceRows });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.BonusPeriod;
})(globalThis);
