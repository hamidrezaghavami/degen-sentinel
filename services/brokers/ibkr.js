import { CONFIG } from "../../config.js";

/**
 * Interactive Brokers (IBKR) Client Portal Web API Adapter
 * Requires IBKR Client Portal Gateway running locally (default: https://localhost:5000/v1/api).
 */
async function ibkrFetch(path, options = {}) {
  const baseUrl = CONFIG.IBKR_BASE_URL.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`IBKR API HTTP ${res.status}: ${text.slice(0, 120) || res.statusText}`);
  }
  return res.json();
}

async function resolveConid(symbol) {
  const results = await ibkrFetch(`/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`);
  const match = Array.isArray(results) ? results.find((r) => r.conid) : null;
  if (!match?.conid) {
    throw new Error(`IBKR could not resolve contract ID (conid) for ${symbol}`);
  }
  return Number(match.conid);
}

export const ibkrBroker = {
  id: "ibkr",
  name: "INTERACTIVE BROKERS (IBKR)",

  async getAccountSummary() {
    const acctId = CONFIG.IBKR_ACCOUNT_ID;
    const summary = await ibkrFetch(`/portfolio/${acctId}/summary`);
    return {
      cash: Number(summary?.totalcashvalue?.amount ?? 0),
      buyingPower: Number(summary?.buyingpower?.amount ?? 0),
      portfolioValue: Number(summary?.netliquidation?.amount ?? 0),
      equity: Number(summary?.netliquidation?.amount ?? 0),
      status: "ACTIVE",
    };
  },

  async getOpenPositions() {
    const acctId = CONFIG.IBKR_ACCOUNT_ID;
    const positions = await ibkrFetch(`/portfolio/${acctId}/positions/0`);
    if (!Array.isArray(positions)) return [];

    return positions.map((pos) => {
      const qty = Number(pos.position ?? 0);
      const entry = Number(pos.avgCost ?? 0);
      const current = Number(pos.mktPrice ?? 0);
      const unrealizedPl = Number(pos.unrealizedPnl ?? (current - entry) * qty);
      const costBasis = Math.abs(entry * qty);
      const unrealizedPlpc = costBasis > 0 ? (unrealizedPl / costBasis) * 100 : 0;

      return {
        symbol: pos.contractDesc || pos.ticker || String(pos.conid),
        qty,
        side: qty >= 0 ? "long" : "short",
        entryPrice: entry,
        currentPrice: current,
        unrealizedPl,
        unrealizedPlpc,
      };
    });
  },

  async getOpenOrderSymbols() {
    const data = await ibkrFetch("/iserver/account/orders");
    const orders = data?.orders ?? [];
    return new Set(
      orders
        .filter((o) => ["PreSubmitted", "Submitted", "PendingSubmit"].includes(o.status))
        .map((o) => o.ticker)
        .filter(Boolean)
    );
  },

  async getLatestPrice() {
    return 0;
  },

  async placeMarketOrder({ symbol, qty, side }) {
    const acctId = CONFIG.IBKR_ACCOUNT_ID;
    const conid = await resolveConid(symbol);

    const payload = {
      orders: [
        {
          acctId,
          conid,
          orderType: "MKT",
          side: side.toUpperCase(),
          quantity: qty,
          tif: "DAY",
        },
      ],
    };

    const result = await ibkrFetch(`/iserver/account/${acctId}/orders`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const first = Array.isArray(result) ? result[0] : result;
    // Auto-confirm IBKR order reply prompt if returned
    if (first?.id && first?.message) {
      const confirmed = await ibkrFetch(`/iserver/reply/${first.id}`, {
        method: "POST",
        body: JSON.stringify({ confirmed: true }),
      });
      const confirmedOrder = Array.isArray(confirmed) ? confirmed[0] : confirmed;
      return {
        id: confirmedOrder?.order_id || first.id,
        status: confirmedOrder?.order_status || "submitted",
      };
    }

    return {
      id: first?.order_id || "ibkr-order",
      status: first?.order_status || "submitted",
    };
  },
};
