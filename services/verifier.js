import Alpaca from "@alpacahq/alpaca-trade-api";
import YahooFinanceModule from "yahoo-finance2";
import { CONFIG } from "../config.js";

const yahooFinance =
  typeof YahooFinanceModule === "function"
    ? new YahooFinanceModule({ suppressNotices: ["yahooSurvey"] })
    : YahooFinanceModule;

if (typeof yahooFinance.suppressNotices === "function") {
  yahooFinance.suppressNotices(["yahooSurvey"]);
}

let alpacaDataClient = null;
function getAlpacaDataClient() {
  if (!alpacaDataClient && CONFIG.ALPACA_API_KEY_ID && CONFIG.ALPACA_API_SECRET_KEY) {
    alpacaDataClient = new Alpaca({
      keyId: CONFIG.ALPACA_API_KEY_ID,
      secretKey: CONFIG.ALPACA_API_SECRET_KEY,
      paper: CONFIG.ALPACA_PAPER,
    });
  }
  return alpacaDataClient;
}

/**
 * Fetch ~35 daily OHLCV bars for technical verification (Yahoo Finance with Alpaca fallback).
 */
async function fetchDailyBars(symbol) {
  const end = new Date();
  const start = new Date(end.getTime() - 55 * 24 * 60 * 60 * 1000);

  // 1. Try yahoo-finance2 chart API
  try {
    const chart = await yahooFinance.chart(symbol, {
      period1: start,
      period2: end,
      interval: "1d",
    });
    const quotes = (chart?.quotes ?? []).filter(
      (q) => Number.isFinite(q?.close) && Number.isFinite(q?.high) && Number.isFinite(q?.low)
    );
    if (quotes.length >= 15) {
      return quotes.map((q) => ({
        close: Number(q.close),
        high: Number(q.high),
        low: Number(q.low),
        volume: Number(q.volume ?? 0),
      }));
    }
  } catch {
    // Fall through to Alpaca historical bars
  }

  // 2. Fallback to Alpaca historical daily bars
  const alpaca = getAlpacaDataClient();
  if (alpaca) {
    const bars = [];
    const iter = alpaca.getBarsV2(symbol, {
      start: start.toISOString(),
      end: end.toISOString(),
      timeframe: "1Day",
      limit: 40,
      feed: "iex",
    });
    for await (const b of iter) {
      bars.push({
        close: Number(b.ClosePrice ?? b.c),
        high: Number(b.HighPrice ?? b.h),
        low: Number(b.LowPrice ?? b.l),
        volume: Number(b.Volume ?? b.v ?? 0),
      });
    }
    if (bars.length >= 15) {
      return bars;
    }
  }

  return [];
}

function calcSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcVolatilityPct(bars, period = 14) {
  if (bars.length < period) return null;
  const recent = bars.slice(-period);
  const dailyRanges = recent.map((b) =>
    b.close > 0 ? ((b.high - b.low) / b.close) * 100 : 0
  );
  return dailyRanges.reduce((sum, r) => sum + r, 0) / dailyRanges.length;
}

/**
 * Quantitatively verify an AI signal before allowing execution.
 * Combines trend (SMA-5 / SMA-20), momentum exhaustion (RSI-14), volatility cap,
 * and squeeze/risk guards to compute a 0-100 safety score.
 *
 * @param {object} signal
 * @returns {Promise<object>}
 */
export async function verifySignal(signal) {
  const {
    ticker,
    suggested_action: action,
    strategy = "NOISE",
    risk_level: riskLevel = "MEDIUM",
    confidence = 50,
    hype_score: hypeScore = 5,
  } = signal;

  if (action === "HOLD") {
    return {
      approved: false,
      safetyScore: 0,
      reason: "HOLD",
      metrics: null,
    };
  }

  // Hard safety gates in SAFE_MODE
  if (CONFIG.SAFE_MODE) {
    if (strategy === "SHORT_SQUEEZE_RISK" && action !== "BUY") {
      return {
        approved: false,
        safetyScore: 15,
        reason: "Blocked: Squeeze Risk",
        metrics: null,
      };
    }
    if (riskLevel === "HIGH") {
      return {
        approved: false,
        safetyScore: 20,
        reason: "Blocked: High Risk",
        metrics: null,
      };
    }
  }

  // Fetch technical bars for quantitative verification on EVERY actionable signal
  const bars = await fetchDailyBars(ticker);
  if (bars.length < 15) {
    return {
      approved: !CONFIG.SAFE_MODE,
      safetyScore: CONFIG.SAFE_MODE ? 35 : 65,
      reason: CONFIG.SAFE_MODE ? "No Tech Data" : "Unverified (SafeMode Off)",
      metrics: null,
    };
  }

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const lastPrice = closes[closes.length - 1];
  const lastVolume = volumes[volumes.length - 1] ?? 0;
  const avgVol10 = calcSMA(volumes.slice(0, -1), Math.min(10, volumes.length - 1));
  const sma5 = calcSMA(closes, 5);
  const sma20 = calcSMA(closes, Math.min(20, closes.length));
  const rsi14 = calcRSI(closes, 14);
  const volatilityPct = calcVolatilityPct(bars, 14);

  const metrics = {
    lastPrice: Number(lastPrice.toFixed(2)),
    sma5: sma5 ? Number(sma5.toFixed(2)) : null,
    sma20: sma20 ? Number(sma20.toFixed(2)) : null,
    rsi14: rsi14 !== null ? Number(rsi14.toFixed(1)) : null,
    volatilityPct: volatilityPct !== null ? Number(volatilityPct.toFixed(2)) : null,
    volumeRatio: avgVol10 && avgVol10 > 0 ? Number((lastVolume / avgVol10).toFixed(2)) : null,
  };

  let score = 35;
  const reasons = [];

  // AI confidence & hype contribution (up to +20)
  score += Math.round((confidence / 100) * 15);
  if (hypeScore >= 7) score += 5;

  if (action === "BUY") {
    // Require full bullish alignment: price > SMA5 > SMA20 (never buy a weakening trend)
    if (sma5 && sma20 && lastPrice > sma5 && sma5 > sma20) {
      score += 25;
    } else if (sma20 && lastPrice > sma20) {
      score += 5;
      reasons.push("Weak Trend (SMA5<=SMA20)");
    } else {
      score -= 20;
      reasons.push("Below SMA20");
    }

    // Sweet-spot RSI (45..68): rising momentum without overbought exhaustion
    if (rsi14 !== null && rsi14 >= 45 && rsi14 <= 68) {
      score += 15;
    } else if (rsi14 !== null && rsi14 > 68) {
      score -= 20;
      reasons.push(`Overbought RSI ${rsi14.toFixed(0)}`);
    } else if (rsi14 !== null) {
      score -= 5;
      reasons.push(`Weak RSI ${rsi14.toFixed(0)}`);
    }
  } else {
    // Require full bearish rollover: price < SMA5 < SMA20 or extreme overbought exhaustion
    const bearishStack = sma5 && sma20 && lastPrice < sma5 && sma5 < sma20;
    const overbought = rsi14 !== null && rsi14 >= 70;

    if (bearishStack) {
      score += 25;
    } else if (sma5 && lastPrice < sma5) {
      score += 10;
    } else {
      score -= 20;
      reasons.push("Uptrend (Above SMA5)");
    }

    if (overbought) {
      score += 15;
    } else if (rsi14 !== null && rsi14 < 45) {
      score -= 20;
      reasons.push(`Oversold RSI ${rsi14.toFixed(0)}`);
    }
  }

  // Volume confirmation: bonus for institutional surge (no penalty on quiet/half-day sessions)
  if (metrics.volumeRatio !== null && metrics.volumeRatio >= 1.1) {
    score += 10;
  }

  // Risk-level adjustment
  if (riskLevel === "LOW") score += 10;
  if (riskLevel === "HIGH") score -= 25;

  const safetyScore = Math.max(0, Math.min(100, score));

  // Volatility & confidence gates (after computing real safetyScore so dashboard shows it)
  if (CONFIG.SAFE_MODE && volatilityPct !== null && volatilityPct > CONFIG.MAX_DAILY_VOLATILITY_PCT) {
    return {
      approved: false,
      safetyScore: Math.min(safetyScore, 45),
      reason: `High Vol (${volatilityPct.toFixed(1)}%/d)`,
      metrics,
    };
  }

  if (CONFIG.SAFE_MODE && confidence < CONFIG.MIN_CONFIDENCE) {
    return {
      approved: false,
      safetyScore,
      reason: `Low AI Conf (${confidence}%)`,
      metrics,
    };
  }

  const approved = safetyScore >= CONFIG.MIN_SAFETY_SCORE;

  return {
    approved,
    safetyScore,
    reason: approved
      ? `Verified (Score ${safetyScore})`
      : reasons[0] || `Low Safety (${safetyScore}/${CONFIG.MIN_SAFETY_SCORE})`,
    metrics,
  };
}
