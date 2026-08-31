(function exposeSpotBonus(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BonusSpot = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createSpotBonus() {
  'use strict';

  const bands = Object.freeze([
    {cars: 10, total: 1000},
    {cars: 15, total: 1500},
    {cars: 25, total: 2000},
    {cars: 35, total: 3000},
    {cars: 45, total: 4000},
    {cars: 55, total: 5000},
    {cars: 65, total: 6000},
    {cars: 75, total: 7000},
    {cars: 85, total: 8000},
    {cars: 95, total: 9000},
    {cars: 105, total: 10000}
  ].map(band => Object.freeze({
    ...band,
    two: band.total / 2,
    three: Math.round((band.total / 3) * 100) / 100,
    four: band.total / 4
  })));

  function dispatcherCount(value) {
    const count = Math.trunc(Number(value));
    return Number.isFinite(count) && count > 0 ? count : 1;
  }

  function bandForCars(value) {
    const cars = Number(value);
    if (!Number.isFinite(cars) || cars < 0) return null;
    return [...bands].reverse().find(band => cars >= band.cars) || null;
  }

  function bonusForCars(cars, dispatchers = 1) {
    const band = bandForCars(cars);
    const count = dispatcherCount(dispatchers);
    const totalCents = band ? Math.round(band.total * 100) : 0;
    const perDispatcherCents = totalCents ? Math.round(totalCents / count) : 0;
    return Object.freeze({
      band,
      dispatcherCount: count,
      totalCents,
      total: totalCents / 100,
      perDispatcherCents,
      perDispatcher: perDispatcherCents / 100
    });
  }

  return Object.freeze({bands, bandForCars, bonusForCars, dispatcherCount});
});
