import Alpaca from "@alpacahq/alpaca-trade-api";
import { CONFIG } from "../../config.js";

let client = null;

function getClient() {
  if (!client) {
    client = new Alpaca({
      keyId: CONFIG.ALPACA_API_KEY_ID,
      secretKey: CONFIG.ALPACA_API_SECRET_KEY,
      paper: CONFIG.ALPACA_PAPER,
    });
  }
  return client;
}

export const alpacaBroker = {
  id: "alpaca",
  name: CONFIG.ALPACA_PAPER ? "ALPACA PAPER" : "ALPACA LIVE",

  async getAccountSummary() {
    const account = await getClient().getAccount();
    return {
      cash: Number(account.cash ?? 0),
      buyingPower: Number(account.buying_power ?? 0),
      portfolioValue: Number(account.portfolio_value ?? 0),
      equity: Number(account.equity ?? 0),
      status: account.status || "ACTIVE",
    };
  },

  async getOpenPositions() {
    const positions = await getClient().getPositions();
    return positions.map((pos) => ({
      symbol: pos.symbol,
      qty: Number(pos.qty ?? 0),
      side: pos.side || (Number(pos.qty) >= 0 ? "long" : "short"),
      entryPrice: Number(pos.avg_entry_price ?? 0),
      currentPrice: Number(pos.current_price ?? 0),
      unrealizedPl: Number(pos.unrealized_pl ?? 0),
      unrealizedPlpc: Number(pos.unrealized_plpc ?? 0) * 100,
    }));
  },

  async getOpenOrderSymbols() {
    const orders = await getClient().getOrders({ status: "open" });
    return new Set(orders.map((o) => o.symbol));
  },

  async getLatestPrice(symbol) {
    const trade = await getClient().getLatestTrade(symbol);
    return Number(trade?.Price ?? trade?.p ?? 0);
  },

  async getClosedStats() {
    const activities = await getClient().getAccountActivities({
      activityTypes: "FILL",
      pageSize: 100,
    });
    const sorted = [...activities].sort(
      (a, b) => new Date(a.transaction_time) - new Date(b.transaction_time)
    );
    const state = {};
    const closed = [];

    for (const fill of sorted) {
      const sym = fill.symbol;
      if (!state[sym]) state[sym] = { qty: 0, cashFlow: 0 };
      const s = state[sym];
      const q = Number(fill.qty);
      const p = Number(fill.price);
      s.qty += fill.side === "buy" ? q : -q;
      s.cashFlow += fill.side === "buy" ? -(q * p) : q * p;

      if (Math.abs(s.qty) < 1e-9) {
        closed.push(Number(s.cashFlow.toFixed(2)));
        state[sym] = { qty: 0, cashFlow: 0 };
      }
    }

    const wins = closed.filter((v) => v > 0);
    const losses = closed.filter((v) => v < 0);
    const grossGain = wins.reduce((sum, v) => sum + v, 0);
    const grossLoss = losses.reduce((sum, v) => sum + v, 0);
    return {
      total: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      grossGain: Number(grossGain.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      netPnL: Number((grossGain + grossLoss).toFixed(2)),
    };
  },

  async placeMarketOrder({
    symbol,
    qty,
    side,
    limitPrice = null,
    takeProfitPrice,
    stopLossPrice,
  }) {
    const payload = {
      symbol,
      qty,
      side,
      type: limitPrice ? "limit" : "market",
      time_in_force: "day",
    };

    if (limitPrice) {
      payload.limit_price = Number(limitPrice.toFixed(2));
    }

    if (takeProfitPrice && stopLossPrice) {
      payload.order_class = "bracket";
      payload.take_profit = { limit_price: Number(takeProfitPrice.toFixed(2)) };
      payload.stop_loss = { stop_price: Number(stopLossPrice.toFixed(2)) };
    }

    const order = await getClient().createOrder(payload);
    return { id: order.id, status: order.status || "accepted" };
  },
};
