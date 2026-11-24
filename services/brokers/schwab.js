import { CONFIG } from "../../config.js";

/**
 * Charles Schwab Trader API Adapter
 * Uses official Schwab OAuth Bearer access token & encrypted account hash.
 */
const SCHWAB_BASE_URL = "https://api.schwabapi.com/trader/v1";

async function schwabFetch(path, options = {}) {
  const res = await fetch(`${SCHWAB_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${CONFIG.SCHWAB_ACCESS_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Schwab API HTTP ${res.status}: ${text.slice(0, 120) || res.statusText}`);
  }

  if (res.status === 201 || res.status === 204) {
    const location = res.headers.get("location") || "";
    const orderId = location.split("/").pop() || "schwab-order";
    return { id: orderId, status: "submitted" };
  }

  return res.json();
}

export const schwabBroker = {
  id: "schwab",
  name: "CHARLES SCHWAB",

  async getAccountSummary() {
    const data = await schwabFetch(`/accounts/${CONFIG.SCHWAB_ACCOUNT_HASH}`);
    const b = data?.securitiesAccount?.currentBalances ?? {};
    return {
      cash: Number(b.cashBalance ?? 0),
      buyingPower: Number(b.buyingPower ?? b.cashAvailableForTrading ?? 0),
      portfolioValue: Number(b.liquidationValue ?? 0),
      equity: Number(b.equity ?? b.liquidationValue ?? 0),
      status: "ACTIVE",
    };
  },

  async getOpenPositions() {
    const data = await schwabFetch(
      `/accounts/${CONFIG.SCHWAB_ACCOUNT_HASH}?fields=positions`
    );
    const positions = data?.securitiesAccount?.positions ?? [];

    return positions.map((pos) => {
      const longQty = Number(pos.longQuantity ?? 0);
      const shortQty = Number(pos.shortQuantity ?? 0);
      const qty = longQty > 0 ? longQty : -shortQty;
      const entryPrice = Number(pos.averagePrice ?? 0);
      const marketValue = Number(pos.marketValue ?? 0);
      const currentPrice = qty !== 0 ? Math.abs(marketValue / qty) : entryPrice;
      const unrealizedPl = Number(pos.longOpenProfitLoss ?? pos.shortOpenProfitLoss ?? 0);
      const costBasis = Math.abs(entryPrice * qty);
      const unrealizedPlpc = costBasis > 0 ? (unrealizedPl / costBasis) * 100 : 0;

      return {
        symbol: pos.instrument?.symbol || "UNKNOWN",
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
    const orders = await schwabFetch(
      `/accounts/${CONFIG.SCHWAB_ACCOUNT_HASH}/orders?status=WORKING`
    );
    if (!Array.isArray(orders)) return new Set();

    const symbols = new Set();
    for (const order of orders) {
      for (const leg of order.orderLegCollection ?? []) {
        if (leg?.instrument?.symbol) {
          symbols.add(leg.instrument.symbol);
        }
      }
    }
    return symbols;
  },

  async getLatestPrice() {
    return 0;
  },

  async placeMarketOrder({ symbol, qty, side, limitPrice = null }) {
    const payload = {
      orderType: limitPrice ? "LIMIT" : "MARKET",
      session: "NORMAL",
      duration: "DAY",
      orderStrategyType: "SINGLE",
      ...(limitPrice ? { price: Number(limitPrice.toFixed(2)) } : {}),
      orderLegCollection: [
        {
          instruction: side === "buy" ? "BUY" : "SELL_SHORT",
          quantity: qty,
          instrument: {
            symbol,
            assetType: "EQUITY",
          },
        },
      ],
    };

    return schwabFetch(`/accounts/${CONFIG.SCHWAB_ACCOUNT_HASH}/orders`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};
