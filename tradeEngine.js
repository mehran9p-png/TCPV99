/**
 * TCP Radar — Unified Quantitative & Risk-to-Reward Engine (tradeEngine.js)
 * Single source of truth for Entry, SL, TP1, TP2, TP3, R:R to first real obstacle,
 * Position Size, Margin, Liquidation Price, Staged Profit Taking, Expectancy,
 * Multi-Candle Backtester (Long & Short), and Built-in Unit Tests.
 */
(function (root) {
  'use strict';

  /**
   * Exact Markov Chain Dynamic Programming for Losing Streak Probability
   * Probability of at least k consecutive losses in n independent trades
   */
  function calcExactMarkovStreakProb(n, k, lossP) {
    if (k <= 0) return 100;
    if (n < k || lossP <= 0) return 0;
    if (lossP >= 1) return 100;
    const winP = 1 - lossP;
    let dp = new Array(k + 1).fill(0);
    dp[0] = 1.0;
    for (let step = 0; step < n; step++) {
      const nxt = new Array(k + 1).fill(0);
      nxt[k] += dp[k];
      for (let r = 0; r < k; r++) {
        nxt[0] += dp[r] * winP;
        nxt[r + 1] += dp[r] * lossP;
      }
      dp = nxt;
    }
    return dp[k] * 100;
  }

  /**
   * Aggregate raw order book into price buckets around reference price
   */
  function aggregateOrderBookWalls(orderBook, refPrice, bucketStepPct = 0.0025) {
    const rawAsks = (orderBook && Array.isArray(orderBook.asks)) ? orderBook.asks : [];
    const rawBids = (orderBook && Array.isArray(orderBook.bids)) ? orderBook.bids : [];
    const asks = [];
    const bids = [];

    if (!refPrice || refPrice <= 0) {
      return { asks: [], bids: [], hasLiveBook: false };
    }

    const hasLiveBook = rawAsks.length > 2 && rawBids.length > 2;
    if (!hasLiveBook) {
      return { asks: [], bids: [], hasLiveBook: false };
    }

    for (let b = 1; b <= 6; b++) {
      const askLow = refPrice * (1 + bucketStepPct * (b - 1));
      const askHigh = refPrice * (1 + bucketStepPct * b);
      let askCoins = 0;
      let weightedAskSum = 0;
      rawAsks.forEach(item => {
        const p = Number(item[0]);
        const q = Number(item[1]);
        if (p >= askLow && p <= askHigh && q > 0) {
          askCoins += q;
          weightedAskSum += p * q;
        }
      });
      const askPrice = askCoins > 0 ? weightedAskSum / askCoins : askHigh;
      const askUsdM = +((askCoins * askPrice) / 1e6).toFixed(3);
      asks.push({
        bucketIndex: b,
        price: askPrice,
        lowBound: askLow,
        highBound: askHigh,
        sizeCoins: +askCoins.toFixed(3),
        usdM: askUsdM
      });

      const bidHigh = refPrice * (1 - bucketStepPct * (b - 1));
      const bidLow = refPrice * (1 - bucketStepPct * b);
      let bidCoins = 0;
      let weightedBidSum = 0;
      rawBids.forEach(item => {
        const p = Number(item[0]);
        const q = Number(item[1]);
        if (p <= bidHigh && p >= bidLow && q > 0) {
          bidCoins += q;
          weightedBidSum += p * q;
        }
      });
      const bidPrice = bidCoins > 0 ? weightedBidSum / bidCoins : bidLow;
      const bidUsdM = +((bidCoins * bidPrice) / 1e6).toFixed(3);
      bids.push({
        bucketIndex: b,
        price: bidPrice,
        lowBound: bidLow,
        highBound: bidHigh,
        sizeCoins: +bidCoins.toFixed(3),
        usdM: bidUsdM
      });
    }

    // Compute average wall size to mark heavy walls
    const avgAskM = asks.reduce((s, x) => s + x.usdM, 0) / Math.max(1, asks.length);
    const avgBidM = bids.reduce((s, x) => s + x.usdM, 0) / Math.max(1, bids.length);

    asks.forEach(a => {
      a.isHeavyWall = a.usdM > 0 && a.usdM >= avgAskM * 1.25;
      a.weightRatio = avgAskM > 0 ? +(a.usdM / avgAskM).toFixed(2) : 1;
    });
    bids.forEach(b => {
      b.isHeavyWall = b.usdM > 0 && b.usdM >= avgBidM * 1.25;
      b.weightRatio = avgBidM > 0 ? +(b.usdM / avgBidM).toFixed(2) : 1;
    });

    return { asks, bids, hasLiveBook: true, avgAskM, avgBidM };
  }

  /**
   * SINGLE SOURCE OF TRUTH: computeTradePlan(side, candles, orderBook, params)
   * Used identically by Top Ticket, Chart Overlay, OrderBook Tab, Calculator, and Journal.
   *
   * @param {'long'|'short'} side
   * @param {Array} candles
   * @param {Object} orderBook - {asks: [[price, qty], ...], bids: [[price, qty], ...]}
   * @param {Object} params - {
   *   balance: number,
   *   riskPct: number,
   *   feePct: number,       // round-trip exchange fee %, e.g. 0.08
   *   slippagePct: number,  // estimated slippage %, e.g. 0.03
   *   leverage: number,     // default 10
   *   winRatePct: number,   // user or backtest win-rate %, e.g. 52
   *   totalTradesN: number, // for streak math, default 100
   *   streakK: number,      // for streak math, default 5
   *   customEntry: number|null,
   *   customSl: number|null,
   *   customTp1: number|null,
   *   customTp2: number|null,
   *   customTp3: number|null,
   *   decimals: number
   * }
   */
  function computeTradePlan(side = 'long', candles = [], orderBook = null, params = {}) {
    const cleanSide = (String(side).toLowerCase() === 'short') ? 'short' : 'long';
    const isLong = cleanSide === 'long';
    const balance = Math.max(1, Number(params.balance) || 1000);
    const riskPct = Math.max(0.05, Number(params.riskPct) || 1.0);
    const feePct = Math.max(0, params.feePct !== undefined ? Number(params.feePct) : 0.08);
    const slippagePct = Math.max(0, params.slippagePct !== undefined ? Number(params.slippagePct) : 0.03);
    const leverage = Math.max(1, Number(params.leverage) || 10);
    const winRatePct = Math.min(99, Math.max(1, Number(params.winRatePct) || 50));
    const totalTradesN = Math.min(2000, Math.max(10, parseInt(params.totalTradesN, 10) || 100));
    const streakK = Math.min(30, Math.max(2, parseInt(params.streakK, 10) || 5));
    const decimals = params.decimals !== undefined ? Number(params.decimals) : 2;
    const bucketStepPct = Number(params.bucketStepPct) || 0.0025;

    const reasons = [];
    const warnings = [];

    const hasCandles = Array.isArray(candles) && candles.length >= 15;
    let currentPrice = Number(params.fallbackPrice) || 0;
    let atr = Number(params.fallbackAtr) || 0;
    let structure = null;

    if (hasCandles && root.TCPIndicators) {
      structure = root.TCPIndicators.analyzeMarketStructure(candles, params.rsiMode || 'auto');
      currentPrice = candles[candles.length - 1].close;
      atr = structure.currentAtr;
    } else if (Array.isArray(candles) && candles.length > 0) {
      currentPrice = candles[candles.length - 1].close;
      atr = Math.max(currentPrice * 0.005, (candles[candles.length - 1].high - candles[candles.length - 1].low));
    }

    if (atr <= 0 && currentPrice > 0) {
      atr = currentPrice * 0.006;
    }

    // Aggregate order book walls if available
    const obAgg = aggregateOrderBookWalls(orderBook, currentPrice, bucketStepPct);

    // 1. Determine Structural Entry & Stop-Loss (unless overridden by user drag/input)
    let entry = 0;
    let sl = 0;
    let structuralEntry = 0;
    let structuralSl = 0;

    if (isLong) {
      // Long: Entry = Breakout level top + 0.1 * ATR(14)
      const breakoutTop = structure ? structure.majorResistance : (currentPrice + atr * 0.5);
      structuralEntry = breakoutTop + 0.1 * atr;

      // If orderBook has a near ask wall around breakoutTop, clear it slightly
      if (obAgg.hasLiveBook && obAgg.asks.length > 0) {
        const nearWall = obAgg.asks.find(a => a.isHeavyWall && Math.abs(a.price - structuralEntry) <= atr * 0.6);
        if (nearWall && nearWall.price >= structuralEntry) {
          structuralEntry = nearWall.price + 0.08 * atr;
          reasons.push(`نقطه ورود لانگ (Stop-Buy) بالای سقف شکست و پشت دیوار فروش اردربوک ($${nearWall.price.toFixed(decimals)}) تنظیم شد.`);
        }
      }

      // Long SL = Lowest valid prior pivot low - 0.25 * ATR(14)
      const pivotLow = structure ? structure.majorSupport : (currentPrice - atr * 1.1);
      structuralSl = pivotLow - 0.25 * atr;
    } else {
      // Short: Entry = Breakdown level bottom - 0.1 * ATR(14)
      const breakdownBottom = structure ? structure.majorSupport : (currentPrice - atr * 0.5);
      structuralEntry = breakdownBottom - 0.1 * atr;

      if (obAgg.hasLiveBook && obAgg.bids.length > 0) {
        const nearWall = obAgg.bids.find(b => b.isHeavyWall && Math.abs(b.price - structuralEntry) <= atr * 0.6);
        if (nearWall && nearWall.price <= structuralEntry) {
          structuralEntry = nearWall.price - 0.08 * atr;
          reasons.push(`نقطه ورود شورت (Stop-Sell) زیر کف شکست و پشت دیوار تقاضای اردربوک ($${nearWall.price.toFixed(decimals)}) تنظیم شد.`);
        }
      }

      // Short SL = Highest valid prior pivot high + 0.25 * ATR(14)
      const pivotHigh = structure ? structure.majorResistance : (currentPrice + atr * 1.1);
      structuralSl = pivotHigh + 0.25 * atr;
    }

    // Apply min/max ATR stop distance constraints on structural SL
    let rawStopDist = Math.abs(structuralEntry - structuralSl);
    const minStopDist = 0.8 * atr;
    const maxStopDist = 3.0 * atr;

    if (atr > 0 && rawStopDist < minStopDist) {
      rawStopDist = minStopDist;
      structuralSl = isLong ? (structuralEntry - minStopDist) : (structuralEntry + minStopDist);
      reasons.push('فاصله استاپ ساختاری کمتر از ۰.۸×ATR بود؛ برای جلوگیری از نویز به ۰.۸×ATR افزایش یافت.');
    } else if (atr > 0 && rawStopDist > maxStopDist) {
      warnings.push(`⚠️ استاپ خیلی دور: فاصله حد ضرر ساختاری (${(rawStopDist / atr).toFixed(2)}×ATR) بیشتر از سقف مجاز ۳×ATR است.`);
    }

    // Check custom overrides (from Calculator inputs or Chart Dragging)
    const hasCustomEntry = Number(params.customEntry) > 0;
    const hasCustomSl = Number(params.customSl) > 0;

    entry = hasCustomEntry ? Number(params.customEntry) : structuralEntry;
    sl = hasCustomSl ? Number(params.customSl) : structuralSl;

    // Validate directional consistency between Entry and SL for chosen side
    if (isLong && sl >= entry) {
      sl = entry - Math.max(minStopDist || entry * 0.005, entry * 0.004);
      warnings.push('در پوزیشن لانگ، حد ضرر باید پایین‌تر از قیمت ورود باشد (به‌صورت خودکار اصلاح شد).');
    } else if (!isLong && sl <= entry) {
      sl = entry + Math.max(minStopDist || entry * 0.005, entry * 0.004);
      warnings.push('در پوزیشن شورت، حد ضرر باید بالاتر از قیمت ورود باشد (به‌صورت خودکار اصلاح شد).');
    }

    const stopDist = Math.max(1e-8, Math.abs(entry - sl));
    const stopDistAtr = atr > 0 ? +(stopDist / atr).toFixed(2) : 1.0;

    if (hasCustomEntry || hasCustomSl) {
      if (atr > 0 && stopDist < 0.8 * atr) {
        warnings.push(`⚠️ فاصله استاپ دستی (${stopDistAtr}×ATR) کمتر از ۰.۸×ATR است و احتمال فعال شدن با نویز بالاست.`);
      } else if (atr > 0 && stopDist > 3.0 * atr) {
        warnings.push(`⚠️ استاپ خیلی دور: فاصله استاپ دستی (${stopDistAtr}×ATR) بیش از ۳×ATR است.`);
      }
    }

    // 2. Identify Real Obstacles for TP1, TP2, TP3 (Opposing Pivots, SMA99, Heavy OrderBook Walls)
    const obstacles = [];
    const frontRunBuffer = 0.08 * (atr || stopDist * 0.25);

    if (isLong) {
      // Candidate obstacles above entry
      if (structure) {
        // Opposing swing highs above entry
        structure.swingHighs.forEach(sh => {
          if (sh.price > entry + stopDist * 0.35) {
            obstacles.push({ price: sh.price - frontRunBuffer, rawLevel: sh.price, source: 'سقف پیوت ساختاری' });
          }
        });
        if (structure.farResistance > entry + stopDist * 0.35) {
          obstacles.push({ price: structure.farResistance - frontRunBuffer, rawLevel: structure.farResistance, source: 'مقاومت ماژور پیوت' });
        }
        // SMA99 if it is above entry acting as dynamic resistance
        if (structure.s99 > entry + stopDist * 0.4) {
          obstacles.push({ price: structure.s99 - frontRunBuffer, rawLevel: structure.s99, source: 'میانگین متحرک SMA 99' });
        }
        // Fibonacci extensions
        if (structure.fibLevels && structure.fibLevels.ext1272 > entry + stopDist * 0.5) {
          obstacles.push({ price: structure.fibLevels.ext1272 - frontRunBuffer, rawLevel: structure.fibLevels.ext1272, source: 'اکستنشن فیبو ۱.۲۷۲' });
        }
        if (structure.fibLevels && structure.fibLevels.ext1618 > entry + stopDist * 0.8) {
          obstacles.push({ price: structure.fibLevels.ext1618 - frontRunBuffer, rawLevel: structure.fibLevels.ext1618, source: 'اکستنشن فیبو ۱.۶۱۸' });
        }
      }
      if (obAgg.hasLiveBook) {
        obAgg.asks.forEach(a => {
          if (a.isHeavyWall && a.price > entry + stopDist * 0.35) {
            obstacles.push({ price: a.price - frontRunBuffer, rawLevel: a.price, source: `دیوار فروش اردربوک (${a.usdM}M$)` });
          }
        });
      }
      obstacles.sort((a, b) => a.price - b.price);
    } else {
      // Short: Candidate obstacles below entry
      if (structure) {
        structure.swingLows.forEach(slw => {
          if (slw.price < entry - stopDist * 0.35) {
            obstacles.push({ price: slw.price + frontRunBuffer, rawLevel: slw.price, source: 'کف پیوت ساختاری' });
          }
        });
        if (structure.farSupport < entry - stopDist * 0.35) {
          obstacles.push({ price: structure.farSupport + frontRunBuffer, rawLevel: structure.farSupport, source: 'حمایت ماژور پیوت' });
        }
        if (structure.s99 < entry - stopDist * 0.4) {
          obstacles.push({ price: structure.s99 + frontRunBuffer, rawLevel: structure.s99, source: 'میانگین متحرک SMA 99' });
        }
        if (structure.fibLevels && structure.fibLevels.ext1272 < entry - stopDist * 0.5) {
          obstacles.push({ price: structure.fibLevels.ext1272 + frontRunBuffer, rawLevel: structure.fibLevels.ext1272, source: 'اکستنشن فیبو ۱.۲۷۲' });
        }
        if (structure.fibLevels && structure.fibLevels.ext1618 < entry - stopDist * 0.8) {
          obstacles.push({ price: structure.fibLevels.ext1618 + frontRunBuffer, rawLevel: structure.fibLevels.ext1618, source: 'اکستنشن فیبو ۱.۶۱۸' });
        }
      }
      if (obAgg.hasLiveBook) {
        obAgg.bids.forEach(b => {
          if (b.isHeavyWall && b.price < entry - stopDist * 0.35) {
            obstacles.push({ price: b.price + frontRunBuffer, rawLevel: b.price, source: `دیوار تقاضای اردربوک (${b.usdM}M$)` });
          }
        });
      }
      obstacles.sort((a, b) => b.price - a.price);
    }

    // Deduplicate obstacles that are too close (< 0.35 * stopDist apart)
    const distinctObstacles = [];
    obstacles.forEach(ob => {
      if (distinctObstacles.length === 0) {
        distinctObstacles.push(ob);
      } else {
        const prevOb = distinctObstacles[distinctObstacles.length - 1];
        if (Math.abs(ob.price - prevOb.price) >= stopDist * 0.35) {
          distinctObstacles.push(ob);
        }
      }
    });

    // Assign TP1, TP2, TP3 based on real structural obstacles (or custom overrides)
    const firstObstacle = distinctObstacles[0] || {
      price: isLong ? (entry + stopDist * 1.8) : (entry - stopDist * 1.8),
      rawLevel: isLong ? (entry + stopDist * 1.85) : (entry - stopDist * 1.85),
      source: 'اکستنشن ساختاری موج'
    };
    const secondObstacle = distinctObstacles[1] || {
      price: isLong ? Math.max(firstObstacle.price + stopDist * 0.8, entry + stopDist * 2.4) : Math.min(firstObstacle.price - stopDist * 0.8, entry - stopDist * 2.4),
      rawLevel: isLong ? (entry + stopDist * 2.45) : (entry - stopDist * 2.45),
      source: 'مقاومت/حمایت موج بزرگ‌تر'
    };
    const thirdObstacle = distinctObstacles[2] || {
      price: isLong ? Math.max(secondObstacle.price + stopDist * 1.1, entry + stopDist * 3.5) : Math.min(secondObstacle.price - stopDist * 1.1, entry - stopDist * 3.5),
      rawLevel: isLong ? (entry + stopDist * 3.55) : (entry - stopDist * 3.55),
      source: 'تارگت نهایی سایکل (تریل استاپ)'
    };

    const tp1 = Number(params.customTp1) > 0 ? Number(params.customTp1) : firstObstacle.price;
    const tp2 = Number(params.customTp2) > 0 ? Number(params.customTp2) : secondObstacle.price;
    const tp3 = Number(params.customTp3) > 0 ? Number(params.customTp3) : thirdObstacle.price;

    // 3. Calculate Gross R:R to TP1 (First Obstacle), TP2, TP3
    const rr1 = +(Math.abs(tp1 - entry) / stopDist).toFixed(2);
    const rr2 = +(Math.abs(tp2 - entry) / stopDist).toFixed(2);
    const rr3 = +(Math.abs(tp3 - entry) / stopDist).toFixed(2);

    reasons.push(`اولین مانع واقعی (${firstObstacle.source}) در $${tp1.toFixed(decimals)} قرار دارد (R:R تا مانع اول = ${rr1}).`);

    // 4. Financial & Position Sizing Math
    const riskDollar = +(balance * (riskPct / 100)).toFixed(2);
    const stopDistPct = (stopDist / Math.max(1e-8, entry)) * 100; // in %
    const totalFrictionPct = feePct + slippagePct; // round-trip fee % + slippage %
    const effectiveLossPct = stopDistPct + totalFrictionPct;

    // Position Size (USDT Notional) = RiskDollar / (StopDist% + Fee% + Slippage%)
    const positionSize = +(riskDollar / (effectiveLossPct / 100)).toFixed(2);
    const margin = +(positionSize / leverage).toFixed(2);

    // Friction in R units: how much R is eaten by round-trip fees + slippage
    const feeDragR = +(totalFrictionPct / Math.max(1e-8, stopDistPct)).toFixed(3);

    // Net R for a single target exit at TP1 or TP2 after fees:
    const netRR1 = +Math.max(0, rr1 - feeDragR).toFixed(2);
    const netRR2 = +Math.max(0, rr2 - feeDragR).toFixed(2);
    const netRR3 = +Math.max(0, rr3 - feeDragR).toFixed(2);

    // Staged Take-Profit Calculation:
    // Stage 1: Close 30% at TP1 (rr1)
    // Stage 2: Close 50% at TP2 (rr2)
    // Stage 3: Close remaining 20% at TP3 (rr3)
    const w1 = params.stage1Weight !== undefined ? Number(params.stage1Weight) : 0.30;
    const w2 = params.stage2Weight !== undefined ? Number(params.stage2Weight) : 0.50;
    const w3 = Math.max(0, +(1 - w1 - w2).toFixed(2));

    const grossStagedR = +(w1 * rr1 + w2 * rr2 + w3 * rr3).toFixed(2);
    // If single target is specified (e.g., in unit test or single-TP mode), use single TP net R;
    // Also provide both single-target Net R at TP1 and Staged Net R
    const useSingleTarget = !!params.singleTargetMode;
    const primaryGrossR = useSingleTarget ? rr1 : rr1; // R:R is ALWAYS evaluated to the first obstacle per spec!
    const netRAfterFees = useSingleTarget
      ? +((rr1 * stopDistPct - totalFrictionPct) / (stopDistPct + totalFrictionPct)).toFixed(3)
      : +((grossStagedR * stopDistPct - totalFrictionPct) / (stopDistPct + totalFrictionPct)).toFixed(3);

    const netRR1AfterFees = +((rr1 * stopDistPct - totalFrictionPct) / (stopDistPct + totalFrictionPct)).toFixed(3);

    // Dollar profits at each stage (accounting for position size & friction)
    const stage1ProfitDollar = +((positionSize * w1) * ((Math.abs(tp1 - entry) / entry) - (totalFrictionPct / 100))).toFixed(2);
    const stage2ProfitDollar = +((positionSize * w2) * ((Math.abs(tp2 - entry) / entry) - (totalFrictionPct / 100))).toFixed(2);
    const stage3ProfitDollar = +((positionSize * w3) * ((Math.abs(tp3 - entry) / entry) - (totalFrictionPct / 100))).toFixed(2);
    const totalStagedNetProfitDollar = +(stage1ProfitDollar + stage2ProfitDollar + stage3ProfitDollar).toFixed(2);

    // Breakeven Win Rate = 1 / (1 + R) where R is R:R to first obstacle (or net R)
    const breakevenWinRate = primaryGrossR > 0 ? +((1 / (1 + primaryGrossR)) * 100).toFixed(2) : 100;
    const breakevenWinRateNet = netRR1AfterFees > 0 ? +((1 / (1 + netRR1AfterFees)) * 100).toFixed(2) : 100;

    // Expectancy (in R) = p * R_net - (1 - p) * 1
    const pWin = winRatePct / 100;
    const effectiveWinR = useSingleTarget ? netRR1AfterFees : netRAfterFees;
    const expectancyR = +((pWin * effectiveWinR) - (1 - pWin) * 1.0).toFixed(3);

    // 5. Isolated Liquidation Price & Leverage Safety
    const mmrBuffer = 0.005; // 0.5% Maintenance Margin Rate
    const liqDistRatio = Math.max(0.001, (1 / leverage) - mmrBuffer - (feePct / 100));
    const liqPrice = isLong
      ? +(entry * (1 - liqDistRatio)).toFixed(decimals)
      : +(entry * (1 + liqDistRatio)).toFixed(decimals);

    const isLiqBeforeStop = isLong ? (liqPrice >= sl) : (liqPrice <= sl);
    // Max safe leverage capped at 10x default recommendation, hard ceiling 20x
    const rawSafeLev = Math.max(1, Math.floor(0.65 / ((stopDistPct / 100) + mmrBuffer)));
    const recommendedMaxLeverage = Math.min(10, rawSafeLev);
    const hardCapLeverage = Math.min(20, rawSafeLev);

    if (leverage > 10) {
      warnings.push(`⚠️ اهرم انتخابی (${leverage}x) بالاتر از سقف پیشنهادی ۱۰x است.`);
    }
    if (isLiqBeforeStop) {
      warnings.push(`🛑 خطر لیکوئید شدن قبل از استاپ! قیمت لیکوئید ایزوله ($${liqPrice}) قبل از رسیدن به حد ضرر ($${sl.toFixed(decimals)}) فعال می‌شود. ثبت ژورنال و کپی تیکت قفل شد.`);
    }

    // 6. Trade Quality Classification based on R:R to First Obstacle (rr1)
    let quality = 'NO TRADE';
    let qualityCode = 'NO_TRADE';
    if (isLiqBeforeStop) {
      quality = 'NO TRADE (خطر لیکوئید قبل از استاپ)';
      qualityCode = 'NO_TRADE';
      reasons.push('به دلیل قرار گرفتن قیمت لیکوئید قبل از حد ضرر، ستاپ نامعتبر (NO TRADE) است.');
    } else if (atr > 0 && stopDist > 3.0 * atr) {
      quality = 'NO TRADE (استاپ خیلی دور > 3×ATR)';
      qualityCode = 'NO_TRADE';
      reasons.push(`فاصله استاپ (${stopDistAtr}×ATR) بیشتر از سقف مجاز ۳×ATR است.`);
    } else if (rr1 < 1.5) {
      quality = 'NO TRADE';
      qualityCode = 'NO_TRADE';
      reasons.push(`نسبت R:R تا اولین مانع واقعی (${rr1}) کمتر از حداقل مجاز ۱.۵ است (مانع ${firstObstacle.source} خیلی نزدیک به نقطه ورود است).`);
    } else if (rr1 >= 1.5 && rr1 < 2.0) {
      quality = 'ضعیف';
      qualityCode = 'WEAK';
      reasons.push(`نسبت R:R تا اولین مانع (${rr1}) بین ۱.۵ تا ۲ است (ستاپ ضعیف؛ نیازمند وین‌ریت بالا یا سایز کمتر).`);
    } else if (rr1 >= 2.0 && rr1 < 3.0) {
      quality = 'قابل قبول';
      qualityCode = 'ACCEPTABLE';
      reasons.push(`نسبت R:R تا اولین مانع (${rr1}) ≥ ۲ است و استاندارد مدیریت ریسک TCP را پاس می‌کند.`);
    } else {
      quality = 'قوی';
      qualityCode = 'STRONG';
      reasons.push(`نسبت R:R تا اولین مانع (${rr1}) ≥ ۳ است؛ فضای حرکتی باز تا مانع بعدی وجود دارد.`);
    }

    // Streak & Drawdown Metrics
    const streakProbPct = +calcExactMarkovStreakProb(totalTradesN, streakK, 1 - pWin).toFixed(1);
    const remAfterK = Math.pow(1 - riskPct / 100, streakK) * 100;
    const drawdownAfterKPct = +(100 - remAfterK).toFixed(2);

    return {
      side: cleanSide,
      isLong,
      currentPrice: +currentPrice.toFixed(decimals),
      atr: +atr.toFixed(decimals),
      stopDistAtr,
      entry: +entry.toFixed(decimals),
      sl: +sl.toFixed(decimals),
      tp1: +tp1.toFixed(decimals),
      tp2: +tp2.toFixed(decimals),
      tp3: +tp3.toFixed(decimals),
      rr1,
      rr2,
      rr3,
      netRR1AfterFees,
      grossStagedR,
      netRAfterFees,
      feeDragR,
      riskPct,
      riskDollar,
      stopDistPct: +stopDistPct.toFixed(3),
      feePct,
      slippagePct,
      effectiveLossPct: +effectiveLossPct.toFixed(3),
      positionSize,
      margin,
      leverage,
      recommendedMaxLeverage,
      hardCapLeverage,
      liqPrice,
      isLiqBeforeStop,
      breakevenWinRate,
      breakevenWinRateNet,
      expectancyR,
      stage1ProfitDollar,
      stage2ProfitDollar,
      stage3ProfitDollar,
      totalStagedNetProfitDollar,
      firstObstacleSource: firstObstacle.source,
      secondObstacleSource: secondObstacle.source,
      thirdObstacleSource: thirdObstacle.source,
      obAgg,
      structure,
      quality,
      qualityCode,
      streakProbPct,
      drawdownAfterKPct,
      reasons,
      warnings
    };
  }

  /**
   * Upgraded Multi-Candle Backtester (Long & Short, Variable R from Engine, Fees/Slippage,
   * Intra-bar SL+TP Conflict Mode, Equity Curve in R, Statistical Validity Warning < 30 Trades)
   *
   * @param {Array} candles - 500+ historical candles
   * @param {Object} options - {
   *   sideMode: 'both' | 'long' | 'short',
   *   feePct: number,
   *   slippagePct: number,
   *   conflictMode: 'conservative' | 'open_proximity' | 'skip',
   *   decimals: number
   * }
   */
  function runHistoricalBacktest(candles, options = {}) {
    const n = Array.isArray(candles) ? candles.length : 0;
    if (n < 50 || !root.TCPIndicators) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgR: 0,
        expectancyR: 0,
        profitFactor: 0,
        maxDrawdownR: 0,
        maxLossStreak: 0,
        netReturnR: 0,
        equityCurveR: [0],
        trades: [],
        signals: [],
        lowSampleWarning: true
      };
    }

    const sideMode = options.sideMode || 'both';
    const feePct = options.feePct !== undefined ? Number(options.feePct) : 0.08;
    const slippagePct = options.slippagePct !== undefined ? Number(options.slippagePct) : 0.03;
    const conflictMode = options.conflictMode || 'conservative'; // 'conservative' (SL first), 'open_proximity', 'skip'
    const decimals = options.decimals !== undefined ? Number(options.decimals) : 2;

    const sma7 = root.TCPIndicators.calcSMA(candles, 7);
    const sma25 = root.TCPIndicators.calcSMA(candles, 25);
    const sma99 = root.TCPIndicators.calcSMA(candles, Math.min(99, n - 2));
    const atr14 = root.TCPIndicators.calcATR(candles, 14);
    const rsi14 = root.TCPIndicators.calcRSI(candles, 14);

    const trades = [];
    const signals = [];
    const equityCurveR = [0];
    let currentEquityR = 0;
    let peakEquityR = 0;
    let maxDrawdownR = 0;
    let curLossStreak = 0;
    let maxLossStreak = 0;
    let grossWinR = 0;
    let grossLossR = 0;

    // Walk forward through history without lookahead bias
    for (let i = 35; i < n - 10; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      const atr = atr14[i] || (c.high - c.low);
      if (atr <= 0) continue;

      const rng = Math.max(1e-8, c.high - c.low);
      const bodyRatio = Math.abs(c.close - c.open) / rng;

      // Recent local swing high and low in [i-20 .. i-1]
      let recentSwingHigh = -Infinity;
      let recentSwingLow = Infinity;
      let nextObstacleHigh = -Infinity;
      let nextObstacleLow = Infinity;

      for (let j = Math.max(0, i - 18); j < i; j++) {
        if (candles[j].high > recentSwingHigh) recentSwingHigh = candles[j].high;
        if (candles[j].low < recentSwingLow) recentSwingLow = candles[j].low;
      }
      for (let j = Math.max(0, i - 48); j < i; j++) {
        if (candles[j].high > nextObstacleHigh) nextObstacleHigh = candles[j].high;
        if (candles[j].low < nextObstacleLow) nextObstacleLow = candles[j].low;
      }

      const isLongTrigger =
        (sideMode === 'both' || sideMode === 'long') &&
        c.close > c.open &&
        c.close > prev.high &&
        sma25[i] && c.close > sma25[i] &&
        (!sma99[i] || sma25[i] >= sma99[i] * 0.996) &&
        rsi14[i] >= 50 && rsi14[i] <= 74 &&
        bodyRatio >= 0.48;

      const isShortTrigger =
        (sideMode === 'both' || sideMode === 'short') &&
        c.close < c.open &&
        c.close < prev.low &&
        sma25[i] && c.close < sma25[i] &&
        (!sma99[i] || sma25[i] <= sma99[i] * 1.004) &&
        rsi14[i] <= 50 && rsi14[i] >= 26 &&
        bodyRatio >= 0.48;

      if (!isLongTrigger && !isShortTrigger) continue;

      const side = isLongTrigger ? 'long' : 'short';
      const entry = isLongTrigger ? (c.close + 0.05 * atr) : (c.close - 0.05 * atr);
      let sl = isLongTrigger
        ? (Math.min(c.low, prev.low, recentSwingLow) - 0.2 * atr)
        : (Math.max(c.high, prev.high, recentSwingHigh) + 0.2 * atr);

      let stopDist = Math.abs(entry - sl);
      if (stopDist < 0.8 * atr) {
        stopDist = 0.8 * atr;
        sl = isLongTrigger ? (entry - stopDist) : (entry + stopDist);
      } else if (stopDist > 3.0 * atr) {
        continue; // Skip trade with stop > 3*ATR per engine rules
      }

      // Dynamic obstacle-based target
      let targetObstacle = isLongTrigger
        ? Math.max(nextObstacleHigh - 0.08 * atr, entry + stopDist * 1.9)
        : Math.min(nextObstacleLow + 0.08 * atr, entry - stopDist * 1.9);

      const grossR = Math.abs(targetObstacle - entry) / stopDist;
      if (grossR < 1.5) continue; // Engine filters out R:R < 1.5 ("NO TRADE")

      const tp1 = isLongTrigger ? (entry + stopDist * Math.min(grossR, 1.5)) : (entry - stopDist * Math.min(grossR, 1.5));
      const tp2 = targetObstacle;

      const stopDistPct = (stopDist / entry) * 100;
      const totalFrictionPct = feePct + slippagePct;

      // Evaluate outcome over subsequent candles (up to 24 bars)
      let outcome = null; // 'win' | 'loss' | 'ambiguous_skip'
      let exitBarIndex = i + 1;
      let realizedGrossR = 0;

      for (let k = i + 1; k < Math.min(n, i + 25); k++) {
        const bar = candles[k];
        const hitSl = isLongTrigger ? (bar.low <= sl) : (bar.high >= sl);
        const hitTp = isLongTrigger ? (bar.high >= tp2) : (bar.low <= tp2);

        if (hitSl && hitTp) {
          // Both SL and TP touched in the same candle!
          if (conflictMode === 'skip') {
            outcome = 'ambiguous_skip';
            break;
          } else if (conflictMode === 'open_proximity') {
            const distToSl = Math.abs(bar.open - sl);
            const distToTp = Math.abs(bar.open - tp2);
            if (distToTp < distToSl) {
              outcome = 'win';
              realizedGrossR = 0.3 * 1.5 + 0.7 * grossR;
            } else {
              outcome = 'loss';
              realizedGrossR = -1.0;
            }
          } else {
            // 'conservative': count SL first
            outcome = 'loss';
            realizedGrossR = -1.0;
          }
          exitBarIndex = k;
          break;
        } else if (hitSl) {
          outcome = 'loss';
          realizedGrossR = -1.0;
          exitBarIndex = k;
          break;
        } else if (hitTp) {
          outcome = 'win';
          // Staged profit taking: 30% at 1.5R + 70% at obstacle R
          realizedGrossR = +(0.3 * Math.min(grossR, 1.5) + 0.7 * grossR).toFixed(2);
          exitBarIndex = k;
          break;
        }
      }

      if (!outcome || outcome === 'ambiguous_skip') continue;

      // Net R after round-trip fee + slippage
      const netR = outcome === 'win'
        ? +(((realizedGrossR * stopDistPct) - totalFrictionPct) / (stopDistPct + totalFrictionPct)).toFixed(2)
        : -1.0; // Position sizing already includes friction in 1R loss

      currentEquityR = +(currentEquityR + netR).toFixed(2);
      equityCurveR.push(currentEquityR);

      if (currentEquityR > peakEquityR) peakEquityR = currentEquityR;
      const dd = +(peakEquityR - currentEquityR).toFixed(2);
      if (dd > maxDrawdownR) maxDrawdownR = dd;

      if (netR > 0) {
        grossWinR += netR;
        curLossStreak = 0;
      } else {
        grossLossR += Math.abs(netR);
        curLossStreak++;
        if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
      }

      trades.push({
        index: i,
        exitIndex: exitBarIndex,
        time: c.time,
        side,
        entry: +entry.toFixed(decimals),
        sl: +sl.toFixed(decimals),
        tp: +tp2.toFixed(decimals),
        grossR: +grossR.toFixed(2),
        netR,
        outcome,
        cumulativeR: currentEquityR
      });

      signals.push({
        time: c.time,
        side,
        price: c.close,
        outcome,
        netR
      });

      // Advance index to avoid overlapping positions
      i = Math.max(i + 1, Math.min(exitBarIndex, i + 4));
    }

    const totalTrades = trades.length;
    const wins = trades.filter(t => t.netR > 0).length;
    const losses = totalTrades - wins;
    const winRate = totalTrades > 0 ? +((wins / totalTrades) * 100).toFixed(1) : 0;
    const avgR = totalTrades > 0 ? +((grossWinR - grossLossR) / totalTrades).toFixed(2) : 0;
    const expectancyR = avgR;
    const profitFactor = grossLossR > 0 ? +(grossWinR / grossLossR).toFixed(2) : (grossWinR > 0 ? 9.99 : 0);

    return {
      totalTrades,
      wins,
      losses,
      winRate,
      avgR,
      expectancyR,
      profitFactor,
      maxDrawdownR: +maxDrawdownR.toFixed(2),
      maxLossStreak,
      netReturnR: +currentEquityR.toFixed(2),
      equityCurveR,
      trades,
      signals,
      lowSampleWarning: totalTrades < 30
    };
  }

  /**
   * Built-in Console Unit Tests (Verifies Phase 1 requirements via console.assert)
   */
  function runTradeEngineUnitTests() {
    const results = [];
    const assertTest = (name, cond, details) => {
      results.push({ name, passed: !!cond, details });
      if (typeof console !== 'undefined' && console.assert) {
        console.assert(cond, `[TCP UnitTest FAIL] ${name}: ${details}`);
      }
    };

    // Test 1: User Prompt Example -> Entry 100, SL 98, TP 104 => Gross R = 2.0, Fee = 0.08%, Slippage = 0%
    // Net R slightly less than 2.0 (~1.922), Breakeven Win Rate ≈ 33.33%
    const t1 = computeTradePlan('long', [], null, {
      balance: 1000,
      riskPct: 1.0,
      feePct: 0.08,
      slippagePct: 0.0,
      leverage: 10,
      winRatePct: 50,
      customEntry: 100,
      customSl: 98,
      customTp1: 104,
      singleTargetMode: true,
      decimals: 2
    });
    assertTest(
      'Test 1 (Entry 100, SL 98, TP 104 -> R=2, Breakeven≈33.3%, NetR<2)',
      t1.rr1 === 2.0 &&
        Math.abs(t1.breakevenWinRate - 33.33) < 0.1 &&
        t1.netRAfterFees < 2.0 &&
        t1.netRAfterFees > 1.85 &&
        t1.qualityCode === 'ACCEPTABLE',
      `rr1=${t1.rr1}, BE=${t1.breakevenWinRate}%, netR=${t1.netRAfterFees}, quality=${t1.quality}`
    );

    // Test 2: Short Position Symmetry -> Entry 100, SL 102, TP 93 => Gross R = 3.5 -> Quality "قوی" (STRONG)
    const t2 = computeTradePlan('short', [], null, {
      balance: 1000,
      riskPct: 1.0,
      feePct: 0.08,
      slippagePct: 0.02,
      leverage: 5,
      winRatePct: 45,
      customEntry: 100,
      customSl: 102,
      customTp1: 93,
      singleTargetMode: true,
      decimals: 2
    });
    assertTest(
      'Test 2 (Short Symmetry: Entry 100, SL 102, TP 93 -> R=3.5, Quality=قوی)',
      t2.side === 'short' && t2.rr1 === 3.5 && t2.qualityCode === 'STRONG',
      `side=${t2.side}, rr1=${t2.rr1}, quality=${t2.quality}`
    );

    // Test 3: R:R < 1.5 -> Quality = "NO TRADE"
    const t3 = computeTradePlan('long', [], null, {
      balance: 1000,
      riskPct: 1.0,
      feePct: 0.08,
      slippagePct: 0.02,
      leverage: 5,
      customEntry: 100,
      customSl: 98,
      customTp1: 102.4, // R:R = 1.2 < 1.5
      decimals: 2
    });
    assertTest(
      'Test 3 (First obstacle R:R < 1.5 -> NO TRADE)',
      t3.rr1 === 1.2 && t3.qualityCode === 'NO_TRADE' && t3.quality === 'NO TRADE',
      `rr1=${t3.rr1}, quality=${t3.quality}`
    );

    // Test 4: Liquidation before Stop-Loss triggers Red Lock (isLiqBeforeStop = true)
    // Entry 100, SL 90 (10% stop), Leverage 15x (liq at ~93.8 > 90)
    const t4 = computeTradePlan('long', [], null, {
      balance: 1000,
      riskPct: 1.0,
      feePct: 0.08,
      slippagePct: 0.02,
      leverage: 15,
      customEntry: 100,
      customSl: 90,
      customTp1: 125,
      decimals: 2
    });
    assertTest(
      'Test 4 (Liquidation before SL -> isLiqBeforeStop=true & NO_TRADE lock)',
      t4.isLiqBeforeStop === true && t4.liqPrice > 90 && t4.qualityCode === 'NO_TRADE',
      `liqPrice=${t4.liqPrice}, sl=${t4.sl}, isLiqBeforeStop=${t4.isLiqBeforeStop}`
    );

    // Test 5: Staged Profit Taking (30% at 1.5R, 50% at 2R, 20% at 3.5R)
    const t5 = computeTradePlan('long', [], null, {
      balance: 1000,
      riskPct: 1.0,
      feePct: 0.08,
      slippagePct: 0.0,
      leverage: 5,
      customEntry: 100,
      customSl: 98,
      customTp1: 103, // 1.5R
      customTp2: 104, // 2.0R
      customTp3: 107, // 3.5R
      singleTargetMode: false,
      decimals: 2
    });
    // Weighted Gross R = 0.3*1.5 + 0.5*2.0 + 0.2*3.5 = 0.45 + 1.0 + 0.70 = 2.15R
    assertTest(
      'Test 5 (Staged Profit Taking: 30%@1.5R + 50%@2R + 20%@3.5R -> GrossStagedR=2.15)',
      Math.abs(t5.grossStagedR - 2.15) < 0.01 && t5.totalStagedNetProfitDollar > 19.5,
      `grossStagedR=${t5.grossStagedR}, netProfit=$${t5.totalStagedNetProfitDollar}`
    );

    if (typeof console !== 'undefined' && console.info) {
      const passedCount = results.filter(r => r.passed).length;
      console.info(`✅ [TCP TradeEngine Unit Tests] ${passedCount}/${results.length} passed.`, results);
    }
    return results;
  }

  const TCPTradeEngine = {
    calcExactMarkovStreakProb,
    aggregateOrderBookWalls,
    computeTradePlan,
    runHistoricalBacktest,
    runTradeEngineUnitTests
  };

  root.TCPTradeEngine = TCPTradeEngine;
})(typeof window !== 'undefined' ? window : globalThis);
