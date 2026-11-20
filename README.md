# degen-sentinel

An autonomous Node.js CLI paper-trading bot that monitors live retail sentiment on **r/wallstreetbets**, extracts hot stock tickers using **Google Gemini** with structured JSON output, applies contrarian/inverse logic on extreme hype, and automatically executes simulated orders via the **Alpaca Paper Trading API**.

> **Disclaimer:** This project is strictly for educational and paper-trading experimentation. It is not financial advice.

## Features

- **Reddit Sentiment Scraper (`services/scraper.js`):** Polls the newest 15 posts from `r/wallstreetbets` using native `fetch` and deduplicates post IDs in-memory.
- **Structured AI Sentiment Engine (`services/analyzer.js`):** Uses `@google/genai` (defaulting to free-tier friendly `gemini-3.5-flash-lite`) with strict JSON Schema output, filtering out WSB slang/acronyms (`DD`, `YOLO`, `HOLD`, `MOON`, `CEO`, etc.) and applying inverse contrarian logic when `hype_score > 8`.
- **Multi-Broker Execution (`services/trader.js` + `services/brokers/`):** Supports the top 4 retail/algo brokers via a unified adapter interface—switch brokers with a single `BROKER=` env var:
  - **Alpaca** (`BROKER=alpaca`, default) — Paper & Live via `@alpacahq/alpaca-trade-api`
  - **Interactive Brokers / IBKR** (`BROKER=ibkr`) — Client Portal Web API
  - **Tradier** (`BROKER=tradier`) — Sandbox & Live REST API
  - **Charles Schwab** (`BROKER=schwab`) — Official Trader API
  - Fetches live quotes with `yahoo-finance2` (with broker fallback), sizes positions against `MAX_TRADE_ALLOCATION_USD`, and skips tickers with open pending orders to avoid wash trades.
- **Flicker-Free Terminal Dashboard (`services/dashboard.js`):** Renders live account metrics, open positions with color-coded PnL, latest AI signals, and an activity log using `chalk` and `cli-table3`.
- **Resilient Autonomous Loop (`index.js`):** Non-overlapping polling with full error isolation and graceful `SIGINT`/`SIGTERM` shutdown.

## Setup

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Configure environment variables:**
   Copy `.env.example` to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   ```

   | Variable | Description | Default |
   | --- | --- | --- |
   | `ALPACA_API_KEY_ID` | Alpaca Paper Trading Key ID | *(required)* |
   | `ALPACA_API_SECRET_KEY` | Alpaca Paper Trading Secret Key | *(required)* |
   | `ALPACA_PAPER` | Use Alpaca paper trading endpoint | `true` |
   | `GEMINI_API_KEY` | Google Gemini API key | *(required)* |
   | `GEMINI_MODEL` | Gemini model ID | `gemini-3.5-flash-lite` |
   | `POLL_INTERVAL_SECONDS` | Polling cadence in seconds | `120` |
   | `MAX_TRADE_ALLOCATION_USD` | Max USD allocation per trade | `500` |

3. **Run the bot:**
   ```bash
   # Start autonomous daemon loop
   pnpm start

   # Run a single scrape -> analyze -> trade -> render cycle
   pnpm once
   ```

## Project Structure

```text
degen-sentinel/
├── config.js              # Environment loader & validation
├── index.js               # Main autonomous event loop & shutdown hooks
├── services/
│   ├── scraper.js         # r/wallstreetbets JSON fetcher & deduplicator
│   ├── analyzer.js        # Gemini structured JSON sentiment analyzer
│   ├── trader.js          # Alpaca Paper API & yahoo-finance2 execution
│   └── dashboard.js       # Flicker-free terminal UI renderer
├── .env.example
├── .gitignore
└── package.json
```
