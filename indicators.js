/**
 * TCP Radar — Technical Indicators & Structural Analysis Module (indicators.js)
 * Implements Wilder's ATR(14), SMA(7/25/99), Wilder's RSI + Half-Cycle Detection,
 * Wilder's DMI (+DI, -DI, ADX), ROC(10), Structural Pivot Highs/Lows, Fibonacci Retracements/Extensions,
 * and Session Opening Range Breakout (ORB).
 */
(function (root) {
  'use strict';

  /**
   * Simple Moving Average (SMA)
   * @param {Array} candles - [{time, open, high, low, close, volume}]
   * @param {number} period
   * @returns {Array<number|null>}
   */
  function calcSMA(candles, period) {
    const n = Array.isArray(candles) ? candles.length : 0;
    const res = new Array(n).fill(null);
    if (n < period || period <= 0) return res;
    let runningSum = 0;
    for (let i = 0; i < n; i++) {
      runningSum += Number(candles[i].close) || 0;
      if (i >= period) {
        runningSum -= Number(candles[i - period].close) || 0;
      }
      if (i >= period - 1) {
        res[i] = runningSum / period;
      }
    }
    return res;
  }

  /**
   * Wilder's Average True Range (ATR)
   * @param {Array} candles
   * @param {number} period - default 14
   * @returns {Array<number|null>}
   */
  function calcATR(candles, period = 14) {
    const n = Array.isArray(candles) ? candles.length : 0;
    const atr = new Array(n).fill(null);
    if (n === 0) return atr;

    const tr = new Array(n).fill(0);
    tr[0] = Math.max(1e-8, (candles[0].high || 0) - (candles[0].low || 0));
    for (let i = 1; i < n; i++) {
      const h = Number(candles[i].high) || 0;
      const l = Number(candles[i].low) || 0;
      const pc = Number(candles[i - 1].close) || 0;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }

    if (n < period) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += tr[i];
        atr[i] = sum / (i + 1);
      }
      return atr;
    }

    let firstSum = 0;
    for (let i = 0; i < period; i++) {
      firstSum += tr[i];
    }
    let prevAtr = firstSum / period;
    atr[period - 1] = prevAtr;

    for (let i = period; i < n; i++) {
      prevAtr = ((prevAtr * (period - 1)) + tr[i]) / period;
      atr[i] = prevAtr;
    }
    return atr;
  }

  /**
   * Detect Dominant Market Cycle between Major Swing Lows & Compute Even Half-Cycle RSI Period
   * @param {Array} candles
   * @returns {{avgCycle: number, evenHalf: number, swingLowIndices: Array<number>}}
   */
  function detectCycleAndRsiPeriod(candles) {
    const lows = [];
    const n = Array.isArray(candles) ? candles.length : 0;
    for (let i = 3; i < n - 3; i++) {
      const c = candles[i].low;
      if (
        c <= candles[i - 1].low &&
        c <= candles[i - 2].low &&
        c <= candles[i - 3].low &&
        c <= candles[i + 1].low &&
        c <= candles[i + 2].low &&
        c <= candles[i + 3].low
      ) {
        lows.push(i);
      }
    }
    let avgCycle = 28;
    if (lows.length >= 2) {
      let sumDiff = 0;
      for (let k = 1; k < lows.length; k++) {
        sumDiff += (lows[k] - lows[k - 1]);
      }
      avgCycle = Math.round(sumDiff / (lows.length - 1));
    }
    const rawHalf = Math.max(8, Math.min(36, Math.round(avgCycle / 2)));
    const evenHalf = rawHalf % 2 === 0 ? rawHalf : rawHalf + 1;
    return { avgCycle, evenHalf, swingLowIndices: lows };
  }

  /**
   * Wilder's Relative Strength Index (RSI)
   * @param {Array} candles
   * @param {number} period
   * @returns {Array<number>}
   */
  function calcRSI(candles, period = 14) {
    const n = Array.isArray(candles) ? candles.length : 0;
    const rsi = new Array(n).fill(50);
    if (n <= period || period <= 0) return rsi;

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period; i < n; i++) {
      if (i > period) {
        const diff = candles[i].close - candles[i - 1].close;
        const g = diff > 0 ? diff : 0;
        const l = diff < 0 ? -diff : 0;
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
      }
      if (avgLoss === 0 && avgGain === 0) {
        rsi[i] = 50;
      } else if (avgLoss === 0) {
        rsi[i] = 100;
      } else {
        const rs = avgGain / avgLoss;
        rsi[i] = 100 - 100 / (1 + rs);
      }
    }
    return rsi;
  }

  /**
   * Wilder's Directional Movement Index (+DI, -DI) and ADX(14)
   * @param {Array} candles
   * @param {number} period
   * @returns {{plusDi: number, minusDi: number, adx: number, series: Array}}
   */
  function calcWilderDMI(candles, period = 14) {
    const n = Array.isArray(candles) ? candles.length : 0;
    if (n <= period + 2) {
      return { plusDi: 25, minusDi: 20, adx: 20, series: [] };
    }
    let smTr = 0;
    let smPlusDm = 0;
    let smMinusDm = 0;
    const dxList = [];
    const series = [];

    for (let i = 1; i < n; i++) {
      const cur = candles[i];
      const prev = candles[i - 1];
      const upMove = cur.high - prev.high;
      const downMove = prev.low - cur.low;
      const plusDm = (upMove > downMove && upMove > 0) ? upMove : 0;
      const minusDm = (downMove > upMove && downMove > 0) ? downMove : 0;
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );

      if (i <= period) {
        smTr += tr;
        smPlusDm += plusDm;
        smMinusDm += minusDm;
        if (i === period && smTr > 0) {
          const pDi = (smPlusDm / smTr) * 100;
          const mDi = (smMinusDm / smTr) * 100;
          const sumDi = pDi + mDi;
          const dx = sumDi === 0 ? 0 : (Math.abs(pDi - mDi) / sumDi) * 100;
          dxList.push({ time: cur.time, pDi, mDi, dx });
        }
      } else {
        smTr = smTr - (smTr / period) + tr;
        smPlusDm = smPlusDm - (smPlusDm / period) + plusDm;
        smMinusDm = smMinusDm - (smMinusDm / period) + minusDm;
        if (smTr > 0) {
          const pDi = (smPlusDm / smTr) * 100;
          const mDi = (smMinusDm / smTr) * 100;
          const sumDi = pDi + mDi;
          const dx = sumDi === 0 ? 0 : (Math.abs(pDi - mDi) / sumDi) * 100;
          dxList.push({ time: cur.time, pDi, mDi, dx });
        }
      }
    }

    const finalPlusDi = smTr > 0 ? Math.round((smPlusDm / smTr) * 100) : 25;
    const finalMinusDi = smTr > 0 ? Math.round((smMinusDm / smTr) * 100) : 20;
    let adx = dxList.length > 0 ? dxList[0].dx : 20;
    for (let k = 0; k < dxList.length; k++) {
      if (k > 0) {
        adx = ((adx * (period - 1)) + dxList[k].dx) / period;
      }
      series.push({
        time: dxList[k].time,
        plusDi: +dxList[k].pDi.toFixed(2),
        minusDi: +dxList[k].mDi.toFixed(2),
        adx: +adx.toFixed(2)
      });
    }
    return {
      plusDi: finalPlusDi,
      minusDi: finalMinusDi,
      adx: +adx.toFixed(1),
      series
    };
  }

  /**
   * Detect Structural Swing Pivots (Confirmed without future repaint on last 2 bars)
   * Emphasizes right-side recent pivots and candle body tops/bottoms per TCP methodology.
   * @param {Array} candles
   * @param {number} leftBars
   * @param {number} rightBars
   * @returns {{swingHighs: Array, swingLows: Array}}
   */
  function detectStructuralPivots(candles, leftBars = 3, rightBars = 2) {
    const n = Array.isArray(candles) ? candles.length : 0;
    const swingHighs = [];
    const swingLows = [];
    if (n < leftBars + rightBars + 2) return { swingHighs, swingLows };

    for (let i = leftBars; i < n - rightBars; i++) {
      const h = candles[i].high;
      const l = candles[i].low;
      let isHigh = true;
      let isLow = true;

      for (let j = i - leftBars; j <= i + rightBars; j++) {
        if (j === i) continue;
        if (candles[j].high > h) isHigh = false;
        if (candles[j].low < l) isLow = false;
      }

      if (isHigh) {
        // Count how many times nearby candles touched this level (within 0.35% band)
        let touches = 1;
        for (let k = Math.max(0, i - 45); k < n; k++) {
          if (Math.abs(k - i) > 2 && Math.abs(candles[k].high - h) / h <= 0.0035) {
            touches++;
          }
        }
        swingHighs.push({
          index: i,
          time: candles[i].time,
          price: h,
          bodyTop: Math.max(candles[i].open, candles[i].close),
          touches
        });
      }

      if (isLow) {
        let touches = 1;
        for (let k = Math.max(0, i - 45); k < n; k++) {
          if (Math.abs(k - i) > 2 && Math.abs(candles[k].low - l) / l <= 0.0035) {
            touches++;
          }
        }
        swingLows.push({
          index: i,
          time: candles[i].time,
          price: l,
          bodyBottom: Math.min(candles[i].open, candles[i].close),
          touches
        });
      }
    }

    return { swingHighs, swingLows };
  }

  /**
   * Compute Fibonacci Retracement & Extension Zones from the recent major swing A -> B
   * @param {number} swingHigh
   * @param {number} swingLow
   * @param {boolean} isUptrend
   */
  function calcFibonacciLevels(swingHigh, swingLow, isUptrend = true) {
    const high = Math.max(swingHigh, swingLow);
    const low = Math.min(swingHigh, swingLow);
    const diff = Math.max(1e-8, high - low);
    if (isUptrend) {
      return {
        swingA: low,
        swingB: high,
        fib382: high - diff * 0.382,
        fib500: high - diff * 0.5,
        fib618: high - diff * 0.618,
        fib786: high - diff * 0.786,
        ext1272: high + diff * 0.272,
        ext1618: high + diff * 0.618
      };
    } else {
      return {
        swingA: high,
        swingB: low,
        fib382: low + diff * 0.382,
        fib500: low + diff * 0.5,
        fib618: low + diff * 0.618,
        fib786: low + diff * 0.786,
        ext1272: low - diff * 0.272,
        ext1618: low - diff * 0.618
      };
    }
  }

  /**
   * Comprehensive Structural & Market Analysis (used by UI and Trade Engine)
   * @param {Array} candles
   * @param {string} rsiMode - 'auto' or period number
   */
  function analyzeMarketStructure(candles, rsiMode = 'auto') {
    const n = Array.isArray(candles) ? candles.length : 0;
    if (n < 15) return null;

    const sma7 = calcSMA(candles, 7);
    const sma25 = calcSMA(candles, 25);
    const sma99 = calcSMA(candles, Math.min(99, Math.max(10, n - 1)));
    const atrSeries = calcATR(candles, 14);
    const currentAtr = atrSeries[n - 1] || Math.max(1e-6, (candles[n - 1].high - candles[n - 1].low));

    const { swingHighs, swingLows } = detectStructuralPivots(candles, 3, 2);
    const last = candles[n - 1];
    const prev = candles[n - 2] || last;

    // Recent pivots on the right side of the chart
    const lastHigh = swingHighs[swingHighs.length - 1] || {
      index: n - 5,
      price: last.high + currentAtr * 0.8,
      bodyTop: Math.max(last.open, last.close) + currentAtr * 0.5,
      touches: 2
    };
    const prevHigh = swingHighs[swingHighs.length - 2] || lastHigh;

    const lastLow = swingLows[swingLows.length - 1] || {
      index: n - 5,
      price: last.low - currentAtr * 0.8,
      bodyBottom: Math.min(last.open, last.close) - currentAtr * 0.5,
      touches: 2
    };
    const prevLow = swingLows[swingLows.length - 2] || lastLow;

    // Identify nearest structural levels relative to current price
    const highsAbove = swingHighs.filter(h => h.bodyTop > last.close * 0.9995).sort((a, b) => a.bodyTop - b.bodyTop);
    const lowsBelow = swingLows.filter(l => l.bodyBottom < last.close * 1.0005).sort((a, b) => b.bodyBottom - a.bodyBottom);

    const nearestResPivot = highsAbove[0] || lastHigh;
    const secondResPivot = highsAbove[1] || {
      price: Math.max(lastHigh.price, prevHigh.price) + currentAtr * 1.6,
      bodyTop: Math.max(lastHigh.bodyTop, prevHigh.bodyTop) + currentAtr * 1.4,
      touches: 2
    };

    const nearestSupPivot = lowsBelow[0] || lastLow;
    const secondSupPivot = lowsBelow[1] || {
      price: Math.min(lastLow.price, prevLow.price) - currentAtr * 1.6,
      bodyBottom: Math.min(lastLow.bodyBottom, prevLow.bodyBottom) - currentAtr * 1.4,
      touches: 2
    };

    const majorResistance = nearestResPivot.bodyTop;
    const farResistance = Math.max(secondResPivot.price, majorResistance + currentAtr * 1.2);
    const majorSupport = nearestSupPivot.bodyBottom;
    const farSupport = Math.min(secondSupPivot.price, majorSupport - currentAtr * 1.2);

    // Dow Theory Structure
    let dowStructure = 'رنج / در انتظار شکست سطح';
    let isBullishStructure = true;
    let isBearishStructure = false;

    if (lastHigh.price >= prevHigh.price && lastLow.price >= prevLow.price) {
      dowStructure = 'صعودی (HH + HL تاییدشده)';
      isBullishStructure = true;
      isBearishStructure = false;
    } else if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) {
      dowStructure = 'نزولی (LH + LL تاییدشده)';
      isBullishStructure = false;
      isBearishStructure = true;
    } else if (last.close > lastHigh.bodyTop) {
      dowStructure = 'شکست سقف ساختاری (BOS صعودی)';
      isBullishStructure = true;
      isBearishStructure = false;
    } else if (last.close < lastLow.bodyBottom) {
      dowStructure = 'شکست کف ساختاری (BOS نزولی)';
      isBullishStructure = false;
      isBearishStructure = true;
    }

    // Candle Anatomy
    const range = Math.max(1e-8, last.high - last.low);
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const bodyRatio = Math.round((body / range) * 100);
    const upperRatio = Math.round((upperWick / range) * 100);
    const lowerRatio = Math.round((lowerWick / range) * 100);

    let sumRange = 0;
    let sumVol = 0;
    const lookback = Math.min(20, n - 1);
    for (let i = Math.max(0, n - 1 - lookback); i < n - 1; i++) {
      sumRange += (candles[i].high - candles[i].low);
      sumVol += candles[i].volume;
    }
    const avgRange = (lookback > 0 ? sumRange / lookback : range) || range;
    const avgVol = (lookback > 0 ? sumVol / lookback : last.volume) || last.volume;
    const sizeVsAvg = +(range / avgRange).toFixed(2);
    const volRatio = +(last.volume / Math.max(1e-8, avgVol)).toFixed(2);

    const rawClosePos = ((last.close - last.low) / range) * 100;
    const buyerPower = Math.max(5, Math.min(95, Math.round(rawClosePos)));

    const takerBuy = last.takerBuyVol !== undefined ? last.takerBuyVol : +(last.volume * (buyerPower / 100)).toFixed(2);
    const takerSell = Math.max(0.01, +(last.volume - takerBuy).toFixed(2));
    const deltaVol = +(takerBuy - takerSell).toFixed(2);

    let sumBuy5 = 0;
    let sumSell5 = 0;
    for (let i = Math.max(0, n - 5); i < n; i++) {
      const tb = candles[i].takerBuyVol !== undefined ? candles[i].takerBuyVol : candles[i].volume * 0.5;
      sumBuy5 += tb;
      sumSell5 += Math.max(0.01, candles[i].volume - tb);
    }
    const fiveCandleBuySellRatio = +(sumBuy5 / Math.max(0.01, sumSell5)).toFixed(2);

    let candleType = 'کندل استاندارد در جریان روند';
    let candleAdvice = 'توازن خریدار و فروشنده متعادل است؛ بررسی کلوز کندل نسبت به سطوح پیوت و میانگین‌ها اولویت دارد.';
    if (sizeVsAvg >= 1.75 && bodyRatio >= 65) {
      candleType = last.close >= last.open ? 'کندل با بدنه بزرگ صعودی (مومنتوم خرید)' : 'کندل با بدنه بزرگ نزولی (فشار عرضه)';
      candleAdvice = 'دامنه نوسان کندل بیش از ۱.۷ برابر میانگین ۲۰ کندل اخیر با بدنه پرقدرت است؛ نشان‌دهنده ورود نقدینگی در جهت کندل.';
    } else if (
      body > Math.abs(prev.close - prev.open) * 1.25 &&
      ((last.close > last.open && prev.close < prev.open && last.close >= prev.open) ||
        (last.close < last.open && prev.close > prev.open && last.close <= prev.open))
    ) {
      candleType = last.close > last.open ? 'اینگلف صعودی (Bullish Engulfing)' : 'اینگلف نزولی (Bearish Engulfing)';
      candleAdvice = 'بدنه کندل قبلی کاملاً پوشش داده شده است؛ در صورت تایید حجم و ساختار، نشانه تغییر مومنتوم کوتاه‌مدت است.';
    } else if (bodyRatio <= 28) {
      candleType = 'کندل بی‌تصمیمی (Indecision / Doji)';
      candleAdvice = 'نسبت بدنه به کل کندل کمتر از ۲۸٪ است؛ تا پیش از شکست سقف یا کف این کندل، جهت مشخصی تایید نشده است.';
    } else if (lowerRatio >= 48 && buyerPower >= 58) {
      candleType = 'کندل پین‌بار صعودی (واکنش تقاضا در کف)';
      candleAdvice = 'شدوی پایینی بلند نشان‌دهنده جذب عرضه در سطوح پایین‌تر و بازگشت قیمت به بالا در پایان کندل است.';
    } else if (upperRatio >= 48 && buyerPower <= 42) {
      candleType = 'کندل پین‌بار نزولی (ریجکت از مقاومت)';
      candleAdvice = 'شدوی بالایی بلند نشان‌دهنده فشار فروشندگان و ریجکت قیمت از سطح عرضه بالایی است.';
    }

    const s7 = sma7[n - 1] || last.close;
    const s25 = sma25[n - 1] || last.close;
    const s99 = sma99[n - 1] || last.close;
    const spreadPct = (Math.max(s7, s25, s99) - Math.min(s7, s25, s99)) / Math.max(1e-8, last.close) * 100;
    const distFrom99Pct = ((last.close - s99) / Math.max(1e-8, s99)) * 100;

    let smaState = 'آرایش صعودی منظم (7 > 25 > 99)';
    let isChertMarket = false;
    if (spreadPct < 0.25) {
      smaState = '⚠️ فشردگی میانگین‌ها (بازار رنج و کم‌نوسان)';
      isChertMarket = true;
    } else if (s7 > s25 && s25 > s99) {
      smaState = 'آرایش صعودی منظم (7 > 25 > 99)';
    } else if (s7 < s25 && s25 < s99) {
      smaState = 'آرایش نزولی منظم (7 < 25 < 99)';
    } else {
      smaState = 'در حال تقاطع و تغییر فاز میانی';
    }

    const cycleInfo = detectCycleAndRsiPeriod(candles);
    const chosenRsiPeriod = rsiMode === 'auto' ? cycleInfo.evenHalf : (parseInt(rsiMode, 10) || 14);
    const rsiSeries = calcRSI(candles, chosenRsiPeriod);
    const currentRsi = rsiSeries[n - 1] || 50;

    const rocBase = candles[Math.max(0, n - 10)].close || last.close;
    const roc10 = ((last.close - rocBase) / Math.max(1e-8, rocBase)) * 100;
    const dmiObj = calcWilderDMI(candles, 14);

    let volFourState = 'حجم نرمال هم‌جهت با موج';
    if (volRatio > 1.8 && bodyRatio < 35) {
      volFourState = 'حالت ۱: حجم بالا با بدنه کوچک (جذب نقدینگی سقف/کف)';
    } else if (last.close > prev.close && volRatio < 0.72) {
      volFourState = 'حالت ۲: واگرایی حجم (پیشروی قیمت با کاهش حجم)';
    } else if (volRatio >= 1.3 && bodyRatio >= 55) {
      volFourState = 'حالت ۳: شکست/حرکت همراه با حجم تاییدی';
    }

    const fibLevels = calcFibonacciLevels(
      Math.max(lastHigh.price, prevHigh.price),
      Math.min(lastLow.price, prevLow.price),
      isBullishStructure
    );

    return {
      sma7,
      sma25,
      sma99,
      atrSeries,
      currentAtr,
      s7,
      s25,
      s99,
      smaState,
      isChertMarket,
      distFrom99Pct,
      majorResistance,
      farResistance,
      majorSupport,
      farSupport,
      nearestResPivot,
      secondResPivot,
      nearestSupPivot,
      secondSupPivot,
      dowStructure,
      isBullishStructure,
      isBearishStructure,
      buyerPower,
      bodyRatio,
      upperRatio,
      lowerRatio,
      sizeVsAvg,
      volRatio,
      volFourState,
      takerBuy,
      takerSell,
      deltaVol,
      fiveCandleBuySellRatio,
      candleType,
      candleAdvice,
      cycleInfo,
      chosenRsiPeriod,
      rsiSeries,
      currentRsi,
      roc10,
      plusDi: dmiObj.plusDi,
      minusDi: dmiObj.minusDi,
      adx: dmiObj.adx,
      dmiSeries: dmiObj.series,
      swingHighs,
      swingLows,
      fibLevels
    };
  }

  const TCPIndicators = {
    calcSMA,
    calcATR,
    detectCycleAndRsiPeriod,
    calcRSI,
    calcWilderDMI,
    detectStructuralPivots,
    calcFibonacciLevels,
    analyzeMarketStructure
  };

  root.TCPIndicators = TCPIndicators;
})(typeof window !== 'undefined' ? window : globalThis);
