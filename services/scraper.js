import { CONFIG } from "../config.js";

const PUBLIC_REDDIT_ENDPOINT = "https://www.reddit.com/r/wallstreetbets/new.json";
const OAUTH_REDDIT_ENDPOINT = "https://oauth.reddit.com/r/wallstreetbets/new";
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
 * Fetch the top N newest posts from r/wallstreetbets and return only unseen posts.
 * Uses native Node.js fetch with a custom User-Agent.
 * Automatically uses Reddit OAuth if REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set.
 *
 * @param {number} limit
 * @returns {Promise<{ posts: Array<object>, totalFetched: number }>}
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

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (response.status === 429) {
    throw new Error("Reddit rate limit hit (HTTP 429). Will retry next cycle.");
  }

  if (response.status === 403) {
    throw new Error(
      "Reddit blocked unauthenticated request (HTTP 403). Add REDDIT_CLIENT_ID & REDDIT_CLIENT_SECRET to .env for OAuth."
    );
  }

  if (!response.ok) {
    throw new Error(`Reddit API error: HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Reddit returned non-JSON response (${contentType || "unknown"}).`);
  }

  const payload = await response.json();
  const children = payload?.data?.children ?? [];

  const newPosts = [];
  for (const child of children) {
    const post = child?.data;
    if (!post?.id || seenPostIds.has(post.id)) continue;

    recordSeenId(post.id);
    newPosts.push({
      id: post.id,
      title: (post.title || "").trim(),
      selftext: (post.selftext || "").trim(),
      upvoteRatio: Number(post.upvote_ratio ?? 0),
      score: Number(post.score ?? 0),
      createdUtc: Number(post.created_utc ?? 0),
    });
  }

  return {
    posts: newPosts,
    totalFetched: children.length,
  };
}
