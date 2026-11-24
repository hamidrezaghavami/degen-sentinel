# degen-sentinel

An autonomous Node.js CLI paper-trading bot that polls live retail sentiment from **r/wallstreetbets**, enriches top tickers with live **Yahoo Finance fundamentals**, analyzes strategy & risk using **Google Gemini** (structured JSON output), verifies setups quantitatively (`SMA-5`/`SMA-20`, `RSI-14`, volume, volatility), and executes **3-level laddered entries, 3-level take-profits (`40/40/20`), and 2-level stop-losses (`50/50`)** across **Alpaca, IBKR, Tradier, or Charles Schwab**.

> **Disclaimer:** Strictly for educational and paper-trading experimentation. Not financial advice.

## Quick Start (One Line)

Add your API keys to `.env` (copied from `.env.example`), then run from anywhere—no `cd` required:

```bash
~/Desktop/Code/degen-sentinel/run.sh
```

Or from inside the project folder:

```bash
./run.sh
```

`run.sh` automatically switches into the project directory and runs inside **production Docker Compose** (multi-stage Alpine image, non-root user, read-only rootfs, healthcheck, 256MB memory cap, auto-restart) if Docker is running, or falls back seamlessly to local `pnpm` / Node.js.

- Background daemon (Docker): `./run.sh --bg`
- Single scan & exit: `./run.sh --once`

## Features

- **Live WSB Scraper (`services/scraper.js`):** Fetches newest `r/wallstreetbets` posts via native `fetch` with Reddit OAuth support and automatic ApeWisdom live fallback.
- **Live Fundamentals Enrichment (`services/fundamentals.js`):** Fetches Market Cap, Forward P/E, Revenue Growth, Profit Margins, 52-week range position, Analyst Consensus, and Target Upside before Gemini evaluates any ticker.
- **Risk-Aware AI Engine (`services/analyzer.js`):** Uses `@google/genai` with strict JSON Schema output, automatic model fallback on `503` spikes, and squeeze/meme-trap protection.
- **Quantitative Signal Verifier (`services/verifier.js`):** Validates `Price > SMA5 > SMA20` trend stack, `RSI-14` sweet spot (`45–68`), volume surge confirmation, and daily volatility caps (`MIN_SAFETY_SCORE=75`).
- **Scaled Multi-Broker Execution (`services/trader.js` + `services/brokers/`):**
  - Supports **Alpaca** (`BROKER=alpaca`), **Interactive Brokers** (`ibkr`), **Tradier** (`tradier`), and **Charles Schwab** (`schwab`).
  - **3-Level Dip Entry** (`40%` market / `40%` `-0.35%` limit / `20%` `-0.70%` limit).
  - **3-Level Take-Profit** (`TP1 40%` / `TP2 40%` / `TP3 20%`, enforced `>= 2:1` reward-to-risk).
  - **2-Level Stop-Loss** (`SL1 50%` at `-0.5%` / `SL2 50%` at `-0.9%`), per-trade dollar risk cap, max 10 trades/day, and daily drawdown circuit breaker.
- **Responsive Terminal Dashboard (`services/dashboard.js`):** Flicker-free UI showing Account Overview, Open Positions, and Signals with live Safety % and `TP / SL1-SL2` levels.

## Key Environment Variables (`.env`)

| Variable | Description | Default |
| --- | --- | --- |
| `BROKER` | Active broker (`alpaca`, `ibkr`, `tradier`, `schwab`) | `alpaca` |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | Alpaca Paper API credentials | *(required for alpaca)* |
| `GEMINI_API_KEY` | Google Gemini API key | *(required)* |
| `GEMINI_MODEL` | Primary Gemini model ID | `gemini-3.5-flash-lite` |
| `MAX_TRADE_ALLOCATION_USD` | Max USD allocation per trade | `500` |
| `MAX_RISK_PER_TRADE_USD` | Max dollar risk per trade | `3.5` |
| `MAX_DAILY_TRADES` | Daily cap on executed trades | `10` |
| `SAFE_MODE` | Enable quantitative & risk guardrails | `true` |

See [.env.example](.env.example) for all broker and tuning options.

## Project Structure

```text
degen-sentinel/
├── run.sh                 # One-line launcher (Docker Compose or local fallback)
├── Dockerfile             # Hardened multi-stage Node 22 Alpine image
├── docker-compose.yml     # Production Compose config (read-only, limits, auto-restart)
├── config.js              # Environment loader & validation
├── index.js               # Autonomous event loop & graceful shutdown
├── services/
│   ├── scraper.js         # r/wallstreetbets scraper + ApeWisdom fallback
│   ├── fundamentals.js    # Live Yahoo Finance fundamentals snapshot
│   ├── analyzer.js        # Gemini structured JSON strategy & risk analyzer
│   ├── verifier.js        # SMA/RSI/volume/volatility quantitative verifier
│   ├── trader.js          # 3-level entry/TP + 2-level SL execution engine
│   ├── dashboard.js       # Responsive flicker-free terminal UI
│   └── brokers/           # Alpaca, IBKR, Tradier, and Schwab adapters
├── .env.example
└── package.json
```
