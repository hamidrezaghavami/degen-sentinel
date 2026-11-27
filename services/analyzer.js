import { GoogleGenAI } from "@google/genai";
import { CONFIG } from "../config.js";
import {
  enrichPostsWithFundamentals,
  formatFundamentalsBlock,
} from "./fundamentals.js";

const IGNORED_TICKERS = new Set([
  "DD", "CEO", "CFO", "CTO", "YOLO", "HOLD", "HODL", "MOON", "WSB",
  "SEC", "FED", "GDP", "CPI", "PPI", "FOMC", "USA", "USD", "ATH",
  "ATL", "ETF", "IPO", "OP", "IRA", "EPS", "PE", "IV", "DTE", "ITM",
  "OTM", "ATM", "FOMO", "LMAO", "IMO", "IMHO", "TLDR", "EDIT", "PSA",
  "BUY", "SELL", "PUT", "PUTS", "CALL", "CALLS", "AI", "US", "UK",
  "EU", "ALL", "ARE", "FOR", "THE", "AND", "NOT", "YOU", "CAN", "OUT",
  "NOW", "NEW", "ONE", "DAY", "WAY", "BIG", "LOW", "TOP", "RED", "RUN",
  "RIP", "WTF", "LOL", "OMG", "FYI", "EOD", "AH", "PM", "AM",
]);

const SYSTEM_INSTRUCTION = `You are a disciplined quantitative & fundamental equity analyst monitoring r/wallstreetbets and S&P 500 leaders.
You are given THREE live data streams for each ticker:
1. Social/Watchlist attention
2. Live Yahoo Finance Fundamentals (Market Cap, Forward P/E, Revenue Growth, Profit Margins, 52-Week Position, Analyst Consensus, Target Upside)
3. Statistical Math Engine metrics (20-day Standard Deviation Z-Score in σ, Bollinger %B, 20-day Sharpe ratio, Statistical Regime)

STRICT RULES:
1. Return ONLY valid JSON matching the requested schema (top 10 highest-quality US stock tickers max).
2. Ignore generic words, slang, and non-ticker acronyms (DD, CEO, YOLO, HOLD, MOON, WSB, SEC, FED, CPI, GDP, ETF, IPO, FOMO, ITM, OTM, DTE, ATH, USA, USD, CALL, PUT, AI).
3. Use BOTH FUNDAMENTALS + STANDARD DEVIATION STATS to pick ONLY high-probability setups:
   - "MOMENTUM_BREAKOUT" -> "BUY": Strong fundamentals (profitable or strong growth, buy consensus, >= $10B MCap) AND healthy statistical trend (Z-Score between -0.5σ and +1.5σ, positive Sharpe20, Regime STAT_UPTREND/NORMAL). NEVER chase BUY above +2.0σ!
   - "MEAN_REVERSION_FADE" -> "SHORT": Statistically overextended (Z-Score >= +1.8σ, BB%B >= 0.95) on weakening/overvalued non-squeeze stocks, OR confirmed STAT_DOWNTREND with weak fundamentals.
   - "SHORT_SQUEEZE_RISK" -> "HOLD" (risk_level "HIGH"): Heavily shorted meme stocks (GME, AMC, low-float >200% mention spikes) or unprofitable cash-burners.
   - "NOISE" -> "HOLD": Conflicting fundamentals and statistical regime.
4. Score hype_score (1-10), confidence (0-100), and risk_level ("LOW", "MEDIUM", "HIGH"). Only give confidence >= 75 when Fundamentals + Quant Z-Score/Sharpe + Sentiment all agree.
5. Keep summary concise (under 80 characters), citing the Z-Score/fundamental driver.
6. If no valid stock tickers are clearly discussed, return {"analysis": []}.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    analysis: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ticker: {
            type: "string",
            description: "Valid uppercase US stock ticker symbol (1-5 letters)",
          },
          sentiment: {
            type: "string",
            enum: [
              "EXTREME_BULLISH",
              "BULLISH",
              "NEUTRAL",
              "BEARISH",
              "EXTREME_BEARISH",
            ],
          },
          hype_score: {
            type: "integer",
            minimum: 1,
            maximum: 10,
          },
          strategy: {
            type: "string",
            enum: [
              "MOMENTUM_BREAKOUT",
              "MEAN_REVERSION_FADE",
              "SHORT_SQUEEZE_RISK",
              "NOISE",
            ],
          },
          risk_level: {
            type: "string",
            enum: ["LOW", "MEDIUM", "HIGH"],
          },
          confidence: {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },
          summary: {
            type: "string",
            description: "Short summary of the retail sentiment and risk",
          },
          suggested_action: {
            type: "string",
            enum: ["BUY", "SELL", "SHORT", "HOLD"],
          },
        },
        required: [
          "ticker",
          "sentiment",
          "hype_score",
          "strategy",
          "risk_level",
          "confidence",
          "summary",
          "suggested_action",
        ],
      },
    },
  },
  required: ["analysis"],
};

let aiClient = null;

function getClient() {
  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey: CONFIG.GEMINI_API_KEY });
  }
  return aiClient;
}

function formatPostsForPrompt(posts) {
  return posts
    .map((post, idx) => {
      const body = post.selftext
        ? post.selftext.replace(/\s+/g, " ").slice(0, 350)
        : "(no body)";
      return `[Post ${idx + 1} | Upvote Ratio: ${(post.upvoteRatio * 100).toFixed(0)}%]\nTitle: ${post.title}\nBody: ${body}`;
    })
    .join("\n\n");
}

function normalizeAndFilterAnalysis(rawAnalysis) {
  if (!Array.isArray(rawAnalysis)) return [];

  const deduped = new Map();

  for (const item of rawAnalysis) {
    const ticker = String(item?.ticker || "")
      .toUpperCase()
      .replace(/^\$/, "")
      .trim();

    if (!/^[A-Z]{1,5}$/.test(ticker)) continue;
    if (IGNORED_TICKERS.has(ticker)) continue;

    const hypeScore = Math.max(1, Math.min(10, Math.round(Number(item?.hype_score) || 1)));
    const confidence = Math.max(0, Math.min(100, Math.round(Number(item?.confidence) || 50)));
    const sentiment = String(item?.sentiment || "NEUTRAL").toUpperCase();
    const strategy = String(item?.strategy || "NOISE").toUpperCase();
    const riskLevel = String(item?.risk_level || "MEDIUM").toUpperCase();
    let suggestedAction = String(item?.suggested_action || "HOLD").toUpperCase();

    // Never allow SHORT on SHORT_SQUEEZE_RISK or HIGH risk when SAFE_MODE is enabled
    if (CONFIG.SAFE_MODE && (strategy === "SHORT_SQUEEZE_RISK" || riskLevel === "HIGH")) {
      if (suggestedAction === "SHORT" || suggestedAction === "SELL") {
        suggestedAction = "HOLD";
      }
    }

    if (!["BUY", "SELL", "SHORT", "HOLD"].includes(suggestedAction)) {
      suggestedAction = "HOLD";
    }

    const entry = {
      ticker,
      sentiment,
      hype_score: hypeScore,
      strategy,
      risk_level: riskLevel,
      confidence,
      summary: String(item?.summary || "").trim().slice(0, 100),
      suggested_action: suggestedAction,
    };

    const existing = deduped.get(ticker);
    if (!existing || entry.confidence > existing.confidence) {
      deduped.set(ticker, entry);
    }
  }

  return Array.from(deduped.values()).sort(
    (a, b) => b.hype_score - a.hype_score || b.confidence - a.confidence
  );
}

/**
 * Deterministic fallback parser used ONLY if all Gemini models are temporarily
 * unavailable (HTTP 503 high-demand spike). Extracts tickers and mention velocity
 * from ApeWisdom WSB telemetry so the quantitative verifier can still evaluate them.
 */
function fallbackAnalyzeFromTelemetry(posts) {
  const analysis = [];
  for (const post of posts) {
    const match = post.title?.match(
      /^\$([A-Z]{1,5})\b.*?\((\d+)\s+mentions,\s*([+-]?\d+|NEW)%/i
    );
    if (!match) continue;
    const ticker = match[1].toUpperCase();
    if (IGNORED_TICKERS.has(ticker)) continue;

    const mentions = Number(match[2] || 0);
    const deltaPct = match[3] === "NEW" ? 100 : Number(match[3] || 0);
    const isMemeSpike = deltaPct >= 250 || ["GME", "AMC", "BBBY"].includes(ticker);

    const hypeScore = Math.max(
      4,
      Math.min(9, Math.round(4 + Math.min(3, mentions / 200) + (deltaPct > 50 ? 2 : deltaPct > 15 ? 1 : 0)))
    );

    analysis.push({
      ticker,
      sentiment: deltaPct >= 40 ? "EXTREME_BULLISH" : deltaPct >= 0 ? "BULLISH" : "NEUTRAL",
      hype_score: hypeScore,
      strategy: isMemeSpike
        ? "SHORT_SQUEEZE_RISK"
        : deltaPct >= 10
          ? "MOMENTUM_BREAKOUT"
          : "NOISE",
      risk_level: isMemeSpike ? "HIGH" : mentions >= 150 ? "LOW" : "MEDIUM",
      confidence: isMemeSpike ? 40 : deltaPct >= 15 ? 72 : 62,
      summary: `WSB fallback: ${mentions} mentions (${deltaPct >= 0 ? `+${deltaPct}` : deltaPct}% 24h)`,
      suggested_action: isMemeSpike ? "HOLD" : deltaPct >= 10 ? "BUY" : "HOLD",
    });
  }
  return normalizeAndFilterAnalysis(analysis).slice(0, 8);
}

/**
 * Analyze aggregated Reddit posts using Google Gemini with strict JSON output
 * and risk-aware strategy recognition.
 *
 * @param {Array<object>} posts
 * @returns {Promise<{ analysis: Array<object> }>}
 */
export async function analyzeSentiment(posts) {
  if (!posts || posts.length === 0) {
    return { analysis: [] };
  }

  const fundamentalsMap = await enrichPostsWithFundamentals(posts);
  const fundamentalsBlock = formatFundamentalsBlock(fundamentalsMap);

  const promptText = `Analyze these ${posts.length} recent r/wallstreetbets posts/metrics alongside their live fundamentals and return the structured JSON strategy & risk analysis (top 10 tickers max):\n\n${formatPostsForPrompt(posts)}${fundamentalsBlock}`;

  const client = getClient();
  const modelsToTry = [
    CONFIG.GEMINI_MODEL,
    ...["gemini-3.1-flash-lite", "gemini-4-hydrogen", "gemma-4-31b-it"].filter(
      (m) => m !== CONFIG.GEMINI_MODEL
    ),
  ];

  let interaction;
  let lastErr;
  for (const model of modelsToTry) {
    try {
      interaction = await client.interactions.create({
        model,
        system_instruction: SYSTEM_INSTRUCTION,
        input: promptText,
        response_format: RESPONSE_SCHEMA,
        store: false,
      });
      break;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isRetryable =
        msg.includes("503") ||
        msg.includes("high demand") ||
        msg.includes("unusable") ||
        msg.includes("fetch failed") ||
        msg.includes("ECONNRESET");
      if (isRetryable) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      throw err;
    }
  }

  if (!interaction) {
    const fallback = fallbackAnalyzeFromTelemetry(posts);
    if (fallback.length > 0) {
      return { analysis: fallback };
    }
    throw lastErr;
  }

  const rawText = interaction?.output_text?.trim();
  if (!rawText) {
    return { analysis: [] };
  }

  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const parsed = JSON.parse(cleaned);
  return {
    analysis: normalizeAndFilterAnalysis(parsed?.analysis),
  };
}
