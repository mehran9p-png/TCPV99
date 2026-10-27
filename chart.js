/**
 * TCP Radar — Professional Interactive Chart Engine (chart.js)
 * Built on TradingView Lightweight Charts v4.1.3 with custom interactive Canvas overlay:
 * - Synchronized Main Candlestick + SMA 7/25/99 + Volume Histogram + RSI (30/50/70) + Optional ADX/DMI
 * - 500+ candles pan/zoom/pinch, scroll-to-realtime button, Fullscreen API + landscape lock
 * - Interactive Draggable Entry & SL lines + Green/Red R:R Zone Box + TP1/TP2/TP3 lines
 * - S/R Pivot Lines, OrderBook Aggregated Walls (weighted opacity), Fibonacci Zone, Backtest Signals & Session Markers
 * - Local Timezone formatting (Asia/Tehran or UTC), Log/Linear/Percentage price scale
 * - Offline watermark ("غیرزنده / آفلاین") and Skeleton loading state
 */
(function (root) {
  'use strict';

  let mainChart = null;
  let rsiChart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let sma7Series = null;
  let sma25Series = null;
  let sma99Series = null;
  let rsiLineSeries = null;
  let adxLineSeries = null;

  let priceLinesPool = [];
  let rsiLinesPool = [];
  let currentDragTarget = null; // 'entry' | 'sl' | null
  let isSyncingRange = false;

  const chartInternalState = {
    candles: [],
    analysis: null,
    tradePlan: null,
    backtestSignals: [],
    prefs: {
      logScale: true,
      percentScale: false,
      timezone: 'Asia/Tehran',
      showSma: true,
      showSr: true,
      showFib: true,
      showVol: true,
      showObWalls: true,
      showSignals: true,
      showSessions: true,
      showAdx: false
    },
    isLive: false,
    decimals: 2,
    onLevelsDragged: null
  };

  function formatLocalTime(unixSec, tz = 'Asia/Tehran') {
    try {
      const d = new Date(unixSec * 1000);
      return new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
        timeZone: tz === 'UTC' ? 'UTC' : 'Asia/Tehran',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(d);
    } catch (e) {
      const d = new Date(unixSec * 1000);
      return d.toISOString().slice(5, 16).replace('T', ' ');
    }
  }

  function getPriceFormat(decimals) {
    const d = Math.max(0, Math.min(6, Number(decimals) || 2));
    const minMove = +(1 / Math.pow(10, d)).toFixed(d);
    return { type: 'price', precision: d, minMove };
  }

  function initCharts(mainContainerId, rsiContainerId, overlayCanvasId, prefs, onLevelsDraggedCallback) {
    if (typeof LightweightCharts === 'undefined') {
      return false;
    }

    chartInternalState.prefs = Object.assign(chartInternalState.prefs, prefs || {});
    chartInternalState.onLevelsDragged = onLevelsDraggedCallback || null;

    const mainEl = document.getElementById(mainContainerId);
    const rsiEl = document.getElementById(rsiContainerId);
    if (!mainEl || !rsiEl) return false;

    // Clean up existing instances if re-initializing
    if (mainChart) {
      try { mainChart.remove(); } catch (e) {}
      mainChart = null;
    }
    if (rsiChart) {
      try { rsiChart.remove(); } catch (e) {}
      rsiChart = null;
    }

    const commonLayout = {
      background: { type: 'solid', color: '#050811' },
      textColor: '#94a3b8',
      fontSize: 11,
      fontFamily: "'Inter', 'Vazirmatn', monospace"
    };

    const commonGrid = {
      vertLines: { color: 'rgba(51, 65, 85, 0.24)' },
      horzLines: { color: 'rgba(51, 65, 85, 0.24)' }
    };

    mainChart = LightweightCharts.createChart(mainEl, {
      width: mainEl.clientWidth || 600,
      height: mainEl.clientHeight || 420,
      layout: commonLayout,
      grid: commonGrid,
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(245, 158, 11, 0.6)', width: 1, style: 2, labelBackgroundColor: '#f59e0b' },
        horzLine: { color: 'rgba(245, 158, 11, 0.6)', width: 1, style: 2, labelBackgroundColor: '#f59e0b' }
      },
      rightPriceScale: {
        borderColor: 'rgba(51, 65, 85, 0.6)',
        scaleMargins: { top: 0.08, bottom: 0.22 },
        mode: getPriceScaleMode()
      },
      localization: {
        locale: 'en-US',
        timeFormatter: (time) => formatLocalTime(time, chartInternalState.prefs.timezone)
      },
      timeScale: {
        borderColor: 'rgba(51, 65, 85, 0.6)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 8
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true
      }
    });

    candleSeries = mainChart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderUpColor: '#10b981',
      borderDownColor: '#f43f5e',
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
      priceFormat: getPriceFormat(chartInternalState.decimals)
    });

    volumeSeries = mainChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol_scale'
    });
    mainChart.priceScale('vol_scale').applyOptions({
      scaleMargins: { top: 0.80, bottom: 0.0 }
    });

    sma7Series = mainChart.addLineSeries({
      color: '#facc15',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
    sma25Series = mainChart.addLineSeries({
      color: '#22d3ee',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
    sma99Series = mainChart.addLineSeries({
      color: '#c084fc',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });

    // RSI & Optional ADX Synchronized Sub-Chart
    rsiChart = LightweightCharts.createChart(rsiEl, {
      width: rsiEl.clientWidth || 600,
      height: rsiEl.clientHeight || 130,
      layout: commonLayout,
      grid: commonGrid,
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(245, 158, 11, 0.5)', width: 1, style: 2 },
        horzLine: { color: 'rgba(245, 158, 11, 0.5)', width: 1, style: 2 }
      },
      rightPriceScale: {
        borderColor: 'rgba(51, 65, 85, 0.6)',
        scaleMargins: { top: 0.1, bottom: 0.1 }
      },
      localization: {
        locale: 'en-US',
        timeFormatter: (time) => formatLocalTime(time, chartInternalState.prefs.timezone)
      },
      timeScale: {
        borderColor: 'rgba(51, 65, 85, 0.6)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 8
      }
    });

    rsiLineSeries = rsiChart.addLineSeries({
      color: '#f59e0b',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      priceLineVisible: false
    });

    adxLineSeries = rsiChart.addLineSeries({
      color: '#38bdf8',
      lineWidth: 1,
      lineStyle: 2,
      priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      priceLineVisible: false,
      visible: !!chartInternalState.prefs.showAdx
    });

    // Add 30 / 50 / 70 horizontal reference lines on RSI
    rsiLinesPool = [
      rsiLineSeries.createPriceLine({ price: 70, color: 'rgba(244, 63, 94, 0.55)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '70' }),
      rsiLineSeries.createPriceLine({ price: 50, color: 'rgba(245, 158, 11, 0.65)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '50' }),
      rsiLineSeries.createPriceLine({ price: 30, color: 'rgba(16, 185, 129, 0.55)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '30' })
    ];

    // Synchronize visible logical range between Main Chart and RSI Chart
    mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (isSyncingRange || !range) return;
      isSyncingRange = true;
      rsiChart.timeScale().setVisibleLogicalRange(range);
      isSyncingRange = false;
      requestAnimationFrame(() => drawOverlayCanvas(overlayCanvasId));
    });

    rsiChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (isSyncingRange || !range) return;
      isSyncingRange = true;
      mainChart.timeScale().setVisibleLogicalRange(range);
      isSyncingRange = false;
      requestAnimationFrame(() => drawOverlayCanvas(overlayCanvasId));
    });

    // Crosshair OHLC + Vol + Change% Tooltip
    mainChart.subscribeCrosshairMove((param) => {
      updateCrosshairTooltip(param);
      requestAnimationFrame(() => drawOverlayCanvas(overlayCanvasId));
    });

    // Setup Interactive Dragging on Overlay Canvas for Entry / SL lines
    setupOverlayDragInteractions(mainEl, overlayCanvasId);

    // Responsive ResizeObserver
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (mainChart && mainEl.clientWidth > 0 && mainEl.clientHeight > 0) {
          mainChart.applyOptions({ width: mainEl.clientWidth, height: mainEl.clientHeight });
        }
        if (rsiChart && rsiEl.clientWidth > 0 && rsiEl.clientHeight > 0) {
          rsiChart.applyOptions({ width: rsiEl.clientWidth, height: rsiEl.clientHeight });
        }
        requestAnimationFrame(() => drawOverlayCanvas(overlayCanvasId));
      });
      ro.observe(mainEl);
      ro.observe(rsiEl);
    }

    return true;
  }

  function getPriceScaleMode() {
    if (typeof LightweightCharts === 'undefined') return 0;
    if (chartInternalState.prefs.percentScale) {
      return LightweightCharts.PriceScaleMode.Percentage;
    }
    if (chartInternalState.prefs.logScale) {
      return LightweightCharts.PriceScaleMode.Logarithmic;
    }
    return LightweightCharts.PriceScaleMode.Normal;
  }

  function applyChartPreferences(prefs, overlayCanvasId) {
    chartInternalState.prefs = Object.assign(chartInternalState.prefs, prefs || {});
    if (!mainChart) return;

    mainChart.applyOptions({
      rightPriceScale: { mode: getPriceScaleMode() },
      localization: {
        locale: 'en-US',
        timeFormatter: (time) => formatLocalTime(time, chartInternalState.prefs.timezone)
      }
    });
    if (rsiChart) {
      rsiChart.applyOptions({
        localization: {
          locale: 'en-US',
          timeFormatter: (time) => formatLocalTime(time, chartInternalState.prefs.timezone)
        }
      });
    }

    const showSma = !!chartInternalState.prefs.showSma;
    if (sma7Series) sma7Series.applyOptions({ visible: showSma });
    if (sma25Series) sma25Series.applyOptions({ visible: showSma });
    if (sma99Series) sma99Series.applyOptions({ visible: showSma });
    if (volumeSeries) volumeSeries.applyOptions({ visible: !!chartInternalState.prefs.showVol });
    if (adxLineSeries) adxLineSeries.applyOptions({ visible: !!chartInternalState.prefs.showAdx });

    renderChartOverlays(overlayCanvasId);
  }

  function updateCrosshairTooltip(param) {
    const el = document.getElementById('hoverCandleMetrics');
    if (!el) return;

    const candles = chartInternalState.candles;
    if (!candles || candles.length === 0 || candles[0].isSkeleton) {
      el.textContent = 'وضعیت داده: غیرزنده / در انتظار اتصال به صرافی...';
      return;
    }

    let targetCandle = candles[candles.length - 1];
    if (param && param.time) {
      const found = candles.find(c => Math.floor(c.time / 1000) === param.time);
      if (found) targetCandle = found;
    }

    const d = chartInternalState.decimals;
    const chgPct = targetCandle.open > 0
      ? (((targetCandle.close - targetCandle.open) / targetCandle.open) * 100).toFixed(2)
      : '0.00';
    const sign = Number(chgPct) >= 0 ? '+' : '';
    const timeStr = formatLocalTime(Math.floor(targetCandle.time / 1000), chartInternalState.prefs.timezone);

    el.textContent = `🕒 ${timeStr} | O: $${targetCandle.open.toFixed(d)} | H: $${targetCandle.high.toFixed(d)} | L: $${targetCandle.low.toFixed(d)} | C: $${targetCandle.close.toFixed(d)} (${sign}${chgPct}%) | Vol: ${targetCandle.volume.toFixed(1)}`;
  }

  /**
   * Full dataset update when switching symbol, timeframe, or receiving 500+ paginated candles
   */
  function setChartData(candles, analysis, tradePlan, backtestSignals, decimals, isLive, overlayCanvasId) {
    chartInternalState.candles = Array.isArray(candles) ? candles : [];
    chartInternalState.analysis = analysis || null;
    chartInternalState.tradePlan = tradePlan || null;
    chartInternalState.backtestSignals = Array.isArray(backtestSignals) ? backtestSignals : [];
    chartInternalState.decimals = decimals !== undefined ? decimals : 2;
    chartInternalState.isLive = !!isLive;

    if (!mainChart || !candleSeries) return;

    candleSeries.applyOptions({ priceFormat: getPriceFormat(chartInternalState.decimals) });

    // Convert timestamps to seconds for Lightweight Charts and ensure strictly ascending unique times
    const seenTimes = new Set();
    const lwcCandles = [];
    const lwcVolumes = [];
    const s7Data = [];
    const s25Data = [];
    const s99Data = [];
    const rsiData = [];
    const adxData = [];

    const dmiMap = new Map();
    if (analysis && Array.isArray(analysis.dmiSeries)) {
      analysis.dmiSeries.forEach(item => {
        dmiMap.set(Math.floor(item.time / 1000), item.adx);
      });
    }

    chartInternalState.candles.forEach((c, idx) => {
      const tSec = Math.floor(c.time / 1000);
      if (seenTimes.has(tSec)) return;
      seenTimes.add(tSec);

      lwcCandles.push({
        time: tSec,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      });

      const isUp = c.close >= c.open;
      lwcVolumes.push({
        time: tSec,
        value: c.volume,
        color: isUp ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)'
      });

      if (analysis && !c.isSkeleton) {
        if (analysis.sma7[idx] !== null && analysis.sma7[idx] !== undefined) {
          s7Data.push({ time: tSec, value: analysis.sma7[idx] });
        }
        if (analysis.sma25[idx] !== null && analysis.sma25[idx] !== undefined) {
          s25Data.push({ time: tSec, value: analysis.sma25[idx] });
        }
        if (analysis.sma99[idx] !== null && analysis.sma99[idx] !== undefined) {
          s99Data.push({ time: tSec, value: analysis.sma99[idx] });
        }
        if (analysis.rsiSeries && analysis.rsiSeries[idx] !== undefined) {
          rsiData.push({ time: tSec, value: analysis.rsiSeries[idx] });
        }
        if (dmiMap.has(tSec)) {
          adxData.push({ time: tSec, value: dmiMap.get(tSec) });
        }
      }
    });

    candleSeries.setData(lwcCandles);
    volumeSeries.setData(lwcVolumes);
    sma7Series.setData(s7Data);
    sma25Series.setData(s25Data);
    sma99Series.setData(s99Data);
    rsiLineSeries.setData(rsiData);
    adxLineSeries.setData(adxData);

    renderChartOverlays(overlayCanvasId);
    updateCrosshairTooltip(null);
  }

  /**
   * Incremental Real-Time Tick Update via WebSocket (NO full chart rebuild!)
   */
  function updateLiveTick(candle, analysis, tradePlan, overlayCanvasId) {
    if (!mainChart || !candleSeries || !candle || candle.isSkeleton) return;

    chartInternalState.analysis = analysis || chartInternalState.analysis;
    chartInternalState.tradePlan = tradePlan || chartInternalState.tradePlan;
    chartInternalState.isLive = true;

    const tSec = Math.floor(candle.time / 1000);
    candleSeries.update({
      time: tSec,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close
    });

    volumeSeries.update({
      time: tSec,
      value: candle.volume,
      color: candle.close >= candle.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)'
    });

    if (analysis) {
      const n = analysis.sma7.length;
      if (n > 0 && analysis.sma7[n - 1] != null) {
        sma7Series.update({ time: tSec, value: analysis.sma7[n - 1] });
      }
      if (n > 0 && analysis.sma25[n - 1] != null) {
        sma25Series.update({ time: tSec, value: analysis.sma25[n - 1] });
      }
      if (n > 0 && analysis.sma99[n - 1] != null) {
        sma99Series.update({ time: tSec, value: analysis.sma99[n - 1] });
      }
      if (analysis.currentRsi != null) {
        rsiLineSeries.update({ time: tSec, value: analysis.currentRsi });
      }
      if (analysis.adx != null) {
        adxLineSeries.update({ time: tSec, value: analysis.adx });
      }
    }

    renderChartOverlays(overlayCanvasId);
  }

  /**
   * Render PriceLines, Markers (Signals + Session Starts), and R:R Box Canvas Overlay
   */
  function renderChartOverlays(overlayCanvasId) {
    if (!mainChart || !candleSeries) return;

    // 1. Clear old price lines
    priceLinesPool.forEach(pl => {
      try { candleSeries.removePriceLine(pl); } catch (e) {}
    });
    priceLinesPool = [];

    const analysis = chartInternalState.analysis;
    const plan = chartInternalState.tradePlan;
    const prefs = chartInternalState.prefs;
    const d = chartInternalState.decimals;
    const isSkeleton = chartInternalState.candles.length === 0 || chartInternalState.candles[0].isSkeleton;

    if (!isSkeleton) {
      // 2. Trade Plan Price Lines (Entry, SL, TP1, TP2, TP3)
      if (plan && plan.entry > 0 && plan.sl > 0) {
        const slPct = (((plan.sl - plan.entry) / plan.entry) * 100).toFixed(2);
        const tp1Pct = (((plan.tp1 - plan.entry) / plan.entry) * 100).toFixed(2);
        const tp2Pct = (((plan.tp2 - plan.entry) / plan.entry) * 100).toFixed(2);
        const tp3Pct = (((plan.tp3 - plan.entry) / plan.entry) * 100).toFixed(2);

        priceLinesPool.push(
          candleSeries.createPriceLine({
            price: plan.entry,
            color: '#38bdf8',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Solid,
            axisLabelVisible: true,
            title: `⇅ ورود (${plan.side.toUpperCase()}) $${plan.entry.toFixed(d)}`
          })
        );

        priceLinesPool.push(
          candleSeries.createPriceLine({
            price: plan.sl,
            color: '#f43f5e',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Solid,
            axisLabelVisible: true,
            title: `⇅ استاپ (${slPct}% | -1R)`
          })
        );

        priceLinesPool.push(
          candleSeries.createPriceLine({
            price: plan.tp1,
            color: '#10b981',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: `TP1 (${tp1Pct}% | ${plan.rr1}R)`
          })
        );

        priceLinesPool.push(
          candleSeries.createPriceLine({
            price: plan.tp2,
            color: '#34d399',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: `TP2 (${tp2Pct}% | ${plan.rr2}R)`
          })
        );

        priceLinesPool.push(
          candleSeries.createPriceLine({
            price: plan.tp3,
            color: '#a7f3d0',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: true,
            title: `TP3 (${tp3Pct}% | ${plan.rr3}R)`
          })
        );
      }

      // 3. Structural Support / Resistance Pivot Lines
      if (prefs.showSr && analysis) {
        priceLinesPool.push(
          candleSeries.createPriceLine({
            price: analysis.majorResistance,
            color: 'rgba(251, 113, 133, 0.7)',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: false,
            title: `مقاومت پیوت (${analysis.nearestResPivot ? analysis.nearestResPivot.touches : 2} برخورد)`
          })
        );
        priceLinesPool.push(
          candleSeries.createPriceLine({
            price: analysis.majorSupport,
            color: 'rgba(52, 211, 153, 0.7)',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: false,
            title: `حمایت پیوت (${analysis.nearestSupPivot ? analysis.nearestSupPivot.touches : 2} برخورد)`
          })
        );
      }

      // 4. OrderBook Aggregated Walls (Faint horizontal lines with weight)
      if (prefs.showObWalls && plan && plan.obAgg && plan.obAgg.hasLiveBook) {
        plan.obAgg.asks.slice(0, 3).forEach(a => {
          if (a.usdM > 0) {
            priceLinesPool.push(
              candleSeries.createPriceLine({
                price: a.price,
                color: a.isHeavyWall ? 'rgba(244, 63, 94, 0.55)' : 'rgba(244, 63, 94, 0.25)',
                lineWidth: a.isHeavyWall ? 2 : 1,
                lineStyle: LightweightCharts.LineStyle.LargeDashed,
                axisLabelVisible: false,
                title: `دیوار فروش ${a.usdM}M$`
              })
            );
          }
        });
        plan.obAgg.bids.slice(0, 3).forEach(b => {
          if (b.usdM > 0) {
            priceLinesPool.push(
              candleSeries.createPriceLine({
                price: b.price,
                color: b.isHeavyWall ? 'rgba(16, 185, 129, 0.55)' : 'rgba(16, 185, 129, 0.25)',
                lineWidth: b.isHeavyWall ? 2 : 1,
                lineStyle: LightweightCharts.LineStyle.LargeDashed,
                axisLabelVisible: false,
                title: `دیوار خرید ${b.usdM}M$`
              })
            );
          }
        });
      }

      // 5. Markers: Backtest Signals (Buy/Sell Arrows) + Session Markers
      const markers = [];
      if (prefs.showSignals && Array.isArray(chartInternalState.backtestSignals)) {
        chartInternalState.backtestSignals.slice(-35).forEach(sig => {
          const tSec = Math.floor(sig.time / 1000);
          const isLongSig = sig.side === 'long';
          markers.push({
            time: tSec,
            position: isLongSig ? 'belowBar' : 'aboveBar',
            color: sig.outcome === 'win' ? '#10b981' : '#f43f5e',
            shape: isLongSig ? 'arrowUp' : 'arrowDown',
            text: `${isLongSig ? 'L' : 'S'} (${sig.netR > 0 ? '+' : ''}${sig.netR}R)`
          });
        });
      }

      if (prefs.showSessions && chartInternalState.candles.length > 0) {
        // Mark London (08:00 UTC) and New York (13:00 UTC) session opens on recent candles
        const recentSlice = chartInternalState.candles.slice(-120);
        recentSlice.forEach((c, i) => {
          if (i === 0) return;
          const prevD = new Date(recentSlice[i - 1].time);
          const curD = new Date(c.time);
          const prevH = prevD.getUTCHours();
          const curH = curD.getUTCHours();
          if (prevH !== curH) {
            if (curH === 7) {
              markers.push({
                time: Math.floor(c.time / 1000),
                position: 'aboveBar',
                color: '#f59e0b',
                shape: 'circle',
                text: 'لندن'
              });
            } else if (curH === 13) {
              markers.push({
                time: Math.floor(c.time / 1000),
                position: 'aboveBar',
                color: '#38bdf8',
                shape: 'circle',
                text: 'نیویورک'
              });
            }
          }
        });
      }

      markers.sort((a, b) => a.time - b.time);
      candleSeries.setMarkers(markers);
    }

    requestAnimationFrame(() => drawOverlayCanvas(overlayCanvasId));
  }

  /**
   * Draw Custom Canvas Overlay on top of Lightweight Charts:
   * - Green/Red R:R Box with draggable handles on Entry and SL
   * - Golden Pocket Fibonacci Retracement Zone (0.5 - 0.618)
   * - Offline Watermark ("غیرزنده / آفلاین") when not connected to live exchange
   */
  function drawOverlayCanvas(overlayCanvasId) {
    const canvas = document.getElementById(overlayCanvasId);
    if (!canvas || !mainChart || !candleSeries) return;

    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(200, rect.width);
    const H = Math.max(200, rect.height);

    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const prefs = chartInternalState.prefs;
    const analysis = chartInternalState.analysis;
    const plan = chartInternalState.tradePlan;
    const isSkeleton = chartInternalState.candles.length === 0 || chartInternalState.candles[0].isSkeleton;

    // 1. Offline / Non-Live Watermark
    if (!chartInternalState.isLive || isSkeleton) {
      ctx.save();
      ctx.fillStyle = 'rgba(244, 63, 94, 0.14)';
      ctx.font = '900 26px Vazirmatn, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚠️ وضعیت داده: غیرزنده / آفلاین', W / 2, H / 2 - 10);
      ctx.font = '700 13px Vazirmatn, sans-serif';
      ctx.fillStyle = 'rgba(226, 232, 240, 0.45)';
      ctx.fillText('نمایش آخرین داده کش‌شده — هیچ عدد ساختگی به‌عنوان تحلیل زنده تولید نمی‌شود', W / 2, H / 2 + 18);
      ctx.restore();
    }

    if (isSkeleton) {
      ctx.restore();
      return;
    }

    const plotRightEdge = Math.max(100, W - 72);

    // 2. Fibonacci Golden Zone (0.50 - 0.618) Shaded Band
    if (prefs.showFib && analysis && analysis.fibLevels) {
      const y50 = candleSeries.priceToCoordinate(analysis.fibLevels.fib500);
      const y618 = candleSeries.priceToCoordinate(analysis.fibLevels.fib618);
      if (y50 !== null && y618 !== null) {
        const topY = Math.min(y50, y618);
        const bandH = Math.max(2, Math.abs(y618 - y50));
        ctx.fillStyle = 'rgba(168, 85, 247, 0.09)';
        ctx.fillRect(12, topY, plotRightEdge - 12, bandH);
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(12, topY, plotRightEdge - 12, bandH);
        ctx.fillStyle = 'rgba(216, 180, 254, 0.85)';
        ctx.font = 'bold 10px Vazirmatn, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('ناحیه PRZ فیبوناچی (0.5 - 0.618)', 18, topY + 12);
      }
    }

    // 3. Interactive R:R Box (Entry -> TP1 Green Reward Box, Entry -> SL Red Risk Box)
    if (plan && plan.entry > 0 && plan.sl > 0 && plan.tp1 > 0) {
      const yEntry = candleSeries.priceToCoordinate(plan.entry);
      const ySl = candleSeries.priceToCoordinate(plan.sl);
      const yTp1 = candleSeries.priceToCoordinate(plan.tp1);

      if (yEntry !== null && ySl !== null && yTp1 !== null) {
        const boxLeft = Math.max(20, plotRightEdge - 190);
        const boxWidth = Math.min(175, plotRightEdge - boxLeft - 6);

        // Reward Zone (Entry to TP1)
        const rewTop = Math.min(yEntry, yTp1);
        const rewH = Math.max(4, Math.abs(yTp1 - yEntry));
        ctx.fillStyle = plan.rr1 >= 1.5 ? 'rgba(16, 185, 129, 0.18)' : 'rgba(245, 158, 11, 0.16)';
        ctx.fillRect(boxLeft, rewTop, boxWidth, rewH);
        ctx.strokeStyle = plan.rr1 >= 1.5 ? 'rgba(16, 185, 129, 0.65)' : 'rgba(245, 158, 11, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(boxLeft, rewTop, boxWidth, rewH);

        // Risk Zone (Entry to SL)
        const riskTop = Math.min(yEntry, ySl);
        const riskH = Math.max(4, Math.abs(ySl - yEntry));
        ctx.fillStyle = 'rgba(244, 63, 94, 0.20)';
        ctx.fillRect(boxLeft, riskTop, boxWidth, riskH);
        ctx.strokeStyle = 'rgba(244, 63, 94, 0.65)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(boxLeft, riskTop, boxWidth, riskH);

        // Badge inside R:R box
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(boxLeft + 4, yEntry - 11, boxWidth - 8, 22);
        ctx.strokeStyle = '#38bdf8';
        ctx.strokeRect(boxLeft + 4, yEntry - 11, boxWidth - 8, 22);

        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 10px Inter, Vazirmatn, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(
          `${plan.side.toUpperCase()} | R:R=${plan.rr1} | ${plan.quality}`,
          boxLeft + boxWidth / 2,
          yEntry + 3
        );

        // Drag handles on Entry and SL
        const drawDragPill = (y, color, text) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(boxLeft - 4, y - 8, 56, 16, 4);
          ctx.fill();
          ctx.fillStyle = '#020617';
          ctx.font = '900 9px Vazirmatn, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(text, boxLeft + 24, y + 3);
        };
        drawDragPill(yEntry, '#38bdf8', '⇅ درگ ورود');
        drawDragPill(ySl, '#fb7185', '⇅ درگ استاپ');
      }
    }

    ctx.restore();
  }

  /**
   * Enable Mouse & Touch Dragging of Entry and SL lines directly on the chart
   */
  function setupOverlayDragInteractions(mainEl, overlayCanvasId) {
    const getRelY = (clientY) => {
      const r = mainEl.getBoundingClientRect();
      return clientY - r.top;
    };
    const getRelX = (clientX) => {
      const r = mainEl.getBoundingClientRect();
      return clientX - r.left;
    };

    const hitTestLine = (relX, relY) => {
      const plan = chartInternalState.tradePlan;
      if (!plan || !candleSeries || !chartInternalState.isLive) return null;
      const W = mainEl.clientWidth || 600;
      // Only intercept drag on the right 240px (where the R:R box & drag pills live) so normal chart panning works everywhere else
      if (relX < W - 260) return null;

      const yEntry = candleSeries.priceToCoordinate(plan.entry);
      const ySl = candleSeries.priceToCoordinate(plan.sl);
      if (yEntry !== null && Math.abs(relY - yEntry) <= 14) return 'entry';
      if (ySl !== null && Math.abs(relY - ySl) <= 14) return 'sl';
      return null;
    };

    mainEl.addEventListener('mousedown', (e) => {
      const relX = getRelX(e.clientX);
      const relY = getRelY(e.clientY);
      const hit = hitTestLine(relX, relY);
      if (hit) {
        currentDragTarget = hit;
        mainChart.applyOptions({ handleScroll: false, handleScale: false });
        e.preventDefault();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!currentDragTarget || !candleSeries) return;
      const relY = getRelY(e.clientY);
      const newPrice = candleSeries.coordinateToPrice(relY);
      if (newPrice !== null && newPrice > 0 && chartInternalState.onLevelsDragged) {
        chartInternalState.onLevelsDragged(currentDragTarget, newPrice);
      }
    });

    window.addEventListener('mouseup', () => {
      if (currentDragTarget) {
        currentDragTarget = null;
        if (mainChart) {
          mainChart.applyOptions({
            handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
            handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
          });
        }
      }
    });

    // Touch dragging support for mobile
    mainEl.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      const hit = hitTestLine(getRelX(t.clientX), getRelY(t.clientY));
      if (hit) {
        currentDragTarget = hit;
        mainChart.applyOptions({ handleScroll: false, handleScale: false });
      }
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!currentDragTarget || !candleSeries || !e.touches || !e.touches[0]) return;
      const relY = getRelY(e.touches[0].clientY);
      const newPrice = candleSeries.coordinateToPrice(relY);
      if (newPrice !== null && newPrice > 0 && chartInternalState.onLevelsDragged) {
        chartInternalState.onLevelsDragged(currentDragTarget, newPrice);
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      if (currentDragTarget) {
        currentDragTarget = null;
        if (mainChart) {
          mainChart.applyOptions({
            handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
            handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
          });
        }
      }
    });
  }

  function scrollToRealtime() {
    if (mainChart) {
      mainChart.timeScale().scrollToRealTime();
    }
    if (rsiChart) {
      rsiChart.timeScale().scrollToRealTime();
    }
  }

  async function toggleChartFullscreen(wrapperElId) {
    const wrapper = document.getElementById(wrapperElId);
    if (!wrapper) return;
    try {
      if (!document.fullscreenElement) {
        if (wrapper.requestFullscreen) {
          await wrapper.requestFullscreen();
        }
        if (screen.orientation && screen.orientation.lock) {
          try { await screen.orientation.lock('landscape'); } catch (e) {}
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
        if (screen.orientation && screen.orientation.unlock) {
          try { screen.orientation.unlock(); } catch (e) {}
        }
      }
    } catch (e) {
      wrapper.classList.toggle('tcp-pseudo-fullscreen');
    }
  }

  const TCPChart = {
    initCharts,
    applyChartPreferences,
    setChartData,
    updateLiveTick,
    renderChartOverlays,
    drawOverlayCanvas,
    scrollToRealtime,
    toggleChartFullscreen
  };

  root.TCPChart = TCPChart;
})(typeof window !== 'undefined' ? window : globalThis);
