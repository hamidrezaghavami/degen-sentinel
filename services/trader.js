import YahooFinanceModule from "yahoo-finance2";
import { CONFIG } from "../config.js";
import { getBroker } from "./brokers/index.js";

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
 * Fetch current live market price via yahoo-finance2, falling back to the active
 * broker's quote endpoint if Yahoo Finance rate-limits the request.
 */
export async function getCurrentPrice(symbol) {
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
    // Fall through to broker market data fallback
  }

  const broker = getBroker();
  if (typeof broker.getLatestPrice === "function") {
    const fallbackPrice = Number(await broker.getLatestPrice(symbol));
    if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
      return fallbackPrice;
    }
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
  let openOrderSymbols = new Set();

  try {
    const [acc, openOrders] = await Promise.all([
      broker.getAccountSummary(),
      broker.getOpenOrderSymbols(),
    ]);
    account = acc;
    openOrderSymbols = openOrders;
  } catch (err) {
    events.push(`Account check failed (${broker.name}): ${err.message}`);
    return {
      enrichedSignals: signals.map((s) => ({ ...s, execution: "SKIPPED (Account Error)" })),
      events,
    };
  }

  let availableCash = Math.max(account.cash, account.buyingPower);

  for (const signal of signals) {
    const { ticker, hype_score: hypeScore, suggested_action: action } = signal;

    if (hypeScore < 8 || action === "HOLD") {
      enrichedSignals.push({
        ...signal,
        execution: hypeScore < 8 ? "IGNORED (Hype < 8)" : "HOLD",
      });
      continue;
    }

    if (openOrderSymbols.has(ticker)) {
      enrichedSignals.push({ ...signal, execution: "SKIPPED (Open Order)" });
      continue;
    }

    const side = action === "BUY" ? "buy" : "sell";

    try {
      const price = await getCurrentPrice(ticker);
      const allocation = Math.min(CONFIG.MAX_TRADE_ALLOCATION_USD, availableCash);

      if (allocation < price) {
        const msg = `Skipped ${action} ${ticker}: price $${price.toFixed(2)} exceeds allocation $${allocation.toFixed(2)}`;
        events.push(msg);
        enrichedSignals.push({ ...signal, execution: "SKIPPED (Price > Budget)" });
        continue;
      }

      const qty = Math.floor(allocation / price);
      if (qty <= 0) {
        enrichedSignals.push({ ...signal, execution: "SKIPPED (Qty 0)" });
        continue;
      }

      const tpFactor = CONFIG.TAKE_PROFIT_PCT / 100;
      const slFactor = CONFIG.STOP_LOSS_PCT / 100;
      const isBuy = side === "buy";
      const takeProfitPrice = Number((price * (isBuy ? 1 + tpFactor : 1 - tpFactor)).toFixed(2));
      const stopLossPrice = Number((price * (isBuy ? 1 - slFactor : 1 + slFactor)).toFixed(2));

      const order = await broker.placeMarketOrder({
        symbol: ticker,
        qty,
        side,
        takeProfitPrice,
        stopLossPrice,
      });
      availableCash = Math.max(0, availableCash - qty * price);

      const execLabel = `${side.toUpperCase()} ${qty} @ ~$${price.toFixed(2)}`;
      events.push(
        `ORDER PLACED [${broker.id.toUpperCase()}]: ${execLabel} ${ticker} (TP $${takeProfitPrice} / SL $${stopLossPrice}, id: ${order.id})`
      );
      enrichedSignals.push({ ...signal, execution: execLabel });
    } catch (err) {
      const reason = err?.response?.data?.message || err.message || "Unknown error";
      events.push(`ORDER FAILED (${action} ${ticker}): ${reason}`);
      enrichedSignals.push({ ...signal, execution: `FAILED: ${reason.slice(0, 26)}` });
    }
  }

  return { enrichedSignals, events };
}
