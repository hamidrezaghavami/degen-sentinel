import dotenv from "dotenv";

dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const CONFIG = {
  ALPACA_API_KEY_ID: process.env.ALPACA_API_KEY_ID?.trim() || "",
  ALPACA_API_SECRET_KEY: process.env.ALPACA_API_SECRET_KEY?.trim() || "",
  ALPACA_PAPER: (process.env.ALPACA_PAPER ?? "true").toLowerCase() !== "false",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim() || "",
  GEMINI_MODEL: process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
  POLL_INTERVAL_SECONDS: parseNumber(process.env.POLL_INTERVAL_SECONDS, 120),
  MAX_TRADE_ALLOCATION_USD: parseNumber(process.env.MAX_TRADE_ALLOCATION_USD, 500),
  REDDIT_USER_AGENT:
    process.env.REDDIT_USER_AGENT?.trim() ||
    "macos:degen-sentinel:v1.0.0 (by /u/hamidrezaghavami)",
};

export function validateConfig() {
  const missing = [];
  if (!CONFIG.ALPACA_API_KEY_ID) missing.push("ALPACA_API_KEY_ID");
  if (!CONFIG.ALPACA_API_SECRET_KEY) missing.push("ALPACA_API_SECRET_KEY");
  if (!CONFIG.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables in .env: ${missing.join(", ")}`
    );
  }
}
