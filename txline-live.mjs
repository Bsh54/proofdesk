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
  }

  stop() {
    this.running = false;
    for (const c of this.controllers) { try { c.abort(); } catch {} }
    this.controllers = [];
    this.onStatus({ state: "stopped" });
  }

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
    if (m.SuperOddsType === "1X2_PARTICIPANT_RESULT" && Array.isArray(m.Prices) && m.Prices.length === 3) {
      const odds = {
        type: "odds", fixtureId: m.FixtureId, messageId: m.MessageId, ts: m.Ts,
        home: m.Prices[0] / 1000, draw: m.Prices[1] / 1000, away: m.Prices[2] / 1000,
        pct: m.Pct, inRunning: !!m.InRunning, bookmaker: m.Bookmaker,
      };
      fx.lastOdds = odds;
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
