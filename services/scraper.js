import { CONFIG } from "../config.js";

const PUBLIC_REDDIT_ENDPOINT = "https://www.reddit.com/r/wallstreetbets/new.json";
const OAUTH_REDDIT_ENDPOINT = "https://oauth.reddit.com/r/wallstreetbets/new";
const APEWISDOM_WSB_ENDPOINT =
  "https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/1";

const MAX_SEEN_IDS = 1000;
const seenPostIds = new Set();

let oauthTokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function recordSeenId(id) {
  seenPostIds.add(id);
  if (seenPostIds.size > MAX_SEEN_IDS) {
    const oldest = seenPostIds.values().next().value;
    seenPostIds.delete(oldest);
  }
}

async function getRedditOAuthToken() {
  const clientId = process.env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = process.env.REDDIT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  if (oauthTokenCache.accessToken && Date.now() < oauthTokenCache.expiresAt - 60_000) {
    return oauthTokenCache.accessToken;
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": CONFIG.REDDIT_USER_AGENT,
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Reddit OAuth failed: HTTP ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  oauthTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return oauthTokenCache.accessToken;
}

/**
 * Build synthetic S&P 500 blue-chip watchlist entries for tickers not already
 * present in the Reddit/WSB batch so Gemini & the verifier always scan major leaders
 * like AMZN, MSFT, JPM, COST, WMT, LLY, NFLX, etc.
 */
function appendSp500Watchlist(posts) {
  const existingTickers = new Set();
  for (const p of posts) {
    const matches = (p.title || "").match(/\$([A-Z]{1,5})\b/g) || [];
    for (const m of matches) existingTickers.add(m.slice(1).toUpperCase());
  }

  const added = [];
  for (const sym of CONFIG.SP500_WATCHLIST || []) {
    if (existingTickers.has(sym)) continue;
    added.push({
      id: `sp500:${sym}:${Math.floor(Date.now() / (15 * 60 * 1000))}`,
      title: `$${sym} — S&P 500 Blue-Chip Leader Watchlist`,
      selftext: `High-liquidity S&P 500 constituent ($${sym}). Evaluate using live fundamentals, analyst consensus, and technical trend.`,
      upvoteRatio: 0.85,
      score: 100,
      createdUtc: Math.floor(Date.now() / 1000),
    });
  }
  return [...posts, ...added];
}
async function fetchFromApeWisdom(limit = 15) {
  const response = await fetch(APEWISDOM_WSB_ENDPOINT, {
    headers: {
      "User-Agent": CONFIG.REDDIT_USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`ApeWisdom fallback error: HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const results = (payload?.results ?? []).slice(0, limit);

  const newItems = [];
  for (const item of results) {
    const ticker = String(item?.ticker || "").trim();
    if (!ticker) continue;

    const mentions = Number(item.mentions ?? 0);
    const mentions24h = Number(item.mentions_24h_ago ?? 0);
    const upvotes = Number(item.upvotes ?? 0);
    const rank = Number(item.rank ?? 0);
    const rank24h = Number(item.rank_24h_ago ?? rank);

    // Deduplicate identical mention snapshots across cycles
    const snapshotId = `apewisdom:${ticker}:${mentions}:${upvotes}`;
    if (seenPostIds.has(snapshotId)) continue;
    recordSeenId(snapshotId);

    const deltaPct =
      mentions24h > 0
        ? (((mentions - mentions24h) / mentions24h) * 100).toFixed(0)
        : "NEW";
    const rankShift = rank24h - rank;

    newItems.push({
      id: snapshotId,
      title: `$${ticker} (${item.name || ticker}) — WSB Rank #${rank} (${mentions} mentions, ${deltaPct}% vs 24h ago)`,
      selftext: `r/wallstreetbets live telemetry: ${mentions} mentions (was ${mentions24h} 24h ago), ${upvotes} total upvotes, rank change ${rankShift >= 0 ? `+${rankShift}` : rankShift}.`,
      upvoteRatio: mentions > 0 ? Math.min(0.99, Math.max(0.5, upvotes / (mentions * 10))) : 0.75,
      score: upvotes,
      createdUtc: Math.floor(Date.now() / 1000),
    });
  }

  const combined = appendSp500Watchlist(newItems);
  return {
    posts: combined,
    totalFetched: results.length + (CONFIG.SP500_WATCHLIST?.length || 0),
    source: "WSB + S&P 500 Watchlist",
  };
}

/**
 * Fetch the top N newest posts from r/wallstreetbets and return only unseen posts.
 * Uses native Node.js fetch with a custom User-Agent.
 * Automatically uses Reddit OAuth if REDDIT_CLIENT_ID & REDDIT_CLIENT_SECRET are set,
 * and falls back to ApeWisdom's live WSB feed if Reddit blocks unauthenticated .json requests.
 *
 * @param {number} limit
 * @returns {Promise<{ posts: Array<object>, totalFetched: number, source: string }>}
 */
export async function fetchNewPosts(limit = 15) {
  const token = await getRedditOAuthToken();
  const url = token
    ? `${OAUTH_REDDIT_ENDPOINT}?limit=${limit}&raw_json=1`
    : `${PUBLIC_REDDIT_ENDPOINT}?limit=${limit}&raw_json=1`;

  const headers = {
    "User-Agent": CONFIG.REDDIT_USER_AGENT,
    Accept: "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("application/json")) {
      if (!token && (response.status === 403 || response.status === 429 || !contentType.includes("application/json"))) {
        return await fetchFromApeWisdom(limit);
      }
      throw new Error(`Reddit API error: HTTP ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const children = payload?.data?.children ?? [];

    const nowSec = Math.floor(Date.now() / 1000);
    const maxAgeSec = (CONFIG.MAX_POST_AGE_HOURS || 2) * 3600;
    const newPosts = [];
    for (const child of children) {
      const post = child?.data;
      if (!post?.id || seenPostIds.has(post.id)) continue;

      const createdUtc = Number(post.created_utc ?? 0);
      // Skip stale Reddit posts older than MAX_POST_AGE_HOURS so social timing matches live market
      if (createdUtc > 0 && nowSec - createdUtc > maxAgeSec) continue;

      recordSeenId(post.id);
      newPosts.push({
        id: post.id,
        title: (post.title || "").trim(),
        selftext: (post.selftext || "").trim(),
        upvoteRatio: Number(post.upvote_ratio ?? 0),
        score: Number(post.score ?? 0),
        createdUtc,
        ageMinutes: createdUtc > 0 ? Math.max(0, Math.round((nowSec - createdUtc) / 60)) : 0,
      });
    }

    const combined = appendSp500Watchlist(newPosts);
    return {
      posts: combined,
      totalFetched: children.length + (CONFIG.SP500_WATCHLIST?.length || 0),
      source: token
        ? "r/wallstreetbets (OAuth) + S&P 500"
        : "r/wallstreetbets (JSON) + S&P 500",
    };
  } catch (err) {
    if (!token) {
      return await fetchFromApeWisdom(limit);
    }
    throw err;
  }
}
