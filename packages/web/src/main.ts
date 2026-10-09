import { API_PREFIX, type Bot, type WorldSnapshot } from "@hamlet/shared/world";
import { createWorld, type World } from "./world/engine.js";

const SETTINGS_KEY = "hamlet-settings";
const DEFAULTS = {
  timeOfDay: 16.5, dayCycle: false, skyPalette: ["#F2955A", "#FFE1B3"], weather: "clear", world: "stone", botStyle: "cavemen", wind: 1,
  softShadows: true, ambientOcclusion: true, rimLight: true, bloom: true, colorGrade: true, edgePan: true, theme: "dark",
};
type Settings = typeof DEFAULTS;
type Key = keyof Settings;

const THEMES: Record<string, Record<string, string>> = {
  dark: { slab: "#1b1c20", edge: "#34363d", line: "#2c2e34", sel: "#25262b", foot: "#16171a", code: "#111214", ink: "#ece8df", soft: "#7d828c", mid: "#c9c6bf", "btn-edge": "#4a4d55", "amber-t": "#ffc21a", "red-t": "#ff6a4d", red: "#ff6a4d", "on-red": "#1b1c20", pill: "rgba(27,28,32,0.88)", shadow: "0 8px 24px rgba(20,10,0,0.25)" },
  light: { slab: "#fbfaf7", edge: "#d9d6cf", line: "#e8e5de", sel: "#f1eee7", foot: "#f3f1ec", code: "#f3f1ec", ink: "#1b1c20", soft: "#6b6f78", mid: "#3a3d44", "btn-edge": "#b9b5ac", "amber-t": "#9a6400", "red-t": "#c7361c", red: "#d9452f", "on-red": "#fbfaf7", pill: "rgba(251,250,247,0.94)", shadow: "0 8px 24px rgba(40,25,5,0.16)" },
};
const PALETTES = [
  { name: "Amber dusk", c: ["#F2955A", "#FFE1B3"] }, { name: "Peach", c: ["#F7B58C", "#FFF0D6"] }, { name: "Ember", c: ["#E0704A", "#FFC78A"] },
  { name: "Rose", c: ["#C9708A", "#FFC9A3"] }, { name: "Clear sky", c: ["#7DB4EA", "#E6F2F8"] },
];
const WORLDS = [["stone", "STONE AGE"], ["suburb", "SUBURB"], ["japan", "JAPAN"]];
const TABS = [["world", "WORLD"], ["light", "LIGHT"], ["graphics", "GRAPHICS"], ["general", "GENERAL"]];
const SWITCHES: [Key, string][] = [["softShadows", "Soft shadows"], ["ambientOcclusion", "Ambient occlusion"], ["rimLight", "Rim light"], ["bloom", "Bloom"], ["colorGrade", "Color grading"]];
const LABEL = { working: "WORKING", needs_input: "NEEDS INPUT", idle: "IDLE", errored: "ERRORED" } as const;

function loadSettings(): Partial<Settings> {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const out: Record<string, unknown> = {};
    for (const k in DEFAULTS) if (k in s && typeof s[k] === typeof DEFAULTS[k as Key]) out[k] = s[k];
    return out as Partial<Settings>;
  } catch {
    return {};
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pad = (n: number) => String(n).padStart(2, "0");

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

function preview(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  let text: string;
  if (toolName === "Bash" && typeof i.command === "string") text = i.command;
  else if (typeof i.file_path === "string") {
    const body = i.new_string ?? i.content ?? "";
    text = `${i.file_path}\n\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}`;
  } else text = JSON.stringify(input, null, 2);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const app = $("#app");
const canvas = $<HTMLCanvasElement>("canvas");
const loading = $(".loading");
const intro = $(".intro");
const sidebar = $(".sidebar");
const tray = $(".tray");
const bubble = $(".bubble");
const cog = $(".cog");
const settingsEl = $(".settings");
const scrim = $(".scrim");

let world: World | undefined;
let bots: Bot[] = [];
let selected: string | null = null;
let offline = false;
let error = "";
let settings = loadSettings();
let tab = "world";
let introDone = false;
// Cities never disappear once seen, so the map stays stable while sessions come and go.
const repos = new Map<string, string[]>();

const cfg = (): Settings => ({ ...DEFAULTS, ...settings });
const selBot = () => bots.find((b) => b.sessionId === selected);
const waitingOldestFirst = () => bots.filter((b) => b.state === "needs_input").sort((a, b) => a.since - b.since);

function setSetting<K extends Key>(k: K, v: Settings[K], rerender = true): void {
  settings = { ...settings };
  if (JSON.stringify(v) === JSON.stringify(DEFAULTS[k])) delete settings[k];
  else settings[k] = v;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
  applySettings();
  if (rerender) renderSettings();
}

function applySettings(): void {
  const t = THEMES[cfg().theme] ?? THEMES.dark!;
  for (const k in t) app.style.setProperty(`--i-${k}`, t[k]!);
  world?.setOptions(opts());
}

const opts = () => ({ ...cfg(), forceWebGL: /[?&]webgl\b/.test(location.search) });

function select(id: string | null, fly = true): void {
  selected = id;
  error = "";
  world?.select(id, fly);
  render();
}

function next(): void {
  const w = waitingOldestFirst();
  if (!w.length) return;
  const i = w.findIndex((b) => b.sessionId === selected);
  select(w[(i + 1) % w.length]!.sessionId);
}

async function answer(behavior: "allow" | "deny"): Promise<void> {
  const p = selBot()?.permission;
  if (!p) return;
  error = "";
  try {
    const res = await fetch(`${API_PREFIX}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: p.id, behavior }),
    });
    if (res.status === 404) throw new Error("That request was already answered or cancelled.");
    if (!res.ok) throw new Error(`Daemon answered ${res.status}.`);
  } catch (e) {
    error = (e as Error).message;
    renderBubble(true);
  }
}

async function openTerminal(): Promise<void> {
  const b = selBot();
  if (!b?.terminal) return;
  error = "";
  try {
    const res = await fetch(`${API_PREFIX}/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: b.sessionId }),
    });
    if (res.status === 404) throw new Error("This session's terminal is unknown.");
    if (!res.ok) throw new Error(`Could not open the terminal: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`);
  } catch (e) {
    error = (e as Error).message;
  }
  renderBubble(true);
}

function toggle(el: HTMLElement, open?: boolean): void {
  el.hidden = open === undefined ? !el.hidden : !open;
}

const RANK: Record<Bot["state"], number> = { needs_input: 0, errored: 1, working: 2, idle: 3 };
const expanded = new Set<string>();
const repoEls = new Map<string, HTMLLIElement>();
const agentEls = new Map<string, HTMLLIElement>();
const motion = matchMedia("(prefers-reduced-motion: no-preference)");
const EASE = "cubic-bezier(.2,.8,.2,1)";

function make(html: string): HTMLLIElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLLIElement;
}

// Moves only out-of-place nodes (moving restarts their transitions), then FLIP-animates what shifted.
function arrange(list: Element, wanted: Element[]): void {
  const before = new Map([...list.children].map((c) => [c, c.getBoundingClientRect().top]));
  let at = list.firstElementChild;
  for (const el of wanted) {
    while (at?.classList.contains("leaving")) at = at.nextElementSibling;
    if (at === el) at = el.nextElementSibling;
    else list.insertBefore(el, at);
  }
  if (!motion.matches) return;
  for (const el of wanted) {
    const dy = (before.get(el) ?? NaN) - el.getBoundingClientRect().top;
    if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 320, easing: EASE });
  }
}

function setBadge(el: HTMLElement, n: number): void {
  const old = Number(el.dataset.n ?? 0);
  if (old === n) return;
  el.dataset.n = String(n);
  if (n) el.querySelector("b")!.textContent = String(n); // a vanishing badge keeps its last number while it fades
  el.classList.toggle("on", n > 0);
  if (n > old && motion.matches) el.animate([{ transform: "scale(1.6)" }, { transform: "none" }], { duration: 450, easing: EASE });
}

function agentRow(b: Bot, i: number): HTMLLIElement {
  let li = agentEls.get(b.sessionId);
  if (!li) {
    li = make(`<li class="agent"><button class="row" data-act="select" data-arg="${esc(b.sessionId)}">
      <span class="dot"></span><span class="where"></span><span class="what"></span><span class="age"></span></button></li>`);
    agentEls.set(b.sessionId, li);
  }
  // Swapping the state class (re)starts the CSS flash for waiting/errored.
  if (li.dataset.state !== b.state) (li.dataset.state = b.state), (li.className = `agent ${b.state}`);
  li.classList.toggle("current", b.sessionId === selected);
  li.style.setProperty("--i", String(i));
  li.querySelector(".where")!.textContent = b.branch;
  li.querySelector(".what")!.textContent = b.permission?.toolName ?? LABEL[b.state];
  li.querySelector(".age")!.textContent = ago(b.since);
  return li;
}

function renderSidebar(): void {
  const byRepo = new Map<string, Bot[]>([...repos.keys()].sort((a, b) => a.localeCompare(b)).map((r) => [r, []]));
  for (const b of bots) byRepo.get(b.repo)?.push(b);
  const live = new Set(bots.map((b) => b.sessionId));
  for (const [id, li] of agentEls)
    if (!live.has(id)) agentEls.delete(id), li.classList.add("leaving"), setTimeout(() => li.remove(), 320);
  const lis = [...byRepo].map(([repo, rb]) => {
    let li = repoEls.get(repo);
    if (!li) {
      li = make(`<li class="repo"><button class="row city" data-act="city" data-arg="${esc(repo)}" title="${esc(repo)}" aria-expanded="false">
        <span class="initial">${esc(repo.slice(0, 1).toUpperCase())}</span><span class="chev" aria-hidden="true">›</span>
        <span class="name">${esc(repo)}</span><span class="n mono soft"></span>
        <span class="badges"><span class="badge amber" title="Waiting">▲<b>0</b></span><span class="badge red" title="Errored">■<b>0</b></span></span>
        </button><div class="agents"><ol></ol></div></li>`);
      repoEls.set(repo, li);
    }
    const open = expanded.has(repo);
    const waiting = rb.filter((b) => b.state === "needs_input").length;
    const errored = rb.filter((b) => b.state === "errored").length;
    li.classList.toggle("open", open);
    li.classList.toggle("warn", waiting > 0);
    li.classList.toggle("err", errored > 0);
    li.querySelector(".city")!.setAttribute("aria-expanded", String(open));
    li.querySelector(".n")!.textContent = String(rb.length);
    setBadge(li.querySelector(".badge.amber")!, waiting);
    setBadge(li.querySelector(".badge.red")!, errored);
    rb.sort((a, b) => RANK[a.state] - RANK[b.state] || a.since - b.since);
    arrange(li.querySelector("ol")!, rb.map(agentRow));
    return li;
  });
  arrange(sidebar.querySelector("ul")!, lis);
}

function toggleRepo(repo: string): void {
  if (!expanded.delete(repo)) expanded.add(repo), world?.flyToCity(repo);
  render();
}

function render(): void {
  renderSidebar();
  sidebar.querySelector(".repo-count")!.textContent = `${pad(repos.size)} REPO${repos.size === 1 ? "" : "S"}`;

  const waiting = waitingOldestFirst();
  tray.hidden = !waiting.length;
  tray.querySelector(".waiting-count")!.textContent = pad(waiting.length);
  tray.querySelector("ol")!.innerHTML = waiting
    .map(
      (b) => `<li><button class="row${b.sessionId === selected ? " current" : ""}" data-act="select" data-arg="${esc(b.sessionId)}">
        <span class="where">${esc(b.repo)} <span class="branch">${esc(b.branch)}</span></span>
        <span class="tool">${esc(b.permission?.toolName ?? "input")}</span>
        <span class="age">${ago(b.since)}</span></button></li>`,
    )
    .join("");

  loading.hidden = !(introDone && offline);
  renderBubble();
}

let bubbleKey = "";
function renderBubble(force = false): void {
  const b = selBot();
  bubble.classList.toggle("open", !!b);
  if (!b) return (bubbleKey = ""), undefined;
  const state = `${LABEL[b.state]} · ${ago(b.since)}`;
  const key = JSON.stringify([b.sessionId, b.state, b.branch, b.permission?.id, !!b.terminal, error]);
  // Only the age ticks between real changes; rebuilding would reset the preview's scroll.
  if (key === bubbleKey && !force) return void (bubble.querySelector(".state")!.textContent = state);
  bubbleKey = key;
  const p = b.permission;
  bubble.className = `panel bubble open ${b.state}`;
  bubble.innerHTML = `<div class="bar"></div>
    <header>
      <span class="head">
        <span class="state">${state}</span>
        <span class="repo">${esc(b.repo)} <span class="branch">${esc(b.branch)}</span></span>
      </span>
      <button class="ghost" data-act="close" aria-label="Close">ESC</button>
    </header>
    <div class="body">${
      p
        ? `<span class="kv">TOOL  <b>${esc(p.toolName)}</b></span>
           <pre><span class="soft">${p.toolName === "Bash" ? "$ " : ""}</span>${esc(preview(p.toolName, p.toolInput))}</pre>
           <span class="cwd">CWD   ${esc(p.cwd)}</span>
           <div class="actions">
             <button class="primary" data-act="allow">[A] ALLOW</button>
             <button class="outline" data-act="deny">[D] DENY</button>
           </div>`
        : `<span class="cwd">CWD   ${esc(b.cwd)}</span>${b.state === "needs_input" ? "<span>Waiting in the terminal.</span>" : ""}`
    }${b.terminal ? `<button class="primary terminal" data-act="terminal" title="Open this session's terminal">[T] OPEN TERMINAL</button>` : ""}${error ? `<p class="error">${esc(error)}</p>` : ""}</div>`;
}

const sw = (k: Key, label: string) => {
  const on = !!cfg()[k];
  return `<div class="line"><span>${label}</span><button class="switch" role="switch" aria-checked="${on}" aria-label="${label}" data-act="switch" data-arg="${k}">${on ? "[ ON  ]" : "[ OFF ]"}</button></div>`;
};
const seg = (k: Key, label: string, values: string[]) =>
  `<div class="line"><span>${label}</span><div class="seg">${values
    .map((v) => `<button aria-pressed="${cfg()[k] === v}" data-act="seg" data-arg="${k}:${v}">${v.toUpperCase()}</button>`)
    .join("")}</div></div>`;
const slider = (k: Key, label: string, value: string, attrs: string) =>
  `<label class="slider"><span class="line"><span>${label}</span><span class="val">${value}</span></span><input type="range" data-key="${k}" ${attrs}></label>`;

function timeLabel(c: Settings): string {
  return c.dayCycle ? "Cycling" : `${pad(Math.floor(c.timeOfDay) % 24)}:${pad(Math.round((c.timeOfDay % 1) * 60))}`;
}

function renderSettings(): void {
  const open = !settingsEl.hidden;
  cog.setAttribute("aria-expanded", String(open));
  if (!open) return;
  const c = cfg();
  settingsEl.querySelector(".tabs")!.innerHTML = TABS.map(
    ([id, label]) => `<button role="tab" aria-selected="${tab === id}" data-act="tab" data-arg="${id}">${label}</button>`,
  ).join("");
  let html = "";
  if (tab === "world") {
    html = `<div class="worlds">${WORLDS.map(
      ([id, name]) => `<button aria-pressed="${c.world === id}" title="${name}" data-act="world" data-arg="${id}">
        <span class="thumb" role="img" aria-label="${name}" style="background-image:url('/world/thumb-${id}.png')"></span>
        <span class="wname">${name}</span></button>`,
    ).join("")}</div>`;
    if (c.world !== "suburb" && c.world !== "japan") html += seg("botStyle", "Bots", ["cavemen", "animals"]);
    html += slider("wind", "Wind", `${c.wind.toFixed(1)}×`, `min="0" max="3" step="0.1" value="${c.wind}"`);
  } else if (tab === "light") {
    html =
      slider("timeOfDay", "Time of day", timeLabel(c), `min="0" max="24" step="0.25" value="${c.timeOfDay}" ${c.dayCycle ? "disabled" : ""}`) +
      sw("dayCycle", "Day cycle") +
      `<div style="display:flex;flex-direction:column;gap:6px"><span>Sky</span><div class="palettes">${PALETTES.map(
        (p, i) =>
          `<button aria-label="${p.name}" title="${p.name}" aria-pressed="${JSON.stringify(p.c) === JSON.stringify(c.skyPalette)}" data-act="palette" data-arg="${i}" style="background:linear-gradient(180deg, ${p.c[0]}, ${p.c[1]})"></button>`,
      ).join("")}</div></div>` +
      seg("weather", "Weather", ["clear", "mist"]);
  } else if (tab === "graphics") html = SWITCHES.map(([k, l]) => sw(k, l)).join("");
  else html = seg("theme", "Theme", ["dark", "light"]) + sw("edgePan", "Pan at screen edge");
  settingsEl.querySelector(".tabpanel")!.innerHTML = html;
  settingsEl.querySelector<HTMLButtonElement>(".reset")!.disabled = Object.keys(settings).length === 0;
}

function toggleSettings(open?: boolean): void {
  toggle(settingsEl, open);
  if (!settingsEl.hidden) scrim.hidden = true;
  renderSettings();
}

app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el) return;
  // The help scrim closes on outside clicks only.
  if (el === scrim && e.target !== scrim) return;
  const arg = el.dataset.arg ?? "";
  switch (el.dataset.act) {
    case "sidebar": sidebar.classList.toggle("collapsed"); break;
    case "city": toggleRepo(arg); break;
    case "select": select(arg); break;
    case "next": next(); break;
    case "close": select(null); break;
    case "allow": case "deny": void answer(el.dataset.act); break;
    case "terminal": void openTerminal(); break;
    case "zoom-in": world?.zoom(-1); break;
    case "zoom-out": world?.zoom(1); break;
    case "frame": world?.frameAll(); break;
    case "help": toggle(scrim); break;
    case "settings": toggleSettings(); break;
    case "reset":
      try {
        localStorage.removeItem(SETTINGS_KEY);
      } catch {}
      settings = {};
      applySettings();
      renderSettings();
      break;
    case "tab": tab = arg; renderSettings(); break;
    case "switch": setSetting(arg as Key, !cfg()[arg as Key] as never); break;
    case "seg": { const [k, v] = arg.split(":"); setSetting(k as Key, v as never); break; }
    case "palette": setSetting("skyPalette", PALETTES[Number(arg)]!.c); break;
    case "world": if (cfg().world !== arg) (select(null, false), setSetting("world", arg)); break;
  }
});

// Sliders update in place so re-rendering never interrupts a drag.
settingsEl.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  const k = input.dataset.key as "wind" | "timeOfDay";
  setSetting(k, parseFloat(input.value), false);
  input.closest(".slider")!.querySelector(".val")!.textContent = k === "wind" ? `${cfg().wind.toFixed(1)}×` : timeLabel(cfg());
  settingsEl.querySelector<HTMLButtonElement>(".reset")!.disabled = Object.keys(settings).length === 0;
});

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement;
  if (/input|textarea|select/i.test(t.tagName) || t.isContentEditable) return;
  const k = e.key.toLowerCase();
  if (k === "escape") {
    if (!scrim.hidden) scrim.hidden = true;
    else if (!settingsEl.hidden) toggleSettings(false);
    else select(null);
  } else if (e.key === "?") toggle(scrim);
  else if (e.key === ",") toggleSettings();
  else if (k === "n") next();
  else if (k === "a" && selBot()?.permission) void answer("allow");
  else if (k === "d" && selBot()?.permission) void answer("deny");
  else if (k === "t") void openTerminal();
});

function applySnapshot(snapshot: WorldSnapshot): void {
  bots = snapshot.bots;
  let grew = false;
  for (const b of bots) {
    const branches = repos.get(b.repo) ?? [];
    if (!branches.includes(b.branch)) (branches.push(b.branch), repos.set(b.repo, branches), (grew = true));
  }
  if (grew) world?.setRepos(repoList());
  world?.setBots(bots);
  if (selected && !selBot()) select(null, false);
  else render();
}

function progress(k: number, stage: string): void {
  intro.querySelector<HTMLElement>(".bar span")!.style.width = `${k * 100}%`;
  intro.querySelector(".bar")!.setAttribute("aria-valuenow", String(Math.round(k * 100)));
  intro.querySelector(".stage")!.textContent = stage;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const repoList = () => [...repos].map(([repo, branches]) => ({ repo, branches: [...branches] }));

applySettings();
render();

let gotRepos!: () => void;
const reposReady = new Promise<void>((r) => (gotRepos = r));

const events = new EventSource(`${API_PREFIX}/stream`);
events.onopen = () => {
  offline = false;
  render();
};
events.onmessage = (e) => {
  offline = false;
  applySnapshot(JSON.parse(e.data) as WorldSnapshot);
  if (repos.size) gotRepos();
  else if (!introDone) progress(0.35, "No Claude Code sessions yet. Start one in a git repo.");
};
events.onerror = () => {
  offline = true;
  if (!introDone) progress(0.35, "Daemon offline. Start it with pnpm daemon.");
  render();
};
setInterval(render, 5000); // keeps "waiting for" ages fresh

try {
  progress(0.1, "Starting renderer");
  world = await createWorld({
    canvas,
    labels: $(".labels"),
    bubble,
    options: opts(),
    callbacks: { onSelect: (id) => select(id), permissionOpen: () => !!selBot()?.permission },
  });
  progress(0.35, "Connecting to daemon");
  await reposReady;
  progress(0.6, "Raising terrain");
  await nextFrame();
  world.setRepos(repoList());
  world.setBots(bots);
  progress(0.85, "Compiling shaders");
  await world.compile();
  progress(1, "Ready");
  await new Promise((r) => setTimeout(r, 350));
  introDone = true;
  intro.classList.add("done");
  world.reveal();
  render();
} catch (e) {
  console.error(e);
  progress(0, `Could not start the 3D view. ${(e as Error).message ?? e}`);
}
