// Verifiable backtest: replay real recorded odds histories through the exact
// same agent engine that trades live, grade against real final results, and
// write a full report (per-rule stats, equity curve, CLV) to data/.
// Usage:
//   node backtest.mjs                 # run with DEFAULT_CONFIG over all cached+listed fixtures
//   node backtest.mjs --fetch         # also download missing odds histories (cache in data/history/)
//   node backtest.mjs --grid          # calibration: grid-search key thresholds, write calibration table
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gzipSync, gunzipSync } from "zlib";
import { createAgent, DEFAULT_CONFIG } from "./agent.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "data");
const HIST = join(DATA, "history");
mkdirSync(HIST, { recursive: true });

const creds = JSON.parse(readFileSync(join(DATA, "txline-credentials.json"), "utf8"));

async function freshJwt() {
  const r = await fetch(creds.api + "/auth/guest/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return (await r.json()).token;
}
async function api(path, jwt) {
  const r = await fetch(creds.api + path, { headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": creds.apiToken } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  const t = await r.text();
  return t.trim() ? JSON.parse(t) : [];
}

// ---- fixture universe (walk the past with startEpochDay) --------------------
async function listFixtures(jwt) {
  const today = Math.floor(Date.now() / 86400000);
  const seen = new Map();
  for (let d = today - 70; d <= today; d += 25) {
    try {
      for (const f of await api(`/api/fixtures/snapshot?startEpochDay=${d}`, jwt)) {
        if (f.FixtureId) seen.set(f.FixtureId, f);
      }
    } catch {}
  }
  return [...seen.values()].sort((a, b) => (a.StartTime || 0) - (b.StartTime || 0));
}

// ---- odds history cache ------------------------------------------------------
async function loadOddsHistory(fid, jwt, fetchMissing) {
  const file = join(HIST, `odds-${fid}.json.gz`);
  if (existsSync(file)) return JSON.parse(gunzipSync(readFileSync(file)).toString());
  if (!fetchMissing) return null;
  const rows = await api(`/api/odds/updates/${fid}`, jwt);
  if (!Array.isArray(rows) || !rows.length) return null;
  writeFileSync(file, gzipSync(JSON.stringify(rows)));
  return rows;
}

// ---- ground truth ------------------------------------------------------------
const ALIAS = { "Czechia": "Czech Republic", "Bosnia & Herzegovina": "Bosnia & Herzegovina", "USA": "USA", "Türkiye": "Turkey" };
const norm = (n) => (ALIAS[n] || n || "").toLowerCase().replace(/[^a-z]/g, "");

function loadResults() {
  const file = join(DATA, "worldcup-results.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8")).matches || [];
}

function groundTruth(fixture, results, closing) {
  const h = norm(fixture.Participant1IsHome === false ? fixture.Participant2 : fixture.Participant1);
  const a = norm(fixture.Participant1IsHome === false ? fixture.Participant1 : fixture.Participant2);
  const day = Math.floor((fixture.StartTime || 0) / 86400000);
  for (const r of results) {
    if (Math.abs(Math.floor(r.startTimestamp * 1000 / 86400000) - day) > 1) continue;
    if (norm(r.homeTeam) === h && norm(r.awayTeam) === a) {
      // 1X2 settles on 90-minute result: period1+period2
      const h90 = (r.homeScore.period1 ?? 0) + (r.homeScore.period2 ?? 0);
      const a90 = (r.awayScore.period1 ?? 0) + (r.awayScore.period2 ?? 0);
      const winner = h90 > a90 ? "home" : a90 > h90 ? "away" : "draw";
      return { winner, finalScore: `${h90}-${a90}`, source: "results-file" };
    }
  }
  // fallback: deduce from closing in-play 1X2 (a price collapsing to <=1.05 marks the winner)
  if (closing) {
    const entries = [["home", closing.home], ["draw", closing.draw], ["away", closing.away]];
    const [side, price] = entries.sort((x, y) => x[1] - y[1])[0];
    if (price <= 1.08) return { winner: side, finalScore: null, source: "closing-odds" };
  }
  return null;
}

// ---- run one backtest pass ----------------------------------------------------
function runPass(config, fixtures, histories, results) {
  const journalLog = [];
  const agent = createAgent(config, { journal: (r) => journalLog.push(r) });
  let graded = 0, skipped = 0;

  for (const f of fixtures) {
    const rows = histories.get(f.FixtureId);
    if (!rows) { skipped++; continue; }
    const meta = {
      home: f.Participant1IsHome === false ? f.Participant2 : f.Participant1,
      away: f.Participant1IsHome === false ? f.Participant1 : f.Participant2,
      startTime: f.StartTime,
    };
    let lastInPlay = null;
    // feed full-time 1X2 ticks in chronological order — exactly what live streaming delivers
    for (const m of rows) {
      if (m.SuperOddsType !== "1X2_PARTICIPANT_RESULT" || m.MarketPeriod || !Array.isArray(m.Prices) || m.Prices.length !== 3) continue;
      const tick = {
        fixtureId: f.FixtureId, ts: m.Ts,
        odds: { home: m.Prices[0] / 1000, draw: m.Prices[1] / 1000, away: m.Prices[2] / 1000 },
        pct: m.Pct, inRunning: !!m.InRunning, meta,
      };
      if (tick.inRunning) lastInPlay = tick.odds;
      agent.onOdds(tick);
    }
    const truth = groundTruth(f, results, lastInPlay);
    if (truth) {
      agent.onFinal(f.FixtureId, { winner: truth.winner, finalScore: truth.finalScore, ts: (f.StartTime || 0) + 2 * 3600 * 1000 });
      graded++;
    } else {
      // no verifiable result -> void the positions (stake returned), stay honest
      for (const p of agent.state.open.filter((p) => p.fixtureId === f.FixtureId)) {
        agent.state.bankroll = +(agent.state.bankroll + p.stake).toFixed(2);
      }
      agent.state.open = agent.state.open.filter((p) => p.fixtureId !== f.FixtureId);
      skipped++;
    }
  }
  return { agent, journalLog, graded, skipped };
}

// ---- main ----------------------------------------------------------------------
const args = process.argv.slice(2);
const doFetch = args.includes("--fetch");
const doGrid = args.includes("--grid");

const jwt = await freshJwt();
const fixtures = (await listFixtures(jwt)).filter((f) => (f.StartTime || 0) < Date.now());
console.log(`fixtures in the past: ${fixtures.length}`);

const histories = new Map();
let fetched = 0;
for (const f of fixtures) {
  try {
    const rows = await loadOddsHistory(f.FixtureId, jwt, doFetch);
    if (rows) { histories.set(f.FixtureId, rows); fetched++; }
  } catch (e) { console.log(`fixture ${f.FixtureId}: ${e.message}`); }
  if (fetched % 25 === 0 && fetched) process.stdout.write(`histories loaded: ${fetched}\r`);
}
console.log(`odds histories available: ${histories.size}`);

const results = loadResults();

if (!doGrid) {
  const { agent, graded, skipped } = runPass(DEFAULT_CONFIG, fixtures, histories, results);
  const report = { ranAt: new Date().toISOString(), config: DEFAULT_CONFIG, fixtures: fixtures.length,
    withHistory: histories.size, graded, skipped, ...agent.snapshot() };
  writeFileSync(join(DATA, "backtest-report.json"), JSON.stringify(report, null, 1));
  const k = report.kpis;
  console.log(`\n== BACKTEST == trades=${k.trades} winRate=${k.winRatePct}% pnl=${k.pnl} roi=${k.roiPct}% avgCLV=${k.avgClvPct}% bankroll=${k.bankroll}`);
  console.log("by rule:", JSON.stringify(k.byRule));
} else {
  const grid = [];
  for (const steamPts of [0.03, 0.04, 0.05, 0.07])
    for (const steamWindowMin of [5, 10, 15])
      for (const maxOdds of [3.0, 4.5])
        grid.push({ steamPts, steamWindowMs: steamWindowMin * 60000, maxOdds });
  const table = [];
  for (const g of grid) {
    const cfgRun = { ...DEFAULT_CONFIG, ...g };
    const { agent } = runPass(cfgRun, fixtures, histories, results);
    const k = agent.kpis();
    table.push({ ...g, trades: k.trades, winRatePct: k.winRatePct, pnl: k.pnl, roiPct: k.roiPct, avgClvPct: k.avgClvPct, bankroll: k.bankroll });
    console.log(`steam=${g.steamPts} win=${g.steamWindowMs / 60000}min maxOdds=${g.maxOdds} -> trades=${k.trades} pnl=${k.pnl} roi=${k.roiPct}% clv=${k.avgClvPct}%`);
  }
  table.sort((a, b) => b.pnl - a.pnl);
  writeFileSync(join(DATA, "calibration.json"), JSON.stringify({ ranAt: new Date().toISOString(), table }, null, 1));
  console.log("\nbest:", JSON.stringify(table[0]));
}
