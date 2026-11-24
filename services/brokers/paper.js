import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YahooFinanceModule from "yahoo-finance2";
import { CONFIG } from "../../config.js";

const yahooFinance =
  typeof YahooFinanceModule === "function"
    ? new YahooFinanceModule({ suppressNotices: ["yahooSurvey"] })
    : YahooFinanceModule;

if (typeof yahooFinance.suppressNotices === "function") {
  yahooFinance.suppressNotices(["yahooSurvey"]);
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const LEDGER_PATH = path.join(DATA_DIR, "paper-ledger.json");

const round2 = (n) => Number(Number(n).toFixed(2));

function createInitialLedger() {
  const startCash = round2(CONFIG.PAPER_STARTING_CASH);
  return {
    createdAt: new Date().toISOString(),
    startingCash: startCash,
    cash: startCash,
    openOrders: [], // Pending limit entries awaiting dip fill
    positions: [], // Active bracket legs with exact entryPrice, takeProfitPrice, stopLossPrice
    closedTrades: [], // Exact penny-accurate closed trade history
  };
}

export function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      const raw = fs.readFileSync(LEDGER_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.cash === "number") {
        return parsed;
      }
    }
  } catch {
    // Fall through to recreate fresh ledger if unreadable
  }
  const fresh = createInitialLedger();
  saveLedger(fresh);
  return fresh;
}

function saveLedger(ledger) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

async function fetchLivePrice(symbol) {
  const quote = await yahooFinance.quote(symbol);
  const price = Number(
    quote?.regularMarketPrice ?? quote?.postMarketPrice ?? quote?.preMarketPrice
  );
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`No live price available for ${symbol}`);
  }
  return round2(price);
}

/**
 * Mark-to-market all pending limit entries and open bracket positions against live prices.
 * Fills limit dip entries and triggers exact TP/SL exits automatically.
 */
async function syncLedgerWithMarket(ledger) {
  const symbols = new Set([
    ...ledger.openOrders.map((o) => o.symbol),
    ...ledger.positions.map((p) => p.symbol),
  ]);

  if (symbols.size === 0) return {};

  const priceMap = {};
  await Promise.all(
    Array.from(symbols).map(async (sym) => {
      try {
        priceMap[sym] = await fetchLivePrice(sym);
      } catch {
        // Keep last known price if quote temporarily unavailable
      }
    })
  );

  let changed = false;

  // 1. Check pending limit dip entries
  const stillPending = [];
  for (const order of ledger.openOrders) {
    const live = priceMap[order.symbol];
    if (!live) {
      stillPending.push(order);
      continue;
    }

    const isBuy = order.side === "buy";
    const triggered = isBuy ? live <= order.limitPrice : live >= order.limitPrice;
    const cost = round2(order.qty * order.limitPrice);

    if (triggered && (!isBuy || ledger.cash >= cost)) {
      const fillPrice = order.limitPrice;
      ledger.cash = round2(isBuy ? ledger.cash - cost : ledger.cash + cost);
      ledger.positions.push({
        id: order.id,
        symbol: order.symbol,
        side: isBuy ? "long" : "short",
        qty: order.qty,
        entryPrice: fillPrice,
        currentPrice: live,
        takeProfitPrice: order.takeProfitPrice,
        stopLossPrice: order.stopLossPrice,
        openedAt: new Date().toISOString(),
      });
      changed = true;
    } else {
      stillPending.push(order);
    }
  }
  ledger.openOrders = stillPending;

  // 2. Check open positions for TP / SL triggers
  const stillOpen = [];
  for (const pos of ledger.positions) {
    const live = priceMap[pos.symbol] ?? pos.currentPrice ?? pos.entryPrice;
    pos.currentPrice = live;

    const isLong = pos.side === "long";
    let exitPrice = null;
    let exitReason = null;

    if (isLong) {
      if (pos.stopLossPrice && live <= pos.stopLossPrice) {
        exitPrice = pos.stopLossPrice;
        exitReason = "SL";
      } else if (pos.takeProfitPrice && live >= pos.takeProfitPrice) {
        exitPrice = pos.takeProfitPrice;
        exitReason = "TP";
      }
    } else {
      if (pos.stopLossPrice && live >= pos.stopLossPrice) {
        exitPrice = pos.stopLossPrice;
        exitReason = "SL";
      } else if (pos.takeProfitPrice && live <= pos.takeProfitPrice) {
        exitPrice = pos.takeProfitPrice;
        exitReason = "TP";
      }
    }

    if (exitPrice !== null) {
      const proceeds = round2(pos.qty * exitPrice);
      const pnl = round2(
        isLong
          ? (exitPrice - pos.entryPrice) * pos.qty
          : (pos.entryPrice - exitPrice) * pos.qty
      );
      ledger.cash = round2(isLong ? ledger.cash + proceeds : ledger.cash - proceeds);
      ledger.closedTrades.push({
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side.toUpperCase(),
        qty: pos.qty,
        entryPrice: pos.entryPrice,
        exitPrice,
        exitReason,
        pnl,
        openedAt: pos.openedAt,
        closedAt: new Date().toISOString(),
      });
      changed = true;
    } else {
      stillOpen.push(pos);
    }
  }
  ledger.positions = stillOpen;

  if (changed) {
    saveLedger(ledger);
  }

  return priceMap;
}

export const paperBroker = {
  id: "paper",
  name: "LOCAL PAPER (EXACT)",

  async getAccountSummary() {
    const ledger = loadLedger();
    await syncLedgerWithMarket(ledger);

    let positionsMarketValue = 0;
    for (const pos of ledger.positions) {
      const live = pos.currentPrice ?? pos.entryPrice;
      positionsMarketValue += pos.side === "long" ? pos.qty * live : -(pos.qty * live);
    }

    const equity = round2(ledger.cash + positionsMarketValue);
    return {
      cash: round2(ledger.cash),
      buyingPower: round2(Math.max(0, ledger.cash)),
      portfolioValue: equity,
      equity,
      status: "ACTIVE",
    };
  },

  async getOpenPositions() {
    const ledger = loadLedger();
    await syncLedgerWithMarket(ledger);

    // Aggregate tranches per symbol for clean dashboard display
    const grouped = new Map();
    for (const pos of ledger.positions) {
      const live = pos.currentPrice ?? pos.entryPrice;
      const signedQty = pos.side === "long" ? pos.qty : -pos.qty;
      const existing = grouped.get(pos.symbol);

      if (!existing) {
        grouped.set(pos.symbol, {
          symbol: pos.symbol,
          qty: signedQty,
          side: pos.side,
          totalCost: pos.entryPrice * pos.qty,
          absQty: pos.qty,
          currentPrice: live,
        });
      } else {
        existing.qty += signedQty;
        existing.totalCost += pos.entryPrice * pos.qty;
        existing.absQty += pos.qty;
        existing.currentPrice = live;
      }
    }

    return Array.from(grouped.values()).map((g) => {
      const entryPrice = g.absQty > 0 ? round2(g.totalCost / g.absQty) : 0;
      const unrealizedPl = round2((g.currentPrice - entryPrice) * g.qty);
      const basis = entryPrice * g.absQty;
      const unrealizedPlpc = basis > 0 ? (unrealizedPl / basis) * 100 : 0;
      return {
        symbol: g.symbol,
        qty: g.qty,
        side: g.qty >= 0 ? "long" : "short",
        entryPrice,
        currentPrice: g.currentPrice,
        unrealizedPl,
        unrealizedPlpc,
      };
    });
  },

  async getOpenOrderSymbols() {
    const ledger = loadLedger();
    return new Set(ledger.openOrders.map((o) => o.symbol));
  },

  async getLatestPrice(symbol) {
    return fetchLivePrice(symbol);
  },

  async placeMarketOrder({
    symbol,
    qty,
    side,
    limitPrice = null,
    takeProfitPrice,
    stopLossPrice,
  }) {
    const ledger = loadLedger();
    const id = `paper-${crypto.randomUUID().slice(0, 8)}`;
    const isBuy = side === "buy";

    if (limitPrice) {
      ledger.openOrders.push({
        id,
        symbol,
        side,
        qty,
        limitPrice: round2(limitPrice),
        takeProfitPrice: takeProfitPrice ? round2(takeProfitPrice) : null,
        stopLossPrice: stopLossPrice ? round2(stopLossPrice) : null,
        createdAt: new Date().toISOString(),
      });
      saveLedger(ledger);
      return { id, status: "accepted (limit)" };
    }

    const fillPrice = await fetchLivePrice(symbol);
    const cost = round2(qty * fillPrice);
    if (isBuy && ledger.cash < cost) {
      throw new Error(`Insufficient paper cash ($${ledger.cash.toFixed(2)} < $${cost.toFixed(2)})`);
    }

    ledger.cash = round2(isBuy ? ledger.cash - cost : ledger.cash + cost);
    ledger.positions.push({
      id,
      symbol,
      side: isBuy ? "long" : "short",
      qty,
      entryPrice: fillPrice,
      currentPrice: fillPrice,
      takeProfitPrice: takeProfitPrice ? round2(takeProfitPrice) : null,
      stopLossPrice: stopLossPrice ? round2(stopLossPrice) : null,
      openedAt: new Date().toISOString(),
    });
    saveLedger(ledger);

    return { id, status: "filled" };
  },
};
