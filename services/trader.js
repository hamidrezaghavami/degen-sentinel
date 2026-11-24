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
 * Build a 3-Level Entry (40%/40%/20%) + 3-Level TP (40%/40%/20%) + 2-Level SL (50%/50%)
 * bracket execution ladder.
 *
 * For qty >= 5, splits cleanly into 4 bracket legs so:
 *  - Entries: Level 1 Market (40%), Level 2 Dip Limit (40% = 10% + 30%), Level 3 Dip Limit (20%)
 *  - Take-Profits: TP1 (40%), TP2 (40%), TP3 (20%)
 *  - Stop-Losses: SL1 (50% = 40% + 10%), SL2 (50% = 30% + 20%)
 *
 * For smaller share counts (qty 1..4), collapses cleanly without zero-share legs.
 */
export function buildScaledOrderPlan({ price, qty, side }) {
  const isBuy = side === "buy";
  const round2 = (n) => Number(n.toFixed(2));
  const dir = isBuy ? 1 : -1;

  const entry1 = round2(price);
  const entry2 = round2(price * (1 - dir * (CONFIG.ENTRY_DIP_2_PCT / 100)));
  const entry3 = round2(price * (1 - dir * (CONFIG.ENTRY_DIP_3_PCT / 100)));

  const sl1Pct = CONFIG.STOP_LOSS_1_PCT;
  const sl2Pct = Math.max(CONFIG.STOP_LOSS_2_PCT, sl1Pct + 0.2);
  const tp1Pct = CONFIG.TP1_PCT;
  const tp2Pct = Math.max(CONFIG.TP2_PCT, sl2Pct * CONFIG.MIN_REWARD_RISK_RATIO);
  const tp3Pct = Math.max(CONFIG.TP3_PCT, tp2Pct + 0.8);

  const calcTp = (base, pct) => round2(base * (1 + dir * (pct / 100)));
  const calcSl = (base, pct) => round2(base * (1 - dir * (pct / 100)));

  if (qty <= 1) {
    return [
      {
        label: "E1/TP2/SL1",
        qty: 1,
        limitPrice: null,
        entryPrice: entry1,
        takeProfitPrice: calcTp(entry1, tp2Pct),
        stopLossPrice: calcSl(entry1, sl1Pct),
      },
    ];
  }

  if (qty === 2) {
    return [
      {
        label: "E1/TP1/SL1",
        qty: 1,
        limitPrice: null,
        entryPrice: entry1,
        takeProfitPrice: calcTp(entry1, tp1Pct),
        stopLossPrice: calcSl(entry1, sl1Pct),
      },
      {
        label: "E2/TP2/SL2",
        qty: 1,
        limitPrice: entry2,
        entryPrice: entry2,
        takeProfitPrice: calcTp(entry2, tp2Pct),
        stopLossPrice: calcSl(entry2, sl2Pct),
      },
    ];
  }

  if (qty === 3) {
    return [
      {
        label: "E1/TP1/SL1",
        qty: 1,
        limitPrice: null,
        entryPrice: entry1,
        takeProfitPrice: calcTp(entry1, tp1Pct),
        stopLossPrice: calcSl(entry1, sl1Pct),
      },
      {
        label: "E2/TP2/SL1",
        qty: 1,
        limitPrice: entry2,
        entryPrice: entry2,
        takeProfitPrice: calcTp(entry2, tp2Pct),
        stopLossPrice: calcSl(entry2, sl1Pct),
      },
      {
        label: "E3/TP3/SL2",
        qty: 1,
        limitPrice: entry3,
        entryPrice: entry3,
        takeProfitPrice: calcTp(entry3, tp3Pct),
        stopLossPrice: calcSl(entry3, sl2Pct),
      },
    ];
  }

  // General split for qty >= 4:
  // TP1 = 40%, TP2 = 40%, TP3 = 20%
  // SL1 = 50% (TP1 40% + 10% of TP2), SL2 = 50% (30% of TP2 + TP3 20%)
  const tp1Qty = Math.max(1, Math.round(qty * 0.4));
  const tp3Qty = Math.max(1, Math.round(qty * 0.2));
  const tp2Qty = Math.max(1, qty - tp1Qty - tp3Qty);

  const targetSl1Qty = Math.round(qty * 0.5);
  const tp2Sl1Qty = Math.max(0, Math.min(tp2Qty, targetSl1Qty - tp1Qty));
  const tp2Sl2Qty = tp2Qty - tp2Sl1Qty;

  const legs = [
    {
      label: "E1/TP1/SL1",
      qty: tp1Qty,
      limitPrice: null,
      entryPrice: entry1,
      takeProfitPrice: calcTp(entry1, tp1Pct),
      stopLossPrice: calcSl(entry1, sl1Pct),
    },
  ];

  if (tp2Sl1Qty > 0) {
    legs.push({
      label: "E2/TP2/SL1",
      qty: tp2Sl1Qty,
      limitPrice: entry2,
      entryPrice: entry2,
      takeProfitPrice: calcTp(entry2, tp2Pct),
      stopLossPrice: calcSl(entry2, sl1Pct),
    });
  }

  if (tp2Sl2Qty > 0) {
    legs.push({
      label: "E2/TP2/SL2",
      qty: tp2Sl2Qty,
      limitPrice: entry2,
      entryPrice: entry2,
      takeProfitPrice: calcTp(entry2, tp2Pct),
      stopLossPrice: calcSl(entry2, sl2Pct),
    });
  }

  if (tp3Qty > 0) {
    legs.push({
      label: "E3/TP3/SL2",
      qty: tp3Qty,
      limitPrice: entry3,
      entryPrice: entry3,
      takeProfitPrice: calcTp(entry3, tp3Pct),
      stopLossPrice: calcSl(entry3, sl2Pct),
    });
  }

  return legs;
}

/**
 * Evaluate signals with risk-aware verification and execute 3-level scaled
 * entry/TP + 2-level SL bracket orders on the active broker.
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
      return {
        entryPrice: null,
        takeProfitPrice: null,
        stopLoss1Price: null,
        stopLoss2Price: null,
        stopLossPrice: null,
      };
    }
    const sl1Pct = CONFIG.STOP_LOSS_1_PCT;
    const sl2Pct = Math.max(CONFIG.STOP_LOSS_2_PCT, sl1Pct + 0.2);
    // Enforce reward-to-risk ratio >= 2:1 (profit side at least 2x wider than max SL)
    const tpPct = Math.max(
      CONFIG.TAKE_PROFIT_PCT,
      sl2Pct * CONFIG.MIN_REWARD_RISK_RATIO
    );
    const isBuy = action === "BUY";

    const takeProfitPrice = Number(
      (price * (isBuy ? 1 + tpPct / 100 : 1 - tpPct / 100)).toFixed(2)
    );
    const stopLoss1Price = Number(
      (price * (isBuy ? 1 - sl1Pct / 100 : 1 + sl1Pct / 100)).toFixed(2)
    );
    const stopLoss2Price = Number(
      (price * (isBuy ? 1 - sl2Pct / 100 : 1 + sl2Pct / 100)).toFixed(2)
    );

    return {
      entryPrice: Number(price.toFixed(2)),
      takeProfitPrice,
      stopLoss1Price,
      stopLoss2Price,
      stopLossPrice: stopLoss1Price,
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

      // Risk-capped position sizing: never exceed MAX_TRADE_ALLOCATION_USD OR MAX_RISK_PER_TRADE_USD
      const avgStopPct = (CONFIG.STOP_LOSS_1_PCT + CONFIG.STOP_LOSS_2_PCT) / 2;
      const riskPerShare = price * (avgStopPct / 100);
      const qtyByBudget = Math.floor(allocation / price);
      const qtyByRisk =
        riskPerShare > 0
          ? Math.floor(CONFIG.MAX_RISK_PER_TRADE_USD / riskPerShare)
          : qtyByBudget;
      const qty = Math.min(qtyByBudget, Math.max(1, qtyByRisk));

      if (qty <= 0) {
        enrichedSignals.push({
          ...signal,
          ...liveTargets,
          safetyScore: verification.safetyScore,
          execution: "SKIPPED (Qty 0)",
        });
        continue;
      }

      const legs = buildScaledOrderPlan({ price, qty, side });
      const placedOrders = [];

      for (const leg of legs) {
        const order = await broker.placeMarketOrder({
          symbol: ticker,
          qty: leg.qty,
          side,
          limitPrice: leg.limitPrice,
          takeProfitPrice: leg.takeProfitPrice,
          stopLossPrice: leg.stopLossPrice,
        });
        placedOrders.push({ ...leg, id: order.id, status: order.status });
      }

      availableCash = Math.max(0, availableCash - qty * price);
      openPositionCount += 1;
      openPositionSymbols.add(ticker);

      const execLabel = `${side.toUpperCase()} ${qty} (${legs.length}L) @ ~$${price.toFixed(2)}`;
      const legSummary = placedOrders
        .map((l) => `${l.label}:${l.qty}@$${l.entryPrice}(TP$${l.takeProfitPrice}/SL$${l.stopLossPrice})`)
        .join(" | ");
      events.push(
        `SCALED ORDER [${broker.id.toUpperCase()} | Score ${verification.safetyScore}]: ${ticker} -> ${legSummary}`
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
