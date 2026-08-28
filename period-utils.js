(function attachPeriodUtils(global) {
  function bounds(month, part) {
    const [year, monthNumber] = String(month || '').split('-').map(Number);
    const daysInMonth = year && monthNumber ? new Date(Date.UTC(year, monthNumber, 0)).getUTCDate() : 0;
    const selectedPart = part === '2' ? '2' : '1';
    const start = selectedPart === '2' ? 16 : 1;
    const end = selectedPart === '2' ? daysInMonth : Math.min(15, daysInMonth);
    return { month, part: selectedPart, start, end, days: Math.max(0, end - start + 1) };
  }

  function contains(dateKey, month, part) {
    const key = String(dateKey || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key.slice(0, 7) !== month) return false;
    const range = bounds(month, part);
    const day = Number(key.slice(8, 10));
    return day >= range.start && day <= range.end;
  }

  global.BonusPeriod = Object.freeze({ bounds, contains });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.BonusPeriod;
})(globalThis);
