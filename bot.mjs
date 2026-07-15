// Telegram bot client — raw Bot API over long polling, no external deps.
// Reads its token from data/telegram.json ({ "token": "..." }); if the file
// is missing the bot stays dormant and the rest of the server is unaffected.
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "data");
const TOKEN_FILE = join(DATA, "telegram.json");
const SUBS_FILE = join(DATA, "pundit-subs.json");

export function createBot({ onCommand }) {
  if (!existsSync(TOKEN_FILE)) {
    console.log("[bot] data/telegram.json missing — bot dormant");
    return null;
  }
  const token = JSON.parse(readFileSync(TOKEN_FILE, "utf8")).token;
  const API = `https://api.telegram.org/bot${token}`;

  // chatId -> { follows: ["all"] | [fixtureId...], voice: bool, name }
  const subs = existsSync(SUBS_FILE) ? new Map(Object.entries(JSON.parse(readFileSync(SUBS_FILE, "utf8")))) : new Map();
  const saveSubs = () => writeFileSync(SUBS_FILE, JSON.stringify(Object.fromEntries(subs)));

  async function call(method, payload) {
    try {
      const r = await fetch(`${API}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      return await r.json();
    } catch (e) { return { ok: false, description: e.message }; }
  }

  async function sendText(chatId, text, extra = {}) {
    return call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  }

  async function sendVoice(chatId, oggPath, caption) {
    // multipart upload for the voice note
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (caption) form.append("caption", caption);
      form.append("voice", new Blob([readFileSync(oggPath)], { type: "audio/ogg" }), "pundit.ogg");
      const r = await fetch(`${API}/sendVoice`, { method: "POST", body: form });
      return await r.json();
    } catch (e) { return { ok: false, description: e.message }; }
  }

  // ---- long polling loop ----
  let offset = 0, running = true;
  (async function poll() {
    while (running) {
      try {
        const r = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`, { signal: AbortSignal.timeout(60000) });
        const body = await r.json();
        if (body.ok) {
          for (const u of body.result) {
            offset = u.update_id + 1;
            const msg = u.message || u.callback_query?.message;
            const text = u.message?.text || u.callback_query?.data || "";
            if (!msg) continue;
            const chatId = msg.chat.id;
            const from = u.message?.from || u.callback_query?.from || {};
            if (u.callback_query) call("answerCallbackQuery", { callback_query_id: u.callback_query.id });
            try { await onCommand({ chatId, text: text.trim(), from, bot: api }); } catch (e) { console.log("[bot] handler error:", e.message); }
          }
        }
      } catch { await new Promise((res) => setTimeout(res, 3000)); }
    }
  })();

  const api = {
    sendText, sendVoice, call,
    subs,
    subscribe(chatId, target, name) {
      const s = subs.get(String(chatId)) || { follows: [], voice: true, name };
      if (target === "all") s.follows = ["all"];
      else if (!s.follows.includes(target) && s.follows[0] !== "all") s.follows.push(target);
      s.name = name || s.name;
      subs.set(String(chatId), s); saveSubs();
      return s;
    },
    unsubscribe(chatId) { subs.delete(String(chatId)); saveSubs(); },
    setVoice(chatId, on) {
      const s = subs.get(String(chatId));
      if (s) { s.voice = on; subs.set(String(chatId), s); saveSubs(); }
      return s;
    },
    followersOf(fixtureId) {
      const out = [];
      for (const [chatId, s] of subs) {
        if (s.follows[0] === "all" || s.follows.includes(Number(fixtureId)) || s.follows.includes(String(fixtureId))) out.push({ chatId, ...s });
      }
      return out;
    },
    stop() { running = false; },
  };
  console.log("[bot] polling started");
  return api;
}
