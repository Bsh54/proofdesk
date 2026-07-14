// Autonomous trading agent — deterministic rule engine over the odds/scores feed.
// The same engine runs on the live stream and on replayed historical data:
// ticks in, decisions out. Every decision is notarised through the hash-chained
// journal with its numeric trigger, and graded after the final whistle.
//
// Strategy playbook (each rule is grounded in published market research):
//   STEAM            pre-match: demargined win probability moves >= steamPts
//                    within steamWindowMs -> follow the money.
//   SURPRISE_FADE    in-play: a goal by a team priced < surpriseProb makes the
//                    market overreact (bias documented to decay in ~5 min) ->
//                    back the conceding side at the inflated price.
//   EXPECTED_FOLLOW  in-play: a goal by a team priced > expectedProb is
//                    underreacted to -> back the scorer immediately.
//   RED_CARD_VALUE   in-play: red card against a team leading or level ->
//                    market over-punishes the 10-man side -> back it (or the
//                    draw when level) once its probability dropped redDropPts.
// Risk framework: fractional Kelly sizing (kellyFrac), hard stake cap per trade
// (stakeCapPct of bankroll), global stop (stopLossPct), one position per match,
// never back odds above maxOdds (favourite-longshot bias filter).
// Skill metric: CLV — entry price vs pre-kickoff closing price (pre-match) or
// vs the same outcome's price clvMarkMs after entry (in-play mark).

export const DEFAULT_CONFIG = {
  bankroll: 1000,
  maxOdds: 4.5,
  kellyFrac: 0.25,
  stakeCapPct: 0.02,
  stopLossPct: 0.20,
  steamPts: 0.04,
  steamWindowMs: 10 * 60 * 1000,
  steamMinTicks: 5,
  surpriseProb: 0.25,
  expectedProb: 0.60,
  fadeDelayMs: 60 * 1000,
  redDropPts: 0.08,
  redDelayMs: 120 * 1000,
  clvMarkMs: 5 * 60 * 1000,
};

const SIDES = ["home", "draw", "away"];

export function createAgent(config = {}, hooks = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const journal = hooks.journal || (() => null);
  const emit = hooks.emit || (() => {});

  const state = {
    bankroll: cfg.bankroll,
    initialBankroll: cfg.bankroll,
    open: [],            // open positions
    closed: [],          // settled positions
    equity: [{ ts: 0, value: cfg.bankroll }],
    halted: false,
    fixtures: new Map(), // fixtureId -> per-fixture memory
  };

  function fx(fixtureId) {
    let f = state.fixtures.get(fixtureId);
    if (!f) {
      f = { probsLog: [], lastProbs: null, lastOdds: null, lastTs: 0, inRunning: false,
            closingOdds: null, pending: [], meta: null, score: [0, 0], done: false };
      state.fixtures.set(fixtureId, f);
    }
    return f;
  }

  function probsFrom(tick) {
    if (tick.pct && tick.pct.length === 3) {
      const s = tick.pct[0] + tick.pct[1] + tick.pct[2];
      if (s > 0) return { home: tick.pct[0] / s, draw: tick.pct[1] / s, away: tick.pct[2] / s };
    }
    const inv = { home: 1 / tick.odds.home, draw: 1 / tick.odds.draw, away: 1 / tick.odds.away };
    const s = inv.home + inv.draw + inv.away;
    return { home: inv.home / s, draw: inv.draw / s, away: inv.away / s };
  }

  function kellyStake(pEst, odds) {
    const b = odds - 1;
    if (b <= 0) return 0;
    const f = (pEst * odds - 1) / b;             // full Kelly fraction
    if (f <= 0) return 0;
    const frac = Math.min(cfg.kellyFrac * f, cfg.stakeCapPct);
    return +(state.bankroll * frac).toFixed(2);
  }

  function openPosition(fixtureId, side, odds, pEst, rule, trigger, ts) {
    if (state.halted) return null;
    if (state.bankroll <= state.initialBankroll * (1 - cfg.stopLossPct)) {
      state.halted = true;
      journal({ kind: "agent", action: "HALT", reason: `stop-loss hit: bankroll ${state.bankroll.toFixed(2)} <= ${(state.initialBankroll * (1 - cfg.stopLossPct)).toFixed(2)}` });
      return null;
    }
    if (odds > cfg.maxOdds) return null;                        // longshot filter
    if (state.open.some((p) => p.fixtureId === fixtureId)) return null; // one per match
    const stake = kellyStake(pEst, odds);
    if (stake < 1) return null;                                 // no measurable edge
    const f = fx(fixtureId);
    const pos = {
      id: Math.random().toString(36).slice(2, 10),
      fixtureId, side, odds, stake, pEst: +pEst.toFixed(4), rule, trigger, ts,
      match: f.meta ? `${f.meta.home} vs ${f.meta.away}` : String(fixtureId),
      team: f.meta ? (side === "home" ? f.meta.home : side === "away" ? f.meta.away : "Draw") : side,
      inRunning: f.inRunning, status: "open", clvPct: null, markOdds: null,
    };
    state.bankroll = +(state.bankroll - stake).toFixed(2);
    state.open.push(pos);
    journal({ kind: "decision", action: "OPEN", position: pos, dataSnapshot: { rule, trigger, probs: f.lastProbs, odds: f.lastOdds } });
    emit({ kind: "agent_trade", action: "OPEN", position: pos });
    return pos;
  }

  function settle(fixtureId, winner, finalScore, ts) {
    const f = fx(fixtureId);
    if (f.done) return;
    f.done = true;
    for (const p of state.open.filter((p) => p.fixtureId === fixtureId)) {
      const won = p.side === winner;
      const pnl = won ? +(p.stake * (p.odds - 1)).toFixed(2) : -p.stake;
      if (won) state.bankroll = +(state.bankroll + p.stake * p.odds).toFixed(2);
      Object.assign(p, { status: "settled", won, pnl, finalScore, settledTs: ts });
      // pre-match CLV against the closing price of the same outcome
      if (!p.inRunning && f.closingOdds) {
        p.clvPct = +((p.odds / f.closingOdds[p.side] - 1) * 100).toFixed(2);
      }
      state.closed.push(p);
      state.equity.push({ ts, value: state.bankroll + openExposure() });
      journal({ kind: "decision", action: "SETTLE", position: p, dataSnapshot: { winner, finalScore } });
      emit({ kind: "agent_trade", action: "SETTLE", position: p });
    }
    state.open = state.open.filter((p) => p.fixtureId !== fixtureId);
  }

  function openExposure() {
    return state.open.reduce((a, p) => a + p.stake, 0);
  }

  // ---- tick handlers ------------------------------------------------------

  function onOdds(tick) {
    // tick: { fixtureId, ts, odds:{home,draw,away}, pct?, inRunning, meta? }
    const f = fx(tick.fixtureId);
    if (f.done) return;
    if (tick.meta) f.meta = tick.meta;
    const probs = probsFrom(tick);
    const wasInRunning = f.inRunning;
    if (!tick.inRunning) f.closingOdds = { ...tick.odds }; // latest pre-match price = closing
    f.inRunning = f.inRunning || !!tick.inRunning;

    // in-play CLV mark: value open in-play positions clvMarkMs after entry
    for (const p of state.open) {
      if (p.fixtureId === tick.fixtureId && p.inRunning && p.markOdds == null && tick.ts >= p.ts + cfg.clvMarkMs) {
        p.markOdds = tick.odds[p.side];
        p.clvPct = +((p.odds / p.markOdds - 1) * 100).toFixed(2);
      }
    }

    // pending in-play entries (fade / red-card) armed by score events
    for (const pend of f.pending.filter((x) => !x.fired && tick.ts >= x.at)) {
      pend.fired = true;
      if (pend.rule === "SURPRISE_FADE") {
        const side = pend.side, odds = tick.odds[side];
        openPosition(tick.fixtureId, side, odds, pend.pEst, pend.rule, pend.trigger, tick.ts);
      }
      if (pend.rule === "RED_CARD_VALUE") {
        const side = pend.side;
        const dropped = pend.probBefore - probs[side];
        if (dropped >= cfg.redDropPts) {
          openPosition(tick.fixtureId, side, tick.odds[side], pend.probBefore, pend.rule,
            `${pend.trigger}; prob dropped ${(dropped * 100).toFixed(1)}pts since card`, tick.ts);
        }
      }
    }
    f.pending = f.pending.filter((x) => !x.fired && tick.ts < x.at + 15 * 60 * 1000);

    // STEAM — pre-match sharp movement detector
    if (!f.inRunning) {
      f.probsLog.push({ ts: tick.ts, probs });
      const cutoff = tick.ts - cfg.steamWindowMs;
      while (f.probsLog.length > 2 && f.probsLog[0].ts < cutoff) f.probsLog.shift();
      if (f.probsLog.length >= cfg.steamMinTicks) {
        const past = f.probsLog[0].probs;
        for (const side of SIDES) {
          const delta = probs[side] - past[side];
          if (delta >= cfg.steamPts) {
            const opened = openPosition(tick.fixtureId, side, tick.odds[side],
              probs[side] + delta / 2, // persistence assumption: half the move continues
              "STEAM",
              `${side} prob +${(delta * 100).toFixed(1)}pts in ${((tick.ts - f.probsLog[0].ts) / 60000).toFixed(1)}min (${(past[side] * 100).toFixed(1)}% -> ${(probs[side] * 100).toFixed(1)}%)`,
              tick.ts);
            if (!opened) journal({ kind: "signal", rule: "STEAM", fixtureId: tick.fixtureId, side, note: "signal detected, position filtered", delta: +(delta * 100).toFixed(1) });
            f.probsLog = [{ ts: tick.ts, probs }]; // reset window after a signal
            break;
          }
        }
      }
    }

    f.lastProbs = probs;
    f.lastOdds = { ...tick.odds };
    f.lastTs = tick.ts;
  }

  // incident: { kind: "goal"|"red", isHome, ts, score:[h,a] }
  function onIncident(fixtureId, inc) {
    const f = fx(fixtureId);
    if (f.done || !f.lastProbs) return;
    const scorerSide = inc.isHome ? "home" : "away";
    const otherSide = inc.isHome ? "away" : "home";
    if (inc.kind === "goal") {
      f.score = inc.score || f.score;
      const pBefore = f.lastProbs[scorerSide];
      if (pBefore < cfg.surpriseProb) {
        // very surprising goal -> market overreacts -> fade: back the conceding side after the spike
        f.pending.push({ rule: "SURPRISE_FADE", side: otherSide, at: inc.ts + cfg.fadeDelayMs, fired: false,
          pEst: f.lastProbs[otherSide], // pre-goal price of the faded side is our value anchor
          trigger: `surprising goal by ${scorerSide} (pre-goal prob ${(pBefore * 100).toFixed(1)}% < ${cfg.surpriseProb * 100}%) — fading the overreaction` });
        journal({ kind: "signal", rule: "SURPRISE_FADE", fixtureId, armed: true, preGoalProb: +(pBefore * 100).toFixed(1) });
      } else if (pBefore > cfg.expectedProb) {
        // expected goal -> market underreacts -> follow the scorer now
        openPosition(fixtureId, scorerSide, f.lastOdds[scorerSide],
          Math.min(0.97, pBefore + 0.10), "EXPECTED_FOLLOW",
          `expected goal by ${scorerSide} (pre-goal prob ${(pBefore * 100).toFixed(1)}% > ${cfg.expectedProb * 100}%) — market underreacts to expected events`, inc.ts);
      }
    }
    if (inc.kind === "red") {
      const carded = scorerSide; // side that received the card
      const [h, a] = f.score;
      const leadingOrLevel = carded === "home" ? h >= a : a >= h;
      if (leadingOrLevel) {
        const level = h === a;
        const side = level ? "draw" : carded;
        f.pending.push({ rule: "RED_CARD_VALUE", side, at: inc.ts + cfg.redDelayMs, fired: false,
          probBefore: f.lastProbs[side],
          trigger: `red card for ${carded} while ${level ? "level" : "leading"} (${h}-${a}) — market over-punishes the 10-man side` });
        journal({ kind: "signal", rule: "RED_CARD_VALUE", fixtureId, armed: true, side, score: `${h}-${a}` });
      }
    }
  }

  function onFinal(fixtureId, { winner, finalScore, ts }) {
    settle(fixtureId, winner, finalScore, ts || Date.now());
  }

  function kpis() {
    const settled = state.closed;
    const wins = settled.filter((p) => p.won).length;
    const pnl = +settled.reduce((a, p) => a + p.pnl, 0).toFixed(2);
    const staked = settled.reduce((a, p) => a + p.stake, 0);
    const clvs = settled.filter((p) => p.clvPct != null).map((p) => p.clvPct);
    const byRule = {};
    for (const p of settled) {
      const r = (byRule[p.rule] = byRule[p.rule] || { trades: 0, wins: 0, pnl: 0, staked: 0 });
      r.trades++; if (p.won) r.wins++; r.pnl = +(r.pnl + p.pnl).toFixed(2); r.staked += p.stake;
    }
    return {
      bankroll: state.bankroll,
      exposure: +openExposure().toFixed(2),
      pnl,
      roiPct: staked ? +((pnl / staked) * 100).toFixed(2) : 0,
      trades: settled.length,
      openCount: state.open.length,
      winRatePct: settled.length ? +((wins / settled.length) * 100).toFixed(1) : 0,
      avgClvPct: clvs.length ? +(clvs.reduce((a, b) => a + b, 0) / clvs.length).toFixed(2) : null,
      halted: state.halted,
      byRule,
    };
  }

  return {
    cfg, state, onOdds, onIncident, onFinal, kpis,
    snapshot: () => ({ kpis: kpis(), open: state.open, closed: state.closed.slice(-100), equity: state.equity.slice(-500), config: cfg }),
  };
}
