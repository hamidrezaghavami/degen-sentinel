import YahooFinanceModule from "yahoo-finance2";
import { CONFIG } from "../config.js";
import { getBroker } from "./brokers/index.js";
import { verifySignal } from "./verifier.js";

// Support both yahoo-finance2 v2 (singleton) and v3/v4 (class)
const yahooFinance =
  typeof YahooFinanceModule === "function"
    ? new YahooFinanceModule({ suppressNotices: ["yahooSurvey"] })
    : YahooFinanceModule;

if (typeof yahooFinance.suppressNotices === "function") {
  yahooFinance.suppressNotices(["yahooSurvey"]);
}

/**
 * Return the display name of the active broker (e.g. ALPACA PAPER, IBKR, TRADIER SANDBOX, CHARLES SCHWAB).
 */
export function getActiveBrokerName() {
  return getBroker().name;
}

/**
 * Fetch account summary from the configured broker.
 */
export async function getAccountSummary() {
  return getBroker().getAccountSummary();
}

/**
 * Fetch all open positions from the configured broker.
 */
export async function getOpenPositions() {
  return getBroker().getOpenPositions();
}

/**
 * Fetch current live market price.
 * Prefers the active broker's own quote (so bracket TP/SL always match the broker's
 * base_price), falling back to yahoo-finance2 when unavailable.
 */
export async function getCurrentPrice(symbol) {
  const broker = getBroker();
  if (typeof broker.getLatestPrice === "function") {
    try {
      const brokerPrice = Number(await broker.getLatestPrice(symbol));
      if (Number.isFinite(brokerPrice) && brokerPrice > 0) {
        return brokerPrice;
      }
    } catch {
      // Fall through to yahoo-finance2
    }
  }

  try {
    const quote = await yahooFinance.quote(symbol);
    const price = Number(
      quote?.regularMarketPrice ??
        quote?.postMarketPrice ??
        quote?.preMarketPrice
    );

    if (Number.isFinite(price) && price > 0) {
      return price;
    }
  } catch {
    // No quote available
  }

  throw new Error(`No valid market price returned for ${symbol}`);
}

/**
 * Evaluate signals with hype_score >= 8 and execute market orders on the active broker.
 *
 * @param {Array<object>} signals
 * @returns {Promise<{ enrichedSignals: Array<object>, events: Array<string> }>}
 */
export async function executeSignals(signals) {
  const events = [];
  const enrichedSignals = [];

  if (!signals || signals.length === 0) {
    return { enrichedSignals, events };
  }

  const broker = getBroker();
  let account;
  let openOrderSymbols;
  let openPositions;

  try {
    const [acc, openOrders, positions] = await Promise.all([
      broker.getAccountSummary(),
      broker.getOpenOrderSymbols(),
      broker.getOpenPositions(),
    ]);
    account = acc;
    openOrderSymbols = openOrders;
    openPositions = positions;
  } catch (err) {
    events.push(`Account check failed (${broker.name}): ${err.message}`);
    return {
      enrichedSignals: signals.map((s) => ({
        ...s,
        safetyScore: 0,
        execution: "SKIPPED (Account Error)",
      })),
      events,
    };
  }

  let openPositionCount = openPositions.length;
  const openPositionSymbols = new Set(openPositions.map((p) => p.symbol));
  let availableCash = Math.max(account.cash, account.buyingPower);

  const computeTargets = (price, action) => {
    if (!Number.isFinite(price) || price <= 0 || action === "HOLD") {
      return { entryPrice: null, takeProfitPrice: null, stopLossPrice: null };
    }
    const tpFactor = CONFIG.TAKE_PROFIT_PCT / 100;
    const slFactor = CONFIG.STOP_LOSS_PCT / 100;
    const isBuy = action === "BUY";
    return {
      entryPrice: Number(price.toFixed(2)),
      takeProfitPrice: Number((price * (isBuy ? 1 + tpFactor : 1 - tpFactor)).toFixed(2)),
      stopLossPrice: Number((price * (isBuy ? 1 - slFactor : 1 + slFactor)).toFixed(2)),
    };
  };

  for (const signal of signals) {
    const { ticker, hype_score: hypeScore, suggested_action: action } = signal;

    // Step 1: Quantitative + Risk-Aware Signal Verification
    let verification;
    try {
      verification = await verifySignal(signal);
    } catch (err) {
      verification = {
        approved: false,
        safetyScore: 0,
        reason: `Verify Error: ${err.message.slice(0, 18)}`,
        metrics: null,
      };
    }

    // Attach TP / SL levels to every actionable signal for the dashboard
    let refPrice = verification.metrics?.lastPrice ?? null;
    if (!refPrice && action !== "HOLD") {
      try {
        refPrice = await getCurrentPrice(ticker);
      } catch {
        refPrice = null;
      }
    }
    const targets = computeTargets(refPrice, action);

    if (!verification.approved) {
      enrichedSignals.push({
        ...signal,
        ...targets,
        safetyScore: verification.safetyScore,
        execution: `BLOCKED (${verification.reason})`,
      });
      if (hypeScore >= 8 && action !== "HOLD") {
        events.push(
          `VERIFIER BLOCKED ${action} ${ticker} [${signal.strategy}]: ${verification.reason}`
        );
      }
      continue;
    }

    if (openOrderSymbols.has(ticker) || openPositionSymbols.has(ticker)) {
      enrichedSignals.push({
        ...signal,
        ...targets,
        safetyScore: verification.safetyScore,
        execution: "SKIPPED (Already Open)",
      });
      continue;
    }

    if (openPositionCount >= CONFIG.MAX_OPEN_POSITIONS) {
      enrichedSignals.push({
        ...signal,
        ...targets,
        safetyScore: verification.safetyScore,
        execution: `SKIPPED (Max ${CONFIG.MAX_OPEN_POSITIONS} Pos)`,
      });
      continue;
    }

    const side = action === "BUY" ? "buy" : "sell";

    try {
      const price = await getCurrentPrice(ticker);
      const liveTargets = computeTargets(price, action);
      const allocation = Math.min(CONFIG.MAX_TRADE_ALLOCATION_USD, availableCash);

      if (allocation < price) {
        const msg = `Skipped ${action} ${ticker}: price $${price.toFixed(2)} exceeds allocation $${allocation.toFixed(2)}`;
        events.push(msg);
        enrichedSignals.push({
          ...signal,
          ...liveTargets,
          safetyScore: verification.safetyScore,
          execution: "SKIPPED (Price > Budget)",
        });
        continue;
      }

      const qty = Math.floor(allocation / price);
      if (qty <= 0) {
        enrichedSignals.push({
          ...signal,
          ...liveTargets,
          safetyScore: verification.safetyScore,
          execution: "SKIPPED (Qty 0)",
        });
        continue;
      }

      const { takeProfitPrice, stopLossPrice } = liveTargets;

      const order = await broker.placeMarketOrder({
        symbol: ticker,
        qty,
        side,
        takeProfitPrice,
        stopLossPrice,
      });
      availableCash = Math.max(0, availableCash - qty * price);
      openPositionCount += 1;
      openPositionSymbols.add(ticker);

      const execLabel = `${side.toUpperCase()} ${qty} @ ~$${price.toFixed(2)}`;
      events.push(
        `VERIFIED ORDER [${broker.id.toUpperCase()} | Score ${verification.safetyScore}]: ${execLabel} ${ticker} (TP $${takeProfitPrice} / SL $${stopLossPrice}, id: ${order.id})`
      );
      enrichedSignals.push({
        ...signal,
        ...liveTargets,
        safetyScore: verification.safetyScore,
        execution: execLabel,
      });
    } catch (err) {
      const reason = err?.response?.data?.message || err.message || "Unknown error";
      events.push(`ORDER FAILED (${action} ${ticker}): ${reason}`);
      enrichedSignals.push({
        ...signal,
        ...targets,
        safetyScore: verification.safetyScore,
        execution: `FAILED: ${reason.slice(0, 22)}`,
      });
    }
  }

  return { enrichedSignals, events };
}
