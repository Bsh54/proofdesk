// ProofDesk — Verifiable sports trading terminal & agent
// Backend: match replay engine + rule-based agent + hash-chained proof journal.
// TxLINE live connector plugs in via env (TXLINE_API_BASE / TXLINE_JWT / TXLINE_API_TOKEN).

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { createHash, randomUUID } from "crypto";
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { TxLive } from "./txline-live.mjs";
import { createAgent, DEFAULT_CONFIG as AGENT_DEFAULTS } from "./agent.mjs";
import { createBot } from "./bot.mjs";
import { createHorus } from "./horus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8088;
const DATA_DIR = join(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. MATCH SIMULATOR / REPLAY ENGINE ("le guetteur")
//    Deterministic seeded match generator -> same seed = same match = same
//    agent decisions = verifiable, reproducible demo.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAMS = [
  ["France", "Brazil"], ["Argentina", "Germany"], ["Spain", "England"],
  ["Portugal", "Netherlands"], ["Morocco", "Japan"], ["USA", "Mexico"],
];

// Generates a full 90-min match timeline: odds ticks (every ~30s of match
// time) + events (goals, cards, VAR, corners, shots).
export function generateMatch(seed) {
  const rnd = mulberry32(seed);
  const [home, away] = TEAMS[seed % TEAMS.length];
  const strength = 0.35 + rnd() * 0.3; // home win base probability
  let pHome = strength, pDraw = 0.28, pAway = 1 - strength - 0.28;
  let scoreH = 0, scoreA = 0;
  const timeline = [];

  const pushOdds = (min) => {
    const norm = pHome + pDraw + pAway;
    const margin = 1.06; // bookmaker overround
    timeline.push({
      type: "odds", minute: min,
      home: +(norm / (pHome * margin)).toFixed(2),
      draw: +(norm / (pDraw * margin)).toFixed(2),
      away: +(norm / (pAway * margin)).toFixed(2),
    });
  };

  pushOdds(0);
  for (let min = 1; min <= 90; min++) {
    // random drift
    const drift = (rnd() - 0.5) * 0.012;
    pHome = Math.max(0.03, pHome + drift);
    pAway = Math.max(0.03, pAway - drift * 0.6);

    const r = rnd();
    if (r < 0.028) { // goal ~2.5 per match
      const isHome = rnd() < pHome / (pHome + pAway);
      if (isHome) { scoreH++; pHome = Math.min(0.92, pHome + 0.18); pAway = Math.max(0.02, pAway - 0.12); }
      else { scoreA++; pAway = Math.min(0.92, pAway + 0.18); pHome = Math.max(0.02, pHome - 0.12); }
      pDraw = Math.max(0.04, 1 - pHome - pAway);
      timeline.push({ type: "goal", minute: min, team: isHome ? home : away, score: `${scoreH}-${scoreA}` });
      // VAR check on some goals
      if (rnd() < 0.18) {
        timeline.push({ type: "var", minute: min, review: "Goal" });
        if (rnd() < 0.35) { // overturned!
          if (isHome) { scoreH--; pHome = Math.max(0.05, pHome - 0.15); } else { scoreA--; pAway = Math.max(0.05, pAway - 0.15); }
          timeline.push({ type: "var_end", minute: min, outcome: "Overturned", score: `${scoreH}-${scoreA}` });
        } else {
          timeline.push({ type: "var_end", minute: min, outcome: "Stands" });
        }
      }
    } else if (r < 0.05) {
      timeline.push({ type: "shot", minute: min, team: rnd() < 0.5 ? home : away, outcome: rnd() < 0.4 ? "OnTarget" : "OffTarget" });
    } else if (r < 0.07) {
      timeline.push({ type: "corner", minute: min, team: rnd() < 0.5 ? home : away });
    } else if (r < 0.082) {
      const red = rnd() < 0.12;
      const isHome = rnd() < 0.5;
      timeline.push({ type: "card", minute: min, card: red ? "red" : "yellow", team: isHome ? home : away });
      if (red) { if (isHome) { pHome = Math.max(0.03, pHome - 0.14); pAway += 0.1; } else { pAway = Math.max(0.03, pAway - 0.14); pHome += 0.1; } }
    }
    if (min % 1 === 0) pushOdds(min);
  }
  timeline.push({ type: "full_time", minute: 90, score: `${scoreH}-${scoreA}`, winner: scoreH > scoreA ? home : scoreA > scoreH ? away : "draw" });
  return { seed, home, away, timeline };
}

// ---------------------------------------------------------------------------
// 2. PROOF JOURNAL ("le notaire") — hash-chained, append-only decision log.
//    Each record embeds sha256(prev) -> tamper-evident chain.
//    anchorTx: reserved for Solana devnet anchoring (wired at J3).
// ---------------------------------------------------------------------------

const JOURNAL_FILE = join(DATA_DIR, "journal.jsonl");
let lastHash = "GENESIS";
if (existsSync(JOURNAL_FILE)) {
  const lines = readFileSync(JOURNAL_FILE, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length) lastHash = JSON.parse(lines[lines.length - 1]).hash;
}

function journalAppend(record) {
  const body = { ...record, id: randomUUID(), ts: new Date().toISOString(), prevHash: lastHash };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const entry = { ...body, hash, anchorTx: null };
  appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + "\n");
  lastHash = hash;
  broadcast({ kind: "journal", entry });
  return entry;
}

function journalRead(limit = 200) {
  if (!existsSync(JOURNAL_FILE)) return [];
  const lines = readFileSync(JOURNAL_FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l));
}

function journalVerify() {
  const entries = journalRead(1e9);
  let prev = "GENESIS";
  for (const e of entries) {
    const { hash, anchorTx, ...body } = e;
    if (body.prevHash !== prev) return { ok: false, brokenAt: e.id, reason: "prevHash mismatch" };
    const recomputed = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (recomputed !== hash) return { ok: false, brokenAt: e.id, reason: "hash mismatch" };
    prev = hash;
  }
  return { ok: true, count: entries.length, head: prev };
}

// ---------------------------------------------------------------------------
// 2-bis. LIVE AUTONOMOUS AGENT — the production trading agent. Runs on the
// full TxLINE stream (every fixture), journals every decision through the
// hash chain, persists its book across restarts, needs no human input.
// ---------------------------------------------------------------------------

const AGENT_STATE_FILE = join(DATA_DIR, "agent-state.json");
const AGENT_CONFIG_FILE = join(DATA_DIR, "agent-config.json");
const agentConfig = existsSync(AGENT_CONFIG_FILE)
  ? { ...AGENT_DEFAULTS, ...JSON.parse(readFileSync(AGENT_CONFIG_FILE, "utf8")) }
  : AGENT_DEFAULTS;

const liveAgent = createAgent(agentConfig, {
  journal: (r) => journalAppend({ ...r, source: "live-agent" }),
  emit: (m) => {
    broadcast(m);
    // sharp-money alerts double as fan notifications through HORUS
    if (horus && m.action === "OPEN" && m.position?.rule === "STEAM") {
      horus.notifyFollowers(m.position.fixtureId, { kind: "steam", side: m.position.side, detail: m.position.trigger });
    }
  },
});

// restore the persisted book (bankroll, settled trades, equity curve)
if (existsSync(AGENT_STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(AGENT_STATE_FILE, "utf8"));
    liveAgent.state.bankroll = saved.bankroll ?? liveAgent.state.bankroll;
    liveAgent.state.closed = saved.closed || [];
    liveAgent.state.equity = saved.equity || liveAgent.state.equity;
    liveAgent.state.halted = saved.halted || false;
  } catch {}
}
setInterval(() => {
  try {
    writeFileSync(AGENT_STATE_FILE, JSON.stringify({
      bankroll: liveAgent.state.bankroll, closed: liveAgent.state.closed,
      equity: liveAgent.state.equity, halted: liveAgent.state.halted, savedAt: Date.now(),
    }));
  } catch {}
}, 30_000);

// ---------------------------------------------------------------------------
// 2-ter. HORUS — the Telegram pundit. The eye on every match: follows the
// full feed, notifies fans of goals / cards / sharp market moves with the
// market's read, speaks voice notes, replays archived matches, answers
// questions. Dormant until data/telegram.json provides a bot token.
// ---------------------------------------------------------------------------

let horus = null;
const chatLists = new Map(); // chatId -> last numbered match list

function matchLabel(id) {
  const meta = live ? live.metaFor(id) : null;
  return meta ? `${meta.home} vs ${meta.away}` : `match ${id}`;
}

function liveContextFor(id) {
  const meta = live ? live.metaFor(id) : null;
  const st = scoreStates.get(id);
  const probs = liveAgent.state.fixtures.get(id)?.lastProbs;
  const odds = liveAgent.state.fixtures.get(id)?.lastOdds;
  const parts = [matchLabel(id)];
  if (st) parts.push(`score ${st.score[0]}-${st.score[1]}, minute ${st.minute ?? "?"}, phase ${st.gameState || PHASES[st.statusId] || "scheduled"}, yellows ${st.yellow.join("-")}, reds ${st.red.join("-")}, corners ${st.corners.join("-")}`);
  if (probs && meta) parts.push(`win probabilities: ${meta.home} ${(probs.home * 100).toFixed(1)}%, draw ${(probs.draw * 100).toFixed(1)}%, ${meta.away} ${(probs.away * 100).toFixed(1)}%`);
  if (odds) parts.push(`odds 1X2: ${odds.home} / ${odds.draw} / ${odds.away}`);
  return parts.join("\n");
}

async function botCommand({ chatId, text, from, bot }) {
  const name = from.first_name || from.username || "fan";
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");
  const listMatches = () => {
    const ids = live ? live.allFixtureIds() : [];
    const rows = ids.map((id) => ({ id, meta: live.metaFor(id) })).filter((r) => r.meta)
      .sort((a, b) => (a.meta.startTime || 0) - (b.meta.startTime || 0));
    chatLists.set(String(chatId), rows.map((r) => r.id));
    return rows;
  };
  switch ((cmd || "").toLowerCase()) {
    case "/start":
      await bot.sendText(chatId,
        `𓂀 <b>I am HORUS — the eye on every match.</b>\n\nI watch all World Cup matches and their betting markets at once, and I tell you the moment something matters: goals, red cards, and when the sharp money moves.\n\n<b>Commands</b>\n/matches — list matches\n/follow N — follow match N\n/followall — follow everything\n/live — current picture of followed matches\n/ask &lt;question&gt; — talk to me about a live match\n/relive N — replay a past match as if live 🕰\n/voice off|on — voice notes\n/unfollow — silence me`);
      break;
    case "/matches": {
      const rows = listMatches();
      if (!rows.length) { await bot.sendText(chatId, "No matches on the feed right now."); break; }
      await bot.sendText(chatId, "<b>Matches</b>\n" + rows.map((r, i) => {
        const st = scoreStates.get(r.id);
        const liveMark = st && st.statusId && st.statusId !== 10 && PHASES[st.statusId] ? " 🔴" : "";
        const when = r.meta.startTime ? new Date(r.meta.startTime).toISOString().slice(5, 16).replace("T", " ") : "";
        return `${i + 1}. ${r.meta.home} vs ${r.meta.away} — ${when} UTC${liveMark}`;
      }).join("\n") + "\n\n/follow N · /relive N");
      break;
    }
    case "/follow": {
      const rows = chatLists.get(String(chatId)) || listMatches().map((r) => r.id);
      const id = rows[parseInt(arg, 10) - 1];
      if (!id) { await bot.sendText(chatId, "Use /matches then /follow N."); break; }
      bot.subscribe(chatId, id, name);
      await bot.sendText(chatId, `𓂀 Following <b>${matchLabel(id)}</b>. I will speak when it matters.`);
      break;
    }
    case "/followall":
      bot.subscribe(chatId, "all", name);
      await bot.sendText(chatId, "𓂀 I will tell you about <b>every match</b> on the feed.");
      break;
    case "/unfollow":
      bot.unsubscribe(chatId);
      await bot.sendText(chatId, "Silenced. /follow when you miss me.");
      break;
    case "/voice":
      bot.setVoice(chatId, arg !== "off");
      await bot.sendText(chatId, arg === "off" ? "Voice notes off." : "Voice notes on.");
      break;
    case "/live": {
      const subs = bot.subs.get(String(chatId));
      const ids = subs ? (subs.follows[0] === "all" ? (live ? live.allFixtureIds() : []) : subs.follows) : [];
      const active = ids.filter((id) => scoreStates.get(Number(id))?.statusId && scoreStates.get(Number(id)).statusId !== 10);
      const shown = (active.length ? active : ids).slice(0, 5);
      if (!shown.length) { await bot.sendText(chatId, "You follow nothing yet — /matches."); break; }
      for (const id of shown) await bot.sendText(chatId, liveContextFor(Number(id)));
      break;
    }
    case "/ask": {
      if (!arg) { await bot.sendText(chatId, "Ask me something: /ask who is winning?"); break; }
      const subs = bot.subs.get(String(chatId));
      const ids = subs ? (subs.follows[0] === "all" ? (live ? live.allFixtureIds() : []) : subs.follows) : (live ? live.allFixtureIds() : []);
      const ctx = ids.slice(0, 6).map((id) => liveContextFor(Number(id))).join("\n---\n");
      await horus.ask(chatId, arg, ctx || "no live data right now");
      break;
    }
    case "/relive": {
      const rows = chatLists.get(String(chatId)) || listMatches().map((r) => r.id);
      const id = rows[parseInt(arg, 10) - 1];
      if (!id) { await bot.sendText(chatId, "Use /matches then /relive N."); break; }
      horus.relive(chatId, id, live.metaFor(id) || { home: "Home", away: "Away" });
      break;
    }
    case "/stopreplay":
      horus.stopReplay(chatId);
      await bot.sendText(chatId, "Replay stopped.");
      break;
    default:
      if (text.startsWith("/")) await bot.sendText(chatId, "Unknown command — /start for the list.");
      else { // free text = conversation
        const ids = live ? live.allFixtureIds() : [];
        const ctx = ids.slice(0, 6).map((id) => liveContextFor(Number(id))).join("\n---\n");
        await horus.ask(chatId, text, ctx || "no live data right now");
      }
  }
}

const punditBot = createBot({ onCommand: botCommand });
horus = createHorus({
  bot: punditBot,
  journal: (r) => journalAppend({ ...r, source: "horus" }),
  getMeta: (id) => (live ? live.metaFor(id) : null),
  getProbs: (id) => liveAgent.state.fixtures.get(id)?.lastProbs || null,
  getState: (id) => scoreStates.get(id) || null,
});

// ---------------------------------------------------------------------------
// 3. RULE-BASED AGENT ("le trader") — paper-trading book.
// ---------------------------------------------------------------------------

const DEFAULT_RULES = [
  { id: "momentum-drop", desc: "Back a team if its odds shorten >12% within 5 min (market momentum)", threshold: 0.12, window: 5, stake: 50 },
  { id: "red-card-fade", desc: "Lay (bet against) a team that receives a red card", stake: 40 },
  { id: "late-equalizer-hunt", desc: "Back the draw if a team leads by 1 goal after minute 75 and concedes >2 corners in 5 min", stake: 30 },
];

function makeAgentState() {
  return { bankroll: 1000, openPositions: [], closedPositions: [], oddsHistory: [], rules: JSON.parse(JSON.stringify(DEFAULT_RULES)) };
}

function agentOnTick(session, ev) {
  const st = session.agent;
  const m = session.match;
  const decisions = [];

  if (ev.type === "odds") {
    st.oddsHistory.push(ev);
    const windowStart = ev.minute - st.rules[0].window;
    const past = st.oddsHistory.find((o) => o.minute >= windowStart);
    if (past) {
      for (const side of ["home", "away"]) {
        const drop = (past[side] - ev[side]) / past[side];
        if (drop > st.rules[0].threshold && !st.openPositions.some((p) => p.side === side)) {
          decisions.push(openPosition(session, { rule: "momentum-drop", side, team: side === "home" ? m.home : m.away, odds: ev[side], stake: st.rules[0].stake, minute: ev.minute, trigger: `${side} odds shortened ${(drop * 100).toFixed(1)}% over ${st.rules[0].window}min (${past[side]} → ${ev[side]})` }));
        }
      }
    }
  }

  if (ev.type === "card" && ev.card === "red") {
    const side = ev.team === m.home ? "away" : "home"; // bet against carded team
    const lastOdds = st.oddsHistory[st.oddsHistory.length - 1];
    if (lastOdds && !st.openPositions.some((p) => p.rule === "red-card-fade")) {
      decisions.push(openPosition(session, { rule: "red-card-fade", side, team: side === "home" ? m.home : m.away, odds: lastOdds[side], stake: st.rules[1].stake, minute: ev.minute, trigger: `Red card for ${ev.team} at ${ev.minute}'` }));
    }
  }

  if (ev.type === "full_time") settleAll(session, ev);
  return decisions;
}

function openPosition(session, pos) {
  const st = session.agent;
  st.bankroll -= pos.stake;
  const position = { ...pos, id: randomUUID().slice(0, 8), status: "open" };
  st.openPositions.push(position);
  // Every decision is notarised with the triggering data snapshot.
  const proof = journalAppend({
    kind: "decision", action: "OPEN", position,
    dataSnapshot: { seed: session.match.seed, match: `${session.match.home} vs ${session.match.away}`, trigger: pos.trigger },
  });
  return { position, proof };
}

function settleAll(session, ftEv) {
  const st = session.agent;
  for (const p of st.openPositions) {
    const won = (ftEv.winner === p.team) || (p.side === "draw" && ftEv.winner === "draw");
    const pnl = won ? +(p.stake * (p.odds - 1)).toFixed(2) : -p.stake;
    if (won) st.bankroll += p.stake * p.odds;
    const closed = { ...p, status: "settled", won, pnl, finalScore: ftEv.score };
    st.closedPositions.push(closed);
    journalAppend({ kind: "decision", action: "SETTLE", position: closed, dataSnapshot: { finalScore: ftEv.score, winner: ftEv.winner } });
  }
  st.openPositions = [];
}

// ---------------------------------------------------------------------------
// 4. SESSION / REPLAY LOOP
// ---------------------------------------------------------------------------

const sessions = new Map();

function startReplay(seed = 42, speed = 20) {
  stopReplay();
  const match = generateMatch(seed);
  const session = { id: randomUUID().slice(0, 8), match, agent: makeAgentState(), cursor: 0, speed, timer: null };
  sessions.set("current", session);
  journalAppend({ kind: "session_start", match: `${match.home} vs ${match.away}`, seed, speed });
  broadcast({ kind: "session", match: { home: match.home, away: match.away, seed }, agent: session.agent });

  const tick = () => {
    const s = sessions.get("current");
    if (!s || s.cursor >= s.match.timeline.length) return stopReplay();
    const ev = s.match.timeline[s.cursor++];
    broadcast({ kind: "event", ev });
    replayUpdateState(s, ev);
    const decisions = agentOnTick(s, ev);
    for (const d of decisions) broadcast({ kind: "decision", ...d });
    broadcast({ kind: "agent", agent: { bankroll: s.agent.bankroll, open: s.agent.openPositions, closed: s.agent.closedPositions } });
    if (ev.type === "full_time") { broadcast({ kind: "session_end" }); return stopReplay(); }
    s.timer = setTimeout(tick, 1000 / s.speed * (s.match.timeline[s.cursor]?.minute > ev.minute ? 30 : 3));
  };
  tick();
  return session;
}

function stopReplay() {
  const s = sessions.get("current");
  if (s?.timer) clearTimeout(s.timer);
  sessions.delete("current");
}

// ---------------------------------------------------------------------------
// 4a-bis. MATCH STATE — Aggregated live match state (score, stats, clock)
// ---------------------------------------------------------------------------

function blankMatchState() {
  return { minute: 0, gameState: "—", score: [0, 0], corners: [0, 0], yellow: [0, 0], red: [0, 0], shots: [0, 0], possession: null };
}

// Decode TxLINE period-prefixed stat keys: "1001" = period1+stat001.
// stat n: 1,2=goals 3,4=yellow 5,6=red 7,8=corners (per team)
function decodeTxStats(st = {}) {
  const per = (p, n) => st[String(p * 1000 + n)] ?? 0;
  const g = (n) => {
    if (st[String(n)] != null) return st[String(n)];
    let s = 0;
    for (let p = 1; p <= 9; p++) s += per(p, n);
    return s;
  };
  const bundle = (get) => ({ score: [get(1), get(2)], yellow: [get(3), get(4)], red: [get(5), get(6)], corners: [get(7), get(8)] });
  return { ...bundle(g), periods: { "1ST": bundle((n) => per(1, n)), "2ND": bundle((n) => per(2, n)) } };
}

function replayUpdateState(s, ev) {
  const st = s.state || (s.state = blankMatchState());
  st.minute = ev.minute ?? st.minute;
  const isHome = ev.team === s.match.home ? 0 : 1;
  if (ev.type === "goal") { const [h, a] = ev.score.split("-").map(Number); st.score = [h, a]; }
  if (ev.type === "var_end" && ev.score) { const [h, a] = ev.score.split("-").map(Number); st.score = [h, a]; }
  if (ev.type === "corner") st.corners[isHome]++;
  if (ev.type === "shot") st.shots[isHome]++;
  if (ev.type === "card") (ev.card === "red" ? st.red : st.yellow)[isHome]++;
  if (ev.type === "full_time") st.gameState = "Finished";
  else if (ev.minute > 0) st.gameState = ev.minute <= 45 ? "1st half" : "2nd half";
  broadcast({ kind: "match_state", state: st });
}

// ---------------------------------------------------------------------------
// 4b. LIVE MODE — real TxLINE data drives the terminal and the agent.
//     Provenance: every agent decision embeds the TxLINE MessageId + Ts of the
//     exact odds message that triggered it.
// ---------------------------------------------------------------------------

let live = null;
let liveSession = null; // { fixtureId, agent, startTs, match }
const scoreStates = new Map(); // fixtureId -> decoded match state (all fixtures)

// Persist score states across restarts (finished matches keep their score).
const STATES_FILE = join(DATA_DIR, "score-states.json");
try {
  if (existsSync(STATES_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(STATES_FILE, "utf8")))) scoreStates.set(Number(k), v);
    console.log(`restored ${scoreStates.size} score states`);
  }
} catch {}
setInterval(() => {
  try { writeFileSync(STATES_FILE, JSON.stringify(Object.fromEntries(scoreStates))); } catch {}
}, 20000);

// Game-state mapping (TxLINE StatusId -> status object)
const PHASES = { 1: "Not started", 2: "1st half", 3: "Halftime", 4: "2nd half", 5: "ET 1st", 6: "ET break", 7: "ET 2nd", 8: "Penalties", 10: "Finished", 19: "Postponed" };

// ---------------------------------------------------------------------------
// INCIDENTS — Event-centric model: each match owns an incidents list
// (goal / card / period), built by diffing consecutive score states.
// ---------------------------------------------------------------------------
const incidentsMap = new Map(); // fixtureId -> [{time, incidentType, ...}]

function pushIncident(fixtureId, inc) {
  const arr = incidentsMap.get(fixtureId) || [];
  arr.push(inc);
  if (arr.length > 200) arr.shift();
  incidentsMap.set(fixtureId, arr);
  broadcast({ kind: "incident", fixtureId, incident: inc });
}

function detectIncidents(fixtureId, prev, st, m) {
  const t = st.minute ?? null;
  for (const side of [0, 1]) {
    const isHome = side === 0;
    if (st.score[side] > prev.score[side])
      pushIncident(fixtureId, { time: t, incidentType: "goal", isHome, homeScore: st.score[0], awayScore: st.score[1] });
    if (st.score[side] < prev.score[side]) // VAR overturned
      pushIncident(fixtureId, { time: t, incidentType: "varDecision", isHome, text: "Goal overturned", homeScore: st.score[0], awayScore: st.score[1] });
    if (st.yellow[side] > prev.yellow[side])
      pushIncident(fixtureId, { time: t, incidentType: "card", cardColor: "yellow", isHome });
    if (st.red[side] > prev.red[side])
      pushIncident(fixtureId, { time: t, incidentType: "card", cardColor: "red", isHome });
  }
  if (st.statusId !== prev.statusId && PHASES[st.statusId])
    pushIncident(fixtureId, { time: t, incidentType: "period", text: PHASES[st.statusId], homeScore: st.score[0], awayScore: st.score[1] });
}

function liveMinute(ts) {
  return Math.max(0, Math.round((ts - liveSession.startTs) / 60000));
}

function ensureLive() {
  if (live) return live;
  live = new TxLive({
    onStatus: (s) => broadcast({ kind: "live_status", ...s }),
    onScore: (s) => {
      const m = s.raw;
      if (!m || !m.FixtureId) return;
      // Track state for EVERY fixture (event-centric model), not only the watched one.
      const st = scoreStates.get(m.FixtureId) || blankMatchState();
      const prev = { score: [...st.score], yellow: [...st.yellow], red: [...st.red], statusId: st.statusId };
      if (m.Clock?.Seconds != null) st.minute = Math.floor(m.Clock.Seconds / 60);
      if (m.GameState) st.gameState = m.GameState;
      if (m.StatusId != null) st.statusId = m.StatusId;
      if (m.Possession != null) st.possession = m.Possession;
      if (m.Stats) {
        const d = decodeTxStats(m.Stats);
        st.score = d.score; st.yellow = d.yellow; st.red = d.red; st.corners = d.corners;
        st.periods = d.periods;
      }
      // possession share: accumulate which side holds the ball, message by message
      st.poss = st.poss || [0, 0];
      if (m.Possession === 1 || m.Possession === "1") st.poss[0]++;
      else if (m.Possession === 2 || m.Possession === "2") st.poss[1]++;
      // attack momentum (event-weighted, decaying wave from -100 away to +100 home)
      updateMomentum(m.FixtureId, st, m);
      scoreStates.set(m.FixtureId, st);
      detectIncidents(m.FixtureId, prev, st, m);
      // agent: in-play event triggers + settlement on final whistle
      const tsNow = m.Ts || Date.now();
      const side0 = st.score[0] > prev.score[0], side1 = st.score[1] > prev.score[1];
      if (side0 || side1) liveAgent.onIncident(m.FixtureId, { kind: "goal", isHome: side0, ts: tsNow, score: [...st.score] });
      if (st.red[0] > prev.red[0]) liveAgent.onIncident(m.FixtureId, { kind: "red", isHome: true, ts: tsNow, score: [...st.score] });
      if (st.red[1] > prev.red[1]) liveAgent.onIncident(m.FixtureId, { kind: "red", isHome: false, ts: tsNow, score: [...st.score] });
      // HORUS speaks to the fans (async, never blocks the feed)
      if (horus) {
        if (side0 || side1) horus.notifyFollowers(m.FixtureId, { kind: "goal", isHome: side0 }).catch(() => {});
        if (st.red[0] > prev.red[0]) horus.notifyFollowers(m.FixtureId, { kind: "red", isHome: true }).catch(() => {});
        if (st.red[1] > prev.red[1]) horus.notifyFollowers(m.FixtureId, { kind: "red", isHome: false }).catch(() => {});
        if (st.statusId !== prev.statusId && PHASES[st.statusId]) horus.notifyFollowers(m.FixtureId, { kind: "period", text: PHASES[st.statusId] }).catch(() => {});
      }
      if (st.statusId === 10 && prev.statusId !== 10) {
        const [h, a] = st.score;
        liveAgent.onFinal(m.FixtureId, { winner: h > a ? "home" : a > h ? "away" : "draw", finalScore: `${h}-${a}`, ts: tsNow });
      }
      if (liveSession && m.FixtureId === liveSession.fixtureId) {
        liveSession.state = st;
        broadcast({ kind: "match_state", state: st });
      }
    },
    onOdds: (o) => {
      broadcast({ kind: "live_odds_all", fixtureId: o.fixtureId, odds: { home: o.home, draw: o.draw, away: o.away }, inRunning: o.inRunning });
      // agent watches EVERY fixture on the stream, autonomously
      liveAgent.onOdds({
        fixtureId: o.fixtureId, ts: o.ts || Date.now(),
        odds: { home: o.home, draw: o.draw, away: o.away },
        pct: o.pct, inRunning: o.inRunning, meta: live ? live.metaFor(o.fixtureId) : null,
      });
      if (horus) horus.rememberProbs(o.fixtureId);
      if (!liveSession || o.fixtureId !== liveSession.fixtureId) return;
      const ev = { type: "odds", minute: liveMinute(o.ts), home: o.home, draw: o.draw, away: o.away, messageId: o.messageId, ts: o.ts };
      broadcast({ kind: "event", ev });
      const s = liveSession;
      const decisions = agentOnTick(s, ev);
      for (const d of decisions) broadcast({ kind: "decision", ...d });
      broadcast({ kind: "agent", agent: { bankroll: s.agent.bankroll, open: s.agent.openPositions, closed: s.agent.closedPositions } });
    },
  });
  return live;
}

// ---------------------------------------------------------------------------
// 5. HTTP + WS
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

app.post("/api/replay/start", (req, res) => {
  const { seed = 42, speed = 20 } = req.body || {};
  const s = startReplay(Number(seed), Number(speed));
  res.json({ ok: true, session: s.id, match: `${s.match.home} vs ${s.match.away}` });
});
app.post("/api/replay/stop", (_req, res) => { stopReplay(); res.json({ ok: true }); });

// ---------------------------------------------------------------------------
// ATTACK MOMENTUM — one point per minute, value -100 (away) .. +100 (home),
// event-weighted with decay. Same graph model as leading livescore apps.
// ---------------------------------------------------------------------------
const momentumMap = new Map(); // fixtureId -> [{minute, value}]

function updateMomentum(fixtureId, st, m) {
  const minute = st.minute ?? 0;
  const side = (m.Possession === 1 || m.Possession === "1") ? 1 : (m.Possession === 2 || m.Possession === "2") ? -1 : 0;
  const a = String(m.Action || "").toLowerCase();
  let w = 4;
  if (a.includes("danger")) w = 18;
  else if (a.includes("shot")) w = 26;
  else if (a.includes("attack")) w = 11;
  else if (a.includes("corner")) w = 14;
  else if (a.includes("free_kick")) w = 9;
  const pts = momentumMap.get(fixtureId) || [];
  const prevVal = pts.length ? pts[pts.length - 1].value : 0;
  const value = Math.max(-100, Math.min(100, Math.round(prevVal * 0.82 + w * side)));
  if (pts.length && pts[pts.length - 1].minute === minute) pts[pts.length - 1].value = value;
  else pts.push({ minute, value });
  if (pts.length > 140) pts.shift();
  momentumMap.set(fixtureId, pts);
}

// --- Events API (event-centric JSON model) ---
// Full schedule: every known fixture (snapshot metadata + streams), so the
// list always shows upcoming, live and finished matches — never an empty page.
app.get("/api/events/live", (_req, res) => {
  if (!live) return res.json({ events: [] });
  const now = Date.now();
  const events = live.allFixtureIds().map((id) => {
    const meta = live.metaFor(id);
    const st = scoreStates.get(id);
    const scoreSum = (st?.score?.[0] ?? 0) + (st?.score?.[1] ?? 0);
    const started = meta?.startTime ? meta.startTime <= now : false;
    const streamLive = live.inRunningFor(id); // odds still flowing = truly live
    // finished wins over stale in-play status: explicit FT, or kickoff >2h30 ago with no live odds
    const longOver = meta?.startTime ? now - meta.startTime > 125 * 60 * 1000 : false;
    const finished = !streamLive && (st?.statusId === 10 || (started && longOver));
    const inplay = !finished && (streamLive || (st && [2, 3, 4, 5, 6, 7, 8].includes(st.statusId)));
    const type = inplay ? "inprogress" : finished ? "finished" : "notstarted";
    return {
      id,
      tournament: { name: meta?.competition || "FIFA World Cup 2026", category: { name: "World", sport: { name: "Football" } } },
      status: {
        code: st?.statusId ?? (inplay ? 2 : finished ? 10 : 1),
        description: inplay ? (PHASES[st?.statusId] || "In progress") : finished ? "FT" : "Not started",
        type,
      },
      homeTeam: { name: meta?.home || `Home #${id}`, id },
      awayTeam: { name: meta?.away || `Away #${id}`, id },
      homeScore: { current: st?.score?.[0] ?? 0, display: st?.score?.[0] ?? 0 },
      awayScore: { current: st?.score?.[1] ?? 0, display: st?.score?.[1] ?? 0 },
      time: { minute: st?.minute ?? null },
      startTimestamp: meta?.startTime ? Math.floor(meta.startTime / 1000) : null,
      odds: live.oddsFor(id) ? { home: live.oddsFor(id).home, draw: live.oddsFor(id).draw, away: live.oddsFor(id).away } : null,
    };
  });
  // in-play first, then upcoming by start time, finished last
  const rank = { inprogress: 0, notstarted: 1, finished: 2 };
  events.sort((a, b) => rank[a.status.type] - rank[b.status.type] || (a.startTimestamp || 9e12) - (b.startTimestamp || 9e12));
  res.json({ events });
});

// Incidents endpoint (per-event incident list)
app.get("/api/events/:id/incidents", (req, res) => {
  res.json({ incidents: incidentsMap.get(Number(req.params.id)) || [] });
});

// Statistics endpoint — periods ALL / 1ST / 2ND, groups, pre-chewed items
// (compareCode tells the frontend which side to highlight: 1 home, 2 away, 3 equal)
app.get("/api/events/:id/statistics", (req, res) => {
  const st = scoreStates.get(Number(req.params.id));
  if (!st) return res.json({ statistics: [] });
  const item = (name, h, a, suffix = "") => ({
    name, home: `${h}${suffix}`, away: `${a}${suffix}`, homeValue: h, awayValue: a,
    compareCode: h > a ? 1 : a > h ? 2 : 3, statisticsType: "positive", valueType: "team",
  });
  const bundleItems = (b, withPoss) => {
    const items = [];
    if (withPoss && st.poss && (st.poss[0] + st.poss[1]) > 10) {
      const tot = st.poss[0] + st.poss[1];
      items.push(item("Ball possession", Math.round(st.poss[0] / tot * 100), Math.round(st.poss[1] / tot * 100), "%"));
    }
    items.push(item("Corner kicks", b.corners[0], b.corners[1]));
    items.push(item("Yellow cards", b.yellow[0], b.yellow[1]));
    items.push(item("Red cards", b.red[0], b.red[1]));
    return items;
  };
  const statistics = [{ period: "ALL", groups: [{ groupName: "Match overview", statisticsItems: bundleItems(st, true) }] }];
  if (st.periods) {
    for (const p of ["1ST", "2ND"]) {
      statistics.push({ period: p, groups: [{ groupName: "Match overview", statisticsItems: bundleItems(st.periods[p], false) }] });
    }
  }
  res.json({ statistics });
});

// "Who will win?" — real visitor votes, persisted server-side.
const VOTES_FILE = join(DATA_DIR, "votes.json");
let votes = {};
try { votes = JSON.parse(readFileSync(VOTES_FILE, "utf8")); } catch {}
app.get("/api/events/:id/votes", (req, res) => res.json({ vote: votes[req.params.id] || { 1: 0, X: 0, 2: 0 } }));
app.post("/api/events/:id/votes", (req, res) => {
  const c = String(req.body?.choice || "");
  if (!["1", "X", "2"].includes(c)) return res.status(400).json({ ok: false });
  const v = (votes[req.params.id] = votes[req.params.id] || { 1: 0, X: 0, 2: 0 });
  v[c]++;
  try { writeFileSync(VOTES_FILE, JSON.stringify(votes)); } catch {}
  res.json({ ok: true, vote: v });
});

// Season statistics per team, aggregated from OUR tracked archive.
function seasonStats(teamName) {
  const form = teamFormAll(teamName);
  const s = { matches: form.length, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
  for (const f of form) {
    if (f.result === "W") s.wins++; else if (f.result === "L") s.losses++; else s.draws++;
    const [gh, ga] = f.score.split("-").map(Number);
    s.goalsFor += f.home ? gh : ga;
    s.goalsAgainst += f.home ? ga : gh;
  }
  return s;
}

// Team form built from OUR observed archive: every finished fixture this
// platform has tracked contributes a W/D/L entry for both teams.
function teamFormAll(teamName, excludeId) {
  if (!live || !teamName) return [];
  const out = [];
  for (const fid of live.allFixtureIds()) {
    if (fid === excludeId) continue;
    const meta = live.metaFor(fid);
    const st = scoreStates.get(fid);
    if (!meta || !st || !st.score) continue;
    const isHome = meta.home === teamName, isAway = meta.away === teamName;
    if (!isHome && !isAway) continue;
    const started = meta.startTime && meta.startTime <= Date.now();
    const over = started && Date.now() - meta.startTime > 125 * 60 * 1000;
    if (!over) continue;
    const [gh, ga] = st.score;
    const mine = isHome ? gh : ga, theirs = isHome ? ga : gh;
    out.push({
      opponent: isHome ? meta.away : meta.home,
      score: `${gh}-${ga}`, home: isHome,
      result: mine > theirs ? "W" : mine < theirs ? "L" : "D",
      startTime: meta.startTime, competition: meta.competition,
    });
  }
  return out.sort((a, b) => b.startTime - a.startTime);
}
const teamForm = (teamName, excludeId) => teamFormAll(teamName, excludeId).slice(0, 5);

// Pre-game endpoint — market-implied win probability (demargined consensus),
// same display concept as the "who will win" bar, but based on real prices.
app.get("/api/events/:id/pregame", (req, res) => {
  const id = Number(req.params.id);
  const meta = live ? live.metaFor(id) : null;
  const odds = live ? live.oddsFor(id) : null;
  let winProbability = null;
  if (odds) {
    let pct = Array.isArray(odds.pct) ? odds.pct.map(parseFloat) : [];
    if (pct.length !== 3 || pct.some(isNaN)) {
      const inv = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
      const s = inv[0] + inv[1] + inv[2];
      pct = inv.map((v) => (v / s) * 100);
    }
    winProbability = { home: +pct[0].toFixed(1), draw: +pct[1].toFixed(1), away: +pct[2].toFixed(1) };
  }
  const opening = live ? live.openingFor(id) : null;
  res.json({
    kickoff: meta?.startTime || null,
    competition: meta?.competition || null,
    winProbability,
    marketsOpen: live ? live.bookFor(id).length : 0,
    oddsMovement: opening && odds ? { opening: { home: opening.home, draw: opening.draw, away: opening.away }, current: { home: odds.home, draw: odds.draw, away: odds.away } } : null,
    homeForm: teamForm(meta?.home, id),
    awayForm: teamForm(meta?.away, id),
    seasonStats: { home: seasonStats(meta?.home), away: seasonStats(meta?.away) },
  });
});

// Attack momentum graph — {graphPoints:[{minute,value}], periodTime, periodCount}
app.get("/api/events/:id/graph", (req, res) => {
  res.json({ graphPoints: momentumMap.get(Number(req.params.id)) || [], periodTime: 45, periodCount: 2 });
});

// Odds endpoint — full market book with movement direction per choice
app.get("/api/events/:id/odds", (req, res) => {
  if (!live) return res.json({ markets: [] });
  const book = live.bookFor(Number(req.params.id));
  const MARKET_LABELS = { "1X2_PARTICIPANT_RESULT": "Full time result", "OVERUNDER_PARTICIPANT_GOALS": "Total goals", "ASIANHANDICAP_PARTICIPANT_GOALS": "Asian handicap" };
  const CHOICE_LABELS = { part1: "1", draw: "X", part2: "2", over: "Over", under: "Under" };
  const markets = book.map((b) => ({
    marketName: (MARKET_LABELS[b.type] || b.type) + (b.period ? " — " + b.period.replace("half=1", "1st half").replace("half=2", "2nd half") : ""),
    marketParams: b.params,
    choices: b.names.map((n, i) => ({
      name: CHOICE_LABELS[n] || n,
      value: b.prices[i].toFixed(2),
      change: b.prev ? Math.sign(b.prices[i] - b.prev[i]) : 0,
    })),
    ts: b.ts,
  }));
  const order = { "Full time result": 0, "Total goals": 1, "Asian handicap": 2 };
  markets.sort((a, b) => (order[a.marketName] ?? 9) - (order[b.marketName] ?? 9) || parseFloat((a.marketParams || "0").replace("line=", "")) - parseFloat((b.marketParams || "0").replace("line=", "")));
  res.json({ markets });
});

// --- LIVE mode ---
app.post("/api/live/connect", async (_req, res) => {
  try { await ensureLive().start(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/api/live/fixtures", (_req, res) => res.json(live ? live.listFixtures() : []));
app.post("/api/live/watch", (req, res) => {
  const { fixtureId } = req.body || {};
  if (!fixtureId) return res.status(400).json({ ok: false, error: "fixtureId required" });
  stopReplay();
  const meta = live ? live.metaFor(Number(fixtureId)) : null;
  liveSession = {
    fixtureId: Number(fixtureId),
    agent: makeAgentState(),
    startTs: Date.now(),
    state: scoreStates.get(Number(fixtureId)) || null,
    match: { seed: "LIVE", home: meta?.home || `Home #${fixtureId}`, away: meta?.away || `Away #${fixtureId}` },
  };
  journalAppend({ kind: "session_start", mode: "LIVE", fixtureId: Number(fixtureId), source: "TxLINE" });
  broadcast({ kind: "session", match: { home: liveSession.match.home, away: liveSession.match.away, seed: "LIVE" }, agent: liveSession.agent });
  res.json({ ok: true, fixtureId: Number(fixtureId) });
});
app.post("/api/live/stop", (_req, res) => { liveSession = null; if (live) live.stop(); live = null; res.json({ ok: true }); });
// ---- live autonomous agent ----
app.get("/api/agent", (_req, res) => res.json(liveAgent.snapshot()));
app.get("/api/agent/backtest", (_req, res) => {
  const f = join(DATA_DIR, "backtest-report.json");
  if (!existsSync(f)) return res.json({ ready: false });
  res.json({ ready: true, ...JSON.parse(readFileSync(f, "utf8")) });
});
app.get("/api/agent/calibration", (_req, res) => {
  const f = join(DATA_DIR, "calibration.json");
  if (!existsSync(f)) return res.json({ ready: false });
  res.json({ ready: true, ...JSON.parse(readFileSync(f, "utf8")) });
});
app.get("/api/journal", (_req, res) => res.json(journalRead()));
app.get("/api/journal/verify", (_req, res) => res.json(journalVerify()));
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "proofdesk", uptime: process.uptime() }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ kind: "hello", journal: journalRead(50) }));
});

server.listen(PORT, () => {
  console.log(`ProofDesk listening on :${PORT}`);
  // Live is the default state, not an option.
  ensureLive().start().then(() => console.log("TxLINE live feed: connected at boot"))
    .catch((e) => console.log("TxLINE live feed unavailable at boot:", e.message));
});
