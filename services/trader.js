import Alpaca from "@alpacahq/alpaca-trade-api";
import YahooFinanceModule from "yahoo-finance2";
import { CONFIG } from "../config.js";

// Support both yahoo-finance2 v2 (singleton default export) and v3 (class export)
const yahooFinance =
  typeof YahooFinanceModule === "function"
    ? new YahooFinanceModule({ suppressNotices: ["yahooSurvey"] })
    : YahooFinanceModule;

if (typeof yahooFinance.suppressNotices === "function") {
  yahooFinance.suppressNotices(["yahooSurvey"]);
}

let alpacaClient = null;

function getAlpaca() {
  if (!alpacaClient) {
    alpacaClient = new Alpaca({
      keyId: CONFIG.ALPACA_API_KEY_ID,
      secretKey: CONFIG.ALPACA_API_SECRET_KEY,
      paper: CONFIG.ALPACA_PAPER,
    });
  }
  return alpacaClient;
}

/**
 * Fetch Alpaca paper account summary.
 */
export async function getAccountSummary() {
  const account = await getAlpaca().getAccount();
  return {
    cash: Number(account.cash ?? 0),
    buyingPower: Number(account.buying_power ?? 0),
    portfolioValue: Number(account.portfolio_value ?? 0),
    equity: Number(account.equity ?? 0),
    status: account.status || "UNKNOWN",
  };
}

/**
 * Fetch all open positions from Alpaca paper account.
 */
export async function getOpenPositions() {
  const positions = await getAlpaca().getPositions();
  return positions.map((pos) => ({
    symbol: pos.symbol,
    qty: Number(pos.qty ?? 0),
    side: pos.side || (Number(pos.qty) >= 0 ? "long" : "short"),
    entryPrice: Number(pos.avg_entry_price ?? 0),
    currentPrice: Number(pos.current_price ?? 0),
    unrealizedPl: Number(pos.unrealized_pl ?? 0),
    unrealizedPlpc: Number(pos.unrealized_plpc ?? 0) * 100,
  }));
}

/**
 * Fetch current live market price via yahoo-finance2, with Alpaca latest-trade fallback
 * if Yahoo Finance rate-limits the request.
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
    // Fall through to Alpaca market data fallback
  }

  const latestTrade = await getAlpaca().getLatestTrade(symbol);
  const fallbackPrice = Number(latestTrade?.Price ?? latestTrade?.p ?? 0);

  if (!Number.isFinite(fallbackPrice) || fallbackPrice <= 0) {
    throw new Error(`No valid market price returned for ${symbol}`);
  }

  return fallbackPrice;
}

/**
 * Evaluate signals with hype_score >= 8 and execute paper market orders on Alpaca.
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

  let account;
  try {
    account = await getAccountSummary();
  } catch (err) {
    events.push(`Account check failed: ${err.message}`);
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

      const order = await getAlpaca().createOrder({
        symbol: ticker,
        qty,
        side,
        type: "market",
        time_in_force: "day",
      });

      availableCash = Math.max(0, availableCash - qty * price);

      const execLabel = `${side.toUpperCase()} ${qty} @ ~$${price.toFixed(2)}`;
      events.push(
        `ORDER PLACED: ${execLabel} ${ticker} (id: ${order.id}, status: ${order.status})`
      );
      enrichedSignals.push({ ...signal, execution: execLabel });
    } catch (err) {
      const reason = err?.response?.data?.message || err.message || "Unknown error";
      events.push(`ORDER FAILED (${action} ${ticker}): ${reason}`);
      enrichedSignals.push({ ...signal, execution: `FAILED: ${reason.slice(0, 28)}` });
    }
  }

  return { enrichedSignals, events };
}
