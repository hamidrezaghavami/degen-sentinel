import chalk from "chalk";
import ora from "ora";
import { CONFIG, validateConfig } from "./config.js";
import { fetchNewPosts } from "./services/scraper.js";
import { analyzeSentiment } from "./services/analyzer.js";
import {
  getActiveBrokerName,
  getAccountSummary,
  getOpenPositions,
  executeSignals,
} from "./services/trader.js";
import { renderDashboard } from "./services/dashboard.js";

const RUN_ONCE = process.argv.includes("--once");

const state = {
  cycle: 0,
  status: "STARTING",
  account: null,
  positions: [],
  signals: [],
  logs: [],
  lastUpdated: new Date(),
  timer: null,
  shuttingDown: false,
};

function addLog(message, level = "info") {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const prefix = chalk.gray(`[${ts}]`);
  let coloredMsg = chalk.white(message);
  if (level === "warn") coloredMsg = chalk.yellow(message);
  if (level === "error") coloredMsg = chalk.red(message);
  if (level === "success") coloredMsg = chalk.green(message);

  state.logs.push(`${prefix} ${coloredMsg}`);
  if (state.logs.length > 50) {
    state.logs.shift();
  }
}

async function runCycle(onBeforeRender = null) {
  if (state.shuttingDown) return;

  state.cycle += 1;
  state.status = "POLLING";
  let cycleHasError = false;

  // 1. Fetch Reddit r/wallstreetbets posts
  let newPosts = [];
  try {
    const { posts, totalFetched, source } = await fetchNewPosts(15);
    newPosts = posts;
    addLog(`Scraped ${source}: ${newPosts.length} new / ${totalFetched} fetched.`);
  } catch (err) {
    cycleHasError = true;
    addLog(`Scraper error: ${err.message}`, "error");
  }

  // 2. Analyze sentiment with Gemini (only when there are new posts)
  let rawSignals = [];
  if (newPosts.length > 0) {
    try {
      const { analysis } = await analyzeSentiment(newPosts);
      rawSignals = analysis;
      addLog(
        `Gemini (${CONFIG.GEMINI_MODEL}) extracted ${rawSignals.length} ticker signal(s).`,
        rawSignals.length > 0 ? "success" : "info"
      );
    } catch (err) {
      cycleHasError = true;
      const errMsg = err?.message || String(err);
      if (errMsg.includes("429") || errMsg.toLowerCase().includes("quota")) {
        addLog("Gemini free-tier rate limit hit. Skipping analysis this cycle.", "warn");
      } else {
        addLog(`Analyzer error: ${errMsg.slice(0, 120)}`, "error");
      }
    }
  } else if (!cycleHasError) {
    addLog("No unseen Reddit posts since last cycle; skipping LLM call.");
  }

  // 3. Execute paper trades for high-hype signals (hype_score >= 8)
  if (rawSignals.length > 0) {
    try {
      const { enrichedSignals, events } = await executeSignals(rawSignals);
      state.signals = enrichedSignals;
      for (const evt of events) {
        const level = evt.startsWith("ORDER PLACED")
          ? "success"
          : evt.startsWith("ORDER FAILED")
            ? "error"
            : "warn";
        addLog(evt, level);
      }
    } catch (err) {
      cycleHasError = true;
      addLog(`Trader error: ${err.message}`, "error");
    }
  }

  // 4. Refresh Alpaca Account & Open Positions
  try {
    const [account, positions] = await Promise.all([
      getAccountSummary(),
      getOpenPositions(),
    ]);
    state.account = account;
    state.positions = positions;
  } catch (err) {
    cycleHasError = true;
    addLog(`Alpaca sync error: ${err.message}`, "error");
  }

  state.status = cycleHasError ? "ERROR" : "RUNNING";
  state.lastUpdated = new Date();

  if (typeof onBeforeRender === "function") {
    onBeforeRender();
  }

  renderDashboard({
    status: state.status,
    brokerName: getActiveBrokerName(),
    cycle: state.cycle,
    pollIntervalSeconds: CONFIG.POLL_INTERVAL_SECONDS,
    account: state.account,
    positions: state.positions,
    signals: state.signals,
    logs: state.logs,
    lastUpdated: state.lastUpdated,
  });

  if (RUN_ONCE) {
    process.exit(0);
  }

  if (!state.shuttingDown) {
    state.timer = setTimeout(runCycle, CONFIG.POLL_INTERVAL_SECONDS * 1000);
  }
}

function handleShutdown(signal) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  if (state.timer) clearTimeout(state.timer);
  console.log(
    chalk.yellow(`\n[degen-sentinel] Received ${signal}. Shutting down cleanly...`)
  );
  process.exit(0);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

async function boot() {
  try {
    validateConfig();
  } catch (err) {
    console.error(chalk.red(`\nConfiguration Error: ${err.message}\n`));
    process.exit(1);
  }

  const brokerName = getActiveBrokerName();
  const spinner = ora({
    text: `Booting degen-sentinel (Broker: ${brokerName}, Model: ${CONFIG.GEMINI_MODEL})...`,
    color: "cyan",
  }).start();

  try {
    state.account = await getAccountSummary();
    spinner.succeed(`Connected to ${brokerName}.`);
  } catch (err) {
    spinner.warn(`Initial ${brokerName} check failed (${err.message}); continuing daemon loop...`);
  }

  const cycleSpinner = ora({
    text: `Running Cycle #1 (scraping r/wallstreetbets, analyzing with Gemini, syncing ${brokerName})...`,
    color: "cyan",
  }).start();

  await runCycle(() => cycleSpinner.stop());
}

boot();
