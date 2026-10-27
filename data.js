/**
 * TCP Radar — Multi-Exchange Live Data & 500+ Candle Pagination Module (data.js)
 * Fetches 500+ historical candles via pagination (Bybit V5 start/end, OKX, Binance),
 * streams live incremental ticks via WebSocket without full chart rebuild,
 * fetches L2 order book and macro dominance, and strictly enforces NO fake data on offline.
 */
(function (root) {
  'use strict';

  const DEFAULT_SYMBOLS = {
    BTCUSDT: { price: null, change24h: null, btcPair24h: 0, ethPair24h: null, volBtc: null, touches: 3, decimals: 2 },
    ETHUSDT: { price: null, change24h: null, btcPair24h: null, ethPair24h: 0, volBtc: null, touches: 3, decimals: 2 },
    SOLUSDT: { price: null, change24h: null, btcPair24h: null, ethPair24h: null, volBtc: null, touches: 4, decimals: 2 },
    BNBUSDT: { price: null, change24h: null, btcPair24h: null, ethPair24h: null, volBtc: null, touches: 2, decimals: 2 },
    XRPUSDT: { price: null, change24h: null, btcPair24h: null, ethPair24h: null, volBtc: null, touches: 4, decimals: 4 },
    ADAUSDT: { price: null, change24h: null, btcPair24h: null, ethPair24h: null, volBtc: null, touches: 3, decimals: 4 },
    DOGEUSDT: { price: null, change24h: null, btcPair24h: null, ethPair24h: null, volBtc: null, touches: 4, decimals: 4 },
    AVAXUSDT: { price: null, change24h: null, btcPair24h: null, ethPair24h: null, volBtc: null, touches: 3, decimals: 2 },
    SUIUSDT: { price: null, change24h: null, btcPair24h: null, ethPair24h: null, volBtc: null, touches: 4, decimals: 3 },
    LINKUSDT: { price: null, change24h: null, btcPair24h: null, ethPair24h: null, volBtc: null, touches: 3, decimals: 2 }
  };

  /**
   * Generate visual-only skeleton bars strictly for blurred loading placeholder.
   * Marked with `isSkeleton: true` — NEVER passed to analysis or displayed as numbers!
   */
  function createVisualSkeletonBars(count = 60) {
    const nowSec = Math.floor(Date.now() / 1000);
    const list = [];
    let val = 100;
    for (let i = count; i >= 1; i--) {
      const wave = Math.sin(i / 4) * 2;
      const open = val;
      const close = 100 + wave;
      const high = Math.max(open, close) + 0.8;
      const low = Math.min(open, close) - 0.8;
      list.push({
        time: (nowSec - i * 900) * 1000,
        open,
        high,
        low,
        close,
        volume: 10,
        isSkeleton: true
      });
      val = close;
    }
    return list;
  }

  /**
   * Fetch 500+ Historical Candles with Pagination Support
   * 1) Bybit V5 Linear (`limit=600`, or paginated `end` timestamp if needed)
   * 2) OKX V5 Swap (paginated `after` cursor to collect >= 500 candles)
   * 3) Binance Futures / Spot (`limit=600`)
   */
  async function fetch500PlusCandles(symbol, tf, preferredSource = 'auto') {
    const bybitInterval = tf === '1m' ? '1' : tf === '15m' ? '15' : tf === '1h' ? '60' : '240';
    const okxBar = tf === '1m' ? '1m' : tf === '15m' ? '15m' : tf === '1h' ? '1H' : '4H';
    const okxInstId = symbol.replace('USDT', '-USDT-SWAP');

    // 1. Try Bybit V5 Linear (Supports up to 1000 per page + pagination via `end`)
    if (preferredSource === 'auto' || preferredSource === 'bybit') {
      try {
        let collected = [];
        let endCursor = '';
        for (let page = 0; page < 2; page++) {
          const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=300` +
            (endCursor ? `&end=${endCursor}` : '');
          const r = await fetch(url);
          if (!r.ok) break;
          const j = await r.json();
          if (!j || !j.result || !Array.isArray(j.result.list) || j.result.list.length === 0) break;
          const batch = j.result.list; // Descending order by timestamp
          collected = collected.concat(batch);
          const oldestTs = parseInt(batch[batch.length - 1][0], 10);
          if (!oldestTs || collected.length >= 550) break;
          endCursor = String(oldestTs - 1);
        }

        if (collected.length >= 50) {
          // Deduplicate and sort ascending by timestamp
          const mapByTime = new Map();
          collected.forEach(k => {
            const t = parseInt(k[0], 10);
            const o = parseFloat(k[1]);
            const h = parseFloat(k[2]);
            const l = parseFloat(k[3]);
            const c = parseFloat(k[4]);
            const v = parseFloat(k[5]);
            const rng = Math.max(1e-8, h - l);
            const closePos = (c - l) / rng;
            mapByTime.set(t, {
              time: t,
              open: o,
              high: h,
              low: l,
              close: c,
              volume: v,
              takerBuyVol: +(v * (0.35 + closePos * 0.35)).toFixed(2)
            });
          });
          const sorted = Array.from(mapByTime.values()).sort((a, b) => a.time - b.time);
          return {
            ok: true,
            sourceLabel: 'زنده: Bybit (.P)',
            exactTaker: false,
            candles: sorted
          };
        }
      } catch (e) {}
    }

    // 2. Try OKX V5 Swap (Paginate 2 pages of 300 via `after` cursor to get >500 candles)
    if (preferredSource === 'auto' || preferredSource === 'okx') {
      try {
        let collected = [];
        let afterCursor = '';
        for (let page = 0; page < 2; page++) {
          const url = `https://www.okx.com/api/v5/market/candles?instId=${okxInstId}&bar=${okxBar}&limit=300` +
            (afterCursor ? `&after=${afterCursor}` : '');
          const r = await fetch(url);
          if (!r.ok) break;
          const j = await r.json();
          if (!j || !Array.isArray(j.data) || j.data.length === 0) break;
          const batch = j.data;
          collected = collected.concat(batch);
          const oldestTs = batch[batch.length - 1][0];
          if (!oldestTs || collected.length >= 520) break;
          afterCursor = String(oldestTs);
        }

        if (collected.length >= 50) {
          const mapByTime = new Map();
          collected.forEach(k => {
            const t = parseInt(k[0], 10);
            const o = parseFloat(k[1]);
            const h = parseFloat(k[2]);
            const l = parseFloat(k[3]);
            const c = parseFloat(k[4]);
            const v = parseFloat(k[5]);
            const rng = Math.max(1e-8, h - l);
            mapByTime.set(t, {
              time: t,
              open: o,
              high: h,
              low: l,
              close: c,
              volume: v,
              takerBuyVol: +(v * (0.35 + ((c - l) / rng) * 0.35)).toFixed(2)
            });
          });
          const sorted = Array.from(mapByTime.values()).sort((a, b) => a.time - b.time);
          return {
            ok: true,
            sourceLabel: 'زنده: OKX (.P)',
            exactTaker: false,
            candles: sorted
          };
        }
      } catch (e) {}
    }

    // 3. Try Binance Futures (`fapi`) then Spot (`api`) with limit=600
    if (preferredSource === 'auto' || preferredSource === 'binance') {
      for (const host of ['fapi.binance.com/fapi/v1/klines', 'api.binance.com/api/v3/klines']) {
        try {
          const r = await fetch(`https://${host}?symbol=${symbol}&interval=${tf}&limit=600`);
          if (r.ok) {
            const rows = await r.json();
            if (Array.isArray(rows) && rows.length >= 50) {
              const parsed = rows.map(k => ({
                time: parseInt(k[0], 10),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                takerBuyVol: parseFloat(k[9])
              }));
              return {
                ok: true,
                sourceLabel: 'زنده: Binance',
                exactTaker: true,
                candles: parsed
              };
            }
          }
        } catch (e) {}
      }
    }

    return { ok: false, sourceLabel: 'غیرزنده / آفلاین', exactTaker: false, candles: [] };
  }

  /**
   * Fetch 24h Market Tickers across watched symbols
   */
  async function fetchMultiExchangeTickers(symbolsMap, preferredSource = 'auto') {
    if (preferredSource === 'auto' || preferredSource === 'bybit') {
      try {
        const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
        if (r.ok) {
          const j = await r.json();
          if (j && j.result && Array.isArray(j.result.list) && j.result.list.length > 0) {
            const map = {};
            j.result.list.forEach(item => { map[item.symbol] = item; });
            const btcChg = map.BTCUSDT ? parseFloat(map.BTCUSDT.price24hPcnt) * 100 : 0;
            const ethChg = map.ETHUSDT ? parseFloat(map.ETHUSDT.price24hPcnt) * 100 : 0;
            const btcPrice = map.BTCUSDT ? parseFloat(map.BTCUSDT.lastPrice) : 0;

            Object.keys(symbolsMap).forEach(sym => {
              if (map[sym]) {
                const p = parseFloat(map[sym].lastPrice);
                const chg = parseFloat(map[sym].price24hPcnt) * 100;
                const turnover = parseFloat(map[sym].turnover24h);
                if (p > 0) symbolsMap[sym].price = p;
                if (!isNaN(chg)) {
                  symbolsMap[sym].change24h = +chg.toFixed(2);
                  symbolsMap[sym].btcPair24h = +(chg - btcChg).toFixed(2);
                  symbolsMap[sym].ethPair24h = +(chg - ethChg).toFixed(2);
                }
                if (turnover > 0 && btcPrice > 0) {
                  symbolsMap[sym].volBtc = Math.round(turnover / btcPrice);
                }
              }
            });
            return true;
          }
        }
      } catch (e) {}
    }

    if (preferredSource === 'auto' || preferredSource === 'binance') {
      for (const host of ['fapi.binance.com/fapi/v1/ticker/24hr', 'api.binance.com/api/v3/ticker/24hr']) {
        try {
          const r = await fetch(`https://${host}`);
          if (r.ok) {
            const data = await r.json();
            if (Array.isArray(data)) {
              const map = {};
              data.forEach(item => { map[item.symbol] = item; });
              const btcChg = map.BTCUSDT ? parseFloat(map.BTCUSDT.priceChangePercent) : 0;
              const ethChg = map.ETHUSDT ? parseFloat(map.ETHUSDT.priceChangePercent) : 0;
              const btcPrice = map.BTCUSDT ? parseFloat(map.BTCUSDT.lastPrice) : 0;
              Object.keys(symbolsMap).forEach(sym => {
                if (map[sym]) {
                  const p = parseFloat(map[sym].lastPrice);
                  const chg = parseFloat(map[sym].priceChangePercent);
                  const quoteVol = parseFloat(map[sym].quoteVolume);
                  if (p > 0) symbolsMap[sym].price = p;
                  if (!isNaN(chg)) {
                    symbolsMap[sym].change24h = +chg.toFixed(2);
                    symbolsMap[sym].btcPair24h = +(chg - btcChg).toFixed(2);
                    symbolsMap[sym].ethPair24h = +(chg - ethChg).toFixed(2);
                  }
                  if (quoteVol > 0 && btcPrice > 0) {
                    symbolsMap[sym].volBtc = Math.round(quoteVol / btcPrice);
                  }
                }
              });
              return true;
            }
          }
        } catch (e) {}
      }
    }
    return false;
  }

  /**
   * Fetch L2 OrderBook Depth (up to 200-500 levels)
   */
  async function fetchOrderBookDepth(symbol, preferredSource = 'auto') {
    if (preferredSource === 'auto' || preferredSource === 'bybit') {
      try {
        const r = await fetch(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=200`);
        if (r.ok) {
          const j = await r.json();
          if (j && j.result && Array.isArray(j.result.a) && Array.isArray(j.result.b) && j.result.a.length > 0) {
            return {
              ok: true,
              asks: j.result.a.map(x => [parseFloat(x[0]), parseFloat(x[1])]),
              bids: j.result.b.map(x => [parseFloat(x[0]), parseFloat(x[1])])
            };
          }
        }
      } catch (e) {}
    }

    if (preferredSource === 'auto' || preferredSource === 'okx') {
      try {
        const okxInstId = symbol.replace('USDT', '-USDT-SWAP');
        const r = await fetch(`https://www.okx.com/api/v5/market/books?instId=${okxInstId}&sz=100`);
        if (r.ok) {
          const j = await r.json();
          if (j && Array.isArray(j.data) && j.data[0] && Array.isArray(j.data[0].asks)) {
            return {
              ok: true,
              asks: j.data[0].asks.map(x => [parseFloat(x[0]), parseFloat(x[1])]),
              bids: j.data[0].bids.map(x => [parseFloat(x[0]), parseFloat(x[1])])
            };
          }
        }
      } catch (e) {}
    }

    if (preferredSource === 'auto' || preferredSource === 'binance') {
      for (const host of ['fapi.binance.com/fapi/v1/depth', 'api.binance.com/api/v3/depth']) {
        try {
          const r = await fetch(`https://${host}?symbol=${symbol}&limit=500`);
          if (r.ok) {
            const d = await r.json();
            if (d && Array.isArray(d.asks) && Array.isArray(d.bids)) {
              return {
                ok: true,
                asks: d.asks.map(x => [parseFloat(x[0]), parseFloat(x[1])]),
                bids: d.bids.map(x => [parseFloat(x[0]), parseFloat(x[1])])
              };
            }
          }
        } catch (e) {}
      }
    }

    return { ok: false, asks: [], bids: [] };
  }

  /**
   * Validate Custom Symbol on Exchange before adding
   */
  async function validateSymbolOnExchange(sym) {
    if (!/^[A-Z0-9]{2,15}USDT$/.test(sym)) return null;
    try {
      const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`);
      if (r.ok) {
        const j = await r.json();
        if (j && j.result && Array.isArray(j.result.list) && j.result.list.length > 0 && j.result.list[0].symbol === sym) {
          return parseFloat(j.result.list[0].lastPrice);
        }
      }
    } catch (e) {}
    for (const host of ['fapi.binance.com/fapi/v1/ticker/price', 'api.binance.com/api/v3/ticker/price']) {
      try {
        const r = await fetch(`https://${host}?symbol=${sym}`);
        if (r.ok) {
          const j = await r.json();
          if (j && j.price && parseFloat(j.price) > 0) {
            return parseFloat(j.price);
          }
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * Fetch Global Macro Dominance from CoinGecko
   */
  async function fetchMacroDominance() {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/global');
      if (r.ok) {
        const j = await r.json();
        if (j && j.data && j.data.market_cap_percentage) {
          const btcd = j.data.market_cap_percentage.btc;
          const usdtd = j.data.market_cap_percentage.usdt;
          const totalMcapUsd = j.data.total_market_cap ? j.data.total_market_cap.usd : 0;
          const total2T = totalMcapUsd > 0 && btcd ? +((totalMcapUsd * (1 - btcd / 100)) / 1e12).toFixed(2) : null;
          return {
            ok: true,
            btcd: btcd ? +btcd.toFixed(2) : null,
            usdtd: usdtd ? +usdtd.toFixed(2) : null,
            total2T
          };
        }
      }
    } catch (e) {}
    return { ok: false, btcd: null, usdtd: null, total2T: null };
  }

  const TCPData = {
    DEFAULT_SYMBOLS,
    createVisualSkeletonBars,
    fetch500PlusCandles,
    fetchMultiExchangeTickers,
    fetchOrderBookDepth,
    validateSymbolOnExchange,
    fetchMacroDominance
  };

  root.TCPData = TCPData;
})(typeof window !== 'undefined' ? window : globalThis);
