# ProofDesk

**A verifiable sports trading terminal & autonomous agent — powered by TxLINE real-time World Cup data, notarised on Solana.**

> Every tipster lies about their track record. ProofDesk is the first sports trading desk where every
> single decision is hash-chained and anchored on-chain — a track record that cannot be faked.

Built for the **TxODDS World Cup Hackathon** (Trading Tools & Agents track) on Superteam Earn.

## What it does

- **📊 Live terminal** — streams real-time World Cup odds and match events from the TxLINE API
  (SSE), renders them in a pro trading dashboard with live charts.
- **🤖 Rule-based agent** — an autonomous paper-trading agent that reacts to market signals
  (odds momentum, red cards, late-game patterns) and takes positions without human input.
- **🧾 Proof journal** — every decision the agent makes is recorded in an append-only,
  hash-chained journal (SHA-256), together with the exact data snapshot that triggered it.
  The chain can be verified by anyone at any time; a single tampered byte breaks it.
- **⏪ Replay / backtesting engine** — deterministic seeded match replays: same seed, same match,
  same decisions. Strategies can be tested and demonstrated reproducibly.

## Architecture

```
TxLINE API (odds/scores SSE) ──► Watcher ──► Agent (rules) ──► Proof Journal (hash chain)
                                    │             │                    │
                                    ▼             ▼                    ▼
                              WebSocket ──► Trading Terminal UI   Solana anchoring
```

## Stack

- **Backend**: Node.js (Express + ws), zero-framework frontend (vanilla JS + canvas)
- **Data**: TxLINE by TxODDS — guest JWT + on-chain free-tier subscription (devnet)
- **Chain**: Solana devnet — subscription, activation signature, journal anchoring

## Run

```bash
npm install
npm start          # serves on :8088 (PORT env to override)
```

Open the UI, press **▶ REPLAY MATCH** to run a deterministic replay, watch the agent trade,
then press **VERIFY CHAIN** to check the integrity of the proof journal.

### TxLINE onboarding (devnet)

```bash
node txline-onboard.mjs    # creates wallet, subscribes on-chain (free tier), activates API token
```

Credentials are stored in `data/` (git-ignored).

## Live demo

https://proofdesk.shadrakbessanh.me
