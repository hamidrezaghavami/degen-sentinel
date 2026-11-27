/**
 * Pure JavaScript Statistical & Quantitative Math Engine
 * Computes Mean, Sample Standard Deviation (σ), Z-Score, Bollinger Bands (%B),
 * Daily Log-Return Volatility, and 20-Day Return-to-Risk Ratio (Sharpe-like).
 */

export function calcMean(values) {
  if (!values || values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function calcStdDev(values) {
  if (!values || values.length < 2) return null;
  const mean = calcMean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compute full statistical profile from an array of daily close prices (oldest -> newest).
 *
 * @param {Array<number>} closes
 * @param {number} window
 * @returns {object|null}
 */
export function computeQuantStats(closes, window = 20) {
  if (!Array.isArray(closes) || closes.length < 15) return null;

  const slice = closes.slice(-Math.min(window, closes.length));
  const lastPrice = slice[slice.length - 1];
  const mean = calcMean(slice);
  const stdDev = calcStdDev(slice);

  if (mean === null || stdDev === null || stdDev === 0) return null;

  // Z-Score: how many standard deviations price is from its 20-day mean
  const zScore = (lastPrice - mean) / stdDev;

  // Bollinger Bands (mean ± 2σ) and %B position (0 = lower band, 1 = upper band)
  const upperBand = mean + 2 * stdDev;
  const lowerBand = mean - 2 * stdDev;
  const bandWidthPct = ((upperBand - lowerBand) / mean) * 100;
  const bollingerPctB =
    upperBand > lowerBand ? (lastPrice - lowerBand) / (upperBand - lowerBand) : 0.5;

  // Daily log returns for true return volatility & risk-adjusted momentum
  const logReturns = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] > 0 && slice[i - 1] > 0) {
      logReturns.push(Math.log(slice[i] / slice[i - 1]));
    }
  }

  const meanReturn = calcMean(logReturns) ?? 0;
  const returnStdDev = calcStdDev(logReturns) ?? 0;
  const dailyReturnVolPct = returnStdDev * 100;
  const annualizedVolPct = returnStdDev * Math.sqrt(252) * 100;
  const sharpe20 =
    returnStdDev > 0 ? (meanReturn / returnStdDev) * Math.sqrt(252) : 0;

  // Statistical regime label
  let regime = "NORMAL";
  if (zScore >= 2.0) regime = "OVEREXTENDED (+2σ)";
  else if (zScore <= -2.0) regime = "OVERSOLD (-2σ)";
  else if (zScore >= 0.5 && sharpe20 > 0.5) regime = "STAT_UPTREND";
  else if (zScore <= -0.5 && sharpe20 < -0.5) regime = "STAT_DOWNTREND";

  return {
    lastPrice: Number(lastPrice.toFixed(2)),
    mean20: Number(mean.toFixed(2)),
    stdDev20: Number(stdDev.toFixed(2)),
    zScore: Number(zScore.toFixed(2)),
    upperBand: Number(upperBand.toFixed(2)),
    lowerBand: Number(lowerBand.toFixed(2)),
    bandWidthPct: Number(bandWidthPct.toFixed(2)),
    bollingerPctB: Number(bollingerPctB.toFixed(2)),
    dailyReturnVolPct: Number(dailyReturnVolPct.toFixed(2)),
    annualizedVolPct: Number(annualizedVolPct.toFixed(1)),
    sharpe20: Number(sharpe20.toFixed(2)),
    regime,
  };
}
