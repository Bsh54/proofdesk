// TxLINE live connector — streams real odds/scores from the TxLINE API (SSE),
// normalises messages for the ProofDesk agent, and records raw data for replay.
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRED_FILE = join(__dirname, "data", "txline-credentials.json");
const REC_DIR = join(__dirname, "data", "recordings");
mkdirSync(REC_DIR, { recursive: true });

export class TxLive {
  constructor({ onOdds, onScore, onStatus }) {
    this.onOdds = onOdds; this.onScore = onScore; this.onStatus = onStatus || (() => {});
    this.controllers = [];
    this.running = false;
    this.fixtures = new Map(); // fixtureId -> { lastOdds, lastSeen, markets:Set }
    this.recFile = join(REC_DIR, `live-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  loadCreds() {
    if (!existsSync(CRED_FILE)) throw new Error("txline-credentials.json missing — run txline-onboard.mjs first");
    return JSON.parse(readFileSync(CRED_FILE, "utf8"));
  }

  async freshJwt(api) {
    const r = await fetch(`${api}/auth/guest/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!r.ok) throw new Error(`guest/start ${r.status}`);
    return (await r.json()).token;
  }

  record(stream, raw) {
    try { appendFileSync(this.recFile, JSON.stringify({ ts: Date.now(), stream, raw }) + "\n"); } catch {}
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const creds = this.loadCreds();
    const jwt = await this.freshJwt(creds.api);
    this.onStatus({ state: "connecting", api: creds.api });
    this.streamLoop(creds.api, jwt, creds.apiToken, "/api/odds/stream", (msg) => this.handleOdds(msg));
    this.streamLoop(creds.api, jwt, creds.apiToken, "/api/scores/stream", (msg) => this.handleScore(msg));
    // fixture metadata (real team names) — refresh every 5 min
    const refreshMeta = () => this.fetchFixtureMeta(creds.api, creds.apiToken).catch((e) => this.onStatus({ state: "meta_error", error: e.message }));
    refreshMeta();
    this.metaTimer = setInterval(refreshMeta, 5 * 60 * 1000);
  }

  async fetchFixtureMeta(api, apiToken) {
    const jwt = await this.freshJwt(api);
    const r = await fetch(`${api}/api/fixtures/snapshot`, { headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken } });
    if (!r.ok) throw new Error(`fixtures/snapshot ${r.status}`);
    const body = await r.json();
    const list = Array.isArray(body) ? body : body.fixtures || body.Fixtures || body.data || [];
    this.meta = this.meta || new Map();
    for (const f of list) {
      if (!f.FixtureId) continue;
      const p1Home = f.Participant1IsHome !== false;
      this.meta.set(f.FixtureId, {
        home: p1Home ? f.Participant1 : f.Participant2,
        away: p1Home ? f.Participant2 : f.Participant1,
        competition: f.Competition || "FIFA World Cup 2026",
        startTime: f.StartTime,
      });
    }
    this.onStatus({ state: "meta_ok", fixtures: this.meta.size });
    // Hydrate the current/final state of every fixture from snapshots, so
    // finished and not-yet-streamed matches always carry a correct score.
    for (const id of this.meta.keys()) this.fetchScoreSnapshot(api, apiToken, id).catch(() => {});
  }

  async fetchScoreSnapshot(api, apiToken, fixtureId) {
    const jwt = await this.freshJwt(api);
    const r = await fetch(`${api}/api/scores/snapshot/${fixtureId}`, { headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken } });
    if (!r.ok) return;
    const body = await r.json();
    const list = Array.isArray(body) ? body : body.snapshots || body.data || [body];
    const last = list[list.length - 1];
    if (last && (last.FixtureId || fixtureId)) {
      if (!last.FixtureId) last.FixtureId = fixtureId;
      this.onScore({ type: "score_raw", fixtureId: last.FixtureId, ts: last.Ts || Date.now(), raw: last });
    }
  }

  stop() {
    this.running = false;
    if (this.metaTimer) clearInterval(this.metaTimer);
    for (const c of this.controllers) { try { c.abort(); } catch {} }
    this.controllers = [];
    this.onStatus({ state: "stopped" });
  }

  metaFor(fixtureId) {
    return (this.meta && this.meta.get(fixtureId)) || null;
  }

  // Union of every fixture we know about: full schedule (meta) + anything
  // seen on the odds stream. This is what powers the schedule-style list.
  allFixtureIds() {
    const ids = new Set(this.fixtures.keys());
    if (this.meta) for (const k of this.meta.keys()) ids.add(k);
    return [...ids];
  }

  oddsFor(fixtureId) { return this.fixtures.get(fixtureId)?.lastOdds || null; }
  inRunningFor(fixtureId) { return this.fixtures.get(fixtureId)?.lastOdds?.inRunning || false; }
  bookFor(fixtureId) { const b = this.fixtures.get(fixtureId)?.book; return b ? [...b.values()] : []; }
  openingFor(fixtureId) { return this.fixtures.get(fixtureId)?.openingOdds || null; }

  async streamLoop(api, jwt, apiToken, path, handler) {
    while (this.running) {
      const ctrl = new AbortController();
      this.controllers.push(ctrl);
      try {
        const res = await fetch(api + path, {
          headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken, Accept: "text/event-stream", "Cache-Control": "no-cache" },
          signal: ctrl.signal,
        });
        if (res.status === 401 || res.status === 403) { jwt = await this.freshJwt(api); continue; }
        if (!res.ok) throw new Error(`${path} → ${res.status}`);
        this.onStatus({ state: "live", stream: path });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (this.running) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              this.record(path, payload);
              try { handler(JSON.parse(payload)); } catch {}
            }
          }
        }
      } catch (e) {
        if (!this.running) return;
        this.onStatus({ state: "reconnecting", stream: path, error: e.message });
        await new Promise((r) => setTimeout(r, 4000));
        try { jwt = await this.freshJwt(api); } catch {}
      }
    }
  }

  handleOdds(m) {
    if (!m || !m.FixtureId) return;
    const fx = this.fixtures.get(m.FixtureId) || { markets: new Set() };
    fx.lastSeen = Date.now();
    fx.markets.add(m.SuperOddsType);
    // full market book: latest prices per market+line, with previous for movement arrows
    if (Array.isArray(m.Prices) && m.PriceNames) {
      fx.book = fx.book || new Map();
      const key = m.SuperOddsType + "|" + (m.MarketParameters || "") + "|" + (m.MarketPeriod || "FT");
      const prevEntry = fx.book.get(key);
      fx.book.set(key, {
        type: m.SuperOddsType, params: m.MarketParameters || null, period: m.MarketPeriod || null,
        names: m.PriceNames, prices: m.Prices.map((p) => p / 1000),
        prev: prevEntry ? prevEntry.prices : null, ts: m.Ts,
      });
    }
    // main 1X2 = FULL TIME only (half-time markets carry MarketPeriod like "half=1")
    if (m.SuperOddsType === "1X2_PARTICIPANT_RESULT" && !m.MarketPeriod && Array.isArray(m.Prices) && m.Prices.length === 3) {
      const odds = {
        type: "odds", fixtureId: m.FixtureId, messageId: m.MessageId, ts: m.Ts,
        home: m.Prices[0] / 1000, draw: m.Prices[1] / 1000, away: m.Prices[2] / 1000,
        pct: m.Pct, inRunning: !!m.InRunning, bookmaker: m.Bookmaker,
      };
      fx.lastOdds = odds;
      if (!fx.openingOdds) fx.openingOdds = { home: odds.home, draw: odds.draw, away: odds.away, ts: odds.ts };
      this.fixtures.set(m.FixtureId, fx);
      this.onOdds(odds);
    } else {
      this.fixtures.set(m.FixtureId, fx);
    }
  }

  handleScore(m) {
    if (!m) return;
    this.onScore({ type: "score_raw", fixtureId: m.FixtureId || null, ts: m.Ts || Date.now(), raw: m });
  }

  listFixtures() {
    return [...this.fixtures.entries()].map(([id, f]) => ({
      fixtureId: id, lastSeen: f.lastSeen, inRunning: f.lastOdds?.inRunning || false,
      odds: f.lastOdds ? { home: f.lastOdds.home, draw: f.lastOdds.draw, away: f.lastOdds.away } : null,
      markets: [...f.markets],
    }));
  }
}
