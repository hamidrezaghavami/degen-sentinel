import http from "node:http";
import { loadLedger, paperBroker } from "./services/brokers/paper.js";

const PORT = Number(process.env.WEB_PORT) || 3131;

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMoney(n) {
  const num = Number(n ?? 0);
  const abs = Math.abs(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `-$${abs}` : `$${abs}`;
}

function fmtSigned(n) {
  const num = Number(n ?? 0);
  return num > 0 ? `+${fmtMoney(num)}` : fmtMoney(num);
}

async function getSnapshot() {
  const [account, positions] = await Promise.all([
    paperBroker.getAccountSummary(),
    paperBroker.getOpenPositions(),
  ]);
  const ledger = loadLedger();
  const closed = ledger.closedTrades || [];
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const grossGain = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);
  const netReturn = account.equity - ledger.startingCash;
  const netReturnPct =
    ledger.startingCash > 0 ? (netReturn / ledger.startingCash) * 100 : 0;
  const winRate =
    closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : "0.0";

  return {
    updatedAt: new Date().toLocaleTimeString("en-US", { hour12: false }),
    startingCash: ledger.startingCash,
    account,
    positions,
    rawLegs: ledger.positions || [],
    openOrders: ledger.openOrders || [],
    closed,
    stats: {
      wins: wins.length,
      losses: losses.length,
      winRate,
      grossGain,
      grossLoss,
      netReturn,
      netReturnPct,
    },
  };
}

function renderHtml(data) {
  const { account, positions, openOrders, closed, stats, startingCash, updatedAt } = data;
  const retClass = stats.netReturn >= 0 ? "pos" : "neg";

  const posRows = positions.length
    ? positions
        .map(
          (p) => `<tr>
            <td><strong>${escapeHtml(p.symbol)}</strong></td>
            <td><span class="badge ${p.side === "long" ? "buy" : "short"}">${p.side.toUpperCase()}</span></td>
            <td>${p.qty}</td>
            <td>${fmtMoney(p.entryPrice)}</td>
            <td>${fmtMoney(p.currentPrice)}</td>
            <td class="${p.unrealizedPl >= 0 ? "pos" : "neg"}">${fmtSigned(p.unrealizedPl)} (${p.unrealizedPlpc >= 0 ? "+" : ""}${p.unrealizedPlpc.toFixed(2)}%)</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="muted">No open positions yet — run <code>./run.sh</code> to scan live signals.</td></tr>`;

  const orderRows = openOrders.length
    ? openOrders
        .map(
          (o) => `<tr>
            <td><strong>${escapeHtml(o.symbol)}</strong></td>
            <td><span class="badge ${o.side === "buy" ? "buy" : "short"}">${o.side.toUpperCase()} LIMIT</span></td>
            <td>${o.qty}</td>
            <td>${fmtMoney(o.limitPrice)}</td>
            <td class="pos">${o.takeProfitPrice ? fmtMoney(o.takeProfitPrice) : "-"}</td>
            <td class="neg">${o.stopLossPrice ? fmtMoney(o.stopLossPrice) : "-"}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="muted">No pending dip limit orders.</td></tr>`;

  const closedRows = closed.length
    ? [...closed]
        .reverse()
        .slice(0, 25)
        .map(
          (t) => `<tr>
            <td><strong>${escapeHtml(t.symbol)}</strong></td>
            <td>${escapeHtml(t.side)}</td>
            <td>${t.qty}</td>
            <td>${fmtMoney(t.entryPrice)}</td>
            <td>${fmtMoney(t.exitPrice)}</td>
            <td><span class="badge ${t.exitReason === "TP" ? "buy" : "neg-bg"}">${escapeHtml(t.exitReason)}</span></td>
            <td class="${t.pnl >= 0 ? "pos" : "neg"}">${fmtSigned(t.pnl)}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="muted">No closed trades recorded yet.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="refresh" content="10" />
  <title>degen-sentinel :: Local Paper Broker</title>
  <style>
    :root { --bg: #0b0f17; --card: #131a26; --border: #233044; --text: #e6edf7; --muted: #8b9bb4; --green: #22c55e; --red: #ef4444; --accent: #38bdf8; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 24px; }
    .wrap { max-width: 1080px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 14px; }
    h1 { margin: 0; font-size: 20px; letter-spacing: .5px; }
    .pill { background: rgba(34,197,94,.15); color: var(--green); border: 1px solid rgba(34,197,94,.35); padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
    .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .6px; }
    .val { font-size: 22px; font-weight: 700; margin-top: 6px; }
    .sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .pos { color: var(--green); }
    .neg { color: var(--red); }
    .muted { color: var(--muted); text-align: center; padding: 18px; }
    section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 18px; }
    h2 { margin: 0 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: .7px; color: var(--accent); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
    tr:last-child td { border-bottom: none; }
    .badge { padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .buy { background: rgba(34,197,94,.15); color: var(--green); }
    .short, .neg-bg { background: rgba(239,68,68,.15); color: var(--red); }
    code { background: #1e293b; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>DEGEN-SENTINEL :: LOCAL PAPER BROKER</h1>
        <div class="sub">100% Penny-Accurate Ledger (<code>data/paper-ledger.json</code>) • Auto-refreshes every 10s • Updated ${escapeHtml(updatedAt)}</div>
      </div>
      <span class="pill">EXACT PAPER MODE</span>
    </header>

    <div class="grid">
      <div class="card">
        <div class="label">Portfolio Equity</div>
        <div class="val">${fmtMoney(account.equity)}</div>
        <div class="sub ${retClass}">${fmtSigned(stats.netReturn)} (${stats.netReturnPct >= 0 ? "+" : ""}${stats.netReturnPct.toFixed(2)}%)</div>
      </div>
      <div class="card">
        <div class="label">Available Cash</div>
        <div class="val">${fmtMoney(account.cash)}</div>
        <div class="sub">Start: ${fmtMoney(startingCash)}</div>
      </div>
      <div class="card">
        <div class="label">Win Rate</div>
        <div class="val">${stats.winRate}%</div>
        <div class="sub"><span class="pos">${stats.wins}W</span> / <span class="neg">${stats.losses}L</span> (${closed.length} closed)</div>
      </div>
      <div class="card">
        <div class="label">Gross Gain</div>
        <div class="val pos">+${fmtMoney(stats.grossGain)}</div>
        <div class="sub">Winning legs</div>
      </div>
      <div class="card">
        <div class="label">Gross Loss</div>
        <div class="val neg">${fmtMoney(stats.grossLoss)}</div>
        <div class="sub">Stopped legs</div>
      </div>
    </div>

    <section>
      <h2>Open Positions (${positions.length})</h2>
      <table>
        <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg Entry</th><th>Live Price</th><th>Unrealized P/L</th></tr></thead>
        <tbody>${posRows}</tbody>
      </table>
    </section>

    <section>
      <h2>Pending Dip Limit Orders (${openOrders.length})</h2>
      <table>
        <thead><tr><th>Symbol</th><th>Type</th><th>Qty</th><th>Limit Entry</th><th>Take-Profit</th><th>Stop-Loss</th></tr></thead>
        <tbody>${orderRows}</tbody>
      </table>
    </section>

    <section>
      <h2>Closed Trade History (${closed.length})</h2>
      <table>
        <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Trigger</th><th>Realized P/L</th></tr></thead>
        <tbody>${closedRows}</tbody>
      </table>
    </section>
  </div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/snapshot") {
      const snap = await getSnapshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snap));
      return;
    }

    const snap = await getSnapshot();
    const html = renderHtml(snap);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Error loading paper ledger: ${err.message}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`degen-sentinel Local Paper Broker UI running at http://localhost:${PORT}`);
});
