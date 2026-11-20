import { CONFIG } from "../../config.js";

/**
 * Tradier Brokerage REST API Adapter (Sandbox & Production)
 */
async function tradierFetch(path, options = {}) {
  const baseUrl = CONFIG.TRADIER_SANDBOX
    ? "https://sandbox.tradier.com/v1"
    : "https://api.tradier.com/v1";

  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${CONFIG.TRADIER_ACCESS_TOKEN}`,
      Accept: "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tradier API HTTP ${res.status}: ${text.slice(0, 120) || res.statusText}`);
  }
  return res.json();
}

export const tradierBroker = {
  id: "tradier",
  name: CONFIG.TRADIER_SANDBOX ? "TRADIER SANDBOX" : "TRADIER LIVE",

  async getAccountSummary() {
    const data = await tradierFetch(`/accounts/${CONFIG.TRADIER_ACCOUNT_ID}/balances`);
    const b = data?.balances ?? {};
    const buyingPower = Number(
      b?.margin?.stock_buying_power ?? b?.cash?.cash_available ?? b?.total_cash ?? 0
    );
    return {
      cash: Number(b.total_cash ?? 0),
      buyingPower,
      portfolioValue: Number(b.total_equity ?? 0),
      equity: Number(b.total_equity ?? 0),
      status: "ACTIVE",
    };
  },

  async getOpenPositions() {
    const data = await tradierFetch(`/accounts/${CONFIG.TRADIER_ACCOUNT_ID}/positions`);
    const raw = data?.positions?.position;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];

    return list.map((pos) => {
      const qty = Number(pos.quantity ?? 0);
      const costBasis = Number(pos.cost_basis ?? 0);
      const entryPrice = qty !== 0 ? Math.abs(costBasis / qty) : 0;
      const currentPrice = Number(pos.last ?? entryPrice);
      const unrealizedPl = (currentPrice - entryPrice) * qty;
      const unrealizedPlpc = costBasis > 0 ? (unrealizedPl / Math.abs(costBasis)) * 100 : 0;

      return {
        symbol: pos.symbol,
        qty,
        side: qty >= 0 ? "long" : "short",
        entryPrice,
        currentPrice,
        unrealizedPl,
        unrealizedPlpc,
      };
    });
  },

  async getOpenOrderSymbols() {
    const data = await tradierFetch(`/accounts/${CONFIG.TRADIER_ACCOUNT_ID}/orders`);
    const raw = data?.orders?.order;
    if (!raw) return new Set();
    const list = Array.isArray(raw) ? raw : [raw];

    return new Set(
      list
        .filter((o) => ["open", "pending", "partially_filled"].includes(o.status))
        .map((o) => o.symbol)
        .filter(Boolean)
    );
  },

  async getLatestPrice(symbol) {
    const data = await tradierFetch(`/markets/quotes?symbols=${encodeURIComponent(symbol)}`);
    const quote = data?.quotes?.quote;
    return Number(quote?.last ?? quote?.close ?? 0);
  },

  async placeMarketOrder({ symbol, qty, side }) {
    const body = new URLSearchParams({
      class: "equity",
      symbol,
      side: side === "buy" ? "buy" : "sell_short",
      quantity: String(qty),
      type: "market",
      duration: "day",
    });

    const data = await tradierFetch(`/accounts/${CONFIG.TRADIER_ACCOUNT_ID}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const order = data?.order ?? {};
    return {
      id: String(order.id ?? "tradier-order"),
      status: order.status || "ok",
    };
  },
};
