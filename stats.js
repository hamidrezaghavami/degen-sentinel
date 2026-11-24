import chalk from "chalk";
import Table from "cli-table3";
import { loadLedger } from "./services/brokers/paper.js";

const ledger = loadLedger();
const closed = ledger.closedTrades || [];
const wins = closed.filter((t) => t.pnl > 0);
const losses = closed.filter((t) => t.pnl < 0);

const grossGain = wins.reduce((s, t) => s + t.pnl, 0);
const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);
const netPnL = grossGain + grossLoss;
const winRate = closed.length > 0 ? ((wins.length / closed.length) * 100).toFixed(1) : "0.0";

console.log(chalk.cyan.bold("\n=== DEGEN-SENTINEL :: EXACT LOCAL PAPER LEDGER ===\n"));

const summary = new Table({
  head: [
    chalk.cyan("Starting Cash"),
    chalk.cyan("Current Cash"),
    chalk.cyan("Open Legs"),
    chalk.cyan("Pending Limits"),
  ],
});
summary.push([
  `$${ledger.startingCash.toFixed(2)}`,
  `$${ledger.cash.toFixed(2)}`,
  String(ledger.positions.length),
  String(ledger.openOrders.length),
]);
console.log(summary.toString());

const perf = new Table({
  head: [
    chalk.cyan("Closed Trades"),
    chalk.cyan("Wins / Losses"),
    chalk.cyan("Win Rate"),
    chalk.cyan("Gross Gain"),
    chalk.cyan("Gross Loss"),
    chalk.cyan("Net P/L"),
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
  console.log(chalk.bold("\nRecent Closed Trades:"));
  const table = new Table({
    head: [
      chalk.cyan("Ticker"),
      chalk.cyan("Side"),
      chalk.cyan("Qty"),
      chalk.cyan("Entry"),
      chalk.cyan("Exit"),
      chalk.cyan("Reason"),
      chalk.cyan("P/L"),
    ],
  });
  for (const t of closed.slice(-15)) {
    table.push([
      chalk.white.bold(t.symbol),
      t.side,
      String(t.qty),
      `$${t.entryPrice.toFixed(2)}`,
      `$${t.exitPrice.toFixed(2)}`,
      t.exitReason === "TP" ? chalk.green("TP") : chalk.red("SL"),
      t.pnl >= 0 ? chalk.green(`+$${t.pnl.toFixed(2)}`) : chalk.red(`-$${Math.abs(t.pnl).toFixed(2)}`),
    ]);
  }
  console.log(table.toString());
}
console.log();
