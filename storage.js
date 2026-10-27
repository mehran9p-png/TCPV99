/**
 * TCP Radar — Persistent Storage, Journal Analytics & JSON Backup Module (storage.js)
 * Manages localStorage for Journal (with Win/Loss/BE/Open, exitPrice, realizedR, notes),
 * Daily Stop Counter (auto-incremented on Loss), Alerts, Chart Layer Settings,
 * and Schema-Validated JSON Backup/Restore.
 */
(function (root) {
  'use strict';

  const STORAGE_KEYS = {
    RISK_ACCEPTED: 'tcp_risk_accepted_v6',
    JOURNAL: 'tcp_pro_journal_v6',
    ALERTS: 'tcp_pro_alerts_v6',
    CHART_PREFS: 'tcp_chart_prefs_v6',
    CACHED_MARKET: 'tcp_cached_market_v6',
    STOPS_PREFIX: 'tcp_stops_'
  };

  function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function safeGet(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function safeSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function isRiskDisclaimerAccepted() {
    try {
      return localStorage.getItem(STORAGE_KEYS.RISK_ACCEPTED) === '1';
    } catch (e) {
      return false;
    }
  }

  function setRiskDisclaimerAccepted() {
    try {
      localStorage.setItem(STORAGE_KEYS.RISK_ACCEPTED, '1');
    } catch (e) {}
  }

  function loadTodayStopsCount() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.STOPS_PREFIX + getTodayKey());
      if (raw === null) return 0;
      return Math.max(0, parseInt(raw, 10) || 0);
    } catch (e) {
      return 0;
    }
  }

  function saveTodayStopsCount(count) {
    const clean = Math.max(0, Math.min(20, parseInt(count, 10) || 0));
    try {
      localStorage.setItem(STORAGE_KEYS.STOPS_PREFIX + getTodayKey(), String(clean));
    } catch (e) {}
    return clean;
  }

  function loadJournal() {
    const saved = safeGet(STORAGE_KEYS.JOURNAL, null);
    if (Array.isArray(saved)) return saved;
    return [];
  }

  function saveJournal(entries) {
    if (!Array.isArray(entries)) return;
    safeSet(STORAGE_KEYS.JOURNAL, entries);
  }

  /**
   * Compute Cumulative Journal Statistics & Equity Curve in R
   * @param {Array} journalEntries
   * @returns {{
   *   totalClosed: number,
   *   wins: number,
   *   losses: number,
   *   breakevens: number,
   *   winRate: number,
   *   avgR: number,
   *   expectancyR: number,
   *   netR: number,
   *   maxDrawdownR: number,
   *   equityCurveR: Array<number>
   * }}
   */
  function computeJournalStats(journalEntries) {
    const list = Array.isArray(journalEntries) ? journalEntries.slice().reverse() : [];
    const closed = list.filter(j => j.outcome === 'WIN' || j.outcome === 'LOSS' || j.outcome === 'BE');
    const equityCurveR = [0];
    let curEq = 0;
    let peakEq = 0;
    let maxDd = 0;
    let wins = 0;
    let losses = 0;
    let breakevens = 0;

    closed.forEach(item => {
      const rVal = Number(item.realizedR) || 0;
      if (item.outcome === 'WIN') wins++;
      else if (item.outcome === 'LOSS') losses++;
      else breakevens++;

      curEq = +(curEq + rVal).toFixed(2);
      equityCurveR.push(curEq);
      if (curEq > peakEq) peakEq = curEq;
      const dd = +(peakEq - curEq).toFixed(2);
      if (dd > maxDd) maxDd = dd;
    });

    const totalClosed = closed.length;
    const winRate = totalClosed > 0 ? +((wins / totalClosed) * 100).toFixed(1) : 0;
    const avgR = totalClosed > 0 ? +(curEq / totalClosed).toFixed(2) : 0;

    return {
      totalClosed,
      wins,
      losses,
      breakevens,
      winRate,
      avgR,
      expectancyR: avgR,
      netR: +curEq.toFixed(2),
      maxDrawdownR: +maxDd.toFixed(2),
      equityCurveR
    };
  }

  function loadAlerts() {
    const saved = safeGet(STORAGE_KEYS.ALERTS, null);
    if (Array.isArray(saved)) return saved;
    return [];
  }

  function saveAlerts(alerts) {
    if (!Array.isArray(alerts)) return;
    safeSet(STORAGE_KEYS.ALERTS, alerts);
  }

  function loadChartPrefs() {
    const defaults = {
      logScale: true,
      percentScale: false,
      timezone: 'Asia/Tehran',
      showSma: true,
      showSr: true,
      showFib: true,
      showVol: true,
      showObWalls: true,
      showSignals: true,
      showSessions: true
    };
    const saved = safeGet(STORAGE_KEYS.CHART_PREFS, null);
    return saved ? Object.assign({}, defaults, saved) : defaults;
  }

  function saveChartPrefs(prefs) {
    safeSet(STORAGE_KEYS.CHART_PREFS, prefs);
  }

  function saveCachedMarketSnapshot(symbol, timeframe, candles, orderBook) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    const key = `${STORAGE_KEYS.CACHED_MARKET}_${symbol}_${timeframe}`;
    safeSet(key, {
      savedAt: Date.now(),
      symbol,
      timeframe,
      candles: candles.slice(-520),
      orderBook: orderBook || { asks: [], bids: [] }
    });
  }

  function loadCachedMarketSnapshot(symbol, timeframe) {
    const key = `${STORAGE_KEYS.CACHED_MARKET}_${symbol}_${timeframe}`;
    return safeGet(key, null);
  }

  const TCPStorage = {
    STORAGE_KEYS,
    getTodayKey,
    isRiskDisclaimerAccepted,
    setRiskDisclaimerAccepted,
    loadTodayStopsCount,
    saveTodayStopsCount,
    loadJournal,
    saveJournal,
    computeJournalStats,
    loadAlerts,
    saveAlerts,
    loadChartPrefs,
    saveChartPrefs,
    saveCachedMarketSnapshot,
    loadCachedMarketSnapshot
  };

  root.TCPStorage = TCPStorage;
})(typeof window !== 'undefined' ? window : globalThis);
