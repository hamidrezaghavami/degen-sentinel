import dotenv from "dotenv";

dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const CONFIG = {
  // Active broker: alpaca (default) | ibkr | tradier | schwab | paper
  BROKER: (process.env.BROKER || "alpaca").trim().toLowerCase(),
  PAPER_STARTING_CASH: parseNumber(process.env.PAPER_STARTING_CASH, 1000),

  // 1. Alpaca
  ALPACA_API_KEY_ID: process.env.ALPACA_API_KEY_ID?.trim() || "",
  ALPACA_API_SECRET_KEY: process.env.ALPACA_API_SECRET_KEY?.trim() || "",
  ALPACA_PAPER: (process.env.ALPACA_PAPER ?? "true").toLowerCase() !== "false",

  // 2. Interactive Brokers (IBKR Client Portal Gateway)
  IBKR_BASE_URL:
    process.env.IBKR_BASE_URL?.trim() || "https://localhost:5000/v1/api",
  IBKR_ACCOUNT_ID: process.env.IBKR_ACCOUNT_ID?.trim() || "",

  // 3. Tradier
  TRADIER_ACCESS_TOKEN: process.env.TRADIER_ACCESS_TOKEN?.trim() || "",
  TRADIER_ACCOUNT_ID: process.env.TRADIER_ACCOUNT_ID?.trim() || "",
  TRADIER_SANDBOX:
    (process.env.TRADIER_SANDBOX ?? "true").toLowerCase() !== "false",

  // 4. Charles Schwab
  SCHWAB_ACCESS_TOKEN: process.env.SCHWAB_ACCESS_TOKEN?.trim() || "",
  SCHWAB_ACCOUNT_HASH: process.env.SCHWAB_ACCOUNT_HASH?.trim() || "",

  // AI & Bot Settings
  GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim() || "",
  GEMINI_MODEL: process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
  POLL_INTERVAL_SECONDS: parseNumber(process.env.POLL_INTERVAL_SECONDS, 120),
  MAX_TRADE_ALLOCATION_USD: parseNumber(process.env.MAX_TRADE_ALLOCATION_USD, 500),
  MAX_RISK_PER_TRADE_USD: parseNumber(process.env.MAX_RISK_PER_TRADE_USD, 3.5),

  // 3-Level Laddered Entry (buy dips / short bounces)
  ENTRY_DIP_2_PCT: parseNumber(process.env.ENTRY_DIP_2_PCT, 0.35),
  ENTRY_DIP_3_PCT: parseNumber(process.env.ENTRY_DIP_3_PCT, 0.7),

  // 2-Level Scaled Stop-Loss (SL1 50% / SL2 50%)
  STOP_LOSS_1_PCT: parseNumber(process.env.STOP_LOSS_1_PCT, 0.5),
  STOP_LOSS_2_PCT: parseNumber(process.env.STOP_LOSS_2_PCT, 0.9),

  // 3-Level Scaled Take-Profit (TP1 40% / TP2 40% / TP3 20%, enforced >= 2:1 RR on TP2+)
  MIN_REWARD_RISK_RATIO: parseNumber(process.env.MIN_REWARD_RISK_RATIO, 2.0),
  TP1_PCT: parseNumber(process.env.TP1_PCT, 1.0),
  TP2_PCT: Math.max(
    parseNumber(process.env.TP2_PCT, 1.8),
    parseNumber(process.env.STOP_LOSS_2_PCT, 0.9) *
      parseNumber(process.env.MIN_REWARD_RISK_RATIO, 2.0)
  ),
  TP3_PCT: Math.max(
    parseNumber(process.env.TP3_PCT, 2.6),
    parseNumber(process.env.STOP_LOSS_2_PCT, 0.9) *
      parseNumber(process.env.MIN_REWARD_RISK_RATIO, 2.0) +
      0.8
  ),
  TAKE_PROFIT_PCT: Math.max(
    parseNumber(process.env.TAKE_PROFIT_PCT, 1.8),
    parseNumber(process.env.STOP_LOSS_2_PCT, 0.9) *
      parseNumber(process.env.MIN_REWARD_RISK_RATIO, 2.0)
  ),

  // Safer Strategy & Signal Verification Guardrails (A+ setups only, targeting >= 60% win rate)
  SAFE_MODE: (process.env.SAFE_MODE ?? "true").toLowerCase() !== "false",
  MIN_CONFIDENCE: parseNumber(process.env.MIN_CONFIDENCE, 70),
  MIN_SAFETY_SCORE: parseNumber(process.env.MIN_SAFETY_SCORE, 75),
  MAX_DAILY_VOLATILITY_PCT: parseNumber(process.env.MAX_DAILY_VOLATILITY_PCT, 10),
  MAX_OPEN_POSITIONS: parseNumber(process.env.MAX_OPEN_POSITIONS, 3),
  MAX_DAILY_TRADES: parseNumber(process.env.MAX_DAILY_TRADES, 10),
  MAX_DAILY_LOSS_PCT: parseNumber(process.env.MAX_DAILY_LOSS_PCT, 1.5),

  REDDIT_USER_AGENT:
    process.env.REDDIT_USER_AGENT?.trim() ||
    "macos:degen-sentinel:v1.0.0 (by /u/hamidrezaghavami)",

  // S&P 500 Blue-Chip Watchlist merged alongside r/wallstreetbets
  SP500_WATCHLIST: (
    process.env.SP500_WATCHLIST ||
    "AMZN,MSFT,AAPL,GOOGL,META,NVDA,JPM,V,COST,WMT,LLY,NFLX,AVGO,CRM,XOM"
  )
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
};

export function validateConfig() {
  const missing = [];

  if (!CONFIG.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");

  switch (CONFIG.BROKER) {
    case "paper":
      // Built-in local exact paper ledger requires no external broker credentials
      break;
    case "alpaca":
      if (!CONFIG.ALPACA_API_KEY_ID) missing.push("ALPACA_API_KEY_ID");
      if (!CONFIG.ALPACA_API_SECRET_KEY) missing.push("ALPACA_API_SECRET_KEY");
      break;
    case "ibkr":
      if (!CONFIG.IBKR_ACCOUNT_ID) missing.push("IBKR_ACCOUNT_ID");
      break;
    case "tradier":
      if (!CONFIG.TRADIER_ACCESS_TOKEN) missing.push("TRADIER_ACCESS_TOKEN");
      if (!CONFIG.TRADIER_ACCOUNT_ID) missing.push("TRADIER_ACCOUNT_ID");
      break;
    case "schwab":
      if (!CONFIG.SCHWAB_ACCESS_TOKEN) missing.push("SCHWAB_ACCESS_TOKEN");
      if (!CONFIG.SCHWAB_ACCOUNT_HASH) missing.push("SCHWAB_ACCOUNT_HASH");
      break;
    default:
      throw new Error(
        `Unsupported BROKER="${CONFIG.BROKER}". Choose one of: paper, alpaca, ibkr, tradier, schwab.`
      );
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables for BROKER=${CONFIG.BROKER}: ${missing.join(", ")}`
    );
  }
}
