import YahooFinanceModule from "yahoo-finance2";

const yahooFinance =
  typeof YahooFinanceModule === "function"
    ? new YahooFinanceModule({ suppressNotices: ["yahooSurvey"] })
    : YahooFinanceModule;

if (typeof yahooFinance.suppressNotices === "function") {
  yahooFinance.suppressNotices(["yahooSurvey"]);
}

const FUNDAMENTALS_CACHE_MS = 15 * 60 * 1000; // Cache fundamentals for 15 minutes
const cache = new Map();

function formatBillions(num) {
  if (!Number.isFinite(num) || num <= 0) return "N/A";
  if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(0)}M`;
  return `$${num.toFixed(0)}`;
}

/**
 * Fetch live fundamentals & valuation metrics for a single ticker via yahoo-finance2.
 * Cached for 15 minutes to stay fast and avoid rate limits.
 *
 * @param {string} symbol
 * @returns {Promise<object|null>}
 */
export async function fetchTickerFundamentals(symbol) {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < FUNDAMENTALS_CACHE_MS) {
    return cached.data;
  }

  try {
    const [quote, summary] = await Promise.all([
      yahooFinance.quote(symbol).catch(() => null),
      yahooFinance
        .quoteSummary(symbol, {
          modules: ["financialData", "defaultKeyStatistics", "summaryDetail"],
        })
        .catch(() => null),
    ]);

    if (!quote && !summary) return null;

    const fin = summary?.financialData ?? {};
    const stats = summary?.defaultKeyStatistics ?? {};
    const detail = summary?.summaryDetail ?? {};

    const price = Number(quote?.regularMarketPrice ?? fin.currentPrice ?? 0);
    const marketCap = Number(quote?.marketCap ?? detail.marketCap ?? 0);
    const trailingPE = Number(quote?.trailingPE ?? detail.trailingPE ?? 0);
    const forwardPE = Number(quote?.forwardPE ?? stats.forwardPE ?? 0);
    const profitMargins = Number(fin.profitMargins ?? 0) * 100;
    const revenueGrowth = Number(fin.revenueGrowth ?? 0) * 100;
    const dayChangePct = Number(quote?.regularMarketChangePercent ?? 0);
    const high52 = Number(quote?.fiftyTwoWeekHigh ?? detail.fiftyTwoWeekHigh ?? 0);
    const low52 = Number(quote?.fiftyTwoWeekLow ?? detail.fiftyTwoWeekLow ?? 0);
    const posIn52w =
      high52 > low52 && price > 0
        ? Math.round(((price - low52) / (high52 - low52)) * 100)
        : null;
    const analystRating = fin.recommendationKey || "none";
    const targetMeanPrice = Number(fin.targetMeanPrice ?? 0);
    const upsidePct =
      targetMeanPrice > 0 && price > 0
        ? Number((((targetMeanPrice - price) / price) * 100).toFixed(1))
        : null;

    const data = {
      symbol,
      price: price > 0 ? Number(price.toFixed(2)) : null,
      marketCapStr: formatBillions(marketCap),
      marketCap,
      trailingPE: trailingPE > 0 ? Number(trailingPE.toFixed(1)) : null,
      forwardPE: forwardPE > 0 ? Number(forwardPE.toFixed(1)) : null,
      profitMarginPct: Number.isFinite(profitMargins)
        ? Number(profitMargins.toFixed(1))
        : null,
      revenueGrowthPct: Number.isFinite(revenueGrowth)
        ? Number(revenueGrowth.toFixed(1))
        : null,
      dayChangePct: Number.isFinite(dayChangePct)
        ? Number(dayChangePct.toFixed(2))
        : null,
      posIn52w,
      analystRating,
      upsidePct,
    };

    cache.set(symbol, { data, fetchedAt: Date.now() });
    return data;
  } catch {
    return null;
  }
}

/**
 * Extract candidate stock tickers from scraped posts and fetch their fundamentals
 * in parallel (capped at top 10 tickers) so Gemini has real financial context.
 *
 * @param {Array<object>} posts
 * @returns {Promise<Map<string, object>>}
 */
export async function enrichPostsWithFundamentals(posts) {
  const candidates = [];
  const seen = new Set();

  for (const post of posts) {
    const matches = (post.title || "").match(/\$([A-Z]{1,5})\b/g) || [];
    for (const raw of matches) {
      const ticker = raw.slice(1).toUpperCase();
      if (!seen.has(ticker)) {
        seen.add(ticker);
        candidates.push(ticker);
      }
      if (candidates.length >= 10) break;
    }
    if (candidates.length >= 10) break;
  }

  const results = new Map();
  if (candidates.length === 0) return results;

  const settled = await Promise.allSettled(
    candidates.map(async (sym) => [sym, await fetchTickerFundamentals(sym)])
  );

  for (const res of settled) {
    if (res.status === "fulfilled" && res.value[1]) {
      results.set(res.value[0], res.value[1]);
    }
  }

  return results;
}

/**
 * Format fetched fundamentals into a concise block for the Gemini prompt.
 */
export function formatFundamentalsBlock(fundamentalsMap) {
  if (!fundamentalsMap || fundamentalsMap.size === 0) return "";

  const lines = ["\nLIVE FUNDAMENTALS SNAPSHOT (Yahoo Finance):"];
  for (const [sym, f] of fundamentalsMap.entries()) {
    const parts = [
      `${sym}:`,
      f.price ? `Price $${f.price}` : null,
      f.dayChangePct !== null ? `Day ${f.dayChangePct >= 0 ? "+" : ""}${f.dayChangePct}%` : null,
      `MCap ${f.marketCapStr}`,
      f.forwardPE ? `FwdPE ${f.forwardPE}` : f.trailingPE ? `PE ${f.trailingPE}` : null,
      f.revenueGrowthPct !== null ? `RevGrowth ${f.revenueGrowthPct}%` : null,
      f.profitMarginPct !== null ? `Margin ${f.profitMarginPct}%` : null,
      f.posIn52w !== null ? `52wPos ${f.posIn52w}%` : null,
      f.analystRating !== "none" ? `Analysts ${f.analystRating}` : null,
      f.upsidePct !== null ? `TargetUpside ${f.upsidePct >= 0 ? "+" : ""}${f.upsidePct}%` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" | ")}`);
  }
  return lines.join("\n");
}
