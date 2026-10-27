/**
 * TCP Radar — Main Application Controller & UI Synchronization Module (ui.js)
 * Connects `data.js`, `indicators.js`, `tradeEngine.js`, `chart.js`, and `storage.js`.
 * Guarantees that `computeTradePlan` is the ONLY source of truth for Entry/SL/TP/R:R/Size
 * across the Top Ticket, Chart Overlay, OrderBook Tab, Calculator, Checklist, and Journal.
 */
(function (root) {
  'use strict';

  const SYMBOLS_MAP = JSON.parse(JSON.stringify(root.TCPData.DEFAULT_SYMBOLS));

  const appState = {
    schemaVersion: '2.0.0',
    dataSource: 'auto',
    isLiveData: false,
    usingCachedSnapshot: false,
    takerVolumeExact: false,
    symbol: 'BTCUSDT',
    timeframe: '15m',
    side: 'long', // 'long' | 'short'
    chartMode: 'tcp', // 'tcp' (Lightweight Charts) | 'tv' (TradingView Iframe)
    candles: [],
    fullHistoryCandles: [],
    replayOffset: 0,
    rawOrderBook: { asks: [], bids: [] },
    obBucketMode: 50, // 10 -> 0.1%, 50 -> 0.25%, 100 -> 0.5%
    rsiMode: 'auto',
    customEntryOverride: null,
    customSlOverride: null,
    todayStopsCount: 0,
    tickCount: 0,
    wsConnected: false,
    ws: null,
    pollTimer: null,
    countdownTimer: null,
    audioEnabled: false,
    audioCtx: null,
    chartPrefs: null,
    lastTradePlan: null,
    lastAnalysis: null,
    lastBacktest: null,
    alerts: [],
    journal: [],
    manualChecklistOverrides: {},
    macro: {
      btcd: { value: null, change: -0.42, trend: 'در انتظار داده زنده / شبیه‌ساز آموزشی' },
      usdtd: { value: null, change: -1.18, trend: 'در انتظار داده زنده / شبیه‌ساز آموزشی' },
      total2: { value: null, unit: 'T$', change: 2.45, trend: 'در انتظار داده زنده / شبیه‌ساز آموزشی' },
      ethbtc: { value: null, change: 0.85, trend: 'در انتظار داده زنده / شبیه‌ساز آموزشی' }
    }
  };

  // --- UTILITY: Formatting & Non-Live Guard ---
  function fmtPrice(val, sym) {
    if (!appState.isLiveData && !appState.usingCachedSnapshot) return '--';
    if (val === null || val === undefined || isNaN(val) || val <= 0) return '--';
    const info = SYMBOLS_MAP[sym || appState.symbol] || { decimals: 2 };
    const d = info.decimals !== undefined ? info.decimals : 2;
    return Number(val).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function showToast(msg) {
    const t = document.getElementById('globalToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2800);
  }

  function copyTextSilently(txt, label) {
    if (!txt || txt === '--') return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(txt)).then(() => {
        showToast(`✓ ${label} (${txt}) کپی شد!`);
      }).catch(() => fallbackCopySimple(txt, label));
    } else {
      fallbackCopySimple(txt, label);
    }
  }

  function fallbackCopySimple(txt, label) {
    const ta = document.createElement('textarea');
    ta.value = String(txt);
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    showToast(`✓ ${label} (${txt}) کپی شد!`);
  }

  function playSetupPing() {
    if (!appState.audioEnabled) return;
    try {
      if (!appState.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) appState.audioCtx = new AudioContextClass();
      }
      if (!appState.audioCtx) return;
      const ctx = appState.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.26);
    } catch (e) {}
  }

  // --- CONNECTION STATUS & ACTION LOCKS ---
  function setLiveConnectionState(isLive, sourceText, exactTaker) {
    appState.isLiveData = !!isLive;
    appState.takerVolumeExact = !!exactTaker;

    const badge = document.getElementById('connBadge');
    const dot = document.getElementById('connDot');
    const txt = document.getElementById('connText');
    const offlineBanner = document.getElementById('offlineAlertBanner');
    const precTag = document.getElementById('takerSourcePrecisionTag');

    if (precTag) {
      precTag.textContent = !isLive ? 'غیرزنده' : (exactTaker ? 'دقیق از کندل بایننس' : 'تخمینی از کلوز کندل');
    }

    if (isLive) {
      txt.textContent = sourceText || 'داده زنده صرافی';
      badge.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30';
      dot.className = 'w-2 h-2 rounded-full bg-emerald-400 pulse-dot';
      offlineBanner.classList.add('hidden');
    } else {
      txt.textContent = 'غیرزنده / آفلاین';
      badge.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40';
      dot.className = 'w-2 h-2 rounded-full bg-rose-400';
      offlineBanner.classList.remove('hidden');
    }
    enforceActionLocks();
  }

  function checkDisciplineGates() {
    const g1 = document.getElementById('gatePhysicalReady').checked;
    const g2 = document.getElementById('gateNoThreeWaveClimax').checked;
    const g3 = document.getElementById('gateHtfNotRange').checked;
    const g4 = document.getElementById('gateNotCounterTrend').checked;
    const p1 = document.getElementById('psychNoBagHold').checked;
    const p2 = document.getElementById('psychCoinFlipAccept').checked;
    const p3 = document.getElementById('psychNotForcing7Pct').checked;
    const noTilt = appState.todayStopsCount < 2;
    return g1 && g2 && g3 && g4 && p1 && p2 && p3 && noTilt;
  }

  function enforceActionLocks() {
    const disciplineOk = checkDisciplineGates();
    const liqSafe = !(appState.lastTradePlan && appState.lastTradePlan.isLiqBeforeStop);
    const canExecuteTradeActions = appState.isLiveData && disciplineOk && liqSafe;

    ['copyTicketEntryBtn', 'copyTicketSlBtn', 'copyTicketTpBtn', 'copyTicketSizeBtn', 'sendSetupToCalcBtn', 'logTradeBtn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !canExecuteTradeActions;
    });

    ['addPriceAlertBtn', 'autoSetBreakoutAlertBtn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !appState.isLiveData;
    });
  }

  // --- EQUITY CURVE CANVAS DRAWER (Used for Backtester & Journal) ---
  function drawEquityCurveCanvas(canvasId, equityArrayR, lineColor = '#10b981') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(220, rect.width || 300);
    const H = Math.max(75, rect.height || 90);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const pts = Array.isArray(equityArrayR) && equityArrayR.length > 1 ? equityArrayR : [0, 0];
    let minR = Math.min(0, ...pts);
    let maxR = Math.max(1, ...pts);
    if (maxR === minR) maxR = minR + 1;

    const padX = 10;
    const padY = 12;
    const plotW = W - padX * 2;
    const plotH = H - padY * 2;

    const yOf = (r) => padY + ((maxR - r) / (maxR - minR)) * plotH;
    const xOf = (i) => padX + (i / (pts.length - 1)) * plotW;

    // Zero baseline
    const yZero = yOf(0);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, yZero);
    ctx.lineTo(W - padX, yZero);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((r, i) => {
      const x = xOf(i);
      const y = yOf(r);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill area under equity curve
    ctx.lineTo(xOf(pts.length - 1), yZero);
    ctx.lineTo(xOf(0), yZero);
    ctx.closePath();
    ctx.fillStyle = pts[pts.length - 1] >= 0 ? 'rgba(16, 185, 129, 0.14)' : 'rgba(244, 63, 94, 0.14)';
    ctx.fill();

    // End label
    const lastR = pts[pts.length - 1];
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 10px Inter, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${lastR >= 0 ? '+' : ''}${lastR}R`, W - 6, 12);
  }

  // --- SINGLE SOURCE OF TRUTH MASTER UPDATE ---
  function updateAllPanels(isIncrementalTick = false) {
    const hasValidCandles = Array.isArray(appState.candles) && appState.candles.length >= 15 && !appState.candles[0].isSkeleton;

    if (!appState.isLiveData || !hasValidCandles) {
      renderNonLivePlaceholders();
      return;
    }

    const info = SYMBOLS_MAP[appState.symbol] || { decimals: 2, touches: 3 };
    const decimals = info.decimals !== undefined ? info.decimals : 2;
    const analysis = root.TCPIndicators.analyzeMarketStructure(appState.candles, appState.rsiMode);
    if (!analysis) return;
    appState.lastAnalysis = analysis;

    const lastCandle = appState.candles[appState.candles.length - 1];
    const livePrice = lastCandle.close;
    info.price = livePrice;
    info.touches = appState.side === 'long'
      ? (analysis.nearestResPivot ? analysis.nearestResPivot.touches : 3)
      : (analysis.nearestSupPivot ? analysis.nearestSupPivot.touches : 3);

    // Gather Calculator Parameters
    const balance = Math.max(1, parseFloat(document.getElementById('calcBalance').value) || 1000);
    const riskPct = Math.max(0.1, parseFloat(document.getElementById('calcRiskPct').value) || 1.0);
    const feePct = Math.max(0, parseFloat(document.getElementById('calcFeePct').value) || 0.08);
    const slippagePct = Math.max(0, parseFloat(document.getElementById('calcSlippagePct').value) || 0.03);
    const leverage = Math.max(1, parseFloat(document.getElementById('calcLeverage').value) || 10);
    const winRatePct = Math.min(95, Math.max(5, parseFloat(document.getElementById('calcWinRate').value) || 52));
    const totalTradesN = Math.min(1000, Math.max(10, parseInt(document.getElementById('calcTotalTradesN').value, 10) || 100));
    const streakK = Math.min(20, Math.max(2, parseInt(document.getElementById('calcStreakK').value, 10) || 5));
    const bucketStepPct = appState.obBucketMode === 10 ? 0.001 : appState.obBucketMode === 50 ? 0.0025 : 0.005;

    // CALL THE UNIFIED ENGINE: computeTradePlan
    const plan = root.TCPTradeEngine.computeTradePlan(
      appState.side,
      appState.candles,
      appState.rawOrderBook,
      {
        balance,
        riskPct,
        feePct,
        slippagePct,
        leverage,
        winRatePct,
        totalTradesN,
        streakK,
        customEntry: appState.customEntryOverride,
        customSl: appState.customSlOverride,
        decimals,
        bucketStepPct,
        rsiMode: appState.rsiMode
      }
    );
    appState.lastTradePlan = plan;

    // Sync Calculator Entry/SL inputs if not actively focused by user
    const activeEl = document.activeElement;
    const entryInput = document.getElementById('calcEntryPrice');
    const stopInput = document.getElementById('calcStopPrice');
    if (entryInput && activeEl !== entryInput) {
      entryInput.value = plan.entry;
    }
    if (stopInput && activeEl !== stopInput) {
      stopInput.value = plan.sl;
    }

    checkPriceAlerts(livePrice);
    enforceActionLocks();

    // 1. Update Top Header & Executive Banner
    document.getElementById('activeSymbolLabel').textContent = `${appState.symbol}.P`;
    document.getElementById('activeTfBadge').textContent = `تایم ورود: ${appState.timeframe} (${appState.candles.length} کندل)`;
    document.getElementById('livePriceDisplay').textContent = `$${fmtPrice(livePrice)}`;

    const chgVal = info.change24h !== null ? info.change24h : +(((livePrice - appState.candles[0].open) / appState.candles[0].open) * 100).toFixed(2);
    const chgEl = document.getElementById('liveChangeBadge');
    chgEl.textContent = `${chgVal >= 0 ? '+' : ''}${chgVal.toFixed(2)}%`;
    chgEl.className = 'text-xs font-bold px-2 py-0.5 rounded ltr-num ' + (chgVal >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400');

    const btcPairVal = info.btcPair24h !== null ? info.btcPair24h : 0;
    document.getElementById('btcPairLiveBadge').textContent = `BTC Pair: ${btcPairVal >= 0 ? '+' : ''}${btcPairVal.toFixed(2)}%`;

    document.getElementById('statHigh24').textContent = `$${fmtPrice(analysis.farResistance)}`;
    document.getElementById('statLow24').textContent = `$${fmtPrice(analysis.farSupport)}`;
    document.getElementById('statVol24').textContent = info.volBtc ? `${info.volBtc.toLocaleString('en-US')} BTC` : `${Math.round(lastCandle.volume * 24).toLocaleString('en-US')} Vol`;
    document.getElementById('statBuyerPower').textContent = `خریدار ${analysis.buyerPower}٪`;

    // 2. Update Unified Top Order Ticket (100% synced with computeTradePlan)
    document.getElementById('ticketSideBadge').textContent = plan.isLong ? 'LONG 🟢' : 'SHORT 🔴';
    document.getElementById('ticketSideBadge').className = 'px-2.5 py-1 rounded-lg font-black text-xs ltr-num ' +
      (plan.isLong ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-300 border border-rose-500/40');

    document.getElementById('ticketEntryTypeLabel').textContent = plan.isLong ? 'Stop-Buy:' : 'Stop-Sell:';
    document.getElementById('ticketEntryVal').textContent = fmtPrice(plan.entry);
    document.getElementById('ticketSlVal').textContent = fmtPrice(plan.sl);
    document.getElementById('ticketTpVal').textContent = `${fmtPrice(plan.tp1)} (${plan.rr1}R)`;
    document.getElementById('ticketSizeVal').textContent = `$${Math.round(plan.positionSize).toLocaleString('en-US')}`;

    const qBadge = document.getElementById('ticketQualityBadge');
    qBadge.textContent = `کیفیت: ${plan.quality} (R:R=${plan.rr1})`;
    if (plan.qualityCode === 'NO_TRADE') {
      qBadge.className = 'px-2.5 py-1 rounded-lg bg-rose-500/25 text-rose-300 border border-rose-500/50 font-black text-[11px]';
    } else if (plan.qualityCode === 'WEAK') {
      qBadge.className = 'px-2.5 py-1 rounded-lg bg-amber-500/25 text-amber-300 border border-amber-500/50 font-bold text-[11px]';
    } else {
      qBadge.className = 'px-2.5 py-1 rounded-lg bg-emerald-500/25 text-emerald-300 border border-emerald-500/50 font-black text-[11px]';
    }

    // 5-Step Daily Routine Strip
    document.getElementById('step1Status').textContent = analysis.isChertMarket ? '⚠️ رنج فشرده' : (analysis.s25 >= analysis.s99 ? 'صعودی' : 'نزولی');
    document.getElementById('step2Status').textContent = appState.macro.usdtd.change < 0 ? 'USDT.D نزولی ✓' : 'USDT.D صعودی';
    document.getElementById('step3Status').textContent = btcPairVal >= 0 ? `+${btcPairVal}% ✓` : `${btcPairVal}%`;
    document.getElementById('step4Status').textContent = `${info.touches} تاچ | ${analysis.volRatio}x`;
    document.getElementById('step5Status').textContent = `$${fmtPrice(plan.entry)} (${plan.rr1}R)`;

    // Cycles
    document.getElementById('hwcStatusPill').textContent = analysis.s25 >= analysis.s99 ? 'صعودی (HH/HL)' : 'نزولی (زیر SMA99)';
    document.getElementById('hwcStatusPill').className = 'text-xs font-extrabold mt-0.5 ' + (analysis.s25 >= analysis.s99 ? 'text-emerald-400' : 'text-rose-400');
    document.getElementById('mwcStatusPill').textContent = analysis.isChertMarket ? 'رنج و فشرده' : (analysis.currentRsi >= 50 ? 'موج صعودی فعال' : 'فاز اصلاحی');
    document.getElementById('lwcStatusPill').textContent = analysis.dowStructure;

    // 3. System Status Narrative
    const routineCmd = document.getElementById('routineFinalCommand');
    const visaBadge = document.getElementById('visaWarningBadge');
    let narrative = '';

    if (appState.todayStopsCount >= 2) {
      routineCmd.textContent = '🛑 قفل انضباطی فعال: ۲ حد ضرر روزانه ثبت شده است';
      routineCmd.className = 'text-[11px] px-2 py-0.5 rounded-full bg-rose-500/25 text-rose-300 border border-rose-500/50 font-black';
      visaBadge.textContent = '🛑 توقف معاملات روزانه (قفل ۲ استاپ)';
      visaBadge.className = 'text-[11px] px-2 py-0.5 rounded-full bg-rose-500/25 text-rose-300 border border-rose-500/50 font-black';
      narrative = `وضعیت سیستم: در روز جاری ${appState.todayStopsCount} معامله با حد ضرر ثبت شده است. بر اساس قوانین مدیریت ریسک، ثبت پوزیشن جدید برای جلوگیری از معاملات انتقامی قفل است.`;
    } else if (plan.qualityCode === 'NO_TRADE') {
      routineCmd.textContent = `وضعیت: NO TRADE (${plan.quality})`;
      routineCmd.className = 'text-[11px] px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 font-bold';
      visaBadge.textContent = '⚠️ نسبت R:R تا مانع اول کمتر از ۱.۵ است';
      visaBadge.className = 'text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold';
      narrative = `تحلیل ساختاری (${plan.side.toUpperCase()}): نقطه ورود روی $${fmtPrice(plan.entry)} و حد ضرر ساختاری روی $${fmtPrice(plan.sl)} (${plan.stopDistAtr}×ATR) محاسبه شد، اما اولین مانع واقعی (${plan.firstObstacleSource}) در $${fmtPrice(plan.tp1)} قرار دارد که نسبت ریسک به ریوارد (${plan.rr1}) را زیر حداقل ۱.۵ قرار می‌دهد (NO TRADE).`;
    } else {
      routineCmd.textContent = `وضعیت: ستاپ ${plan.side.toUpperCase()} (${plan.quality} | R:R=${plan.rr1})`;
      routineCmd.className = 'text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold';
      visaBadge.textContent = 'وضعیت انضباطی: شرایط ستاپ برقرار است ✓';
      visaBadge.className = 'text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-bold';
      narrative = `تحلیل ساختاری (${plan.side.toUpperCase()}): روی نماد ${appState.symbol}.P (${appState.timeframe})، سطح ورود ${plan.isLong ? 'Stop-Buy' : 'Stop-Sell'} روی $${fmtPrice(plan.entry)}، حد ضرر ساختاری روی $${fmtPrice(plan.sl)} (${plan.stopDistAtr}×ATR) و تارگت اول قبل از ${plan.firstObstacleSource} روی $${fmtPrice(plan.tp1)} (R:R=${plan.rr1} | R خالص پس از کارمزد=${plan.netRAfterFees}R) محاسبه شد.`;
    }
    document.getElementById('arshiaLiveNarrative').textContent = narrative;

    // 4. Radar Metrics & Candle Anatomy
    document.getElementById('valSma7').textContent = fmtPrice(analysis.s7);
    document.getElementById('valSma25').textContent = fmtPrice(analysis.s25);
    document.getElementById('valSma99').textContent = fmtPrice(analysis.s99);
    document.getElementById('smaConditionText').textContent = analysis.smaState;
    document.getElementById('smaConditionText').className = analysis.isChertMarket ? 'text-rose-400 font-bold' : 'text-emerald-400 font-bold';
    document.getElementById('sma99DistText').textContent = `${analysis.distFrom99Pct >= 0 ? '+' : ''}${analysis.distFrom99Pct.toFixed(2)}%`;

    const buyPct = Math.round((analysis.takerBuy / Math.max(0.01, analysis.takerBuy + analysis.takerSell)) * 100);
    document.getElementById('takerBuyVolText').textContent = `${buyPct}% (${analysis.takerBuy})`;
    document.getElementById('takerSellVolText').textContent = `${100 - buyPct}% (${analysis.takerSell})`;
    document.getElementById('fiveCandleDeltaText').textContent = `${analysis.fiveCandleBuySellRatio}x`;
    const deltaBadge = document.getElementById('deltaBotVerdictBadge');
    deltaBadge.textContent = `Delta: ${analysis.deltaVol >= 0 ? '+' : ''}${analysis.deltaVol}`;
    deltaBadge.className = 'text-[11px] font-black px-2 py-0.5 rounded ltr-num ' + (analysis.deltaVol >= 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300');

    document.getElementById('smTrapLevelText').textContent = `$${fmtPrice(plan.isLong ? analysis.majorResistance : analysis.majorSupport)}`;
    document.getElementById('elliottTrapText').textContent = analysis.currentRsi >= 50 ? 'مومنتوم بالای خط ۵۰' : 'زیر خط ۵۰';

    document.getElementById('rsiValueLabel').textContent = `${analysis.currentRsi.toFixed(1)} (P=${analysis.chosenRsiPeriod})`;
    const rsiBadge = document.getElementById('rsiSignalBadge');
    if (analysis.currentRsi >= 70) {
      rsiBadge.textContent = 'اشباع خرید (>70)';
      rsiBadge.className = 'px-2 py-0.5 rounded bg-amber-500/20 text-amber-300';
    } else if (analysis.currentRsi <= 30) {
      rsiBadge.textContent = 'اشباع فروش (<30)';
      rsiBadge.className = 'px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300';
    } else if (analysis.currentRsi >= 50) {
      rsiBadge.textContent = 'بالای خط عطف ۵۰';
      rsiBadge.className = 'px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400';
    } else {
      rsiBadge.textContent = 'زیر خط عطف ۵۰';
      rsiBadge.className = 'px-2 py-0.5 rounded bg-rose-500/15 text-rose-400';
    }

    document.getElementById('lastCandleTag').textContent = analysis.candleType;
    document.getElementById('bullPowerLabel').textContent = `زور خریدار: ${analysis.buyerPower}٪`;
    document.getElementById('bearPowerLabel').textContent = `زور فروشنده: ${100 - analysis.buyerPower}٪`;
    document.getElementById('bullPowerBar').style.width = `${analysis.buyerPower}%`;
    document.getElementById('candleBodyRatio').textContent = `${analysis.bodyRatio}%`;
    document.getElementById('candleSizeVsAvg').textContent = `${analysis.sizeVsAvg}x`;
    document.getElementById('candleUpperWick').textContent = `${analysis.upperRatio}%`;
    document.getElementById('candleLowerWick').textContent = `${analysis.lowerRatio}%`;
    document.getElementById('candleRuleExplanation').textContent = analysis.candleAdvice;

    document.getElementById('volRatioText').textContent = `${analysis.volRatio}x`;
    document.getElementById('volFourStateText').textContent = analysis.volFourState;
    document.getElementById('volBoxRangeText').textContent = `$${fmtPrice(analysis.majorSupport)} - $${fmtPrice(analysis.majorResistance)}`;
    document.getElementById('volStatusBadge').textContent = analysis.volRatio >= 1.1 ? 'حجم بالاتر از میانگین ✓' : 'حجم کم';

    document.getElementById('valAdx').textContent = analysis.adx;
    document.getElementById('valDiCross').textContent = `+${analysis.plusDi} / -${analysis.minusDi}`;
    document.getElementById('valRoc').textContent = `${analysis.roc10 >= 0 ? '+' : ''}${analysis.roc10.toFixed(2)}%`;

    // 5. Update Interactive Chart (Incremental if WebSocket tick, full setData otherwise)
    if (isIncrementalTick) {
      root.TCPChart.updateLiveTick(lastCandle, analysis, plan, 'chartOverlayCanvas');
    } else {
      const btSignals = appState.lastBacktest ? appState.lastBacktest.signals : [];
      root.TCPChart.setChartData(appState.candles, analysis, plan, btSignals, decimals, appState.isLiveData, 'chartOverlayCanvas');
    }

    // 6. Update Tabs 2, 3, 4, 5 using the EXACT SAME `plan`
    renderChecklistAndScenarios(analysis, info, plan);
    renderOrderBookAndSessions(analysis, livePrice, plan);
    renderMacroAndBtcPairs();
    renderCalculatorFromPlan(plan);
  }

  // --- NON-LIVE PLACEHOLDER RENDERER (Strictly "--" and "غیرزنده" when offline) ---
  function renderNonLivePlaceholders() {
    document.getElementById('livePriceDisplay').textContent = '--';
    document.getElementById('liveChangeBadge').textContent = 'غیرزنده';
    document.getElementById('btcPairLiveBadge').textContent = 'BTC Pair: --';
    document.getElementById('statHigh24').textContent = '--';
    document.getElementById('statLow24').textContent = '--';
    document.getElementById('statVol24').textContent = '--';
    document.getElementById('statBuyerPower').textContent = 'غیرزنده';

    document.getElementById('ticketEntryVal').textContent = '--';
    document.getElementById('ticketSlVal').textContent = '--';
    document.getElementById('ticketTpVal').textContent = '--';
    document.getElementById('ticketSizeVal').textContent = '--';
    document.getElementById('ticketQualityBadge').textContent = 'غیرزنده / آفلاین';
    document.getElementById('ticketQualityBadge').className = 'px-2.5 py-1 rounded-lg bg-rose-500/25 text-rose-300 border border-rose-500/50 font-black text-[11px]';

    ['step1Status', 'step2Status', 'step3Status', 'step4Status', 'step5Status', 'valSma7', 'valSma25', 'valSma99', 'sma99DistText', 'takerBuyVolText', 'takerSellVolText', 'fiveCandleDeltaText', 'smTrapLevelText', 'rsiValueLabel', 'candleBodyRatio', 'candleSizeVsAvg', 'candleUpperWick', 'candleLowerWick', 'volRatioText', 'volBoxRangeText', 'valAdx', 'valDiCross', 'valRoc', 'obStopBuyPrice', 'obSafeTargetPrice', 'obSafeStopLoss', 'orbHighText', 'orbLowText'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '--';
    });

    document.getElementById('routineFinalCommand').textContent = 'وضعیت: غیرزنده (عدم دسترسی به صرافی)';
    document.getElementById('visaWarningBadge').textContent = 'وضعیت داده: غیرزنده';
    document.getElementById('arshiaLiveNarrative').textContent = 'وضعیت سیستم: ارتباط زنده با API صرافی‌ها برقرار نیست. طبق قانون عدم تولید داده جعلی، هیچ عدد تصادفی یا ساختگی به‌عنوان تحلیل نمایش داده نمی‌شود.';

    root.TCPChart.drawOverlayCanvas('chartOverlayCanvas');
    enforceActionLocks();
  }

  // --- TAB 2: CHECKLIST & SCENARIOS (10th item truly evaluates R:R >= 2 from computeTradePlan) ---
  function renderChecklistAndScenarios(analysis, info, plan) {
    const allGatesPass = checkDisciplineGates();

    const tiltBadge = document.getElementById('tiltStatusBadge');
    if (appState.todayStopsCount === 0) {
      tiltBadge.textContent = 'نرمال (۰ استاپ)';
      tiltBadge.className = 'px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[11px] font-bold';
    } else if (appState.todayStopsCount === 1) {
      tiltBadge.textContent = 'احتیاط (۱ استاپ ثبت‌شده)';
      tiltBadge.className = 'px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[11px] font-bold';
    } else {
      tiltBadge.textContent = '🛑 قفل سقف ضرر روزانه فعال شد';
      tiltBadge.className = 'px-2 py-0.5 rounded bg-rose-500/25 text-rose-300 text-[11px] font-black';
    }

    const gateBadge = document.getElementById('hardGateGlobalBadge');
    if (allGatesPass && !plan.isLiqBeforeStop) {
      gateBadge.textContent = 'وضعیت پلن مکتوب: پیش‌شرط‌ها برقرار است ✓';
      gateBadge.className = 'px-3 py-1.5 rounded-xl text-xs font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    } else {
      gateBadge.textContent = '🛑 قفل انضباطی یا لیکوئید فعال است';
      gateBadge.className = 'px-3 py-1.5 rounded-xl text-xs font-black bg-rose-500/25 text-rose-300 border border-rose-500/50';
    }

    const isAlignedWithHwc = plan.isLong ? (analysis.s25 >= analysis.s99) : (analysis.s25 <= analysis.s99);
    const isStructureAligned = plan.isLong ? analysis.isBullishStructure : analysis.isBearishStructure;
    const isRsiAligned = plan.isLong
      ? (analysis.currentRsi >= 50 && analysis.currentRsi < 74)
      : (analysis.currentRsi <= 50 && analysis.currentRsi > 26);
    const isRrAtLeastTwo = plan.rr1 >= 2.0 && !plan.isLiqBeforeStop && allGatesPass;

    const items = [
      { id: 'c1', title: `۱. هم‌جهتی پوزیشن (${plan.side.toUpperCase()}) با سایکل بزرگ‌تر (SMA25/99)`, pass: isAlignedWithHwc, detail: isAlignedWithHwc ? 'هم‌جهت با میانگین ۹۹' : 'خلاف جهت میانگین ۹۹' },
      { id: 'c2', title: '۲. ساختار پیوت‌ها (HH/HL برای لانگ یا LH/LL برای شورت)', pass: isStructureAligned, detail: analysis.dowStructure },
      { id: 'c3', title: '۳. عدم فشردگی میانگین‌های ۷، ۲۵ و ۹۹', pass: !analysis.isChertMarket, detail: analysis.smaState },
      { id: 'c4', title: '۴. همراهی حجم معاملات و دلتای هم‌جهت', pass: (plan.isLong ? analysis.deltaVol >= 0 : analysis.deltaVol <= 0) && analysis.volRatio >= 0.95, detail: `نسبت حجم: ${analysis.volRatio}x | دلتا: ${analysis.deltaVol}` },
      { id: 'c5', title: '۵. نسبت بدنه کندل و نبود کندل بی‌تصمیمی', pass: analysis.bodyRatio > 28, detail: analysis.candleType },
      { id: 'c6', title: '۶. قرارگیری RSI در ناحیه تایید و خارج از اشباع', pass: isRsiAligned, detail: `RSI(${analysis.chosenRsiPeriod}) = ${analysis.currentRsi.toFixed(1)}` },
      { id: 'c7', title: '۷. هم‌راستایی دامیننس تتر (USDT.D)', pass: plan.isLong ? (appState.macro.usdtd.change < 0) : (appState.macro.usdtd.change > 0), detail: `USDT.D تغییر: ${appState.macro.usdtd.change}%` },
      { id: 'c8', title: '۸. قدرت نسبی پیر بیت‌کوین و نقدینگی کافی', pass: (info.volBtc || 1500) >= 1000, detail: `حجم: ${info.volBtc || '--'} BTC | پیر بیت: ${info.btcPair24h || 0}%` },
      { id: 'c9', title: '۹. تعداد برخورد با سطح شکست (≥۳ برخورد)', pass: info.touches >= 3, detail: `${info.touches} برخورد ثبت‌شده روی سطح` },
      { id: 'c10', title: '۱۰. بررسی واقعی R:R ≥ 2 تا اولین مانع + پیش‌شرط انضباطی', pass: isRrAtLeastTwo, detail: `R:R واقعی تا مانع اول (${plan.firstObstacleSource}) = ${plan.rr1} | کیفیت: ${plan.quality}` }
    ];

    let score = 0;
    const container = document.getElementById('checklistItemsContainer');
    container.innerHTML = '';

    items.forEach(item => {
      const effectivePass = appState.manualChecklistOverrides[item.id] !== undefined
        ? appState.manualChecklistOverrides[item.id]
        : item.pass;
      if (effectivePass) score++;

      const row = document.createElement('div');
      row.className = 'flex items-center justify-between p-2.5 rounded-xl border transition cursor-pointer min-h-[44px] ' +
        (effectivePass ? 'bg-emerald-500/10 border-emerald-500/30 text-slate-100' : 'bg-slate-900/80 border-slate-800 text-slate-400');
      row.innerHTML = `
        <div class="flex items-center gap-2.5">
          <span class="w-6 h-6 rounded-md flex items-center justify-center text-xs font-black ${effectivePass ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-500'}">
            ${effectivePass ? '✓' : '✕'}
          </span>
          <div>
            <div class="font-bold">${item.title}</div>
            <div class="text-[11px] text-slate-400">${item.detail}</div>
          </div>
        </div>
        <span class="text-[11px] px-2 py-0.5 rounded ${effectivePass ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'}">
          ${effectivePass ? '+1 امتیاز' : 'برقرار نیست'}
        </span>
      `;
      row.addEventListener('click', () => {
        appState.manualChecklistOverrides[item.id] = !effectivePass;
        updateAllPanels(true);
      });
      container.appendChild(row);
    });

    document.getElementById('checklistTotalScore').textContent = `${score} / 10`;
    const verdictEl = document.getElementById('checklistVerdictBadge');
    if (!allGatesPass || plan.qualityCode === 'NO_TRADE') {
      verdictEl.textContent = `🛑 ${plan.quality} (امتیاز ${score}/10)`;
      verdictEl.className = 'text-[11px] font-black text-rose-400';
    } else if (score >= 8) {
      verdictEl.textContent = `شرایط ستاپ برقرار است (${plan.quality} | ریسک پیشنهادی ۰.۷۵٪ تا ۱٪)`;
      verdictEl.className = 'text-[11px] font-bold text-emerald-400';
    } else if (score >= 6) {
      verdictEl.textContent = `شرایط ستاپ متوسط (${plan.quality} | ریسک پیشنهادی ۰.۵٪)`;
      verdictEl.className = 'text-[11px] font-bold text-amber-400';
    } else {
      verdictEl.textContent = 'شرایط ستاپ ناقص است (عدم ورود)';
      verdictEl.className = 'text-[11px] font-bold text-rose-400';
    }

    const scenarios = [
      {
        code: 'سناریوی A (شکست مقاومت همراه با حجم - لانگ)',
        cond: `کلوز کندل ${appState.timeframe} بالای مقاومت ($${fmtPrice(analysis.majorResistance)}) همراه با دلتای حجم مثبت`,
        action: `ورود Stop-Buy روی $${fmtPrice(plan.isLong ? plan.entry : analysis.majorResistance + 0.1 * analysis.currentAtr)} | استاپ: $${fmtPrice(plan.isLong ? plan.sl : analysis.majorSupport - 0.25 * analysis.currentAtr)} | تارگت اول: $${fmtPrice(plan.isLong ? plan.tp1 : analysis.farResistance)}`,
        color: 'border-emerald-500/40 bg-emerald-500/10'
      },
      {
        code: 'سناریوی B (شکست حمایت همراه با فشار عرضه - شورت)',
        cond: `کلوز کندل زیر حمایت ساختاری ($${fmtPrice(analysis.majorSupport)}) و قرارگیری زیر SMA 25`,
        action: `ورود Stop-Sell زیر $${fmtPrice(!plan.isLong ? plan.entry : analysis.majorSupport - 0.1 * analysis.currentAtr)} | استاپ بالای پیوت: $${fmtPrice(!plan.isLong ? plan.sl : analysis.majorResistance + 0.25 * analysis.currentAtr)} | تارگت اول: $${fmtPrice(!plan.isLong ? plan.tp1 : analysis.farSupport)}`,
        color: 'border-rose-500/40 bg-rose-500/10'
      },
      {
        code: 'سناریوی C (نوسان در باکس رنج یا R:R < 1.5)',
        cond: `فاصله تا اولین مانع کمتر از ۱.۵ برابر حد ضرر یا فشردگی میانگین‌ها`,
        action: `برنامه مکتوب: اعلام وضعیت NO TRADE؛ عدم ورود در میانه باکس و تنظیم آلارم روی سقف و کف ساختاری.`,
        color: 'border-amber-500/40 bg-amber-500/10'
      }
    ];

    document.getElementById('scenariosListContainer').innerHTML = scenarios.map(s => `
      <div class="p-3 rounded-xl border ${s.color} space-y-1 text-xs">
        <div class="font-extrabold text-white">${s.code}</div>
        <div class="text-slate-300"><strong class="text-amber-300">شرط فعال‌سازی:</strong> ${s.cond}</div>
        <div class="text-slate-200"><strong class="text-emerald-300">برنامه مدیریت:</strong> ${s.action}</div>
      </div>
    `).join('');

    document.getElementById('cycleCardsGrid').innerHTML = `
      <div class="bg-slate-900/90 p-3 rounded-xl border border-slate-800 space-y-1">
        <div class="text-amber-400 font-bold">۱. موج بزرگ (HWC)</div>
        <div class="text-white font-semibold">جهت ساختار: ${analysis.s25 >= analysis.s99 ? 'صعودی' : 'نزولی'}</div>
        <p class="text-[11px] text-slate-400">فاصله از SMA99 برابر ${analysis.distFrom99Pct.toFixed(2)}% است.</p>
      </div>
      <div class="bg-slate-900/90 p-3 rounded-xl border border-slate-800 space-y-1">
        <div class="text-cyan-400 font-bold">۲. موج میانی (MWC)</div>
        <div class="text-white font-semibold">سطح ۵۰٪ فیبو: $${fmtPrice(analysis.fibLevels.fib500)}</div>
        <p class="text-[11px] text-slate-400">طول سایکل متوسط ${analysis.cycleInfo.avgCycle} کندل و دوره RSI اتوماتیک ${analysis.cycleInfo.evenHalf} است.</p>
      </div>
      <div class="bg-slate-900/90 p-3 rounded-xl border border-slate-800 space-y-1">
        <div class="text-emerald-400 font-bold">۳. موج کوچک (LWC - ${appState.timeframe})</div>
        <div class="text-white font-semibold">تعداد برخورد: ${info.touches} بار | ATR: $${fmtPrice(analysis.currentAtr)}</div>
        <p class="text-[11px] text-slate-400">کیفیت ستاپ فعلی: <strong>${plan.quality}</strong> (R:R=${plan.rr1}).</p>
      </div>
    `;
  }

  // --- TAB 3: ORDER BOOK & SESSIONS (100% Unified with computeTradePlan) ---
  function renderOrderBookAndSessions(analysis, livePrice, plan) {
    // Display the EXACT SAME Entry, TP1, and SL from `computeTradePlan`!
    document.getElementById('obEntryTypeTitle').textContent = plan.isLong ? 'سطح پیشنهادی Stop-Buy (لانگ):' : 'سطح پیشنهادی Stop-Sell (شورت):';
    document.getElementById('obStopBuyPrice').textContent = `$${fmtPrice(plan.entry)}`;
    document.getElementById('obSafeTargetPrice').textContent = `$${fmtPrice(plan.tp1)} (${plan.rr1}R - ${plan.firstObstacleSource})`;
    document.getElementById('obSafeStopLoss').textContent = `$${fmtPrice(plan.sl)} (${plan.stopDistAtr}×ATR)`;

    const obAgg = plan.obAgg;
    const asksEl = document.getElementById('obAsksList');
    const bidsEl = document.getElementById('obBidsList');

    if (!obAgg || !obAgg.hasLiveBook) {
      asksEl.innerHTML = '<div class="text-slate-400 text-xs p-3 text-center">غیرزنده / در انتظار دریافت عمق بازار از صرافی (هیچ داده ساختگی نمایش داده نمی‌شود)</div>';
      bidsEl.innerHTML = '<div class="text-slate-400 text-xs p-3 text-center">غیرزنده / در انتظار دریافت عمق بازار از صرافی</div>';
    } else {
      let cumAskM = 0;
      const orderedAsks = obAgg.asks.slice(0, 5).reverse();
      asksEl.innerHTML = orderedAsks.map(a => {
        cumAskM = +(cumAskM + a.usdM).toFixed(2);
        const pct = Math.min(100, Math.round((a.weightRatio / 2.2) * 100));
        return `
          <div class="relative overflow-hidden flex items-center justify-between p-2 rounded-lg bg-slate-900/90 border ${a.isHeavyWall ? 'border-rose-500/60' : 'border-rose-500/20'}">
            <div class="absolute inset-y-0 left-0 bg-rose-500/15" style="width:${pct}%"></div>
            <div class="relative z-10">
              <span class="font-bold text-rose-300 ltr-num">$${fmtPrice(a.price)}</span>
              <span class="block text-[11px] text-slate-400">${a.isHeavyWall ? '🧱 دیوار سنگین عرضه (مانع تارگت لانگ)' : 'پله عرضه لیمیت'}</span>
            </div>
            <div class="relative z-10 text-left">
              <span class="font-bold text-white ltr-num">${a.usdM}M$ <span class="text-[11px] text-amber-300">(Sum: ${cumAskM}M$)</span></span>
              <span class="block text-[11px] text-emerald-400">وزن: ${a.weightRatio}x میانگین</span>
            </div>
          </div>
        `;
      }).join('');

      let cumBidM = 0;
      bidsEl.innerHTML = obAgg.bids.slice(0, 5).map(b => {
        cumBidM = +(cumBidM + b.usdM).toFixed(2);
        const pct = Math.min(100, Math.round((b.weightRatio / 2.2) * 100));
        return `
          <div class="relative overflow-hidden flex items-center justify-between p-2 rounded-lg bg-slate-900/90 border ${b.isHeavyWall ? 'border-emerald-500/60' : 'border-emerald-500/20'}">
            <div class="absolute inset-y-0 left-0 bg-emerald-500/15" style="width:${pct}%"></div>
            <div class="relative z-10">
              <span class="font-bold text-emerald-300 ltr-num">$${fmtPrice(b.price)}</span>
              <span class="block text-[11px] text-slate-400">${b.isHeavyWall ? '🧱 دیوار سنگین تقاضا (حمایت/مانع شورت)' : 'پله تقاضای لیمیت'}</span>
            </div>
            <div class="relative z-10 text-left">
              <span class="font-bold text-white ltr-num">${b.usdM}M$ <span class="text-[11px] text-cyan-300">(Sum: ${cumBidM}M$)</span></span>
              <span class="block text-[11px] text-emerald-400">وزن: ${b.weightRatio}x میانگین</span>
            </div>
          </div>
        `;
      }).join('');
    }

    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    document.getElementById('utcClockLabel').textContent = `UTC ${String(utcH).padStart(2, '0')}:${String(utcM).padStart(2, '0')}`;

    const sessions = [
      { name: 'سشن آسیا / توکیو (۰۰:۰۰ تا ۰۹:۰۰ UTC)', active: utcH >= 0 && utcH < 9, behavior: 'نوسان محدودتر یا اصلاح موج قبلی' },
      { name: 'سشن اروپا / لندن (۰۷:۰۰ تا ۱۶:۰۰ UTC)', active: utcH >= 7 && utcH < 16, behavior: 'افزایش حجم و بررسی شکست محدوده ۱۵ دقیقه ابتدایی' },
      { name: 'سشن آمریکا / نیویورک (۱۳:۰۰ تا ۲۲:۰۰ UTC)', active: utcH >= 13 && utcH < 22, behavior: 'بیشترین حجم معاملات روزانه' }
    ];
    const activeSessionNames = sessions.filter(s => s.active).map(s => s.name.split('(')[0].trim());
    document.getElementById('sessionBannerText').textContent = 'سشن فعال: ' + (activeSessionNames.length ? activeSessionNames.join(' + ') : 'بین سشن‌ها');

    document.getElementById('sessionsContainer').innerHTML = sessions.map(s => `
      <div class="p-2.5 rounded-xl border ${s.active ? 'bg-amber-500/15 border-amber-500/40' : 'bg-slate-900/70 border-slate-800'} flex items-center justify-between">
        <div>
          <div class="font-bold ${s.active ? 'text-amber-300' : 'text-slate-300'}">${s.name}</div>
          <div class="text-[11px] text-slate-400 mt-0.5">${s.behavior}</div>
        </div>
        <span class="text-[11px] px-2 py-0.5 rounded font-bold ${s.active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-500'}">
          ${s.active ? 'فعال ●' : 'بسته'}
        </span>
      </div>
    `).join('');

    const orbHigh = analysis.majorResistance;
    const orbLow = analysis.majorSupport;
    document.getElementById('orbHighText').textContent = `$${fmtPrice(orbHigh)}`;
    document.getElementById('orbLowText').textContent = `$${fmtPrice(orbLow)}`;
    const orbBadge = document.getElementById('orbStatusBadge');
    if (livePrice > orbHigh) {
      orbBadge.textContent = 'شکست سقف محدوده ✓';
      orbBadge.className = 'px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[11px] font-bold';
    } else if (livePrice < orbLow) {
      orbBadge.textContent = 'شکست کف محدوده';
      orbBadge.className = 'px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[11px] font-bold';
    } else {
      orbBadge.textContent = 'درون محدوده سشن';
      orbBadge.className = 'px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[11px] font-bold';
    }

    const isLiqGrab = analysis.volRatio >= 1.45 && (analysis.upperRatio >= 40 || analysis.lowerRatio >= 40);
    const lgBadge = document.getElementById('liqGrabBadge');
    const lgDesc = document.getElementById('liqGrabDesc');
    if (isLiqGrab) {
      lgBadge.textContent = '⚠️ شدوی بلند همراه با جهش حجم شناسایی شد';
      lgBadge.className = 'px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[11px] font-bold';
      lgDesc.textContent = 'در کندل فعلی شدوی بلند (بیش از ۴۰٪ کندل) همراه با حجم بالاتر از میانگین مشاهده می‌شود که نشانه جذب نقدینگی در انتهای موج است.';
    } else {
      lgBadge.textContent = 'نرمال (بدون انحراف شدید)';
      lgBadge.className = 'px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[11px] font-bold';
      lgDesc.textContent = 'نسبت بدنه و حجم کندل در محدوده طبیعی میانگین وزنی حجم و ATR قرار دارد.';
    }
  }

  // --- TAB 4: MACRO DOMINANCE & BTC PAIRS ---
  function renderMacroAndBtcPairs() {
    const m = appState.macro;
    const gauges = [
      { title: 'دامیننس بیت‌کوین (BTC.D)', val: m.btcd.value !== null ? `${m.btcd.value.toFixed(2)}%` : '--', chg: m.btcd.change, desc: m.btcd.trend },
      { title: 'دامیننس تتر (USDT.D)', val: m.usdtd.value !== null ? `${m.usdtd.value.toFixed(2)}%` : '--', chg: m.usdtd.change, desc: m.usdtd.trend },
      { title: 'ارزش آلت‌کوین‌ها (TOTAL2)', val: m.total2.value !== null ? `${m.total2.value.toFixed(2)} ${m.total2.unit}` : '--', chg: m.total2.change, desc: m.total2.trend },
      { title: 'شاخص ETH / BTC', val: m.ethbtc.value !== null ? m.ethbtc.value.toFixed(5) : '--', chg: m.ethbtc.change, desc: m.ethbtc.trend }
    ];

    document.getElementById('macroGaugesGrid').innerHTML = gauges.map(g => `
      <div class="bg-slate-900/90 p-3 rounded-xl border border-slate-800 space-y-1">
        <div class="text-[11px] text-slate-400 font-semibold">${g.title}</div>
        <div class="flex items-baseline justify-between">
          <span class="text-lg font-black text-white ltr-num">${g.val}</span>
          <span class="text-xs font-bold ltr-num ${g.chg >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${g.chg >= 0 ? '+' : ''}${g.chg}%</span>
        </div>
        <div class="text-[11px] text-amber-300/90">${g.desc}</div>
      </div>
    `).join('');

    const tbody = document.getElementById('btcPairsTableBody');
    tbody.innerHTML = Object.keys(SYMBOLS_MAP).map(sym => {
      const item = SYMBOLS_MAP[sym];
      const hasLiveRow = appState.isLiveData && item.price !== null;
      const chg = item.change24h !== null ? item.change24h : 0;
      const btcP = item.btcPair24h !== null ? item.btcPair24h : 0;
      const ethP = item.ethPair24h !== null ? item.ethPair24h : 0;
      const vol = item.volBtc !== null ? item.volBtc : 0;
      const isStrongBtcPair = hasLiveRow && btcP > 0.5 && vol >= 1000;
      const score = hasLiveRow ? ((btcP > 0 ? 3 : 1) + (vol >= 1000 ? 3 : 0) + (item.touches >= 3 ? 2 : 1) + (ethP >= 0 ? 2 : 0)) : 0;

      return `
        <tr class="hover:bg-slate-900/80 transition">
          <td class="py-2.5 px-3 font-extrabold text-white ltr-num">${sym}.P</td>
          <td class="py-2.5 px-3 font-bold text-slate-200 ltr-num">${hasLiveRow ? '$' + fmtPrice(item.price, sym) : '-- (غیرزنده)'}</td>
          <td class="py-2.5 px-3 font-bold ltr-num ${chg >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${hasLiveRow ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '--'}</td>
          <td class="py-2.5 px-3 font-bold ltr-num ${btcP >= 0 ? 'text-cyan-400' : 'text-rose-400'}">${hasLiveRow ? (btcP >= 0 ? '+' : '') + btcP.toFixed(2) + '%' : '--'}</td>
          <td class="py-2.5 px-3 font-bold ltr-num ${ethP >= 0 ? 'text-purple-300' : 'text-slate-400'}">${hasLiveRow ? (ethP >= 0 ? 'قوی‌تر از ETH ✓' : 'ضعیف‌تر از ETH') : '--'}</td>
          <td class="py-2.5 px-3 ltr-num text-slate-300">${hasLiveRow && vol > 0 ? vol.toLocaleString('en-US') + ' BTC' : '--'}</td>
          <td class="py-2.5 px-3 text-amber-300 font-semibold">${item.touches} برخورد</td>
          <td class="py-2.5 px-3">
            <span class="px-2 py-0.5 rounded text-[11px] font-bold ${isStrongBtcPair ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'}">
              ${hasLiveRow ? score + '/10' : 'غیرزنده'}
            </span>
          </td>
          <td class="py-2.5 px-3">
            <button type="button" data-pick-sym="${sym}" class="pick-sym-btn min-h-[38px] px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500 text-amber-300 hover:text-slate-950 font-bold text-[11px] transition">
              بررسی روی چارت
            </button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.pick-sym-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const picked = btn.getAttribute('data-pick-sym');
        switchSymbol(picked);
        switchTab('view-radar');
      });
    });
  }

  // --- TAB 5: CALCULATOR, STAGED PROFIT, EXPECTANCY & JOURNAL ---
  function renderCalculatorFromPlan(plan) {
    if (!plan) return;

    document.getElementById('outRiskDollar').textContent = `$${plan.riskDollar.toFixed(2)}`;
    document.getElementById('outPosSize').textContent = `$${plan.positionSize.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    document.getElementById('outMarginUsed').textContent = `$${plan.margin.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    document.getElementById('outMaxSafeLev').textContent = `${plan.recommendedMaxLeverage}x (سقف مجاز ۲۰x)`;
    document.getElementById('outApproxLiqPrice').textContent = `$${fmtPrice(plan.liqPrice)}`;

    // New Quantitative Metrics: Net R after Fees, Breakeven Win Rate, Expectancy R, Quality
    document.getElementById('outNetR').textContent = `${plan.netRAfterFees}R (خالص پله‌ای) | ${plan.netRR1AfterFees}R (مانع اول)`;
    document.getElementById('outBreakevenWr').textContent = `${plan.breakevenWinRate}% (با کارمزد: ${plan.breakevenWinRateNet}%)`;
    const expEl = document.getElementById('outExpectancyR');
    expEl.textContent = `${plan.expectancyR >= 0 ? '+' : ''}${plan.expectancyR}R در هر ترید`;
    expEl.className = 'text-sm font-black ltr-num mt-0.5 ' + (plan.expectancyR > 0 ? 'text-emerald-400' : 'text-rose-400');

    const qualEl = document.getElementById('outSetupQuality');
    qualEl.textContent = `${plan.quality} (R:R=${plan.rr1})`;
    qualEl.className = 'text-sm font-black mt-0.5 ' +
      (plan.qualityCode === 'NO_TRADE' ? 'text-rose-400' : plan.qualityCode === 'WEAK' ? 'text-amber-400' : 'text-emerald-400');

    // Staged Targets
    document.getElementById('outTp1Price').textContent = `$${fmtPrice(plan.tp1)} (${plan.rr1}R - ${plan.firstObstacleSource})`;
    document.getElementById('outTp1Profit').textContent = `بستن ۳۰٪ حجم (+$${plan.stage1ProfitDollar}) + ریسک‌فری`;

    document.getElementById('outTp2Price').textContent = `$${fmtPrice(plan.tp2)} (${plan.rr2}R - ${plan.secondObstacleSource})`;
    document.getElementById('outTp2Profit').textContent = `بستن ۵۰٪ حجم (+$${plan.stage2ProfitDollar})`;

    document.getElementById('outTp3Price').textContent = `$${fmtPrice(plan.tp3)} (${plan.rr3}R - ${plan.thirdObstacleSource})`;
    document.getElementById('outTp3Profit').textContent = `بستن ۲۰٪ پایانی (+$${plan.stage3ProfitDollar}) | جمع کل خالص: +$${plan.totalStagedNetProfitDollar}`;

    // Warnings & Reasons Box
    const liqWarnEl = document.getElementById('liqBeforeStopWarning');
    if (plan.warnings.length > 0) {
      liqWarnEl.innerHTML = plan.warnings.map(w => `<div>${w}</div>`).join('');
      liqWarnEl.classList.remove('hidden');
    } else {
      liqWarnEl.classList.add('hidden');
    }

    const reasonsEl = document.getElementById('engineReasonsList');
    if (reasonsEl) {
      reasonsEl.innerHTML = plan.reasons.map(r => `<li>• ${r}</li>`).join('');
    }

    document.getElementById('outStreak5Prob').textContent = `${plan.streakProbPct}%`;
    document.getElementById('outDrawdown5').textContent = `-${plan.drawdownAfterKPct}% (${plan.drawdownAfterKPct <= 12 ? 'قابل کنترل' : 'افت سرمایه سنگین ⚠️'})`;
  }

  // --- BACKTESTER UI & EXECUTION (500+ Candles, Long & Short, Conflict Mode, Equity Curve) ---
  function executeAndRenderBacktest() {
    if (!appState.isLiveData || !Array.isArray(appState.candles) || appState.candles.length < 50 || appState.candles[0].isSkeleton) {
      return;
    }
    const sideMode = document.getElementById('btSideSelect') ? document.getElementById('btSideSelect').value : 'both';
    const conflictMode = document.getElementById('btConflictModeSelect') ? document.getElementById('btConflictModeSelect').value : 'conservative';
    const feePct = parseFloat(document.getElementById('calcFeePct').value) || 0.08;
    const slippagePct = parseFloat(document.getElementById('calcSlippagePct').value) || 0.03;
    const decimals = (SYMBOLS_MAP[appState.symbol] || { decimals: 2 }).decimals;

    const bt = root.TCPTradeEngine.runHistoricalBacktest(appState.candles, {
      sideMode,
      feePct,
      slippagePct,
      conflictMode,
      decimals
    });
    appState.lastBacktest = bt;

    document.getElementById('btTotalTrades').textContent = `${bt.totalTrades} (${appState.candles.length} کندل)`;
    document.getElementById('btWinRate').textContent = `${bt.winRate}%`;
    document.getElementById('btAvgR').textContent = `${bt.avgR >= 0 ? '+' : ''}${bt.avgR}R`;
    document.getElementById('btProfitFactor').textContent = `${bt.profitFactor}`;
    document.getElementById('btMaxDrawdown').textContent = `-${bt.maxDrawdownR}R`;
    document.getElementById('btMaxLossStreak').textContent = `${bt.maxLossStreak} باخت`;
    document.getElementById('btNetReturn').textContent = `${bt.netReturnR >= 0 ? '+' : ''}${bt.netReturnR}R`;

    const sampleWarn = document.getElementById('btLowSampleWarning');
    if (sampleWarn) {
      if (bt.lowSampleWarning) {
        sampleWarn.classList.remove('hidden');
      } else {
        sampleWarn.classList.add('hidden');
      }
    }

    drawEquityCurveCanvas('btEquityCanvas', bt.equityCurveR, bt.netReturnR >= 0 ? '#22d3ee' : '#f43f5e');

    // Refresh chart markers so backtest arrows appear on chart
    root.TCPChart.setChartData(
      appState.candles,
      appState.lastAnalysis,
      appState.lastTradePlan,
      bt.signals,
      decimals,
      appState.isLiveData,
      'chartOverlayCanvas'
    );
  }

  // --- JOURNAL RENDERING & OUTCOME LOGGING (Win/Loss/BE + Auto Stop Counter + Equity Curve) ---
  function renderJournal() {
    const list = document.getElementById('journalEntriesList');
    if (!list) return;

    const stats = root.TCPStorage.computeJournalStats(appState.journal);
    document.getElementById('jStatWinRate').textContent = `${stats.winRate}% (${stats.totalClosed} بسته)`;
    document.getElementById('jStatAvgR').textContent = `${stats.avgR >= 0 ? '+' : ''}${stats.avgR}R`;
    document.getElementById('jStatExpectancy').textContent = `${stats.expectancyR >= 0 ? '+' : ''}${stats.expectancyR}R`;
    document.getElementById('jStatMaxDd').textContent = `-${stats.maxDrawdownR}R`;

    drawEquityCurveCanvas('journalEquityCanvas', stats.equityCurveR, stats.netR >= 0 ? '#10b981' : '#f43f5e');

    if (appState.journal.length === 0) {
      list.innerHTML = '<div class="text-slate-500 text-xs p-3 text-center">هنوز معامله‌ای در ژورنال ثبت نشده است.</div>';
      return;
    }

    list.innerHTML = appState.journal.map(j => {
      const outcomeBadge = j.outcome === 'WIN'
        ? '<span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-black">برد (WIN)</span>'
        : j.outcome === 'LOSS'
        ? '<span class="px-2 py-0.5 rounded bg-rose-500/25 text-rose-300 font-black">باخت (LOSS)</span>'
        : j.outcome === 'BE'
        ? '<span class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">سربه‌سر (BE)</span>'
        : '<span class="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold">باز (OPEN)</span>';

      return `
        <div class="p-2.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-1.5">
          <div class="flex flex-wrap items-center justify-between gap-1">
            <div>
              <span class="font-extrabold text-amber-400 ltr-num">${j.symbol}.P (${j.tf})</span>
              <span class="mx-1 px-1.5 py-0.5 rounded text-[10px] font-black ${j.side === 'short' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'}">${(j.side || 'long').toUpperCase()}</span>
              <span class="text-slate-400 text-[11px]">${j.time}</span>
            </div>
            <div class="flex items-center gap-1.5">
              ${outcomeBadge}
              <span class="ltr-num font-black ${Number(j.realizedR) > 0 ? 'text-emerald-400' : Number(j.realizedR) < 0 ? 'text-rose-400' : 'text-slate-300'}">${Number(j.realizedR) > 0 ? '+' : ''}${j.realizedR || 0}R</span>
              <button type="button" data-del-journal="${j.id}" class="del-journal-btn text-slate-500 hover:text-rose-400 px-1.5 font-bold" title="حذف">✕</button>
            </div>
          </div>
          <div class="text-[11px] text-slate-300 ltr-num">
            Entry: $${j.entry} | SL: $${j.stop} | TP1: $${j.tp} | Exit: ${j.exitPrice ? '$' + j.exitPrice : '--'} | Risk: ${j.riskPct}%
          </div>
          ${j.note ? `<div class="text-[11px] text-slate-400 bg-slate-950/70 px-2 py-1 rounded">📝 ${j.note}</div>` : ''}
          <div class="flex flex-wrap items-center gap-1 pt-1">
            <button type="button" data-j-id="${j.id}" data-j-out="WIN" class="j-outcome-btn min-h-[34px] px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-300 font-bold text-[10px]">✓ ثبت برد (+${j.plannedR || 2}R)</button>
            <button type="button" data-j-id="${j.id}" data-j-out="BE" class="j-outcome-btn min-h-[34px] px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 font-bold text-[10px]">= سربه‌سر (0R)</button>
            <button type="button" data-j-id="${j.id}" data-j-out="LOSS" class="j-outcome-btn min-h-[34px] px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 font-bold text-[10px]">✕ ثبت باخت (-1R + استاپ روزانه)</button>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.del-journal-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.getAttribute('data-del-journal'), 10);
        appState.journal = appState.journal.filter(x => x.id !== id);
        root.TCPStorage.saveJournal(appState.journal);
        renderJournal();
      });
    });

    list.querySelectorAll('.j-outcome-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.getAttribute('data-j-id'), 10);
        const out = btn.getAttribute('data-j-out');
        const item = appState.journal.find(x => x.id === id);
        if (!item) return;
        const prevOutcome = item.outcome;
        item.outcome = out;
        if (out === 'WIN') {
          item.realizedR = Number(item.plannedR) || 1.9;
          item.exitPrice = item.tp;
        } else if (out === 'BE') {
          item.realizedR = 0;
          item.exitPrice = item.entry;
        } else if (out === 'LOSS') {
          item.realizedR = -1.0;
          item.exitPrice = item.stop;
          // Auto-increment today's stop counter if not already marked LOSS
          if (prevOutcome !== 'LOSS') {
            appState.todayStopsCount = root.TCPStorage.saveTodayStopsCount(appState.todayStopsCount + 1);
            document.getElementById('todayStopsCountLabel').textContent = appState.todayStopsCount;
            showToast(`⚠️ یک باخت ثبت شد؛ شمارنده استاپ روزانه به ${appState.todayStopsCount} افزایش یافت.`);
            updateAllPanels(true);
          }
        }
        root.TCPStorage.saveJournal(appState.journal);
        renderJournal();
      });
    });
  }

  // --- ALERTS ---
  function checkPriceAlerts(livePrice) {
    if (!appState.isLiveData) return;
    let changed = false;
    appState.alerts.forEach(al => {
      if (!al.triggered && al.symbol === appState.symbol) {
        if (al.direction === 'above' && livePrice >= al.price) {
          al.triggered = true;
          changed = true;
          playSetupPing();
          showToast(`🔔 آلارم صعودی فعال شد: ${al.symbol} از $${al.price} عبور کرد!`);
        } else if (al.direction === 'below' && livePrice <= al.price) {
          al.triggered = true;
          changed = true;
          playSetupPing();
          showToast(`🔔 آلارم نزولی فعال شد: ${al.symbol} به زیر $${al.price} رسید!`);
        }
      }
    });
    if (changed) root.TCPStorage.saveAlerts(appState.alerts);
    renderAlertsList();
  }

  function renderAlertsList() {
    const container = document.getElementById('activeAlertsList');
    if (!container) return;
    if (appState.alerts.length === 0) {
      container.innerHTML = '<div class="text-slate-500">هیچ آلارمی ثبت نشده است.</div>';
      return;
    }
    container.innerHTML = appState.alerts.map(a => `
      <div class="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-slate-900 border ${a.triggered ? 'border-emerald-500/50 text-emerald-300' : 'border-slate-800 text-slate-300'}">
        <span class="ltr-num font-bold">${a.symbol}.P ${a.direction === 'below' ? '≤' : '≥'} $${a.price}</span>
        <div class="flex items-center gap-2">
          <span class="text-[11px]">${a.triggered ? 'عبور انجام شد 🔔' : 'در انتظار عبور...'}</span>
          <button type="button" data-del-alert="${a.id}" class="del-alert-btn text-rose-400 font-bold px-1.5">✕</button>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('.del-alert-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.getAttribute('data-del-alert'), 10);
        appState.alerts = appState.alerts.filter(x => x.id !== id);
        root.TCPStorage.saveAlerts(appState.alerts);
        renderAlertsList();
      });
    });
  }

  // --- DATA FETCHING & WEBSOCKET STREAMING ---
  async function loadSymbolData(symbol, tf) {
    // Reset custom drag overrides when symbol or timeframe changes
    appState.customEntryOverride = null;
    appState.customSlOverride = null;

    const res = await root.TCPData.fetch500PlusCandles(symbol, tf, appState.dataSource);
    if (res.ok && res.candles.length >= 30) {
      appState.usingCachedSnapshot = false;
      appState.fullHistoryCandles = res.candles;
      appState.candles = res.candles.slice();
      setLiveConnectionState(true, `${res.sourceLabel} (${res.candles.length} کندل)`, res.exactTaker);
      root.TCPStorage.saveCachedMarketSnapshot(symbol, tf, res.candles, appState.rawOrderBook);
      executeAndRenderBacktest();
      updateAllPanels(false);
    } else {
      // Offline Fallback: Check if we have a real cached snapshot in localStorage
      const cached = root.TCPStorage.loadCachedMarketSnapshot(symbol, tf);
      setLiveConnectionState(false, 'غیرزنده / آفلاین', false);
      if (cached && Array.isArray(cached.candles) && cached.candles.length > 20) {
        appState.usingCachedSnapshot = true;
        appState.candles = cached.candles;
        appState.fullHistoryCandles = cached.candles.slice();
        const d = (SYMBOLS_MAP[symbol] || { decimals: 2 }).decimals;
        const cachedAnalysis = root.TCPIndicators.analyzeMarketStructure(cached.candles, appState.rsiMode);
        root.TCPChart.setChartData(cached.candles, cachedAnalysis, null, [], d, false, 'chartOverlayCanvas');
      } else {
        appState.usingCachedSnapshot = false;
        const skel = root.TCPData.createVisualSkeletonBars(60);
        appState.candles = skel;
        root.TCPChart.setChartData(skel, null, null, [], 2, false, 'chartOverlayCanvas');
      }
      renderNonLivePlaceholders();
    }

    const obRes = await root.TCPData.fetchOrderBookDepth(symbol, appState.dataSource);
    if (obRes.ok) {
      appState.rawOrderBook = { asks: obRes.asks, bids: obRes.bids };
      if (appState.isLiveData) {
        root.TCPStorage.saveCachedMarketSnapshot(symbol, tf, appState.candles, appState.rawOrderBook);
        updateAllPanels(true);
      }
    }
  }

  function connectLiveWebSocket() {
    if (appState.ws) {
      try { appState.ws.close(); } catch (e) {}
      appState.ws = null;
    }
    const bybitInt = appState.timeframe === '1m' ? '1' : appState.timeframe === '15m' ? '15' : appState.timeframe === '1h' ? '60' : '240';

    try {
      const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
      appState.ws = ws;
      ws.onopen = function () {
        appState.wsConnected = true;
        ws.send(JSON.stringify({ op: 'subscribe', args: [`kline.${bybitInt}.${appState.symbol}`] }));
      };
      ws.onmessage = function (event) {
        if (appState.replayOffset > 0) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.data && msg.data[0]) {
            const k = msg.data[0];
            const o = parseFloat(k.open);
            const h = parseFloat(k.high);
            const l = parseFloat(k.low);
            const cl = parseFloat(k.close);
            const v = parseFloat(k.volume);
            const rng = Math.max(1e-8, h - l);
            const c = {
              time: parseInt(k.start, 10),
              open: o,
              high: h,
              low: l,
              close: cl,
              volume: v,
              takerBuyVol: +(v * (0.35 + ((cl - l) / rng) * 0.35)).toFixed(2)
            };

            if (!Array.isArray(appState.candles) || appState.candles.length === 0 || appState.candles[0].isSkeleton) {
              return;
            }

            const last = appState.candles[appState.candles.length - 1];
            if (last && last.time === c.time) {
              appState.candles[appState.candles.length - 1] = c;
            } else if (last && c.time > last.time) {
              appState.candles.push(c);
              if (appState.candles.length > 650) appState.candles.shift();
            }

            appState.fullHistoryCandles = appState.candles.slice();
            appState.tickCount++;
            document.getElementById('tickCounterText').textContent = `Tick #${appState.tickCount}`;
            setLiveConnectionState(true, `وب‌سوکت زنده Bybit (${appState.candles.length} کندل)`, false);
            updateAllPanels(true);
          }
        } catch (err) {}
      };
      ws.onerror = function () { appState.wsConnected = false; };
      ws.onclose = function () { appState.wsConnected = false; };
    } catch (err) {
      appState.wsConnected = false;
    }
  }

  function updateCandleCountdown() {
    const tfMs = appState.timeframe === '1m' ? 60000 : appState.timeframe === '15m' ? 900000 : appState.timeframe === '1h' ? 3600000 : 14400000;
    const now = Date.now();
    const rem = tfMs - (now % tfMs);
    const totalSec = Math.floor(rem / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    const el = document.getElementById('candleCountdownBadge');
    if (el) {
      el.textContent = `⏳ ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')} تا کلوز`;
    }
  }

  function switchTab(targetId) {
    document.querySelectorAll('.tab-view').forEach(sec => {
      sec.classList.toggle('hidden', sec.id !== targetId);
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const isTarget = btn.getAttribute('data-target') === targetId;
      btn.classList.toggle('active', isTarget);
      btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });
    if (targetId === 'view-radar') {
      root.TCPChart.drawOverlayCanvas('chartOverlayCanvas');
    } else if (targetId === 'view-calculator') {
      renderJournal();
    }
  }

  function switchSymbol(newSym) {
    if (!SYMBOLS_MAP[newSym]) {
      SYMBOLS_MAP[newSym] = { price: null, change24h: null, btcPair24h: null, ethPair24h: null, volBtc: null, touches: 3, decimals: 4 };
    }
    appState.symbol = newSym;
    document.getElementById('symbolSelect').value = newSym;
    appState.replayOffset = 0;
    loadSymbolData(appState.symbol, appState.timeframe);
    connectLiveWebSocket();
    syncTradingViewIframe();
  }

  function setSide(newSide) {
    appState.side = newSide === 'short' ? 'short' : 'long';
    appState.customEntryOverride = null;
    appState.customSlOverride = null;

    document.querySelectorAll('.side-toggle-btn').forEach(btn => {
      const isMatch = btn.getAttribute('data-side') === appState.side;
      btn.classList.toggle('active', isMatch);
    });

    updateAllPanels(false);
    showToast(appState.side === 'long' ? '🟢 جهت موتور روی لانگ (LONG) تنظیم شد' : '🔴 جهت موتور روی شورت (SHORT) تنظیم شد');
  }

  function syncTradingViewIframe() {
    if (appState.chartMode !== 'tv') return;
    const iframe = document.getElementById('tvIframe');
    if (!iframe) return;
    const tvInt = appState.timeframe === '1m' ? '1' : appState.timeframe === '15m' ? '15' : appState.timeframe === '1h' ? '60' : '240';
    const tvSym = `BYBIT:${appState.symbol}.P`;
    const targetUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSym)}&interval=${tvInt}&theme=dark&style=1&timezone=Asia%2FTehran&withdateranges=1&hide_side_toolbar=0&allow_symbol_change=1`;
    if (iframe.getAttribute('data-loaded-url') !== targetUrl) {
      iframe.src = targetUrl;
      iframe.setAttribute('data-loaded-url', targetUrl);
    }
  }

  // --- CALLBACK WHEN USER DRAGS ENTRY OR SL LINE ON CHART ---
  function handleChartLevelDragged(target, newPrice) {
    const info = SYMBOLS_MAP[appState.symbol] || { decimals: 2 };
    const d = info.decimals;
    const rounded = +Number(newPrice).toFixed(d);
    if (target === 'entry') {
      appState.customEntryOverride = rounded;
      document.getElementById('calcEntryPrice').value = rounded;
    } else if (target === 'sl') {
      appState.customSlOverride = rounded;
      document.getElementById('calcStopPrice').value = rounded;
    }
    updateAllPanels(true);
  }

  // --- EVENT BINDINGS ---
  function bindEvents() {
    // Risk Modal
    document.getElementById('acceptRiskModalBtn').addEventListener('click', () => {
      root.TCPStorage.setRiskDisclaimerAccepted();
      document.getElementById('riskDisclaimerModal').classList.add('hidden');
    });

    // Bottom Navigation Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        switchTab(btn.getAttribute('data-target'));
      });
    });

    // Long / Short Side Toggle Buttons (Top Ticket + Calculator)
    document.querySelectorAll('.side-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        setSide(btn.getAttribute('data-side'));
      });
    });

    // Data Source & Symbol Select
    document.getElementById('dataSourceSelect').addEventListener('change', (e) => {
      appState.dataSource = e.target.value;
      loadSymbolData(appState.symbol, appState.timeframe);
      showToast('🌐 در حال بررسی منبع داده انتخابی...');
    });

    document.getElementById('symbolSelect').addEventListener('change', (e) => {
      switchSymbol(e.target.value);
    });

    // Custom Symbol Add
    document.getElementById('addCustomSymbolBtn').addEventListener('click', async () => {
      const inp = document.getElementById('customSymbolInput');
      let raw = (inp.value || '').trim().toUpperCase();
      if (!raw) return;
      if (!raw.endsWith('USDT')) raw += 'USDT';
      showToast(`⏳ در حال اعتبارسنجی نماد ${raw} در صرافی...`);
      const verifiedPrice = await root.TCPData.validateSymbolOnExchange(raw);
      if (!verifiedPrice) {
        showToast(`❌ نماد "${raw}" در صرافی یافت نشد یا نامعتبر است!`);
        return;
      }
      if (!SYMBOLS_MAP[raw]) {
        const dec = verifiedPrice < 1 ? 4 : verifiedPrice < 10 ? 3 : 2;
        SYMBOLS_MAP[raw] = { price: verifiedPrice, change24h: 0.0, btcPair24h: 0.0, ethPair24h: 0.0, volBtc: 1500, touches: 3, decimals: dec };
        const opt = document.createElement('option');
        opt.value = raw;
        opt.textContent = raw + '.P';
        document.getElementById('symbolSelect').appendChild(opt);
      }
      inp.value = '';
      switchSymbol(raw);
      showToast(`✓ نماد معتبر ${raw}.P اضافه شد!`);
    });

    // Timeframe Buttons
    document.querySelectorAll('#tfGroup .tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tfGroup .tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        appState.timeframe = btn.getAttribute('data-tf');
        appState.replayOffset = 0;
        loadSymbolData(appState.symbol, appState.timeframe);
        connectLiveWebSocket();
        syncTradingViewIframe();
      });
    });

    // Chart Mode (Lightweight Charts vs TradingView Widget)
    document.getElementById('modeTcpCanvasBtn').addEventListener('click', (e) => {
      appState.chartMode = 'tcp';
      e.currentTarget.classList.add('active');
      document.getElementById('modeTvWidgetBtn').classList.remove('active');
      document.getElementById('tcpChartWorkspace').classList.remove('hidden');
      document.getElementById('tvWidgetWrapper').classList.add('hidden');
      updateAllPanels(false);
    });
    document.getElementById('modeTvWidgetBtn').addEventListener('click', (e) => {
      appState.chartMode = 'tv';
      e.currentTarget.classList.add('active');
      document.getElementById('modeTcpCanvasBtn').classList.remove('active');
      document.getElementById('tcpChartWorkspace').classList.add('hidden');
      document.getElementById('tvWidgetWrapper').classList.remove('hidden');
      syncTradingViewIframe();
    });

    // Chart Layer & Scale Toggles (saved to localStorage)
    const bindPrefToggle = (btnId, prefKey, labelPrefix) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      const syncBtnText = () => {
        const on = !!appState.chartPrefs[prefKey];
        btn.textContent = `${labelPrefix} ${on ? '✓' : '✕'}`;
        btn.classList.toggle('opacity-60', !on);
      };
      syncBtnText();
      btn.addEventListener('click', () => {
        appState.chartPrefs[prefKey] = !appState.chartPrefs[prefKey];
        if (prefKey === 'logScale' && appState.chartPrefs.logScale) {
          appState.chartPrefs.percentScale = false;
        }
        if (prefKey === 'percentScale' && appState.chartPrefs.percentScale) {
          appState.chartPrefs.logScale = false;
        }
        root.TCPStorage.saveChartPrefs(appState.chartPrefs);
        syncBtnText();
        const otherScaleBtn = document.getElementById(prefKey === 'logScale' ? 'togglePercentScaleBtn' : 'toggleLogScaleBtn');
        if (otherScaleBtn && (prefKey === 'logScale' || prefKey === 'percentScale')) {
          const otherKey = prefKey === 'logScale' ? 'percentScale' : 'logScale';
          const otherPrefix = prefKey === 'logScale' ? 'درصدی (%)' : 'لگاریتمی (Log)';
          otherScaleBtn.textContent = `${otherPrefix} ${appState.chartPrefs[otherKey] ? '✓' : '✕'}`;
        }
        root.TCPChart.applyChartPreferences(appState.chartPrefs, 'chartOverlayCanvas');
      });
    };

    bindPrefToggle('toggleLogScaleBtn', 'logScale', 'لگاریتمی (Log)');
    bindPrefToggle('togglePercentScaleBtn', 'percentScale', 'درصدی (%)');
    bindPrefToggle('toggleSmaBtn', 'showSma', 'SMA 7/25/99');
    bindPrefToggle('toggleSrBtn', 'showSr', 'حمایت/مقاومت');
    bindPrefToggle('toggleFibBtn', 'showFib', 'فیبوناچی');
    bindPrefToggle('toggleVolBtn', 'showVol', 'حجم');
    bindPrefToggle('toggleObWallsBtn', 'showObWalls', 'دیوار اردربوک');
    bindPrefToggle('toggleSignalsBtn', 'showSignals', 'سیگنال‌ها');
    bindPrefToggle('toggleSessionsBtn', 'showSessions', 'سشن‌ها');
    bindPrefToggle('toggleAdxBtn', 'showAdx', 'ADX');

    // Timezone Select (Asia/Tehran vs UTC)
    const tzSelect = document.getElementById('chartTimezoneSelect');
    if (tzSelect) {
      tzSelect.value = appState.chartPrefs.timezone || 'Asia/Tehran';
      tzSelect.addEventListener('change', (e) => {
        appState.chartPrefs.timezone = e.target.value;
        root.TCPStorage.saveChartPrefs(appState.chartPrefs);
        root.TCPChart.applyChartPreferences(appState.chartPrefs, 'chartOverlayCanvas');
      });
    }

    // Scroll to Realtime & Fullscreen API
    document.getElementById('scrollToNowBtn').addEventListener('click', () => {
      root.TCPChart.scrollToRealtime();
    });
    document.getElementById('fullscreenChartBtn').addEventListener('click', () => {
      root.TCPChart.toggleChartFullscreen('chartFullscreenCard');
    });

    // Reset Draggable Levels back to Structural Engine
    document.getElementById('resetStructuralLevelsBtn').addEventListener('click', () => {
      appState.customEntryOverride = null;
      appState.customSlOverride = null;
      updateAllPanels(false);
      showToast('📐 خطوط ورود و استاپ به حالت ساختاری موتور بازنشانی شدند');
    });

    // Manual Refresh from Exchange
    document.getElementById('simulateTickBtn').addEventListener('click', () => {
      loadSymbolData(appState.symbol, appState.timeframe);
      showToast('🔄 درخواست بروزرسانی داده به صرافی ارسال شد');
    });

    // Bar Replay Controls
    document.getElementById('replayBackBtn').addEventListener('click', () => {
      if (appState.fullHistoryCandles.length < 40) return;
      if (appState.replayOffset < appState.fullHistoryCandles.length - 35) {
        appState.replayOffset++;
        appState.candles = appState.fullHistoryCandles.slice(0, appState.fullHistoryCandles.length - appState.replayOffset);
        updateAllPanels(false);
      }
    });
    document.getElementById('replayForwardBtn').addEventListener('click', () => {
      if (appState.replayOffset > 0) {
        appState.replayOffset--;
        appState.candles = appState.fullHistoryCandles.slice(0, appState.fullHistoryCandles.length - appState.replayOffset);
        updateAllPanels(false);
      }
    });
    document.getElementById('replayResetBtn').addEventListener('click', () => {
      appState.replayOffset = 0;
      if (appState.fullHistoryCandles.length > 0) appState.candles = appState.fullHistoryCandles.slice();
      updateAllPanels(false);
      root.TCPChart.scrollToRealtime();
      showToast('🔴 بازگشت به آخرین کندل زنده');
    });

    // One-Tap Copy Order Ticket
    document.getElementById('copyTicketEntryBtn').addEventListener('click', () => {
      copyTextSilently(document.getElementById('ticketEntryVal').textContent.replace(/,/g, ''), 'سطح ورود');
    });
    document.getElementById('copyTicketSlBtn').addEventListener('click', () => {
      copyTextSilently(document.getElementById('ticketSlVal').textContent.replace(/,/g, ''), 'سطح حد ضرر');
    });
    document.getElementById('copyTicketTpBtn').addEventListener('click', () => {
      const plan = appState.lastTradePlan;
      if (plan) copyTextSilently(plan.tp1, 'تارگت اول');
    });
    document.getElementById('copyTicketSizeBtn').addEventListener('click', () => {
      copyTextSilently(document.getElementById('ticketSizeVal').textContent.replace('$', '').replace(/,/g, ''), 'حجم پوزیشن');
    });
    document.getElementById('sendSetupToCalcBtn').addEventListener('click', () => {
      appState.customEntryOverride = null;
      appState.customSlOverride = null;
      updateAllPanels(true);
      switchTab('view-calculator');
    });

    // Backtester Controls
    document.getElementById('runBacktestBtn').addEventListener('click', () => {
      executeAndRenderBacktest();
      showToast('📈 بک‌تست روی ۵۰۰+ کندل اخیر اجرا شد');
    });
    ['btSideSelect', 'btConflictModeSelect'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', executeAndRenderBacktest);
    });

    // RSI Period Select
    document.getElementById('rsiPeriodSelect').addEventListener('change', (e) => {
      appState.rsiMode = e.target.value;
      updateAllPanels(false);
    });

    // Alerts
    document.getElementById('addPriceAlertBtn').addEventListener('click', () => {
      if (!appState.isLiveData) return;
      const val = parseFloat(document.getElementById('alertPriceInput').value);
      if (!val || val <= 0) return;
      const curPrice = appState.candles[appState.candles.length - 1].close;
      const direction = val >= curPrice ? 'above' : 'below';
      appState.alerts.unshift({
        id: Date.now(),
        symbol: appState.symbol,
        price: val,
        direction,
        createdAtPrice: curPrice,
        triggered: false
      });
      document.getElementById('alertPriceInput').value = '';
      root.TCPStorage.saveAlerts(appState.alerts);
      renderAlertsList();
      showToast(`⏰ آلارم ${direction === 'above' ? '≥' : '≤'} $${val} ثبت شد!`);
    });

    document.getElementById('autoSetBreakoutAlertBtn').addEventListener('click', () => {
      if (!appState.isLiveData || !appState.lastTradePlan) return;
      const curPrice = appState.candles[appState.candles.length - 1].close;
      const p = appState.lastTradePlan.entry;
      appState.alerts.unshift({
        id: Date.now(),
        symbol: appState.symbol,
        price: p,
        direction: p >= curPrice ? 'above' : 'below',
        createdAtPrice: curPrice,
        triggered: false
      });
      root.TCPStorage.saveAlerts(appState.alerts);
      renderAlertsList();
      showToast(`⏰ آلارم روی سطح ورود ($${p}) ثبت شد!`);
    });

    // Scan Best Coin
    document.getElementById('scanBestCoinBtn').addEventListener('click', () => {
      let bestSym = 'BTCUSDT';
      let bestScore = -999;
      Object.keys(SYMBOLS_MAP).forEach(sym => {
        const c = SYMBOLS_MAP[sym];
        if (c.price !== null) {
          const s = (c.btcPair24h || 0) * 2 + (c.touches >= 3 ? 3 : 0) + ((c.volBtc || 0) >= 1000 ? 2 : -5);
          if (s > bestScore) {
            bestScore = s;
            bestSym = sym;
          }
        }
      });
      switchSymbol(bestSym);
      playSetupPing();
      showToast(`🎯 نماد منتخب بر اساس قدرت نسبی: ${bestSym}.P`);
    });

    // Audio Toggle
    document.getElementById('toggleAudioAlertBtn').addEventListener('click', (e) => {
      appState.audioEnabled = !appState.audioEnabled;
      e.currentTarget.textContent = appState.audioEnabled ? '🔔 زنگ هشدار: روشن' : '🔕 زنگ هشدار: خاموش';
      if (appState.audioEnabled) playSetupPing();
    });

    // Discipline Gates & Stop Counter
    document.getElementById('incStopCountBtn').addEventListener('click', () => {
      appState.todayStopsCount = root.TCPStorage.saveTodayStopsCount(appState.todayStopsCount + 1);
      document.getElementById('todayStopsCountLabel').textContent = appState.todayStopsCount;
      updateAllPanels(true);
    });
    document.getElementById('decStopCountBtn').addEventListener('click', () => {
      appState.todayStopsCount = root.TCPStorage.saveTodayStopsCount(appState.todayStopsCount - 1);
      document.getElementById('todayStopsCountLabel').textContent = appState.todayStopsCount;
      updateAllPanels(true);
    });
    ['gatePhysicalReady', 'gateNoThreeWaveClimax', 'gateHtfNotRange', 'gateNotCounterTrend', 'psychNoBagHold', 'psychCoinFlipAccept', 'psychNotForcing7Pct'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => updateAllPanels(true));
    });

    // OrderBook Controls
    document.querySelectorAll('#obBucketGroup .bucket-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#obBucketGroup .bucket-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        appState.obBucketMode = parseInt(btn.getAttribute('data-bucket'), 10) || 50;
        updateAllPanels(true);
      });
    });
    document.getElementById('fetchRealObBtn').addEventListener('click', async () => {
      const obRes = await root.TCPData.fetchOrderBookDepth(appState.symbol, appState.dataSource);
      if (obRes.ok) {
        appState.rawOrderBook = { asks: obRes.asks, bids: obRes.bids };
        updateAllPanels(true);
        showToast('✓ عمق بازار صرافی بروزرسانی شد');
      } else {
        showToast('⚠️ عدم دسترسی به API عمق بازار');
      }
    });
    document.getElementById('snapshotObBtn').addEventListener('click', () => {
      const note = document.getElementById('obSnapshotNote');
      const t = new Date().toLocaleTimeString('fa-IR');
      note.textContent = `📸 اسکرین‌شات اردربوک تجمیعی در ساعت ${t} ذخیره شد.`;
      note.classList.remove('hidden');
    });

    // Macro Simulator
    document.querySelectorAll('.macro-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-macro-mode');
        const banner = document.getElementById('macroActionBanner');
        if (mode === 'altseason') {
          appState.macro.btcd = { value: 56.80, change: -0.85, trend: 'نزولی (چرخش نقدینگی به آلت‌کوین‌ها)' };
          appState.macro.usdtd = { value: 4.45, change: -1.42, trend: 'نزولی (ورود استیبل‌کوین به بازار)' };
          appState.macro.total2 = { value: 1.28, unit: 'T$', change: 4.15, trend: 'صعودی (بالای مقاومت)' };
          appState.macro.ethbtc = { value: 0.0375, change: 1.85, trend: 'صعودی (تقویت آلت‌کوین‌ها)' };
          banner.textContent = 'وضعیت شبیه‌ساز کلان: تمرکز روی آلت‌کوین‌های دارای قدرت نسبی به BTC';
        } else if (mode === 'btconly') {
          appState.macro.btcd = { value: 58.95, change: 1.12, trend: 'صعودی (تمرکز نقدینگی روی بیت‌کوین)' };
          appState.macro.usdtd = { value: 4.55, change: -0.65, trend: 'نزولی (ورود نقدینگی به BTC)' };
          appState.macro.total2 = { value: 1.19, unit: 'T$', change: 0.45, trend: 'عملکرد ضعیف‌تر آلت‌کوین‌ها نسبت به بیت' };
          appState.macro.ethbtc = { value: 0.0351, change: -0.90, trend: 'نزولی نسبت به بیت‌کوین' };
          banner.textContent = 'وضعیت شبیه‌ساز کلان: اولویت با جفت‌ارز BTCUSDT.P';
        } else {
          appState.macro.btcd = { value: 58.40, change: 0.65, trend: 'صعودی در ریزش (فشار فروش بیشتر در آلت‌ها)' };
          appState.macro.usdtd = { value: 5.35, change: 2.35, trend: 'صعودی (خروج پول به تتر)' };
          appState.macro.total2 = { value: 1.05, unit: 'T$', change: -4.80, trend: 'شکست حمایت شاخص آلت‌کوین‌ها' };
          appState.macro.ethbtc = { value: 0.0342, change: -2.10, trend: 'ریزش شدیدتر آلت‌کوین‌ها' };
          banner.textContent = 'وضعیت شبیه‌ساز کلان: فشار عرضه (بررسی ستاپ‌های شورت)';
        }
        updateAllPanels(true);
      });
    });

    // Calculator Inputs -> Live Sync with computeTradePlan & Chart Overlay
    ['calcBalance', 'calcRiskPct', 'calcFeePct', 'calcSlippagePct', 'calcLeverage', 'calcWinRate', 'calcTotalTradesN', 'calcStreakK'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => updateAllPanels(true));
    });

    document.getElementById('calcEntryPrice').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (v > 0) {
        appState.customEntryOverride = v;
        updateAllPanels(true);
      }
    });
    document.getElementById('calcStopPrice').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (v > 0) {
        appState.customSlOverride = v;
        updateAllPanels(true);
      }
    });

    document.getElementById('fillFromChartBtn').addEventListener('click', () => {
      appState.customEntryOverride = null;
      appState.customSlOverride = null;
      updateAllPanels(false);
      showToast('🎯 قیمت ورود، حد ضرر و تارگت‌ها به مقادیر ساختاری چارت بازنشانی شدند');
    });

    // Journal Logging
    document.getElementById('logTradeBtn').addEventListener('click', () => {
      const plan = appState.lastTradePlan;
      if (!appState.isLiveData || !plan || plan.isLiqBeforeStop || appState.todayStopsCount >= 2) return;

      const outcomeVal = document.getElementById('journalOutcomeSelect').value; // 'OPEN' | 'WIN' | 'LOSS' | 'BE'
      const exitPriceRaw = parseFloat(document.getElementById('journalExitPriceInput').value);
      const noteText = (document.getElementById('journalNoteInput').value || '').trim();

      let realizedR = 0;
      let exitPrice = null;
      if (outcomeVal === 'WIN') {
        exitPrice = exitPriceRaw > 0 ? exitPriceRaw : plan.tp1;
        const stopDist = Math.max(1e-8, Math.abs(plan.entry - plan.sl));
        realizedR = exitPriceRaw > 0 ? +((Math.abs(exitPrice - plan.entry) / stopDist) - plan.feeDragR).toFixed(2) : plan.netRR1AfterFees;
      } else if (outcomeVal === 'LOSS') {
        exitPrice = exitPriceRaw > 0 ? exitPriceRaw : plan.sl;
        realizedR = -1.0;
        appState.todayStopsCount = root.TCPStorage.saveTodayStopsCount(appState.todayStopsCount + 1);
        document.getElementById('todayStopsCountLabel').textContent = appState.todayStopsCount;
      } else if (outcomeVal === 'BE') {
        exitPrice = plan.entry;
        realizedR = 0;
      }

      const newEntry = {
        id: Date.now(),
        time: new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }),
        symbol: appState.symbol,
        tf: appState.timeframe,
        side: plan.side,
        type: document.getElementById('journalOrderType').value,
        entry: plan.entry,
        stop: plan.sl,
        tp: plan.tp1,
        exitPrice,
        plannedR: plan.netRR1AfterFees,
        realizedR,
        outcome: outcomeVal,
        riskPct: plan.riskPct,
        score: document.getElementById('checklistTotalScore').textContent.trim(),
        mood: document.getElementById('journalMood').value,
        note: noteText
      };

      appState.journal.unshift(newEntry);
      root.TCPStorage.saveJournal(appState.journal);
      document.getElementById('journalNoteInput').value = '';
      document.getElementById('journalExitPriceInput').value = '';
      renderJournal();
      updateAllPanels(true);
      showToast('📓 پوزیشن در ژورنال معاملاتی ثبت شد');
    });

    // CSV & JSON Export/Import
    document.getElementById('exportJournalCsvBtn').addEventListener('click', () => {
      const headers = ['Time,Symbol,Timeframe,Side,OrderType,Entry,StopLoss,Target1,ExitPrice,Outcome,RealizedR,RiskPct,ChecklistScore,Mood,Note'];
      const rows = appState.journal.map(j =>
        `"${j.time}","${j.symbol}","${j.tf}","${j.side || 'long'}","${j.type}",${j.entry},${j.stop},${j.tp},${j.exitPrice || ''},"${j.outcome || 'OPEN'}",${j.realizedR || 0},${j.riskPct},"${j.score}","${j.mood}","${(j.note || '').replace(/"/g, '""')}"`
      );
      const csvContent = '\uFEFF' + headers.concat(rows).join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'TCP_Trade_Journal.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    document.getElementById('exportBackupJsonBtn').addEventListener('click', () => {
      const payload = {
        schemaVersion: '2.0.0',
        exportedAt: new Date().toISOString(),
        todayStopsCount: appState.todayStopsCount,
        chartPrefs: appState.chartPrefs,
        journal: appState.journal,
        alerts: appState.alerts
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tcp_radar_backup_v2.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('💾 فایل پشتیبان JSON دانلود شد');
    });

    document.getElementById('importBackupJsonInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data || !data.schemaVersion) {
            showToast('❌ فرمت فایل پشتیبان نامعتبر است');
            return;
          }
          if (Array.isArray(data.journal)) {
            appState.journal = data.journal;
            root.TCPStorage.saveJournal(appState.journal);
          }
          if (Array.isArray(data.alerts)) {
            appState.alerts = data.alerts;
            root.TCPStorage.saveAlerts(appState.alerts);
          }
          if (typeof data.todayStopsCount === 'number') {
            appState.todayStopsCount = root.TCPStorage.saveTodayStopsCount(data.todayStopsCount);
            document.getElementById('todayStopsCountLabel').textContent = appState.todayStopsCount;
          }
          renderJournal();
          renderAlertsList();
          updateAllPanels(true);
          showToast('✓ پشتیبان JSON با موفقیت بازیابی شد');
        } catch (err) {
          showToast('❌ خطا در خواندن فایل JSON');
        }
      };
      reader.readAsText(file);
    });

    // GitHub Modal
    const modal = document.getElementById('githubModal');
    document.getElementById('openGithubModalBtn').addEventListener('click', () => modal.classList.remove('hidden'));
    document.getElementById('closeGithubModalBtn').addEventListener('click', () => modal.classList.add('hidden'));

    document.getElementById('copyHtmlCodeBtn').addEventListener('click', () => {
      const fullHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      copyTextSilently(fullHtml, 'کل کد HTML');
    });
    document.getElementById('downloadHtmlFileBtn').addEventListener('click', () => {
      const fullHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'index.html';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // --- BOOTSTRAP APPLICATION ---
  window.addEventListener('load', async () => {
    // 1. Run Console Unit Tests for Quantitative Engine
    root.TCPTradeEngine.runTradeEngineUnitTests();

    // 2. Load Persisted State
    if (!root.TCPStorage.isRiskDisclaimerAccepted()) {
      document.getElementById('riskDisclaimerModal').classList.remove('hidden');
    }
    appState.todayStopsCount = root.TCPStorage.loadTodayStopsCount();
    document.getElementById('todayStopsCountLabel').textContent = appState.todayStopsCount;
    appState.journal = root.TCPStorage.loadJournal();
    appState.alerts = root.TCPStorage.loadAlerts();
    appState.chartPrefs = root.TCPStorage.loadChartPrefs();

    // 3. Initialize Interactive Lightweight Charts
    root.TCPChart.initCharts(
      'lwcMainContainer',
      'lwcRsiContainer',
      'chartOverlayCanvas',
      appState.chartPrefs,
      handleChartLevelDragged
    );

    bindEvents();
    renderAlertsList();
    renderJournal();
    updateCandleCountdown();

    // Register Service Worker
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    // 4. Fetch Live Exchange Data (500+ candles, tickers, orderbook, macro)
    await loadSymbolData(appState.symbol, appState.timeframe);
    root.TCPData.fetchMultiExchangeTickers(SYMBOLS_MAP, appState.dataSource).then((ok) => {
      if (ok && SYMBOLS_MAP.ETHUSDT.price && SYMBOLS_MAP.BTCUSDT.price) {
        appState.macro.ethbtc.value = +(SYMBOLS_MAP.ETHUSDT.price / SYMBOLS_MAP.BTCUSDT.price).toFixed(5);
      }
      renderMacroAndBtcPairs();
    });
    root.TCPData.fetchMacroDominance().then((m) => {
      if (m.ok) {
        if (m.btcd) appState.macro.btcd.value = m.btcd;
        if (m.usdtd) appState.macro.usdtd.value = m.usdtd;
        if (m.total2T) appState.macro.total2.value = m.total2T;
        renderMacroAndBtcPairs();
      }
    });
    connectLiveWebSocket();

    if (appState.countdownTimer) clearInterval(appState.countdownTimer);
    appState.countdownTimer = setInterval(updateCandleCountdown, 1000);

    // REST Polling fallback when WebSocket is disconnected (Never generates fake ticks!)
    if (appState.pollTimer) clearInterval(appState.pollTimer);
    appState.pollTimer = setInterval(() => {
      if (!appState.wsConnected && appState.replayOffset === 0) {
        loadSymbolData(appState.symbol, appState.timeframe);
      }
    }, 15000);
  });
})(typeof window !== 'undefined' ? window : globalThis);
