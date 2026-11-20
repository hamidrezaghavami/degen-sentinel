import { GoogleGenAI } from "@google/genai";
import { CONFIG } from "../config.js";

const IGNORED_TICKERS = new Set([
  "DD",
  "CEO",
  "CFO",
  "CTO",
  "YOLO",
  "HOLD",
  "HODL",
  "MOON",
  "WSB",
  "SEC",
  "FED",
  "GDP",
  "CPI",
  "PPI",
  "FOMC",
  "USA",
  "USD",
  "ATH",
  "ATL",
  "ETF",
  "IPO",
  "OP",
  "IRA",
  "EPS",
  "PE",
  "IV",
  "DTE",
  "ITM",
  "OTM",
  "ATM",
  "FOMO",
  "LMAO",
  "IMO",
  "IMHO",
  "TLDR",
  "EDIT",
  "PSA",
  "BUY",
  "SELL",
  "PUT",
  "PUTS",
  "CALL",
  "CALLS",
  "AI",
  "US",
  "UK",
  "EU",
  "ALL",
  "ARE",
  "FOR",
  "THE",
  "AND",
  "NOT",
  "YOU",
  "CAN",
  "OUT",
  "NOW",
  "NEW",
  "ONE",
  "DAY",
  "WAY",
  "BIG",
  "LOW",
  "TOP",
  "RED",
  "RUN",
  "RIP",
  "WTF",
  "LOL",
  "OMG",
  "FYI",
  "EOD",
  "AH",
  "PM",
  "AM",
]);

const SYSTEM_INSTRUCTION = `You are a quantitative contrarian sentiment analyst monitoring r/wallstreetbets.
Analyze the provided Reddit posts and extract genuine publicly traded US stock tickers (e.g., TSLA, NVDA, AAPL, AMD, GME, PLTR, SPY).

STRICT RULES:
1. Return ONLY valid JSON matching the requested schema.
2. Ignore generic words, slang, and non-ticker acronyms such as: DD, CEO, YOLO, HOLD, HODL, MOON, WSB, SEC, FED, CPI, GDP, ETF, IPO, FOMO, ITM, OTM, DTE, ATH, USA, USD, CALL, PUT, AI.
3. Score hype_score from 1 to 10 (10 = extreme retail euphoria/panic).
4. Apply CONTRARIAN / INVERSE logic for extreme hype:
   - If hype_score > 8 and sentiment is EXTREME_BULLISH or BULLISH -> suggested_action MUST be "SHORT".
   - If hype_score > 8 and sentiment is EXTREME_BEARISH or BEARISH -> suggested_action MUST be "BUY".
   - Otherwise, set suggested_action to "BUY", "SELL", "SHORT", or "HOLD" based on sentiment.
5. Keep summary concise (under 80 characters).
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
          summary: {
            type: "string",
            description: "Short summary of the retail sentiment",
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
    const sentiment = String(item?.sentiment || "NEUTRAL").toUpperCase();
    let suggestedAction = String(item?.suggested_action || "HOLD").toUpperCase();

    // Enforce contrarian rule if hype_score > 8
    if (hypeScore > 8) {
      if (sentiment.includes("BULLISH")) {
        suggestedAction = "SHORT";
      } else if (sentiment.includes("BEARISH")) {
        suggestedAction = "BUY";
      }
    }

    if (!["BUY", "SELL", "SHORT", "HOLD"].includes(suggestedAction)) {
      suggestedAction = "HOLD";
    }

    const entry = {
      ticker,
      sentiment,
      hype_score: hypeScore,
      summary: String(item?.summary || "").trim().slice(0, 100),
      suggested_action: suggestedAction,
    };

    const existing = deduped.get(ticker);
    if (!existing || entry.hype_score > existing.hype_score) {
      deduped.set(ticker, entry);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => b.hype_score - a.hype_score);
}

/**
 * Analyze aggregated Reddit posts using Google Gemini with strict JSON output.
 *
 * @param {Array<object>} posts
 * @returns {Promise<{ analysis: Array<object> }>}
 */
export async function analyzeSentiment(posts) {
  if (!posts || posts.length === 0) {
    return { analysis: [] };
  }

  const promptText = `Analyze these ${posts.length} recent r/wallstreetbets posts and return the structured JSON sentiment analysis:\n\n${formatPostsForPrompt(posts)}`;

  const client = getClient();
  const interaction = await client.interactions.create({
    model: CONFIG.GEMINI_MODEL,
    system_instruction: SYSTEM_INSTRUCTION,
    input: promptText,
    response_format: RESPONSE_SCHEMA,
    store: false,
  });

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
