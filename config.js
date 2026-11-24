import dotenv from "dotenv";

dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const CONFIG = {
  // Active broker: alpaca | ibkr | tradier | schwab
  BROKER: (process.env.BROKER || "alpaca").trim().toLowerCase(),

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

  // 2-Level Scaled Stop-Loss & Enforced >= 2:1 Reward-to-Risk Take-Profit
  STOP_LOSS_1_PCT: parseNumber(process.env.STOP_LOSS_1_PCT, 0.5),
  STOP_LOSS_2_PCT: parseNumber(process.env.STOP_LOSS_2_PCT, 0.9),
  MIN_REWARD_RISK_RATIO: parseNumber(process.env.MIN_REWARD_RISK_RATIO, 2.0),
  TAKE_PROFIT_PCT: Math.max(
    parseNumber(process.env.TAKE_PROFIT_PCT, 1.8),
    parseNumber(process.env.STOP_LOSS_2_PCT, 0.9) *
      parseNumber(process.env.MIN_REWARD_RISK_RATIO, 2.0)
  ),

  // Safer Strategy & Signal Verification Guardrails
  SAFE_MODE: (process.env.SAFE_MODE ?? "true").toLowerCase() !== "false",
  MIN_CONFIDENCE: parseNumber(process.env.MIN_CONFIDENCE, 60),
  MIN_SAFETY_SCORE: parseNumber(process.env.MIN_SAFETY_SCORE, 65),
  MAX_DAILY_VOLATILITY_PCT: parseNumber(process.env.MAX_DAILY_VOLATILITY_PCT, 8),
  MAX_OPEN_POSITIONS: parseNumber(process.env.MAX_OPEN_POSITIONS, 3),

  REDDIT_USER_AGENT:
    process.env.REDDIT_USER_AGENT?.trim() ||
    "macos:degen-sentinel:v1.0.0 (by /u/hamidrezaghavami)",
};

export function validateConfig() {
  const missing = [];

  if (!CONFIG.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");

  switch (CONFIG.BROKER) {
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
        `Unsupported BROKER="${CONFIG.BROKER}". Choose one of: alpaca, ibkr, tradier, schwab.`
      );
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables for BROKER=${CONFIG.BROKER}: ${missing.join(", ")}`
    );
  }
}
