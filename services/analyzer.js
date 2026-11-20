import { GoogleGenAI } from "@google/genai";
import { CONFIG } from "../config.js";

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

const SYSTEM_INSTRUCTION = `You are a risk-aware quantitative sentiment & strategy analyst monitoring r/wallstreetbets.
Analyze the provided Reddit posts/telemetry and extract genuine publicly traded US stock tickers (e.g., NVDA, AAPL, AMD, MSFT, TSLA, GME, SPY).

STRICT RULES:
1. Return ONLY valid JSON matching the requested schema.
2. Ignore generic words, slang, and non-ticker acronyms (DD, CEO, YOLO, HOLD, MOON, WSB, SEC, FED, CPI, GDP, ETF, IPO, FOMO, ITM, OTM, DTE, ATH, USA, USD, CALL, PUT, AI).
3. Classify each ticker into the SAFEST matching strategy:
   - "MOMENTUM_BREAKOUT": Liquid large-cap with accelerating organic attention and sustainable bullish trend -> suggested_action "BUY".
   - "MEAN_REVERSION_FADE": Overextended mega-cap/liquid stock where hype is peaking/fading -> suggested_action "SHORT" (only if risk is not HIGH).
   - "SHORT_SQUEEZE_RISK": Heavily shorted meme stocks (e.g., GME, AMC, BBBY, sudden +200% retail meme spikes) -> NEVER recommend SHORT; set risk_level "HIGH" and suggested_action "HOLD".
   - "NOISE": Low conviction or unclear catalyst -> suggested_action "HOLD".
4. Score hype_score from 1 to 10, confidence from 0 to 100, and risk_level ("LOW", "MEDIUM", "HIGH").
5. Be conservative: prefer "HOLD" over risky shorts on meme stocks or unclear moves.
6. Keep summary concise (under 80 characters).
7. If no valid stock tickers are clearly discussed, return {"analysis": []}.`;

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

  const promptText = `Analyze these ${posts.length} recent r/wallstreetbets posts/metrics and return the structured JSON strategy & risk analysis:\n\n${formatPostsForPrompt(posts)}`;

  const client = getClient();
  let interaction;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      interaction = await client.interactions.create({
        model: CONFIG.GEMINI_MODEL,
        system_instruction: SYSTEM_INSTRUCTION,
        input: promptText,
        response_format: RESPONSE_SCHEMA,
        store: false,
      });
      break;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (attempt < 2 && (msg.includes("unusable") || msg.includes("fetch failed") || msg.includes("ECONNRESET"))) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
  if (!interaction && lastErr) throw lastErr;

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
