import chalk from "chalk";
import Table from "cli-table3";

function formatMoney(value) {
  const num = Number(value ?? 0);
  const abs = Math.abs(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `-$${abs}` : `$${abs}`;
}

function formatPnl(value) {
  const num = Number(value ?? 0);
  const formatted = formatMoney(num);
  if (num > 0) return chalk.green(`+${formatted}`);
  if (num < 0) return chalk.red(formatted);
  return chalk.gray(formatted);
}

function formatAction(action) {
  switch (action) {
    case "BUY":
      return chalk.green.bold("BUY");
    case "SHORT":
      return chalk.magenta.bold("SHORT");
    case "SELL":
      return chalk.red.bold("SELL");
    default:
      return chalk.gray("HOLD");
  }
}

function formatSentiment(sentiment) {
  switch (sentiment) {
    case "EXTREME_BULLISH":
      return chalk.greenBright.bold(sentiment);
    case "BULLISH":
      return chalk.green(sentiment);
    case "EXTREME_BEARISH":
      return chalk.redBright.bold(sentiment);
    case "BEARISH":
      return chalk.red(sentiment);
    default:
      return chalk.yellow(sentiment || "NEUTRAL");
  }
}

/**
 * Render the entire terminal dashboard in a single stdout write to prevent flicker.
 */
export function renderDashboard({
  status = "RUNNING",
  cycle = 0,
  pollIntervalSeconds = 120,
  account = null,
  positions = [],
  signals = [],
  logs = [],
  lastUpdated = new Date(),
}) {
  const lines = [];

  const termWidth = Math.max(72, process.stdout.columns || 80);
  const boxWidth = Math.min(termWidth, 100);
  const innerWidth = boxWidth - 2;

  const statusText = ` ${status} `;
  const statusBadge =
    status === "ERROR"
      ? chalk.bgRed.white.bold(statusText)
      : status === "POLLING"
        ? chalk.bgYellow.black.bold(statusText)
        : chalk.bgGreen.black.bold(statusText);

  const timeStr = lastUpdated.toLocaleTimeString("en-US", { hour12: false });

  // Responsive Header (never wraps on 80-col terminals)
  const titlePlain =
    boxWidth >= 82
      ? " DEGEN-SENTINEL :: WSB Contrarian Paper Bot"
      : " DEGEN-SENTINEL :: WSB Paper Bot";
  const titleStyled =
    boxWidth >= 82
      ? " " + chalk.white.bold("DEGEN-SENTINEL") + chalk.gray(" :: WSB Contrarian Paper Bot")
      : " " + chalk.white.bold("DEGEN-SENTINEL") + chalk.gray(" :: WSB Paper Bot");
  const padLen = Math.max(1, innerWidth - titlePlain.length - statusText.length - 1);

  lines.push(chalk.cyan.bold("╔" + "═".repeat(innerWidth) + "╗"));
  lines.push(
    chalk.cyan.bold("║") +
      titleStyled +
      " ".repeat(padLen) +
      statusBadge +
      " " +
      chalk.cyan.bold("║")
  );
  lines.push(chalk.cyan.bold("╚" + "═".repeat(innerWidth) + "╝"));
  lines.push(
    chalk.gray(
      `Cycle #${cycle} | Updated: ${timeStr} | Interval: ${pollIntervalSeconds}s | Ctrl+C to exit`
    )
  );
  lines.push("");

  // Account Summary
  const totalUnrealizedPnL = positions.reduce(
    (sum, p) => sum + Number(p.unrealizedPl ?? 0),
    0
  );

  const accountTable = new Table({
    head: [
      chalk.cyan("Buying Power"),
      chalk.cyan("Cash Balance"),
      chalk.cyan("Portfolio Value"),
      chalk.cyan("Total Unrealized PnL"),
    ],
    style: { head: [], border: ["gray"] },
  });

  if (account) {
    accountTable.push([
      chalk.white.bold(formatMoney(account.buyingPower)),
      chalk.white(formatMoney(account.cash)),
      chalk.white.bold(formatMoney(account.portfolioValue)),
      formatPnl(totalUnrealizedPnL),
    ]);
  } else {
    accountTable.push([
      chalk.gray("N/A"),
      chalk.gray("N/A"),
      chalk.gray("N/A"),
      chalk.gray("N/A"),
    ]);
  }

  lines.push(chalk.bold.white("ACCOUNT OVERVIEW (ALPACA PAPER)"));
  lines.push(accountTable.toString());
  lines.push("");

  // Open Positions
  lines.push(chalk.bold.white(`OPEN POSITIONS (${positions.length})`));
  if (positions.length > 0) {
    const posTable = new Table({
      head: [
        chalk.cyan("Symbol"),
        chalk.cyan("Side"),
        chalk.cyan("Qty"),
        chalk.cyan("Entry Price"),
        chalk.cyan("Current Price"),
        chalk.cyan("Unrealized PnL"),
      ],
      style: { head: [], border: ["gray"] },
    });

    for (const pos of positions) {
      const pnlPct =
        pos.unrealizedPlpc >= 0
          ? chalk.green(`(+${pos.unrealizedPlpc.toFixed(2)}%)`)
          : chalk.red(`(${pos.unrealizedPlpc.toFixed(2)}%)`);

      posTable.push([
        chalk.white.bold(pos.symbol),
        pos.side === "short" ? chalk.magenta("SHORT") : chalk.green("LONG"),
        String(pos.qty),
        formatMoney(pos.entryPrice),
        formatMoney(pos.currentPrice),
        `${formatPnl(pos.unrealizedPl)} ${pnlPct}`,
      ]);
    }
    lines.push(posTable.toString());
  } else {
    lines.push(chalk.gray("  No open positions."));
  }
  lines.push("");

  // Latest Signals (responsive columns so borders never break in 80-col terminals)
  lines.push(chalk.bold.white(`LATEST SIGNALS (${signals.length})`));
  if (signals.length > 0) {
    const showSummary = termWidth >= 106;
    const execWidth = showSummary ? 24 : Math.max(18, termWidth - 52);
    const summaryWidth = Math.max(22, termWidth - 78);

    const sigTable = new Table({
      head: showSummary
        ? [
            chalk.cyan("Ticker"),
            chalk.cyan("Sentiment"),
            chalk.cyan("Hype"),
            chalk.cyan("Action"),
            chalk.cyan("Execution"),
            chalk.cyan("Summary"),
          ]
        : [
            chalk.cyan("Ticker"),
            chalk.cyan("Sentiment"),
            chalk.cyan("Hype"),
            chalk.cyan("Action"),
            chalk.cyan("Execution"),
          ],
      colWidths: showSummary
        ? [9, 17, 7, 8, execWidth, summaryWidth]
        : [9, 17, 7, 8, execWidth],
      wordWrap: true,
      style: { head: [], border: ["gray"] },
    });

    for (const sig of signals.slice(0, 8)) {
      const hypeStr =
        sig.hype_score >= 8
          ? chalk.red.bold(`${sig.hype_score}/10`)
          : chalk.yellow(`${sig.hype_score}/10`);

      const row = [
        chalk.white.bold(sig.ticker),
        formatSentiment(sig.sentiment),
        hypeStr,
        formatAction(sig.suggested_action),
        sig.execution || chalk.gray("PENDING"),
      ];
      if (showSummary) {
        row.push(chalk.gray(sig.summary || ""));
      }
      sigTable.push(row);
    }
    lines.push(sigTable.toString());
  } else {
    lines.push(chalk.gray("  No actionable ticker signals extracted yet."));
  }
  lines.push("");

  // Recent Activity Log
  lines.push(chalk.bold.white("RECENT ACTIVITY LOG"));
  if (logs.length > 0) {
    for (const entry of logs.slice(-8)) {
      lines.push(`  ${entry}`);
    }
  } else {
    lines.push(chalk.gray("  Waiting for events..."));
  }

  // Single-write clear screen & move cursor home to avoid terminal flicker
  const frame = lines.join("\n") + "\n";
  process.stdout.write("\x1b[2J\x1b[H" + frame);
}
