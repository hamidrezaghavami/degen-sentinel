import chalk from "chalk";
import Table from "cli-table3";
import Alpaca from "@alpacahq/alpaca-trade-api";
import { CONFIG } from "./config.js";
import { loadLedger } from "./services/brokers/paper.js";

function renderStats({ title, startingCash, currentEquity, cash, openCount, closed }) {
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const grossGain = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);
  const netPnL = grossGain + grossLoss;
  const winRate = closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : "0.0";

  console.log(chalk.cyan.bold(`\n=== DEGEN-SENTINEL :: ${title} ===\n`));

  const summary = new Table({
    head: [
      chalk.cyan("Starting / Ref"),
      chalk.cyan("Current Equity"),
      chalk.cyan("Cash"),
      chalk.cyan("Open Positions"),
    ],
  });
  summary.push([
    `$${Number(startingCash).toFixed(2)}`,
    `$${Number(currentEquity).toFixed(2)}`,
    `$${Number(cash).toFixed(2)}`,
    String(openCount),
  ]);
  console.log(summary.toString());

  const perf = new Table({
    head: [
      chalk.cyan("Closed Positions"),
      chalk.cyan("Wins / Losses"),
      chalk.cyan("Win Rate"),
      chalk.cyan("Gross Gain"),
      chalk.cyan("Gross Loss"),
      chalk.cyan("Exact Fill P/L"),
    ],
  });
  perf.push([
    String(closed.length),
    `${chalk.green(wins.length)}W / ${chalk.red(losses.length)}L`,
    `${winRate}%`,
    chalk.green(`+$${grossGain.toFixed(2)}`),
    chalk.red(`-$${Math.abs(grossLoss).toFixed(2)}`),
    netPnL >= 0 ? chalk.green(`+$${netPnL.toFixed(2)}`) : chalk.red(`-$${Math.abs(netPnL).toFixed(2)}`),
  ]);
  console.log(perf.toString());

  if (closed.length > 0) {
    console.log(chalk.bold("\nRecent Closed Positions (from real broker fills):"));
    const table = new Table({
      head: [
        chalk.cyan("Ticker"),
        chalk.cyan("Side"),
        chalk.cyan("P/L"),
      ],
    });
    for (const t of closed.slice(-15)) {
      table.push([
        chalk.white.bold(t.symbol),
        t.side,
        t.pnl >= 0
          ? chalk.green(`+$${t.pnl.toFixed(2)}`)
          : chalk.red(`-$${Math.abs(t.pnl).toFixed(2)}`),
      ]);
    }
    console.log(table.toString());
  }
  console.log();
}

async function main() {
  if (CONFIG.BROKER === "alpaca") {
    const alpaca = new Alpaca({
      keyId: CONFIG.ALPACA_API_KEY_ID,
      secretKey: CONFIG.ALPACA_API_SECRET_KEY,
      paper: CONFIG.ALPACA_PAPER,
    });

    const [acct, positions, activities] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
      alpaca.getAccountActivities({ activityTypes: "FILL", pageSize: 100 }),
    ]);

    const sorted = [...activities].sort(
      (a, b) => new Date(a.transaction_time) - new Date(b.transaction_time)
    );
    const state = {};
    const closed = [];

    for (const fill of sorted) {
      const sym = fill.symbol;
      if (!state[sym]) state[sym] = { qty: 0, cashFlow: 0, side: null };
      const s = state[sym];
      const q = Number(fill.qty);
      const p = Number(fill.price);
      if (s.qty === 0) s.side = fill.side === "buy" ? "LONG" : "SHORT";
      s.qty += fill.side === "buy" ? q : -q;
      s.cashFlow += fill.side === "buy" ? -(q * p) : q * p;

      if (Math.abs(s.qty) < 1e-9) {
        closed.push({ symbol: sym, side: s.side, pnl: Number(s.cashFlow.toFixed(2)) });
        state[sym] = { qty: 0, cashFlow: 0, side: null };
      }
    }

    renderStats({
      title: CONFIG.ALPACA_PAPER ? "ALPACA PAPER (EXACT FILLS)" : "ALPACA LIVE",
      startingCash: 100000,
      currentEquity: Number(acct.equity ?? 0),
      cash: Number(acct.cash ?? 0),
      openCount: positions.length,
      closed,
    });
    return;
  }

  const ledger = loadLedger();
  renderStats({
    title: "LOCAL PAPER LEDGER",
    startingCash: ledger.startingCash,
    currentEquity: ledger.cash,
    cash: ledger.cash,
    openCount: (ledger.positions || []).length,
    closed: ledger.closedTrades || [],
  });
}

main().catch((err) => {
  console.error(chalk.red(`Stats error: ${err.message}`));
  process.exit(1);
});
