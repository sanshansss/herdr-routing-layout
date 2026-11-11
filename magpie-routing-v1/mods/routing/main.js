import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, settings, home, panes, watchFolder } from "herdr";
import * as fs from "fs/promises";

// magpie writes one JSON line per finished request to
// ~/.config/magpie/routing/<local day>.jsonl. There is no live HTTP feed on
// the gateway port (only /v1), so the stage replays each route that lands,
// approximating magpie's Routing panel with native straight-line transitions.
// The file is watched rather than polled; a slow timer only covers a missed
// event. Magpie itself only reads routing data on a low cadence, so the
// fallback here stays just as quiet (25s is the upper bound).
const FALLBACK_MS = 25000;
const KEEP = 60;
const SIDE = 3;
const MAX_FLYING = 4;
// Native transitions move each leg; script wakes only at route phase boundaries.
const FLY_IN_MS = 420;   // agent → magpie
const FLY_OUT_MS = 460;  // magpie → provider
const FLY_BACK_MS = 360; // a failed try back to magpie
const FLY_HOME_MS = 420; // magpie → agent
const AT_DEST_MS = 120;
const FADE_MS = 300;
const FIRST_LOOK_BYTES = 120000; // of a big day file, only its tail is parsed first

// A maker's own colour, else one picked from the id, so an agent keeps its
// colour from one request to the next. Red is left out: here red is failure.
const HUES = {
  claude: "#d97757", codex: "#6366f1", gemini: "#0ea5e9", copilot: "#a855f7",
  cursor: "#14b8a6", opencode: "#eab308", crush: "#ec4899", goose: "#84cc16",
  pi: "#10b981", omp: "#d946ef", omo: "#7c3aed", dsh: "#06b6d4",
  commandcode: "#f97316", mimocode: "#3b82f6", deveco: "#3c99cc",
};
const SPARE = ["#8b5cf6", "#22c55e", "#0d9488", "#0891b2", "#ca8a04", "#db2777", "#2563eb", "#65a30d"];

function hueOf(id) {
  const k = String(id || "").toLowerCase();
  if (HUES[k]) return HUES[k];
  let h = 0;
  for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SPARE[h % SPARE.length];
}

function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { title: b + 1, body: b, small: b - 0.5, tiny: b - 1.5 };
}

function dayName(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// tryOk mirrors magpie: under 400, and not flagged as failed.
function tryOk(tr) {
  return Number(tr.status || 0) < 400 && !tr.fail;
}

// seat is one of a route's keys or accounts for one model. A try is found
// back in the order by that seat, as magpie's tried() does.
function seatKey(x) {
  return String(x.id ?? "") + "\u0000" + String(x.model ?? "") + (x.fixed ? ":" + x.fixed : "");
}

function tried(r, tr) {
  if (!tr) return null;
  return r.order.find((x) => seatKey(x) === seatKey(tr))
    || r.order.find((x) => x.id === tr.id && (x.model || "") === (tr.model || ""))
    || r.order.find((x) => x.id === tr.id)
    || null;
}

// seat is where one try went: the provider, and the account or key there.
function seat(r, tr) {
  const w = tried(r, tr);
  if (!w) {
    const name = tr?.name || tr?.provider || tr?.id || "?";
    return { key: String(r.provider || name), name: String(r.provider || name), sub: "" };
  }
  const sub = w.kind === "provider" || !w.who ? "" : String(w.who);
  return { key: String(w.provider || r.provider || "?"), name: String(w.name || w.provider || r.provider || "?"), sub };
}

// Keep routing and context metadata only; never retain prompt or item text.
function slimRoute(r) {
  if (!r || typeof r !== "object") return null;
  const id = Number(r.id);
  if (!Number.isFinite(id)) return null;
  const tries = Array.isArray(r.tries) ? r.tries.map((t) => ({
    id: t.id === undefined ? "" : String(t.id),
    model: t.model === undefined ? "" : String(t.model),
    status: Number(t.status || 0),
    done: Boolean(t.done),
    ms: Number(t.ms || 0),
    fail: Boolean(t.fail),
    provider: t.provider ? String(t.provider) : "",
    name: t.name ? String(t.name) : "",
    kind: t.kind ? String(t.kind) : "",
    who: "",
    fixed: t.fixed ? String(t.fixed) : "",
  })) : [];
  const order = Array.isArray(r.order) ? r.order.map((w) => ({
    id: w.id === undefined ? "" : String(w.id),
    provider: w.provider ? String(w.provider) : "",
    name: w.name ? String(w.name) : "",
    kind: w.kind === undefined ? "provider" : String(w.kind),
    model: w.model ? String(w.model) : "",
    who: "",
    fixed: w.fixed ? String(w.fixed) : "",
  })) : [];
  return {
    id,
    time: r.time ? String(r.time) : "",
    agent: r.agent ? String(r.agent) : "unknown",
    ms: Number(r.ms || 0),
    status: Number(r.status || 0),
    done: Boolean(r.done),
    provider: r.provider ? String(r.provider).slice(0, 100) : "",
    model: r.model ? String(r.model).slice(0, 100) : "",
    served: r.served ? String(r.served).slice(0, 100) : "",
    tokens: Number(r.tokens || 0),
    out: Number(r.out || 0),
    ttft: Number(r.ttft || 0),
    session: typeof r.session === "string" ? r.session : "",
    // Magpie's groupSession() is parentSession || session; the folder and
    // conv are the fallbacks its session board uses when a record carries
    // no native session. The routing JSONL has no title field, so the
    // selector below names a session by its id rather than inventing one.
    parentSession: typeof r.parentSession === "string" ? r.parentSession : "",
    conv: typeof r.conv === "string" ? r.conv : "",
    folder: r.folder ? String(r.folder).slice(0, 200) : "",
    kind: r.kind ? String(r.kind).slice(0, 40) : "",
    sub: r.sub ? String(r.sub).slice(0, 40) : "",
    prompt: r.prompt && typeof r.prompt === "object" ? {
      tokens: Number(r.prompt.tokens || 0), window: Number(r.prompt.window || 0),
      turns: Number(r.prompt.turns || 0), counted: Boolean(r.prompt.counted),
      held: Boolean(r.prompt.held),
      parts: Array.isArray(r.prompt.parts) ? r.prompt.parts.filter(p => p && typeof p.kind === "string").map(p => ({
        kind: p.kind.slice(0, 100), tokens: Math.max(0, Number(p.tokens) || 0),
        items: Array.isArray(p.items) ? p.items.filter(i => i && typeof i.name === "string").map(i => ({
          name: i.name.slice(0, 200), tag: i.tag ? String(i.tag).slice(0, 40) : "",
          tokens: Math.max(0, Number(i.tokens) || 0),
          count: Math.max(1, Number(i.n) || 1),
        })) : [],
      })) : [],
    } : null,
    order,
    tries,
  };
}

// The session grouping Magpie's client.js uses. A request's session is its
// parent's when it names one (a subagent), else its own; the key adds the
// agent so two agents may share a UUID without sharing a conversation.
// Requests without a session still group by conv when the gateway supplied
// one, exactly as Magpie's ctxSessionOf() does.
function groupSession(r) {
  return r.parentSession || r.session || "";
}

function sessionKey(r) {
  const g = groupSession(r);
  return g ? JSON.stringify([r.agent || "other", g]) : "";
}

function sessionIdOf(r) {
  return groupSession(r) || r.conv || "";
}

function ctxSessionOf(r) {
  if (!r.prompt || r.kind) return "";
  return sessionKey(r) || (r.conv ? JSON.stringify([r.agent || "other", "conv", r.conv]) : "");
}

function hasTools(r) {
  return Boolean(r.prompt && r.prompt.parts.some((p) => p.kind === "tools" && p.tokens > 0));
}

function ageText(ms) {
  if (!ms) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.round(ms / 60000) + "m";
}

// The context card follows magpie's: a part's kind, its colour and its
// friendly name. "skills" is a kind the running gateway writes between tools
// and memory, newer than magpie's six-part order, so it sits here too.
const CTX_KINDS = ["system", "tools", "skills", "memory", "files", "results", "chat"];
const CTX_NAMES = {
  system: "System prompt", tools: "Tools", skills: "Skills", memory: "Memory",
  files: "Files", results: "Tool results", chat: "Conversation",
};
const CTX_SHORT = {
  system: "System", tools: "Tools", skills: "Skills", memory: "Memory",
  files: "Files", results: "Results", chat: "Chat",
};
const CTX_ITEM_NAMES = {
  prompt: "Agent prompt", harness: "Harness messages", billing: "Billing header",
  environment: "Environment notes", context: "Context", skills: "Skills",
  reminders: "System reminders", compacted: "Compacted summary", image: "Image", document: "Document",
};
const CTX_COLORS_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"];
const CTX_COLORS_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"];

function fmtK(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  const short = (x, d) => x.toFixed(d).replace(/\.0+$/, "");
  if (n >= 1e6) return short(n / 1e6, n >= 1e7 ? 1 : 2) + "M";
  if (n >= 1e3) return short(n / 1e3, n >= 1e5 ? 0 : 1) + "K";
  return String(n);
}

function ctxPct(x) {
  if (!Number.isFinite(x)) return "—";
  return (x * 100).toFixed(1).replace(/\.0$/, "") + "%";
}

// Magpie's health bands: under 75% is healthy, under 90% is filling up.
function ctxHealth(fill) {
  if (!Number.isFinite(fill)) return null;
  if (fill < 0.75) return { word: "Healthy", tone: "done" };
  if (fill < 0.9) return { word: "Filling up", tone: "working" };
  return { word: "Near full", tone: "blocked" };
}

function ctxPartName(kind) { return CTX_NAMES[kind] || kind; }
function ctxShortName(kind) { return CTX_SHORT[kind] || kind; }

// Only the names the history carries: a file path, a tool, a turn. The
// prompt's own text is never kept, so it can never be shown here.
function ctxItemName(item) {
  if (item.tag === "turn") return "Turn " + item.name;
  if (item.tag === "turns") return item.count > 1 ? item.count + " earlier turns" : "Earlier turns";
  if (item.tag === "more") return item.count > 1 ? item.count + " more items" : "More items";
  return CTX_ITEM_NAMES[item.name] || item.name;
}

// The short word on an item's tag badge, as magpie labels the metadata it
// keeps. Empty means the item has no tag to show.
const CTX_TAGS = {
  mcp: "MCP", namespace: "namespace", read: "read", shell: "shell",
  result: "result", user: "user", project: "project", local: "local",
  memory: "memory", skills: "skills", reminder: "reminder", image: "image",
  turn: "", turns: "", more: "", compacted: "",
};
function ctxTagName(item) {
  return Object.prototype.hasOwnProperty.call(CTX_TAGS, item.tag) ? CTX_TAGS[item.tag] : (item.tag || "");
}

// The window as a grid: one cell for each 1/400 of the model's window,
// coloured by the part that fills it. A window smaller than the prompt
// (unknown, or overrun) is the prompt, so the grid stays full. Each cell
// also names the item it stands for, so hovering an item row can light
// the cells it fills. Largest remainder keeps the cells adding up.
const CTX_CELLS = 400;
function ctxCells(parts, tokens, window) {
  const cells = [];
  if (!(tokens > 0)) return new Array(CTX_CELLS).fill(null);
  const scale = Math.max(window, tokens, 1);
  const used = Math.min(CTX_CELLS, Math.round((tokens / scale) * CTX_CELLS));
  const live = parts.filter(x => x.tokens > 0);
  const sum = live.reduce((n, x) => n + x.tokens, 0) || 1;
  const want = live.map(x => (x.tokens / sum) * used);
  const got = want.map(w => Math.max(1, Math.floor(w)));
  let left = used - got.reduce((n, x) => n + x, 0);
  const order = want.map((w, i) => [w - Math.floor(w), i]).sort((a, b) => b[0] - a[0]);
  for (let j = 0; left > 0 && order.length; j = (j + 1) % order.length, left--) got[order[j][1]]++;
  for (let j = got.length - 1; left < 0 && j >= 0; j--) {
    while (left < 0 && got[j] > 1) { got[j]--; left++; }
  }
  live.forEach((part, pi) => {
    // Items largest first, as the rows are: a cell takes the item whose
    // share of the part its middle falls in.
    const items = part.items.slice().sort((a, b) => b.tokens - a.tokens);
    const isum = items.reduce((n, it) => n + it.tokens, 0) || 1;
    let at = 0, acc = 0;
    for (let c = 0; c < got[pi]; c++) {
      const mid = ((c + 0.5) / got[pi]) * isum;
      while (at < items.length - 1 && acc + items[at].tokens < mid) acc += items[at++].tokens;
      cells.push({ kind: part.kind, item: items.length ? at : -1 });
    }
  });
  while (cells.length < CTX_CELLS) cells.push(null);
  return cells.slice(0, CTX_CELLS);
}

// How many more requests fit at the pace the session's prompts have grown,
// as magpie's headroom() reads it. Null when the session has no growth.
function ctxHeadroom(series, free) {
  const steps = [];
  for (let i = 1; i < series.length; i++) {
    const d = series[i].tokens - series[i - 1].tokens;
    if (d > 0 && series[i].tokens >= series[i - 1].tokens * 0.6) steps.push(d);
  }
  if (!steps.length) return null;
  steps.sort((a, b) => a - b);
  const median = steps[steps.length >> 1];
  return median > 0 ? Math.floor(free / median) : null;
}

// The palette follows the theme actually in use, not only the setting:
// herdr may show a light theme while the system is dark, or the reverse.
function ctxDark(t) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(t.background || t.surface || ""));
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

// A cubic like magpie's wire: M x1 y1 C mx y1 mx y2 x2 y2.
function cubicAt(x1, y1, x2, y2, k) {
  const mx = (x1 + x2) / 2;
  const u = 1 - k;
  const a = u * u * u, b = 3 * u * u * k, c = 3 * u * k * k, d = k * k * k;
  return {
    x: a * x1 + b * mx + c * mx + d * x2,
    y: a * y1 + b * y1 + c * y2 + d * y2,
  };
}

// The app's own program icon for an agent, when it has one.
function programFor(id) {
  const k = String(id || "").toLowerCase();
  if (!k) return null;
  for (const p of panes()) {
    const prog = p.program;
    if (!prog?.icon) continue;
    const key = String(prog.key || "").toLowerCase();
    const name = String(prog.name || "").toLowerCase();
    if (key === k || name === k || key.startsWith(k) || name.startsWith(k)) return prog;
  }
  return null;
}

export default class Routing extends View {
  init(props, cx) {
    this.routes = new Map();
    this.live = [];
    this.offset = 0;
    this.day = "";
    this.carry = "";
    this.seen = new Set();
    this.armed = false;
    this.plays = new Map();
    this.trips = [];
    this.agents = [];
    this.dests = [];
    this.size = { width: 400, height: 104 };
    this.status = "";
    this.selected = null;
    this.session = "";
    this.detailTab = "route";
    this.contextFilter = "";
    this.contextExpanded = false;
    this.ctxCardId = null;
    this.ctxHover = "";
    this.ctxHot = null;
    this.loading = false;
    this.h = cx.focus_handle();

    cx.spawn(async (cx) => {
      await this.pump(cx);
      // The watcher is the primary refresh. When it cannot be armed, only
      // retry the watch (with backoff); never read the file on that short
      // loop — the 25s timer is the data fallback.
      let retry = 2000;
      for (;;) {
        try {
          await watchFolder(this.folderPath());
          retry = 2000;
        } catch {
          await cx.sleep(retry);
          retry = Math.min(FALLBACK_MS, retry * 2);
          continue;
        }
        // Let the append land, then read only what was added.
        await cx.sleep(120);
        await this.pump(cx);
      }
    });
    cx.timer.every(FALLBACK_MS, (cx) => { this.pump(cx); });
  }

  folderPath() {
    const h = String(home() || "").replace(/[\/]+$/, "");
    return h + "/.config/magpie/routing";
  }

  recordPath() {
    return this.folderPath() + "/" + dayName(new Date()) + ".jsonl";
  }

  // A running day grows to megabytes in a few hours. Only what was appended
  // since the last look is parsed: the file is read whole (reading a few MB
  // is cheap) and sliced from the byte offset already seen. A line still
  // being written stays in carry until its newline arrives.
  async pump(cx) {
    if (this.loading) return;
    this.loading = true;
    try {
      const day = dayName(new Date());
      if (day !== this.day) {
        this.day = day;
        this.offset = 0;
        this.carry = "";
        this.seen.clear();
        this.live = [];
        this.routes.clear();
        this.plays.clear();
        this.trips = [];
        this.armed = false;
      }
      const raw = await fs.readFile(this.folderPath() + "/" + day + ".jsonl", "utf8");
      let changed = false;
      if (this.status) { this.status = ""; changed = true; }

      if (this.offset === 0 && !this.carry && raw.length > FIRST_LOOK_BYTES) {
        // Start at the newest KEEP records, not at a byte count: the list
        // and the session selector then hold the same recent window after
        // a reload as they do while running.
        let at = raw.length;
        for (let need = KEEP; need > 0; need--) {
          const prev = raw.lastIndexOf(String.fromCharCode(10), at - 2);
          if (prev < 0) { at = 0; break; }
          at = prev + 1;
        }
        this.offset = at;
      }
      if (raw.length < this.offset) {
        // replaced, or the day rolled over: read it from the top
        this.offset = 0;
        this.carry = "";
        this.seen.clear();
        this.live = [];
        this.routes.clear();
        this.plays.clear();
        this.trips = [];
        this.armed = false;
      }
      if (raw.length > this.offset) {
        const chunk = this.carry + raw.slice(this.offset);
        this.offset = raw.length;
        const nl = chunk.lastIndexOf(String.fromCharCode(10));
        if (nl < 0) {
          this.carry = chunk;
        } else {
          this.carry = chunk.slice(nl + 1);
          const fresh = [];
          for (const line of chunk.slice(0, nl).split(String.fromCharCode(10))) {
            const t = line.trim();
            if (!t) continue;
            let r = null;
            try { r = slimRoute(JSON.parse(t)); } catch { r = null; }
            if (!r) continue;
            this.routes.set(r.id, r);
            changed = true;
            if (!this.seen.has(r.id)) {
              this.seen.add(r.id);
              this.live.unshift(r.id);
              fresh.push(r.id);
            }
          }
          if (this.live.length > KEEP) {
            for (const id of this.live.splice(KEEP)) { this.routes.delete(id); this.seen.delete(id); }
          }
          if (fresh.length) {
            if (this.armed) for (const id of fresh.slice(-MAX_FLYING)) this.start(id, cx);
            this.armed = true;
            changed = true;
          }
        }
      }
      if (changed) {
        cx.notify();
      }
    } catch {
      if (this.status !== "no-record") {
        this.status = "no-record";
        this.offset = 0;
        this.carry = "";
        this.armed = false;
        this.plays.clear();
        this.trips = [];
        cx.notify();
      }
    } finally {
      this.loading = false;
    }
  }

  start(id, cx) {
    if (this.plays.has(id) || this.trips.length >= MAX_FLYING) return;
    const r = this.routes.get(id);
    if (!r) return;
    const trip = { id, phase: "to-hub", index: 0, target: 0, duration: FLY_IN_MS };
    this.plays.set(id, trip);
    this.trips.push(trip);
    cx.spawn(async (cx) => {
      // Establish the first position before changing the transition target.
      cx.notify();
      await cx.sleep(50);
      const alive = () => this.plays.get(id) === trip;
      const move = async (phase, duration) => {
        if (!alive()) return false;
        trip.phase = phase; trip.duration = duration; trip.target = 1;
        cx.notify();
        await cx.sleep(duration);
        return alive();
      };
      if (!await move("to-hub", FLY_IN_MS)) return;
      for (let i = 0; i < Math.max(1, r.tries.length); i++) {
        trip.index = i;
        if (!await move("to-dest", FLY_OUT_MS)) return;
        trip.phase = "at-dest"; cx.notify();
        await cx.sleep(AT_DEST_MS);
        if (!alive()) return;
        const tr = r.tries[i];
        if (!tr) break;
        const ok = tryOk(tr);
        if (!await move(ok ? "ok-back" : "back-fail", ok ? FLY_HOME_MS : FLY_BACK_MS)) return;
        if (ok || !r.tries[i + 1]) {
          if (!await move(ok ? "ok-home" : "home-fail", FLY_HOME_MS)) return;
          break;
        }
      }
      if (!alive()) return;
      trip.phase = "fade"; trip.duration = FADE_MS; cx.notify();
      await cx.sleep(FADE_MS);
      if (!alive()) return;
      this.trips = this.trips.filter((x) => x !== trip);
      this.plays.delete(id);
      cx.notify();
    });
  }

  // Each leg is a native straight transition between the cubic endpoints.
  progress(trip) {
    if (trip.phase === "to-hub") return { leg: "agent", k: trip.target };
    if (trip.phase === "to-dest" || trip.phase === "at-dest") return { leg: "dest", k: 1 };
    if (trip.phase === "back-fail" || trip.phase === "ok-back") return { leg: "dest", k: 0 };
    return { leg: "agent", k: 0 };
  }

  place(had, want) {
    const out = had.map((k) => (want.includes(k) ? k : null));
    for (const k of want) {
      if (out.includes(k)) continue;
      const i = out.indexOf(null);
      if (i >= 0) out[i] = k; else out.push(k);
    }
    return out.filter(Boolean).slice(0, SIDE);
  }

  stage() {
    const recent = this.live.map((id) => this.routes.get(id)).filter(Boolean);
    const agents = [];
    const dests = new Map();
    const flying = (r) => this.plays.has(r.id);

    for (const r of recent) {
      if (!flying(r)) continue;
      if (!agents.includes(r.agent)) agents.push(r.agent);
      for (const tr of r.tries) {
        const s = seat(r, tr);
        if (!dests.has(s.key)) dests.set(s.key, { key: s.key, name: s.name, sub: s.sub, how: "" });
      }
    }
    for (const r of recent) {
      if (agents.length < SIDE && !agents.includes(r.agent)) agents.push(r.agent);
      const tr = r.tries[r.tries.length - 1];
      if (tr) {
        const s = seat(r, tr);
        if (!dests.has(s.key) && dests.size < SIDE) dests.set(s.key, { key: s.key, name: s.name, sub: s.sub, how: "" });
      }
    }
    // Each destination names the account its latest try went to, and how it went.
    for (const r of recent) {
      for (let i = r.tries.length - 1; i >= 0; i--) {
        const tr = r.tries[i];
        const s = seat(r, tr);
        const d = dests.get(s.key);
        if (d && !d.how) {
          d.how = !tr.done ? "wait" : tryOk(tr) ? "ok" : "bad";
          d.sub = s.sub;
        }
      }
    }
    this.agents = this.place(this.agents, agents.slice(0, SIDE));
    this.dests = this.place(this.dests, [...dests.keys()].slice(0, SIDE));
    return { dests };
  }

  wire(x1, y1, x2, y2, color, width) {
    const mx = (x1 + x2) / 2;
    const path = PathBuilder.stroke(width)
      .move_to(x1, y1)
      .cubic_bezier_to(x2, y2, mx, y1, mx, y2)
      .build();
    return window.paint_path(path, color).absolute().left(0).top(0);
  }

  render() {
    const t = theme();
    const s = S();
    const st = this.stage();
    // A picked session outranks a picked request: its card is the session's
    // newest reading and keeps following it as records arrive. Clicking a
    // row clears the session deliberately, so neither selection can be
    // overwritten by the other.
    const picked = this.sessionGroup();
    return v_flex().size_full().bg(t.chrome).border_l(1).border_color(t.border)
      .child(this.head_(t, s))
      .child(this.stage_(st, t, s))
      .child(this.sessions_(t, s))
      .child(picked
        ? this.sessionView_(picked, t, s)
        : this.selected !== null && this.routes.has(this.selected)
          ? this.detail_(this.routes.get(this.selected), t, s)
          : this.list_(t, s));
  }

  // The sessions among the kept routes, newest first, grouped exactly as
  // Magpie groups them. A reading is the newest request that carries a
  // prompt: a tool-less side call does not stand for a conversation whose
  // turns carry tools, and a subagent's prompt is its own conversation's.
  sessions() {
    const groups = new Map();
    for (const id of this.live) {
      const r = this.routes.get(id);
      if (!r) continue;
      const key = ctxSessionOf(r);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) { g = { key, rows: [] }; groups.set(key, g); }
      g.rows.push(r);
    }
    const out = [];
    for (const g of groups.values()) {
      const rows = g.rows.slice().sort((a, b) => b.id - a.id);
      const tooled = rows.some((x) => !x.sub && hasTools(x));
      const latest = rows.find((x) => !x.sub && (!tooled || hasTools(x))) || rows[0];
      out.push({
        key: g.key,
        rows,
        latest,
        id: sessionIdOf(latest),
        agent: latest.agent,
        folder: latest.folder || rows.find((x) => x.folder)?.folder || "",
        count: rows.length,
      });
    }
    out.sort((a, b) => b.latest.id - a.latest.id);
    return out;
  }

  sessionGroup() {
    if (!this.session) return null;
    return this.sessions().find((g) => g.key === this.session) || null;
  }

  // The id is what the JSONL can offer: it carries session/conv/folder but
  // no session title (Magpie's sessionTitle/native_session come from the
  // gateway's /api/gateway/session-titles, never from this file). A UUID's
  // first block is its conventional short name; a conv id's tail is the
  // part that tells two `magpie-…` conversations apart. The full id stays
  // in the tooltip, so nothing is lost.
  sessionLabel(g) {
    const id = String(g.id || "");
    if (!id) return g.agent || "unknown";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return id.slice(0, 8);
    if (id.startsWith("magpie-") && id.length > 15) return "magpie-" + id.slice(-8);
    return id.length > 8 ? "…" + id.slice(-7) : id;
  }

  sessions_(t, s) {
    const all = this.sessions();
    if (!all.length) return div();
    // Magpie keeps at most six session blocks. The picked one is kept among
    // them even when it is older than the newest six, so switching away and
    // back does not lose the selection.
    let shown = all.slice(0, 6);
    if (this.session && !shown.some((g) => g.key === this.session)) {
      const picked = all.find((g) => g.key === this.session);
      if (picked) shown = [...shown.slice(0, 5), picked];
    }
    const chip = (g, i) => {
      const on = g.key === this.session;
      const p = g.latest.prompt || {};
      const tokens = Math.max(0, Number(p.tokens) || 0);
      const window = Math.max(0, Number(p.window) || 0);
      const pct = window > 0 ? Math.round(tokens / window * 100) + "%" : "";
      return v_flex().id(`routing-session-${i}`).min_w(0).max_w(190).px(7).py(4).gap(2).rounded(6)
        .bg(on ? t.selected : t.raised).border(1).border_color(on ? t.accent : t.border)
        .hover(el => el.bg(t.hover))
        .tooltip([`Session ${g.id || "unknown"}`, `${g.agent || "agent"} · ${g.count} request${g.count === 1 ? "" : "s"}`,
          g.folder ? "Folder: " + g.folder : "", "Show this session's newest context card"].filter(Boolean).join("\n"))
        .on_click((_e, cx) => {
          this.session = g.key;
          this.selected = null;
          this.detailTab = "context";
          this.contextFilter = "";
          this.contextExpanded = false;
          this.ctxHover = "";
          this.ctxHot = null;
          cx.notify();
        })
        .child(h_flex().min_w(0).gap(5).items_center()
          .child(div().size(6).rounded(3).flex_none().bg(hueOf(g.agent)))
          .child(div().flex_1().min_w(0).truncate().text_size(s.tiny).font_medium().text_color(t.foreground)
            .child(this.sessionLabel(g)))
          .when(Boolean(pct), el => el.child(div().flex_none().text_size(s.tiny).text_color(t.dim).child(pct))))
        .child(div().text_size(s.tiny).text_color(t.muted)
          .child(`${fmtK(tokens)} / ${window > 0 ? fmtK(window) : "—"}`));
    };
    return v_flex().flex_none().px(8).py(6).gap(5).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(s.tiny).font_semibold().text_color(t.muted).child("Context by session"))
        .child(div().flex_1())
        .when(all.length > shown.length, el => el.child(div().text_size(s.tiny).text_color(t.dim).child(`${shown.length} of ${all.length}`)))
        .when(Boolean(this.session), el => el.child(div().id("routing-session-all").px(5).py(2).rounded(4)
          .text_size(s.tiny).text_color(t.accent).hover(e2 => e2.bg(t.hover))
          .on_click((_e, cx) => {
            this.session = "";
            this.selected = null;
            cx.notify();
          })
          .child("All routes"))))
      .child(h_flex().gap(4).flex_wrap().children(shown.map(chip)));
  }

  // The picked session's newest context card, with the request it came
  // from named so the reading is never mistaken for another session's.
  sessionView_(g, t, s) {
    const r = g.latest;
    const at = Date.parse(r.time) || 0;
    const age = at ? ageText(Date.now() - at) : "";
    return v_flex().flex_1().min_h(0)
      .child(v_flex().px(10).py(6).gap(2).flex_none().border_b(1).border_color(t.border)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().size(7).rounded(4).flex_none().bg(hueOf(g.agent)))
          .child(div().flex_1().min_w(0).truncate().text_size(s.small).font_semibold().text_color(t.foreground)
            .tooltip(`Session id: ${g.id || "unknown"}\nThe routing JSONL carries no session title.`)
            .child("Session " + this.sessionLabel(g))))
        .child(div().text_size(s.tiny).text_color(t.dim)
          .child([`${g.agent || "agent"} · latest #${r.id}`, age ? age + " ago" : ""].filter(Boolean).join(" · "))))
      .child(v_flex().id("routing-session-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8)
        .children(this.context_(r, t, s)));
  }

  head_(t, s) {
    if (this.status === "no-record") return div();
    return h_flex().px(12).h(32).gap(7).items_center().flex_none()
      .border_b(1).border_color(t.border)
      .child(svg("mods/routing/route.svg").size(14).text_color(t.dim))
      .child(div().text_size(s.title).font_semibold().text_color(t.foreground).child("Routing"))
      .child(div().flex_1())
      .child(div().text_size(s.tiny).text_color(t.dim).child(String(this.live.length) + " recent"));
  }

  list_(t, s) {
    if (this.status === "no-record") {
      return v_flex().p(14).gap(8).flex_1()
        .child(div().text_size(s.title).font_semibold().text_color(t.foreground).child("No routing yet"))
        .child(div().text_size(s.small).text_color(t.muted).child("magpie writes each request to its routing folder as it finishes: " + this.recordPath()))
        .child(div().text_size(s.small).text_color(t.dim).child("Send one from an agent routed through magpie and it plays here."));
    }
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar()
      .children(this.live.slice(0, 30).map((id) => this.row(this.routes.get(id), t, s)));
  }

  row(r, t, s) {
    if (!r) return div();
    const last = r.tries[r.tries.length - 1];
    const bad = Boolean(last && !tryOk(last));
    const underWay = this.plays.has(r.id);
    const where = last ? seat(r, last).name : "not tried yet";
    return h_flex().id(`request-${r.id}`).px(10).h(34).gap(6).items_center().flex_none()
      .hover(el => el.bg(t.hover)).on_click((_e, cx) => { this.selected = r.id; this.session = ""; this.detailTab = "route"; this.contextFilter = ""; this.contextExpanded = false; this.ctxHover = ""; this.ctxHot = null; cx.notify(); })
      .border_b(1).border_color(t.border)
      .child(div().size(6).rounded(3).flex_none().bg(underWay ? t.accent : bad ? t.blocked : hueOf(r.agent)))
      .child(div().w(54).truncate().text_size(s.tiny).text_color(t.foreground).child(String(r.agent)))
      .child(div().flex_1().min_w(0).truncate().text_size(s.tiny).text_color(bad ? t.blocked : t.muted).child(`${r.model || "—"} → ${where}`))
      .child(div().text_size(s.tiny).text_color(t.dim).child(ageText(r.ms)));
  }

  detail_(r, t, s) {
    const button = (id, label, action, active) => div().id(id).px(8).py(4).rounded(5)
      .text_size(s.small).text_color(active ? t.foreground : t.muted)
      .bg(active ? t.selected : t.chrome).hover(el => el.bg(t.hover)).on_click(action).child(label);
    const line = (label, value) => h_flex().gap(8).w_full().items_center()
      .child(div().w(76).flex_none().text_size(s.tiny).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).truncate().text_size(s.small).text_color(t.foreground).child(String(value || "—")));
    const content = this.detailTab === "context"
      ? this.context_(r, t, s)
      : [line("Time", r.time), line("Agent", r.agent), line("Model", r.model),
         line("Served", r.served), line("Status", r.status || (r.done ? "Finished" : "Pending")),
         line("Duration", ageText(r.ms)), line("First token", ageText(r.ttft)),
         line("Tokens", `${r.tokens} in · ${r.out} out`),
         div().pt(6).text_size(s.small).font_semibold().text_color(t.foreground).child("Attempts"),
         ...(r.tries.length ? r.tries.map((tr, i) => line(`#${i + 1} ${tr.status || "…"}`, `${seat(r, tr).name} · ${tr.model || "—"} · ${ageText(tr.ms)}${tr.fail ? " · failed" : ""}`))
           : [div().text_size(s.small).text_color(t.dim).child("No attempts recorded")])];
    return v_flex().flex_1().min_h(0)
      .child(h_flex().px(8).py(5).gap(4).items_center().flex_none().border_b(1).border_color(t.border)
        .child(button("routing-back", "‹ History", (_e, cx) => { this.selected = null; cx.notify(); }, false))
        .child(div().flex_1())
        .child(button("routing-route", "Route", (_e, cx) => { this.detailTab = "route"; cx.notify(); }, this.detailTab === "route"))
        .child(button("routing-context", "Context", (_e, cx) => { this.detailTab = "context"; cx.notify(); }, this.detailTab === "context")))
      .child(v_flex().id("routing-detail-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8).children(content));
  }

  // The card follows magpie's Context window: how full the window is, a
  // waffle grid of what fills it, the parts' legend and, under them, the
  // items behind the parts, largest first. Everything drawn here comes
  // from the kind/name/token metadata the JSONL keeps; the request's own
  // text is never read.
  context_(r, t, s) {
    const p = r.prompt;
    const text = (value, color = t.muted) => div().text_size(s.small).text_color(color).child(String(value));

    // A card drawn again for another request starts with no cell lit.
    if (this.ctxCardId !== r.id) {
      this.ctxCardId = r.id;
      this.ctxHover = "";
      this.ctxHot = null;
    }

    if (!p) {
      return [v_flex().w_full().min_w(0).rounded(10).bg(t.surface).border(1).border_color(t.border).p(12).gap(8)
        .child(div().text_size(s.small).font_semibold().text_color(t.foreground).child("Context window"))
        .child(text("Unavailable — this request has no context statistics."))];
    }

    const palette = ctxDark(t) ? CTX_COLORS_DARK : CTX_COLORS_LIGHT;
    const color = kind => {
      const i = CTX_KINDS.indexOf(kind);
      return i < 0 ? t.dim : palette[i];
    };
    const parts = p.parts.slice().sort((a, b) => {
      const ai = CTX_KINDS.indexOf(a.kind), bi = CTX_KINDS.indexOf(b.kind);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.kind.localeCompare(b.kind);
    });
    const liveParts = parts.filter(part => part.tokens > 0);
    const total = parts.reduce((n, part) => n + part.tokens, 0);
    const window = Math.max(0, Number(p.window) || 0);
    const free = Math.max(0, window - total);
    const fill = window > 0 ? total / window : null;
    const live = !r.done;
    const state = live ? "Live" : p.counted ? "Counted" : "Estimated";
    const stateTone = live ? t.accent : p.counted ? t.done : t.muted;
    const health = ctxHealth(fill);

    // The session's recent prompts, as Magpie's renderCtx draws them: the
    // conversation's turns alone. A subagent's prompt is its own
    // conversation's, and in a session whose turns carry tools a tool-less
    // side call cannot stand for the conversation's line. This mod only
    // keeps the latest routes, so the card says "among recent history".
    const sk = ctxSessionOf(r);
    const sessionReqs = sk ? [...this.routes.values()].filter(x => ctxSessionOf(x) === sk) : [];
    const tooled = sessionReqs.some(x => !x.sub && hasTools(x));
    const same = x => (x.sub || "") === (r.sub || "") && (!tooled || hasTools(x));
    const series = sk ? sessionReqs.filter(same)
      .sort((a, b) => a.id - b.id)
      .map(x => ({ id: x.id, tokens: Math.max(0, Number(x.prompt.tokens) || 0), time: x.time })) : [];
    if (sk && !series.some(x => x.id === r.id) && (!tooled || hasTools(r))) {
      series.push({ id: r.id, tokens: Math.max(0, Number(r.prompt.tokens) || 0), time: r.time });
      series.sort((a, b) => a.id - b.id);
    }
    const room = fill !== null && series.length > 1 ? ctxHeadroom(series, free) : null;
    const shownSeries = series.length > 32 ? series.slice(-32) : series;
    const peak = Math.max(1, ...series.map(x => x.tokens));
    const top = window > 0 && peak > window * 0.6 ? Math.max(window, peak) : peak * 1.2;

    // The head: what the card is, the model, and how the prompt was counted.
    const head = h_flex().w_full().min_w(0).gap(6).items_center()
      .child(div().flex_none().text_size(s.title).font_semibold().text_color(t.foreground).child("Context window"))
      .child(div().flex_1())
      .when(this.size.width >= 420 && Boolean(r.model), el => el.child(
        div().min_w(0).truncate().text_size(s.tiny).text_color(t.dim).child(r.model)))
      .child(h_flex().flex_none().items_center().justify_center().h(20).min_w(76).px(6).rounded(10).bg(t.raised).gap(4)
        .child(div().size(5).rounded(3).flex_none().bg(stateTone))
        .child(div().text_size(s.tiny).text_color(stateTone).child(state)));

    // How full, in the figure, its share of the window, and what is left.
    const bits = [];
    if (fill !== null) {
      bits.push(ctxPct(fill) + " full");
      bits.push(fmtK(free) + " free");
      if (room !== null) {
        bits.push(room >= 999 ? "plenty of headroom"
          : `~${room} request${room === 1 ? "" : "s"} of headroom`);
      }
    } else bits.push("the model's window isn't known");
    if (p.turns) bits.push(`${p.turns} turn${p.turns === 1 ? "" : "s"}`);
    if (p.held) bits.push("earlier turns held");

    const stat = v_flex().w_full().gap(3)
      .child(h_flex().items_center().gap(6)
        .child(div().text_size(s.tiny).text_color(t.dim).child("Context used"))
        .when(Boolean(health), el => el.child(div().px(5).py(1).rounded(8).bg(t.raised)
          .text_size(s.tiny).text_color(t[health.tone] || t.muted).child(health.word))))
      .child(h_flex().items_end().gap(6).flex_wrap()
        .child(div().text_size(s.title + 7).font_semibold().text_color(t.foreground).child(fmtK(total)))
        .child(div().text_size(s.small).text_color(t.muted)
          .child(window > 0 ? `/ ${fmtK(window)} tokens` : "tokens")))
      .child(div().text_size(s.tiny).text_color(t.muted).child(bits.join(" · ")));

    // The window as 400 cells, a cell for each 1/400 of it. 50 to a row when
    // there is room, 25 in a narrow panel, so the cells stay readable and
    // the card still scrolls in a small pane.
    const cells = ctxCells(parts, total, window);
    const cellH = this.size.width >= 520 ? 6 : 4;
    const cols = this.size.width >= 520 ? 50 : 25;
    const focus = this.ctxHover;
    const hot = this.ctxHot;
    const dimCell = (cell) => {
      if (hot) return !(cell && cell.kind === hot.kind && cell.item === hot.item);
      if (focus === "free") return Boolean(cell);
      if (focus) return !cell || cell.kind !== focus;
      return false;
    };
    const gridRows = [];
    for (let at = 0; at < cells.length; at += cols) {
      const row = [];
      for (let i = 0; i < cols; i++) {
        const cell = cells[at + i];
        row.push(div().flex_1().h(cellH).rounded(1)
          .bg(cell ? color(cell.kind) : t.raised)
          .when(dimCell(cell), el => el.opacity(cell ? 0.16 : 0.25)));
      }
      gridRows.push(h_flex().w_full().gap(2).children(row));
    }
    const grid = v_flex().w_full().gap(2).children(gridRows);

    // The legend: a part (or the free space) hovered lights its cells.
    const legendItem = (kind, name, tokens, filled) => {
      const key = kind || "free";
      return h_flex().items_center().gap(5).px(4).py(2).rounded(4)
        .when(focus === key, el => el.bg(t.hover))
        .on_hover((hovered, cx) => {
          const next = hovered ? key : "";
          if (this.ctxHover !== next) { this.ctxHover = next; cx.notify(); }
        })
        .child(div().size(7).rounded(2).flex_none()
          .when(filled, el => el.bg(color(kind)))
          .when(!filled, el => el.border(1).border_color(t.border)))
        .child(div().text_size(s.tiny).text_color(filled ? t.foreground : t.muted).child(name))
        .child(div().text_size(s.tiny).text_color(t.dim).child(fmtK(tokens)));
    };
    const legend = h_flex().w_full().flex_wrap().gap(10)
      .children(liveParts.map(part => legendItem(part.kind, ctxPartName(part.kind), part.tokens, true)))
      .when(free > 0, el => el.child(legendItem("", "Free space", free, false)));

    // A filter the newly shown request has no part for falls back to All.
    const activeFilter = parts.some(part => part.kind === this.contextFilter && part.tokens > 0)
      ? this.contextFilter : "";
    if (activeFilter !== this.contextFilter) this.contextFilter = activeFilter;
    if (this.ctxHot && activeFilter && this.ctxHot.kind !== activeFilter) this.ctxHot = null;

    // Every item, with the index it has inside its part's items sorted
    // largest first: ctxCells maps cells by that same index, so a row
    // hovered lights exactly the cells it fills.
    const items = parts.flatMap(part => {
      const sorted = part.items.slice().sort((a, b) => b.tokens - a.tokens);
      return sorted.map((item, idx) => ({ ...item, kind: part.kind, idx }));
    })
      .filter(item => !activeFilter || item.kind === activeFilter)
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
    const max = items.length ? Math.max(1, items[0].tokens) : 1;
    const shown = this.contextExpanded ? items : items.slice(0, 8);
    const narrow = this.size.width < 420;

    const filter = (kind, label, idx) => div().id(`context-filter-${idx}`).px(7).py(3).rounded(4)
      .text_size(s.tiny).text_color(activeFilter === kind ? t.foreground : t.muted)
      .bg(activeFilter === kind ? t.selected : t.raised).hover(el => el.bg(t.hover))
      .on_click((_e, cx) => {
        this.contextFilter = kind;
        this.contextExpanded = false;
        this.ctxHover = "";
        this.ctxHot = null;
        cx.notify();
      })
      .child(label);

    // The name: a path keeps its file name first, the folder dim after it.
    const itemLabel = (item) => {
      const name = ctxItemName(item);
      const at = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
      if ((item.kind === "files" || item.kind === "memory") && at >= 0) {
        return h_flex().flex_1().min_w(0).gap(5).overflow_hidden()
          .child(div().flex_none().max_w(narrow ? 104 : 176).truncate()
            .text_size(s.small).text_color(t.foreground).child(name.slice(at + 1)))
          .child(div().flex_1().min_w(0).truncate().text_size(s.tiny).text_color(t.dim)
            .child(name.slice(0, at + 1)));
      }
      return div().flex_1().min_w(0).truncate().text_size(s.small).text_color(t.foreground).child(name);
    };

    const itemRow = (item) => {
      const tag = ctxTagName(item);
      return h_flex().w_full().min_w(0).px(5).py(3).gap(6).rounded(5).items_center()
        .hover(el => el.bg(t.hover))
        .on_hover((hovered, cx) => {
          const next = hovered ? { kind: item.kind, item: item.idx } : null;
          const same = this.ctxHot && next && this.ctxHot.kind === next.kind && this.ctxHot.item === next.item;
          if (hovered ? !same : Boolean(this.ctxHot)) { this.ctxHot = next; cx.notify(); }
        })
        .child(div().size(6).rounded(2).flex_none().bg(color(item.kind)))
        .child(itemLabel(item))
        .when(item.count > 1 && item.tag !== "turns" && item.tag !== "more",
          el => el.child(div().flex_none().text_size(s.tiny).text_color(t.muted).child("×" + fmtK(item.count))))
        .when(!narrow && Boolean(tag), el => el.child(div().flex_none().px(4).py(1).rounded(3)
          .bg(t.raised).text_size(s.tiny).text_color(t.dim).child(tag)))
        .child(div().w(narrow ? 36 : 56).h(4).flex_none().rounded(2).bg(t.raised).overflow_hidden()
          .child(div().h(4).rounded(2).bg(color(item.kind))
            .w(Math.max(2, item.tokens / max * 100).toFixed(1) + "%")))
        .child(div().w(44).flex_none().text_right().text_size(s.tiny).text_color(t.muted).child(fmtK(item.tokens)));
    };

    const contents = v_flex().w_full().gap(6).border_t(1).border_color(t.border).pt(9)
      .child(h_flex().items_center().gap(6)
        .child(div().text_size(s.tiny).font_semibold().text_color(t.muted).child("Contents"))
        .child(div().flex_1())
        .when(Boolean(activeFilter), el => el.child(div().id("context-clear").px(4).py(2).rounded(4)
          .text_size(s.tiny).text_color(t.accent).hover(e2 => e2.bg(t.hover))
          .on_click((_e, cx) => {
            this.contextFilter = "";
            this.contextExpanded = false;
            this.ctxHover = "";
            this.ctxHot = null;
            cx.notify();
          })
          .child("Clear")))
        .child(div().text_size(s.tiny).text_color(t.dim)
          .child(`${items.length} item${items.length === 1 ? "" : "s"}`)))
      .child(h_flex().gap(4).flex_wrap().children([
        filter("", "All", 0),
        ...liveParts.map((part, i) =>
          filter(part.kind, narrow ? ctxShortName(part.kind) : ctxPartName(part.kind), i + 1)),
      ]))
      .child(v_flex().w_full().gap(1).children(
        shown.length ? shown.map(itemRow) : [text("No items recorded for this selection", t.dim)]))
      .when(items.length > 8, el => el.child(div().id("context-expand").py(4).px(2).rounded(5)
        .text_size(s.small).text_color(t.accent).hover(e2 => e2.bg(t.hover))
        .on_click((_e, cx) => { this.contextExpanded = !this.contextExpanded; cx.notify(); })
        .child(this.contextExpanded ? "Show fewer" : `Show all ${items.length} items`)));

    // The session's prompts, as bars; the one open is the accent.
    const sessionBars = shownSeries.map(x => div().id(`context-session-${x.id}`).flex_1().min_w(1)
      .h(Math.max(2, Math.round(x.tokens / top * 26))).rounded(1)
      .bg(x.id === r.id ? t.accent : t.border)
      .hover(el => el.bg(x.id === r.id ? t.accent : t.muted))
      .on_click((_e, cx) => {
        if (x.id !== r.id && this.routes.has(x.id)) {
          this.session = "";
          this.selected = x.id;
          this.contextExpanded = false;
          this.ctxHover = "";
          this.ctxHot = null;
          cx.notify();
        }
      }));
    const session = series.length > 1
      ? v_flex().w_full().gap(4).border_t(1).border_color(t.border).pt(9)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(s.small).font_semibold().text_color(t.foreground).child("This session"))
          .child(div().flex_1())
          .child(div().text_size(s.tiny).text_color(t.dim).child(`${series.length} requests`)))
        .child(h_flex().w_full().h(26).gap(2).items_end().children(sessionBars))
        .child(div().text_size(s.tiny).text_color(t.dim)
          .child(`${fmtK(series[0].tokens)} → ${fmtK(series[series.length - 1].tokens)} tokens · oldest to newest among recent history`))
        .when(series.length > shownSeries.length, el => el.child(div().text_size(s.tiny).text_color(t.dim)
          .child(`The last ${shownSeries.length} are shown; older requests are not kept.`)))
      : null;

    return [v_flex().w_full().min_w(0).rounded(10).bg(t.surface).border(1).border_color(t.border).p(12).gap(10)
      .children([
        head,
        stat,
        ...(total > 0 ? [grid, legend] : [text("No category statistics recorded", t.dim)]),
        contents,
        ...(session ? [session] : []),
      ])];
  }

  // The stage copies magpie's ps-* tray panel: 104px tall, 40px hub, 22px
  // nodes, 38px column gaps, cubic wires, and dots that travel the curves.
  stage_(st, t, s) {
    const W = Math.max(200, this.size.width);
    const H = 104;
    const hubR = 20;
    const hubX = W / 2, hubY = H / 2;
    const gap = 38;
    const leftEdge = hubX - hubR - gap;
    const rightEdge = hubX + hubR + gap;
    const colW = Math.max(44, leftEdge - 4);
    const rowH = 22, rowGap = 6;
    const topOf = (n) => Math.max(4, (H - (n * rowH + Math.max(0, n - 1) * rowGap)) / 2);
    const agTop = topOf(this.agents.length);
    const dsTop = topOf(this.dests.length);
    const centerY = (top, i) => top + i * (rowH + rowGap) + rowH / 2;

    const wires = [];
    const litBy = (kind, key) => this.trips.find((trip) => {
      const r = this.routes.get(trip.id);
      if (!r) return false;
      const p = this.progress(trip);
      if (p.leg !== kind) return false;
      if (kind === "agent") return r.agent === key;
      const tr = r.tries[trip.index];
      return Boolean(tr) && seat(r, tr).key === key;
    });

    this.agents.forEach((agent, i) => {
      const y = centerY(agTop, i);
      const lit = litBy("agent", agent);
      const col = lit ? hueOf(agent) : t.border;
      // magpie lights a wire to 55% of the agent's colour; the rest stay line.
      wires.push(this.wire(leftEdge + 3, y, hubX - hubR - 2, hubY, col, 1.5).opacity(lit ? 0.55 : 1));
    });
    this.dests.forEach((key, i) => {
      const y = centerY(dsTop, i);
      const lit = litBy("dest", key);
      const r = lit ? this.routes.get(lit.id) : null;
      const col = lit && r ? hueOf(r.agent) : t.border;
      wires.push(this.wire(hubX + hubR + 2, hubY, rightEdge - 3, y, col, 1.5).opacity(lit ? 0.55 : 1));
    });

    const agNodes = this.agents.map((agent, i) => {
      const prog = programFor(agent);
      const icon = prog
        ? (prog.tint
          ? svg(prog.icon).size(13).flex_none().text_color(t.foreground)
          : image(prog.icon).size(13).flex_none())
        : div().size(6).rounded(3).flex_none().bg(hueOf(agent));
      return h_flex().absolute().right(W - leftEdge).top(agTop + i * (rowH + rowGap))
        .max_w(colW).h(rowH).px(8).gap(5).items_center().rounded(7)
        .bg(t.raised).border(1).border_color(t.border)
        .child(icon)
        .child(div().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(agent));
    });

    const dsNodes = this.dests.map((key, i) => {
      const d = st.dests.get(key) || { how: "ok", name: key, sub: "" };
      const col = d.how === "bad" ? t.blocked : d.how === "wait" ? t.muted : t.done;
      return h_flex().absolute().left(rightEdge).top(dsTop + i * (rowH + rowGap))
        .max_w(colW).h(rowH).px(8).gap(5).items_center().rounded(7)
        .bg(t.raised).border(1).border_color(t.border)
        .child(div().size(6).rounded(3).flex_none().bg(col)
          .when(d.how === "wait", (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1800 })))
        .child(div().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(d.name || key))
        .when(Boolean(d.sub), (el) => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(d.sub)));
    });

    const dots = this.trips.flatMap((trip) => {
      const r = this.routes.get(trip.id);
      if (!r) return [];
      const p = this.progress(trip);
      let x, y, col = hueOf(r.agent);
      if (p.leg === "agent") {
        const i = this.agents.indexOf(r.agent);
        if (i < 0) return [];
        y = centerY(agTop, i);
        const pt = cubicAt(leftEdge + 3, y, hubX - hubR - 2, hubY, p.k);
        x = pt.x; y = pt.y;
        if (trip.phase === "ok-home") col = t.done;
        else if (trip.phase === "home-fail") col = t.blocked;
      } else {
        const tr = r.tries[trip.index];
        const i = this.dests.indexOf(tr ? seat(r, tr).key : "");
        if (i < 0) return [];
        y = centerY(dsTop, i);
        const pt = cubicAt(hubX + hubR + 2, hubY, rightEdge - 3, y, p.k);
        x = pt.x; y = pt.y;
        if (trip.phase === "back-fail") col = t.blocked;
        else if (trip.phase === "ok-back") col = t.done;
        else if (trip.phase === "at-dest" && tr) col = tryOk(tr) ? t.done : t.blocked;
      }
      const waiting = trip.phase === "at-dest";
      const fade = trip.phase === "fade" ? 0 : 1;
      const halo = div().id(`halo-${trip.id}`).absolute().left(x - 6).top(y - 6).transition("left", trip.duration).transition("top", trip.duration).transition("opacity", FADE_MS).size(12).rounded(6).bg(col).opacity(0.22 * fade);
      const core = div().id(`dot-${trip.id}`).absolute().left(x - 3.5).top(y - 3.5).transition("left", trip.duration).transition("top", trip.duration).transition("opacity", FADE_MS).size(7).rounded(4).bg(col).opacity(fade)
        .when(waiting, (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1200 }));
      return [halo, core];
    });

    const busy = this.trips.length > 0;
    const ring = busy
      ? div().absolute().left(hubX - 27).top(hubY - 27).size(54).rounded(27)
        .border(1).border_color(t.accent).opacity(0.4)
        .loop("opacity", { from: 0.4, to: 0, period: 1800 })
      : div();
    const hub = div().absolute().left(hubX - hubR).top(hubY - hubR).size(hubR * 2).rounded(hubR)
      .flex().items_center().justify_center().bg(t.surface).border(1)
      .border_color(busy ? t.accent : t.border)
      .child(svg("mods/routing/bird.svg").size(24).text_color(t.foreground));

    const empty = this.live.length === 0
      ? [div().absolute().left(10).top(hubY + hubR + 8).w(W - 20).flex().justify_center()
        .child(div().text_size(s.tiny).text_color(t.dim).child("Waiting for a request"))]
      : [];

    return div().id("routing-stage").h(H).flex_none().relative().mx(8).my(6).rounded(11)
      .bg(t.surface).border(1).border_color(t.border)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .children([...wires, ...agNodes, ...dsNodes, hub, ring, ...dots, ...empty]);
  }
}
