import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import "./fonts.css";
import { getTheme, applyUiTheme, TERMINAL_FONT, type TerminalTheme } from "./themes";

// ---------- Window label detection ----------
const myLabel = getCurrentWindow().label;
const isMainWindow = !myLabel.startsWith("term-");

// ---------- Body setup ----------
// In the main window, the sidebar + terminal area layout already created
// #tabs, #terminal-status-bar, and #terminals (via renderShell in main.ts).
// In a term-* window, we own the whole body and create them ourselves.
let tabsEl: HTMLElement;
let termsEl: HTMLElement;
let statusBarEl: HTMLElement;
if (isMainWindow) {
  const t = document.getElementById("tabs");
  const ts = document.getElementById("terminals");
  const sb = document.getElementById("terminal-status-bar");
  if (!t || !ts || !sb) throw new Error("Main window terminal area not found");
  tabsEl = t;
  termsEl = ts;
  statusBarEl = sb;
} else {
  document.body.innerHTML = "";
  tabsEl = document.createElement("div");
  tabsEl.id = "tabs";
  statusBarEl = document.createElement("div");
  statusBarEl.id = "terminal-status-bar";
  statusBarEl.className = "terminal-status-bar";
  termsEl = document.createElement("div");
  termsEl.id = "terminals";
  document.body.append(tabsEl, termsEl, statusBarEl);
  document.body.classList.add("terminal-window");
  document.title = "Terminal";
}
// Apply saved status bar visibility (shared via localStorage, same origin).
if (localStorage.getItem("kc-statusbar-visible") === "0") {
  document.body.classList.add("statusbar-hidden");
}
listen<{ visible: boolean }>("statusbar-visibility", (ev) => {
  document.body.classList.toggle("statusbar-hidden", !ev.payload.visible);
});

// ---------- Types ----------
interface AddTabPayload {
  terminal_id: string;
  title: string;
  ssh_args: string[];
  cwd?: string | null;
  adopt?: boolean;
  initial_content?: string;
  env?: Record<string, string>;
  account_name?: string | null;
}

interface Pane {
  id: string;          // terminal_id (owns Rust PTY)
  baseTitle: string;
  title: string;
  sshArgs: string[];
  cwd: string | null;
  env?: Record<string, string>;
  accountName?: string | null;
  fontSize: number;
  paneEl: HTMLElement;
  headerEl: HTMLElement;
  xtermEl: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
  search: SearchAddon;
  // WebGL 컨텍스트를 잃으면 dispose하고 null로 떨어뜨린다(= DOM 렌더러로 복귀).
  webgl: WebglAddon | null;
  exited: boolean;
}

interface Tab {
  id: string;          // unique tab id
  tabBtnEl: HTMLElement;
  panesWrapEl: HTMLElement;
  panes: Pane[];       // left-to-right
  ratios: number[];    // sum = 1
  focusedPaneId: string;
  zoomedPaneId: string | null;
  broadcast: boolean;
}

interface MergeTabPayload {
  terminal_id: string;
  title: string;
  ssh_args: string[];
  cwd?: string | null;
  initial_content: string;
  screen_x: number;
  screen_y: number;
  env?: Record<string, string>;
  account_name?: string | null;
}

interface PtyOutput { terminal_id: string; data: number[]; }
interface PtyExit { terminal_id: string; }

// ---------- State ----------
const tabs = new Map<string, Tab>();
let activeTabId: string | null = null;
const pendingOutput = new Map<string, Uint8Array[]>();

const MAX_PANES_PER_TAB = 3;
const FONT_MIN = 8;
const FONT_MAX = 28;
const FONT_DEFAULT = 13;

let currentTheme: TerminalTheme = getTheme(null);
applyUiTheme(currentTheme.ui);

const scoped = { target: { kind: "AnyLabel" as const, label: myLabel } };

// 프로그래밍 폰트가 리가처를 만드는 연산자 문자들의 연속 구간.
// $ @ % 는 셸 출력에 자주 나오고 리가처도 거의 없어서 뺐다.
const LIGATURE_RUN = /[=!<>+*/&|~^:.?#;-]{2,}/g;

const CLOSE_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
const ZOOM_OUT_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 3h6M3 9v6m0-6h6M3 9l6 6m12-6v6m0-6h-6m6 0l-6 6M9 21H3m0 0v-6"/></svg>`;

// ---------- Helpers ----------
function uid() { return "x-" + Math.random().toString(36).slice(2, 10); }

// Clean every transient drag-related class across the document. This is
// called on ANY dragend at capture phase, so even if the original drag source
// was removed from DOM mid-drop (and dragend can't bubble to our handlers),
// we don't leak visual residue (accent lines, drop zones, ghost highlights).
function clearAllDragArtifacts() {
  document.querySelectorAll(
    ".tab-dragging, .tab-drop-before, .tab-drop-after, .tab-pane-drop, " +
    ".drop-zone-left, .drop-zone-right, .pane-dragging, " +
    ".pane-drop-before, .pane-drop-after"
  ).forEach(el => {
    el.classList.remove(
      "tab-dragging", "tab-drop-before", "tab-drop-after", "tab-pane-drop",
      "drop-zone-left", "drop-zone-right", "pane-dragging",
      "pane-drop-before", "pane-drop-after"
    );
  });
  tabsEl.classList.remove("tab-bar-drop-empty");
}

// Global cleanup on dragend AND drop, at capture phase — runs before/regardless
// of any other handler, so we never leak visual residue even when the drag
// source element was removed from DOM mid-drop.
document.addEventListener("dragend", clearAllDragArtifacts, { capture: true });
document.addEventListener("drop", () => {
  // Schedule cleanup after the specific drop handlers finish adjusting DOM
  setTimeout(clearAllDragArtifacts, 0);
}, { capture: true });

function findPane(terminalId: string): { tab: Tab; pane: Pane; index: number } | null {
  for (const tab of tabs.values()) {
    const index = tab.panes.findIndex(p => p.id === terminalId);
    if (index >= 0) return { tab, pane: tab.panes[index], index };
  }
  return null;
}

function getActiveTab(): Tab | null {
  return activeTabId ? tabs.get(activeTabId) ?? null : null;
}

function getActivePane(): { tab: Tab; pane: Pane } | null {
  const tab = getActiveTab();
  if (!tab) return null;
  const pane = tab.panes.find(p => p.id === tab.focusedPaneId) ?? tab.panes[0];
  return pane ? { tab, pane } : null;
}

function stripSuffix(s: string): string { return s.replace(/ \(\d+\)$/, ""); }

function chooseTitle(base: string): string {
  const taken = new Set<string>();
  for (const t of tabs.values()) for (const p of t.panes) taken.add(p.title);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const c = `${base} (${n})`;
    if (!taken.has(c)) return c;
  }
  return base;
}

function updateWindowTitle() {
  const ap = getActivePane();
  void getCurrentWindow().setTitle(ap ? ap.pane.title : "Terminal");
}

function sendResize(pane: Pane) {
  if (pane.exited) return;
  const { rows, cols } = pane.term;
  if (!rows || !cols) return;
  invoke("pty_resize", { terminalId: pane.id, rows, cols }).catch(() => {});
}

function normalizeRatios(tab: Tab) {
  const sum = tab.ratios.reduce((a, b) => a + b, 0);
  if (sum > 0) tab.ratios = tab.ratios.map(r => r / sum);
  else tab.ratios = tab.panes.map(() => 1 / tab.panes.length);
}

// ---------- 링크 열기 ----------
// 터미널 안의 링크는 반드시 OS에 넘겨야 한다. 웹뷰의 window.open을 쓰면
// 앱 자체가 그 URL로 이동해버릴 수 있다.
// OSC 8은 임의의 스킴을 실어보낼 수 있으므로 화이트리스트로 거른다.
const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "file:", "mailto:"]);

function openLink(uri: string) {
  let scheme: string;
  try { scheme = new URL(uri).protocol; }
  catch { return; }
  if (!SAFE_LINK_SCHEMES.has(scheme)) return;
  void openExternal(uri).catch(() => {});
}

// ---------- Theme hot-swap ----------
function applyThemeToAllPanes(t: TerminalTheme) {
  currentTheme = t;
  applyUiTheme(t.ui);
  for (const tab of tabs.values()) {
    for (const pane of tab.panes) {
      pane.term.options.theme = t.xterm;
    }
  }
}

listen<string>("terminal-theme-changed", (event) => {
  applyThemeToAllPanes(getTheme(event.payload));
});

// ---------- Terminal status bar (usage + rate limit) ----------
interface _UsageTotals { input: number; output: number; cache_read: number; cache_write: number; messages: number; }
interface _SessionUsage { session_id: string; model: string | null; totals: _UsageTotals; duration_min: number; first_ts: string | null; last_ts: string | null; }
interface _UsageReport { today: _UsageTotals; week: _UsageTotals; all_time: _UsageTotals; by_model_today: Record<string, _UsageTotals>; by_model_week: Record<string, _UsageTotals>; active_session: _SessionUsage | null; }
interface _OauthQuota { utilization: number; resets_at: string | null; }
interface _ScopedQuota { label: string | null; utilization: number; resets_at: string | null; }
interface _OauthUsage { fiveHour: _OauthQuota; sevenDay: _OauthQuota; sevenDaySonnet: _OauthQuota | null; sevenDayScoped?: _ScopedQuota | null; }

let _statusUsage: _UsageReport | null = null;
let _statusOauth: _OauthUsage | null = null;
let _localActiveSessionId: string | null = null;
let _localSessionUsage: _SessionUsage | null = null;
// For new sessions (no --resume), remember the tab-open time so we can look up
// the session_id Claude creates on first write.
let _newSessionDiscoveryStart: number | null = null;

async function _refetchLocalSession() {
  if (!_localActiveSessionId) {
    // Try to discover a fresh session id for the active tab if we're waiting.
    if (_newSessionDiscoveryStart !== null) {
      try {
        const sid = await invoke<string | null>("find_new_session_since", { sinceMs: _newSessionDiscoveryStart });
        if (sid) {
          _localActiveSessionId = sid;
          _newSessionDiscoveryStart = null;
        }
      } catch {}
    }
    if (!_localActiveSessionId) {
      _localSessionUsage = null;
      renderStatusBar();
      return;
    }
  }
  try {
    const s = await invoke<_SessionUsage | null>("get_session_usage", { sessionId: _localActiveSessionId });
    _localSessionUsage = s;
  } catch {
    _localSessionUsage = null;
  }
  renderStatusBar();
}

function _fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function _totalTokens(t: _UsageTotals): number {
  return t.input + t.output + t.cache_read + t.cache_write;
}
function _modelColor(m: string | null): string {
  if (m === "sonnet") return "var(--blue, #4593fc)";
  if (m === "opus") return "#a78bfa";
  if (m === "haiku") return "#22c55e";
  if (m === "fable") return "#fb7185";
  return "var(--fg-dim)";
}
function _pctColor(pct: number): string {
  if (pct >= 90) return "#ef4444";
  if (pct >= 70) return "#f59e0b";
  return "var(--accent)";
}
function _fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}
function _fmtReset(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "";
  const diff = t - Date.now();
  if (diff <= 0) return "리셋됨";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m 후 리셋`;
  const hours = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hours < 24) return rm > 0 ? `${hours}h ${rm}m 후 리셋` : `${hours}h 후 리셋`;
  const days = Math.floor(hours / 24);
  const rh = hours % 24;
  return rh > 0 ? `${days}d ${rh}h 후 리셋` : `${days}d 후 리셋`;
}
function renderStatusBar() {
  if (!statusBarEl) return;
  const parts: string[] = [];
  const s = _localSessionUsage;
  if (s) {
    const total = _fmtTokens(_totalTokens(s.totals));
    const model = s.model ? s.model[0].toUpperCase() + s.model.slice(1) : "?";
    const dot = `<span class="sb-dot" style="background:${_modelColor(s.model)}"></span>`;
    const timeRange = s.first_ts
      ? `${_fmtTime(s.first_ts)}${s.last_ts ? "→" + _fmtTime(s.last_ts) : ""}`
      : "";
    parts.push(`
      <div class="sb-block">
        ${dot}
        <span class="sb-label">세션</span>
        <span class="sb-value">${total}</span>
        <span class="sb-sub">${model}${timeRange ? " · " + timeRange : ""}</span>
      </div>
    `);
  }
  if (_statusOauth) {
    const f = _statusOauth.fiveHour;
    const w = _statusOauth.sevenDay;
    const fClock = f ? _fmtTime(f.resets_at) : "";
    const wClock = w ? _fmtTime(w.resets_at) : "";
    if (f) parts.push(`
      <div class="sb-block sb-ratelimit" title="${_fmtReset(f.resets_at)}">
        <span class="sb-label">5h</span>
        <span class="sb-bar"><span class="sb-bar-fill" style="width:${Math.min(100, f.utilization)}%; background:${_pctColor(f.utilization)}"></span></span>
        <span class="sb-value">${Math.round(f.utilization)}%</span>
        ${fClock ? `<span class="sb-clock">${fClock}</span>` : ""}
      </div>
    `);
    if (w) parts.push(`
      <div class="sb-block sb-ratelimit" title="${_fmtReset(w.resets_at)}">
        <span class="sb-label">주간</span>
        <span class="sb-bar"><span class="sb-bar-fill" style="width:${Math.min(100, w.utilization)}%; background:${_pctColor(w.utilization)}"></span></span>
        <span class="sb-value">${Math.round(w.utilization)}%</span>
        ${wClock ? `<span class="sb-clock">${wClock}</span>` : ""}
      </div>
    `);
    const sc = _statusOauth.sevenDayScoped;
    if (sc) {
      const scClock = _fmtTime(sc.resets_at);
      parts.push(`
      <div class="sb-block sb-ratelimit" title="${_fmtReset(sc.resets_at)}">
        <span class="sb-label">주간 ${sc.label || "모델"}</span>
        <span class="sb-bar"><span class="sb-bar-fill" style="width:${Math.min(100, sc.utilization)}%; background:${_pctColor(sc.utilization)}"></span></span>
        <span class="sb-value">${Math.round(sc.utilization)}%</span>
        ${scClock ? `<span class="sb-clock">${scClock}</span>` : ""}
      </div>
    `);
    }
  }
  statusBarEl.innerHTML = parts.join('<span class="sb-sep"></span>') || `<span class="sb-empty">세션을 열면 사용량이 표시됩니다</span>`;
}

listen<_UsageReport>("usage-update", (event) => {
  _statusUsage = event.payload;
  // Refetch THIS window's session whenever the global tick fires.
  void _refetchLocalSession();
});
listen<_OauthUsage>("usage-oauth-update", (event) => {
  _statusOauth = event.payload;
  renderStatusBar();
});
// Initial snapshots so the bar doesn't look empty until first event
void invoke<_UsageReport>("get_usage_report").then((r) => { _statusUsage = r; renderStatusBar(); }).catch(() => {});
// oauth: Rust poll이 캐시를 채울 때까지 2초마다 재시도 (최대 10회 = 20초)
(function initOauth(retries: number) {
  void invoke<_OauthUsage>("get_cached_oauth_usage")
    .then((o) => { _statusOauth = o; renderStatusBar(); })
    .catch(() => { if (retries > 0) setTimeout(() => initOauth(retries - 1), 2000); });
})(10);
// Periodic re-render so reset countdowns tick without new data
setInterval(renderStatusBar, 30_000);
// Periodic session refetch (3s). Fires even when no global update event arrives
// (e.g. brand-new session waiting for its first message to land).
setInterval(() => void _refetchLocalSession(), 3_000);

// ---------- PTY output routing ----------
listen<PtyOutput>("pty-output", (event) => {
  const data = new Uint8Array(event.payload.data);
  const r = findPane(event.payload.terminal_id);
  if (r) {
    r.pane.term.write(data);
  } else {
    const q = pendingOutput.get(event.payload.terminal_id) ?? [];
    q.push(data);
    pendingOutput.set(event.payload.terminal_id, q);
  }
});

listen<PtyExit>("pty-exit", (event) => {
  const r = findPane(event.payload.terminal_id);
  if (!r) return;
  r.pane.exited = true;
  r.pane.headerEl.classList.add("pane-exited");
  r.pane.term.writeln("\r\n\x1b[1;33m[세션 종료됨]\x1b[0m");
});

// ---------- Rendering ----------
function renderTabLayout(tab: Tab) {
  const isMulti = tab.panes.length > 1;
  const zoomedId = tab.zoomedPaneId;

  tab.panesWrapEl.classList.toggle("multi", isMulti);
  tab.panesWrapEl.classList.toggle("zoomed", !!zoomedId);
  tab.panesWrapEl.replaceChildren();

  tab.panes.forEach((pane, i) => {
    const hidden = zoomedId !== null && pane.id !== zoomedId;
    pane.paneEl.classList.toggle("pane-hidden", hidden);
    pane.headerEl.classList.toggle("pane-header-visible", isMulti || !!zoomedId);

    if (zoomedId) {
      pane.paneEl.style.flex = hidden ? "0 0 0" : "1 1 0";
    } else {
      pane.paneEl.style.flex = `${tab.ratios[i] ?? 1} 1 0`;
    }
    tab.panesWrapEl.appendChild(pane.paneEl);

    if (!zoomedId && i < tab.panes.length - 1) {
      const div = document.createElement("div");
      div.className = "pane-divider";
      div.dataset.leftIdx = String(i);
      div.dataset.tabId = tab.id;
      tab.panesWrapEl.appendChild(div);
    }
  });

  // Fit after layout settles
  requestAnimationFrame(() => {
    for (const p of tab.panes) {
      if (!p.exited && p.paneEl.offsetWidth > 0 && p.paneEl.offsetHeight > 0) {
        try { p.fit.fit(); } catch {}
        sendResize(p);
      }
    }
  });
}

function applyFocusStyles(tab: Tab) {
  for (const p of tab.panes) {
    p.paneEl.classList.toggle("pane-focused", p.id === tab.focusedPaneId);
  }
}

// ---------- Pane creation ----------
// NOTE: handlers below look up the owning tab via findPane() each time, so a pane
// can be moved between tabs and still behave correctly (focus, broadcast, zoom).
function createPane(init: { id: string; baseTitle: string; title: string; sshArgs: string[]; cwd: string | null; env?: Record<string, string>; accountName?: string | null }): Pane {
  const paneEl = document.createElement("div");
  paneEl.className = "term-pane";
  paneEl.dataset.paneId = init.id;

  const headerEl = document.createElement("div");
  headerEl.className = "pane-header";
  headerEl.draggable = true;
  headerEl.innerHTML = `
    <span class="pane-header-title"></span>
    <span class="pane-header-actions">
      <button class="pane-header-btn pane-header-zoom" title="전체화면 토글">${ZOOM_OUT_SVG}</button>
      <button class="pane-header-btn pane-header-close" title="pane 닫기">${CLOSE_SVG}</button>
    </span>
  `;
  (headerEl.querySelector(".pane-header-title") as HTMLElement).textContent = init.title;

  const xtermEl = document.createElement("div");
  xtermEl.className = "pane-xterm";
  paneEl.append(headerEl, xtermEl);

  const term = new Terminal({
    theme: currentTheme.xterm,
    fontFamily: TERMINAL_FONT,
    fontSize: FONT_DEFAULT,
    cursorBlink: true,
    cursorStyle: "block",
    scrollback: 50000,
    allowProposedApi: true,
    // minimumContrastRatio를 1보다 크게 두면 xterm이 대비를 맞추려고 색을
    // 임의로 밝게 끌어올린다. Claude Code가 의도한 흐린 힌트 텍스트나 diff
    // 배경이 원본과 다르게 보이는 원인이라 끈다(1 = 보정 없음).
    minimumContrastRatio: 1,
    lineHeight: 1.08,
    // 기본 구분자에는 / . : 가 들어있어서 `src/terminal.ts:1379` 같은 경로를
    // 더블클릭으로 한 번에 잡지 못한다. 공백류만 구분자로 둔다.
    wordSeparator: " ()[]{}',\"`",
    // OSC 8 하이퍼링크(Claude Code가 파일 경로 등에 붙인다) 클릭 처리.
    // WebLinksAddon은 정규식으로 찾은 http(s)만 보므로 그것과는 별개다.
    linkHandler: {
      activate: (_ev, text) => openLink(text),
      // file:// 같은 비-HTTP 스킴도 받아야 파일 경로 링크가 동작한다.
      // 임의 스킴이 그대로 셸에 넘어가지 않도록 openLink에서 화이트리스트를 건다.
      allowNonHttpProtocols: true,
    },
  });
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    // IME 조합 중에는 무조건 xterm에 넘긴다.
    // xterm의 _keyDown은 이 핸들러를 _compositionHelper.keydown()보다 *먼저* 부른다.
    // 여기서 false를 반환하면 CompositionHelper가 통째로 스킵되는데, 그러면
    //  - _finalizeComposition(false)로 취소돼야 할 setTimeout 전송이 살아남아 → 글자 중복
    //  - keyCode 229 경로(_handleAnyTextareaChanges)가 안 돌아 → 글자 누락
    // 둘 다 발생한다. 조합 중 키는 전부 xterm이 처리해야 한다.
    if (ev.isComposing || ev.keyCode === 229) return true;
    // Shift+Enter / Ctrl+Enter → Option+Enter sequence (ESC+CR), which
    // Claude Code CLI interprets as "insert newline in prompt".
    if (ev.key === "Enter" && (ev.shiftKey || ev.ctrlKey) && !ev.altKey && !ev.metaKey) {
      if (!pane.exited) {
        const bytes = Array.from(new TextEncoder().encode("\x1b\r"));
        void invoke("pty_write", { terminalId: pane.id, data: bytes });
      }
      ev.preventDefault();
      return false;
    }
    return !isOurShortcut(ev);
  });
  const fit = new FitAddon();
  const serialize = new SerializeAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_ev, uri) => openLink(uri)));
  term.loadAddon(serialize);
  term.loadAddon(search);
  // OSC 52 — CLI가 클립보드에 쓸 수 있게 한다.
  term.loadAddon(new ClipboardAddon());
  // 이모지/조합 문자/한글의 셀 폭을 최신 규칙으로 계산한다. 이게 없으면
  // 박스 드로잉과 이모지가 섞인 줄에서 폭이 1칸씩 어긋난다.
  term.loadAddon(new UnicodeGraphemesAddon());
  term.unicode.activeVersion = "15-graphemes";
  term.open(xtermEl);

  // ---- 리가처 ----
  // Cascadia Code는 리가처 폰트인데 xterm은 셀 단위로 그려서 =>, !=, -> 가
  // 붙지 않는다. registerCharacterJoiner로 "이 구간은 한 덩어리"라고 알려주면
  // 브라우저 텍스트 셰이핑이 폰트의 리가처를 적용한다. open() 이후에만 호출 가능.
  //
  // 공식 @xterm/addon-ligatures는 쓸 수 없다 — 의존하는 font-finder /
  // font-ligatures가 파일시스템에서 폰트를 읽는 Node 전용 패키지라
  // 웹뷰에서 동작하지 않는다. 그래서 연산자 문자 런을 직접 잇는다.
  // 폰트에 해당 리가처가 없으면 그냥 원래대로 그려지므로 손해는 없다.
  term.registerCharacterJoiner((text) => {
    const ranges: [number, number][] = [];
    LIGATURE_RUN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LIGATURE_RUN.exec(text)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
    }
    return ranges;
  });

  // WebGL 렌더러는 반드시 open() 이후에 붙인다.
  // 기본 DOM 렌더러는 선택 영역을 마우스 이동마다 span으로 다시 만들기 때문에
  // 드래그 선택과 스크롤이 눈에 띄게 밀린다. WebGL은 텍스처 아틀라스 + GPU라
  // 그 비용이 사라지고, 한글처럼 폭이 다른 글리프도 셀 격자에 맞춰 그린다.
  let webgl: WebglAddon | null = null;
  try {
    const w = new WebglAddon();
    // 컨텍스트 손실(GPU 리셋, 드라이버 갱신 등)은 정상적으로 일어날 수 있다.
    // 이때 addon을 붙들고 있으면 화면이 죽으므로 버리고 DOM 렌더러로 돌아간다.
    w.onContextLoss(() => {
      w.dispose();
      if (pane) pane.webgl = null;
    });
    term.loadAddon(w);
    webgl = w;
  } catch {
    // WebGL을 못 쓰는 환경(원격 데스크톱, 소프트웨어 렌더링 등)에서는
    // 조용히 DOM 렌더러로 둔다. 느릴 뿐 동작에는 문제가 없다.
    webgl = null;
  }

  const pane: Pane = {
    id: init.id,
    baseTitle: init.baseTitle,
    title: init.title,
    sshArgs: init.sshArgs,
    cwd: init.cwd,
    fontSize: FONT_DEFAULT,
    paneEl, headerEl, xtermEl,
    term, fit, serialize, search, webgl,
    env: init.env,
    accountName: init.accountName ?? null,
    exited: false,
  };

  // Focus on click anywhere in pane (resolve current tab dynamically)
  paneEl.addEventListener("mousedown", (e) => {
    // find bar 안을 클릭한 경우엔 터미널로 포커스를 되돌리면 안 된다.
    // (되돌리면 검색어를 한 글자도 못 친다)
    if ((e.target as HTMLElement).closest(".find-bar")) return;
    const r = findPane(pane.id);
    if (!r) return;
    const { tab } = r;
    if (tab.focusedPaneId !== pane.id) {
      tab.focusedPaneId = pane.id;
      applyFocusStyles(tab);
      pane.term.focus();
      sendResize(pane);
      updateWindowTitle();
    }
  });

  headerEl.querySelector(".pane-header-close")!.addEventListener("click", (e) => {
    e.stopPropagation();
    void closePane(pane.id);
  });
  headerEl.querySelector(".pane-header-zoom")!.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = findPane(pane.id);
    if (r) toggleZoomForPane(r.tab, pane.id);
  });
  headerEl.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest(".pane-header-btn")) return;
    const r = findPane(pane.id);
    if (r) toggleZoomForPane(r.tab, pane.id);
  });

  term.onData((data) => {
    if (pane.exited) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    const r = findPane(pane.id);
    if (!r) return;
    const { tab } = r;
    if (tab.broadcast) {
      for (const p of tab.panes) {
        if (!p.exited) void invoke("pty_write", { terminalId: p.id, data: bytes });
      }
    } else {
      void invoke("pty_write", { terminalId: pane.id, data: bytes });
    }
  });

  return pane;
}

// ---------- Tab creation ----------
async function addTab(payload: AddTabPayload) {
  if (findPane(payload.terminal_id)) return;  // dedup guard

  const baseTitle = stripSuffix(payload.title);
  const displayTitle = chooseTitle(baseTitle);
  const adopt = payload.adopt === true;
  const initialContent = payload.initial_content || "";

  const tabId = uid();

  const tabBtnEl = document.createElement("div");
  tabBtnEl.className = "tab";
  tabBtnEl.dataset.tabId = tabId;
  tabBtnEl.draggable = true;
  tabBtnEl.innerHTML = `
    <span class="tab-broadcast" title="broadcast"></span>
    <span class="tab-title"></span>
    <span class="tab-close" title="닫기">${CLOSE_SVG}</span>
  `;
  (tabBtnEl.querySelector(".tab-title") as HTMLElement).textContent = displayTitle;
  tabsEl.appendChild(tabBtnEl);

  const panesWrapEl = document.createElement("div");
  panesWrapEl.className = "panes-wrap";
  panesWrapEl.dataset.tabId = tabId;
  termsEl.appendChild(panesWrapEl);

  const tab: Tab = {
    id: tabId,
    tabBtnEl, panesWrapEl,
    panes: [],
    ratios: [],
    focusedPaneId: payload.terminal_id,
    zoomedPaneId: null,
    broadcast: false,
  };
  tabs.set(tabId, tab);

  // Tab button interactions
  tabBtnEl.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    setActiveTab(tabId);
  });
  tabBtnEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
    e.stopPropagation();
    void closeTab(tabId);
  });
  tabBtnEl.addEventListener("auxclick", (e) => {
    if ((e as MouseEvent).button === 1) void closeTab(tabId);
  });

  // First pane
  const pane = createPane({
    id: payload.terminal_id,
    baseTitle,
    title: displayTitle,
    sshArgs: payload.ssh_args,
    cwd: payload.cwd ?? null,
    env: payload.env,
    accountName: payload.account_name ?? null,
  });
  tab.panes.push(pane);
  tab.ratios.push(1);

  // Activate this tab
  if (activeTabId && activeTabId !== tabId) {
    const prev = tabs.get(activeTabId);
    if (prev) {
      prev.tabBtnEl.classList.remove("active");
      prev.panesWrapEl.classList.remove("active");
    }
  }
  activeTabId = tabId;
  tabBtnEl.classList.add("active");
  panesWrapEl.classList.add("active");
  renderTabLayout(tab);
  applyFocusStyles(tab);

  // Track this window's active session for the status bar.
  const _resumeIdx = pane.sshArgs.indexOf("--resume");
  const _sid = _resumeIdx >= 0 && _resumeIdx + 1 < pane.sshArgs.length ? pane.sshArgs[_resumeIdx + 1] : null;
  _localActiveSessionId = _sid;
  _newSessionDiscoveryStart = _sid ? null : Date.now() - 5000;
  void _refetchLocalSession();

  if (adopt) {
    if (initialContent) pane.term.write(initialContent);
    const queued = pendingOutput.get(pane.id);
    if (queued) {
      for (const c of queued) pane.term.write(c);
      pendingOutput.delete(pane.id);
    }
    sendResize(pane);
    pane.term.focus();
    updateWindowTitle();
    return;
  }

  try {
    await invoke("pty_spawn", {
      terminalId: pane.id,
      sshArgs: payload.ssh_args,
      cwd: payload.cwd ?? null,
      rows: pane.term.rows || 24,
      cols: pane.term.cols || 80,
      env: payload.env ?? null,
    });
    pane.term.focus();
    updateWindowTitle();
  } catch (e) {
    pane.term.writeln(`\x1b[1;31m세션 실행 실패: ${e}\x1b[0m`);
    pane.exited = true;
    pane.headerEl.classList.add("pane-exited");
  }
}

// ---------- Tab activation ----------
function setActiveTab(tabId: string) {
  if (activeTabId === tabId) {
    const t = tabs.get(tabId);
    if (t) {
      const p = t.panes.find(p => p.id === t.focusedPaneId);
      if (p) p.term.focus();
    }
    return;
  }
  if (activeTabId) {
    const prev = tabs.get(activeTabId);
    if (prev) {
      prev.tabBtnEl.classList.remove("active");
      prev.panesWrapEl.classList.remove("active");
    }
  }
  const next = tabs.get(tabId);
  if (!next) return;
  activeTabId = tabId;
  next.tabBtnEl.classList.add("active");
  next.panesWrapEl.classList.add("active");
  applyFocusStyles(next);
  renderTabLayout(next);
  const p = next.panes.find(p => p.id === next.focusedPaneId) ?? next.panes[0];
  if (p) {
    next.focusedPaneId = p.id;
    // Previously-inactive tab's panes may have stale canvas dims from when
    // their wrap was display:none. Re-fit all panes in the new tab so
    // columns/rows match the current container.
    requestAnimationFrame(() => {
      for (const pp of next.panes) {
        if (!pp.exited) {
          try { pp.fit.fit(); } catch {}
          sendResize(pp);
        }
      }
    });
    p.term.focus();
    // Track this window's own active session (per-window, not global).
    const resumeIdx = p.sshArgs.indexOf("--resume");
    const sid = resumeIdx >= 0 && resumeIdx + 1 < p.sshArgs.length ? p.sshArgs[resumeIdx + 1] : null;
    _localActiveSessionId = sid;
    // For new (no-resume) sessions, we don't have an id yet. Remember open time
    // so we can discover the id once Claude writes the jsonl file.
    if (!sid) {
      _newSessionDiscoveryStart = Date.now() - 5000; // 5s slack for clock skew
    } else {
      _newSessionDiscoveryStart = null;
    }
    _refetchLocalSession();
  }
  updateWindowTitle();
}

// ---------- Split ----------
async function splitTab(tab: Tab, from: Pane, sshArgs: string[], baseTitle: string) {
  if (tab.panes.length >= MAX_PANES_PER_TAB) return;
  if (!sshArgs.length) return;

  const newId = uid();
  const displayTitle = chooseTitle(baseTitle);
  const pane = createPane({ id: newId, baseTitle, title: displayTitle, sshArgs, cwd: from.cwd, env: from.env, accountName: from.accountName });

  const insertIdx = tab.panes.indexOf(from) + 1;
  tab.panes.splice(insertIdx, 0, pane);

  // Split the origin's share equally with the new pane
  const origIdx = insertIdx - 1;
  const half = tab.ratios[origIdx] / 2;
  tab.ratios.splice(origIdx, 1, half, half);

  // Clear zoom on split
  tab.zoomedPaneId = null;
  renderTabLayout(tab);

  tab.focusedPaneId = pane.id;
  applyFocusStyles(tab);

  try {
    await invoke("pty_spawn", {
      terminalId: newId,
      sshArgs,
      cwd: from.cwd,
      rows: pane.term.rows || 24,
      cols: pane.term.cols || 80,
      env: from.env ?? null,
    });
    pane.term.focus();
    updateWindowTitle();
  } catch (e) {
    pane.term.writeln(`\x1b[1;31m분할 실패: ${e}\x1b[0m`);
    pane.exited = true;
    pane.headerEl.classList.add("pane-exited");
  }
}

function splitActiveSameSession() {
  const ap = getActivePane();
  if (!ap) return;
  void splitTab(ap.tab, ap.pane, ap.pane.sshArgs, ap.pane.baseTitle);
}

// ---------- Close pane / close tab ----------
// Fire-and-forget PTY teardown. `pty_kill_many` runs taskkill on a background
// thread, so awaiting it here would only stall the UI for no benefit — the
// backend keeps the PTY registered until the kill returns, and RunEvent::Exit
// reaps anything still alive if the app quits first. Nothing orphans.
function killPtysInBackground(terminalIds: string[]) {
  if (terminalIds.length === 0) return;
  void invoke("pty_kill_many", { terminalIds }).catch(() => {});
}

async function closePane(terminalId: string) {
  const r = findPane(terminalId);
  if (!r) return;
  const { tab, pane, index } = r;

  closeFindIfPane(terminalId);
  killPtysInBackground([terminalId]);
  pane.term.dispose();

  tab.panes.splice(index, 1);
  tab.ratios.splice(index, 1);

  if (tab.panes.length === 0) {
    await closeTab(tab.id);
    return;
  }

  normalizeRatios(tab);

  if (tab.focusedPaneId === terminalId) {
    tab.focusedPaneId = tab.panes[Math.min(index, tab.panes.length - 1)].id;
  }
  if (tab.zoomedPaneId === terminalId) tab.zoomedPaneId = null;

  renderTabLayout(tab);
  applyFocusStyles(tab);
  const focused = tab.panes.find(p => p.id === tab.focusedPaneId);
  if (focused) { focused.term.focus(); sendResize(focused); }
  updateWindowTitle();
}

async function closeTab(tabId: string) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  killPtysInBackground(tab.panes.map(p => p.id));
  for (const p of tab.panes) p.term.dispose();
  tab.tabBtnEl.remove();
  tab.panesWrapEl.remove();
  tabs.delete(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
    const next = tabs.keys().next().value;
    if (next) setActiveTab(next);
    else if (!isMainWindow) void getCurrentWindow().close();
  }
}

// ---------- Focus navigation ----------
function focusAdjacentPane(dir: -1 | 1) {
  const t = getActiveTab();
  if (!t) return;
  const idx = t.panes.findIndex(p => p.id === t.focusedPaneId);
  const next = idx + dir;
  if (next < 0 || next >= t.panes.length) return;
  t.focusedPaneId = t.panes[next].id;
  applyFocusStyles(t);
  const p = t.panes[next];
  sendResize(p);
  p.term.focus();
  updateWindowTitle();
}

// ---------- Divider resize ----------
function resizeActiveDivider(delta: number) {
  const t = getActiveTab();
  if (!t || t.panes.length < 2) return;
  const idx = t.panes.findIndex(p => p.id === t.focusedPaneId);
  const leftIdx = idx >= 0 && idx < t.panes.length - 1 ? idx : t.panes.length - 2;
  if (leftIdx < 0) return;
  const newLeft = Math.max(0.1, Math.min(0.9, t.ratios[leftIdx] + delta));
  const diff = newLeft - t.ratios[leftIdx];
  t.ratios[leftIdx] = newLeft;
  t.ratios[leftIdx + 1] -= diff;
  renderTabLayout(t);
}

function startDividerDrag(tab: Tab, leftIdx: number, startX: number) {
  const startRatios = tab.ratios.slice();
  const wrap = tab.panesWrapEl;
  const totalWidth = wrap.getBoundingClientRect().width;
  const leftRatio = startRatios[leftIdx];
  const rightRatio = startRatios[leftIdx + 1];
  const combined = leftRatio + rightRatio;
  const minRatio = 0.1 * combined;

  let pendingRatioLeft = leftRatio;
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    tab.ratios[leftIdx] = pendingRatioLeft;
    tab.ratios[leftIdx + 1] = combined - pendingRatioLeft;
    for (let i = 0; i < tab.panes.length; i++) {
      tab.panes[i].paneEl.style.flex = `${tab.ratios[i]} 1 0`;
    }
    const lp = tab.panes[leftIdx];
    const rp = tab.panes[leftIdx + 1];
    try { lp.fit.fit(); } catch {}
    try { rp.fit.fit(); } catch {}
    sendResize(lp);
    sendResize(rp);
  };

  const onMove = (e: PointerEvent) => {
    const dx = e.clientX - startX;
    const ratioDelta = dx / Math.max(totalWidth, 1) * (startRatios.reduce((a, b) => a + b, 0));
    pendingRatioLeft = Math.max(minRatio, Math.min(combined - minRatio, leftRatio + ratioDelta));
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.body.classList.remove("dragging-divider");
    flush();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.body.classList.add("dragging-divider");
}

termsEl.addEventListener("pointerdown", (e) => {
  const div = (e.target as HTMLElement).closest(".pane-divider") as HTMLElement | null;
  if (!div) return;
  const tabId = div.dataset.tabId!;
  const leftIdx = Number(div.dataset.leftIdx);
  const tab = tabs.get(tabId);
  if (!tab) return;
  e.preventDefault();
  startDividerDrag(tab, leftIdx, e.clientX);
});

termsEl.addEventListener("dblclick", (e) => {
  const div = (e.target as HTMLElement).closest(".pane-divider") as HTMLElement | null;
  if (!div) return;
  const tabId = div.dataset.tabId!;
  const leftIdx = Number(div.dataset.leftIdx);
  const tab = tabs.get(tabId);
  if (!tab) return;
  const combined = tab.ratios[leftIdx] + tab.ratios[leftIdx + 1];
  tab.ratios[leftIdx] = combined / 2;
  tab.ratios[leftIdx + 1] = combined / 2;
  renderTabLayout(tab);
});

// ---------- Zoom ----------
function toggleZoomForPane(tab: Tab, paneId: string) {
  tab.zoomedPaneId = tab.zoomedPaneId === paneId ? null : paneId;
  if (tab.zoomedPaneId) tab.focusedPaneId = paneId;
  renderTabLayout(tab);
  applyFocusStyles(tab);
  const p = tab.panes.find(p => p.id === tab.focusedPaneId);
  if (p) { sendResize(p); p.term.focus(); }
  updateWindowTitle();
}

function toggleZoomActive() {
  const ap = getActivePane();
  if (!ap) return;
  toggleZoomForPane(ap.tab, ap.pane.id);
}

// ---------- Broadcast ----------
function toggleBroadcastActive() {
  const t = getActiveTab();
  if (!t) return;
  t.broadcast = !t.broadcast;
  t.panesWrapEl.classList.toggle("broadcast", t.broadcast);
  t.tabBtnEl.classList.toggle("broadcast", t.broadcast);
}

// ---------- Font zoom (Ctrl+wheel, per pane) ----------
function adjustFontSize(pane: Pane, delta: number) {
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, pane.fontSize + delta));
  if (next === pane.fontSize) return;
  pane.fontSize = next;
  pane.term.options.fontSize = next;
  try { pane.fit.fit(); } catch {}
  sendResize(pane);
}

document.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  e.stopPropagation();
  const ap = getActivePane();
  if (!ap) return;
  adjustFontSize(ap.pane, e.deltaY > 0 ? -1 : 1);
}, { capture: true, passive: false });

// ---------- Clipboard ----------
async function copyActiveSelection(): Promise<boolean> {
  const ap = getActivePane();
  if (!ap) return false;
  const sel = ap.pane.term.getSelection();
  if (!sel) return false;
  try {
    await navigator.clipboard.writeText(sel);
    return true;
  } catch {
    return false;
  }
}

function sendTextToActivePty(text: string) {
  const ap = getActivePane();
  if (!ap || !text) return;
  const bytes = Array.from(new TextEncoder().encode(text));
  if (ap.tab.broadcast) {
    for (const p of ap.tab.panes) {
      if (!p.exited) void invoke("pty_write", { terminalId: p.id, data: bytes });
    }
  } else if (!ap.pane.exited) {
    void invoke("pty_write", { terminalId: ap.pane.id, data: bytes });
  }
}

// Ctrl+V / Ctrl+Shift+V / 우클릭 붙여넣기 공통 경로.
// 1차: clipboard API (navigator.clipboard.readText)
// 2차 fallback: 숨긴 textarea에 execCommand("paste") 해서 paste 이벤트 유도 → clipboardData 추출
async function pasteToActive() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    await new Promise<void>((resolve) => {
      const ta = document.createElement("textarea");
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none;top:0;left:0;width:0;height:0";
      document.body.appendChild(ta);
      ta.addEventListener("paste", (pe) => {
        pe.preventDefault();
        text = pe.clipboardData?.getData("text/plain") ?? "";
        ta.remove();
        resolve();
      }, { once: true });
      ta.focus();
      if (!document.execCommand("paste")) { ta.remove(); resolve(); }
    });
  }
  sendTextToActivePty(text);
}

// ---------- Scrollback 검색 (Ctrl+F) ----------
// 활성 pane 위에 떠 있는 작은 find bar. pane 하나당 하나만 뜨고,
// 다른 pane에서 다시 열면 이전 것은 정리한다.
interface FindBar {
  el: HTMLElement;
  input: HTMLInputElement;
  countEl: HTMLElement;
  paneId: string;
  // onDidChangeResults 구독. 닫을 때 반드시 끊어야 한다 —
  // 안 그러면 find bar를 열 때마다 같은 pane에 구독이 쌓인다.
  resultsSub: { dispose(): void };
}
let findBar: FindBar | null = null;

function searchDecorations() {
  const accent = currentTheme.ui.accent;
  return {
    matchBackground: currentTheme.ui.bg4,
    matchOverviewRuler: accent,
    activeMatchBackground: accent,
    activeMatchColorOverviewRuler: accent,
  };
}

function runFind(dir: 1 | -1) {
  if (!findBar) return;
  const r = findPane(findBar.paneId);
  if (!r) { closeFind(); return; }
  const term = findBar.input.value;
  if (!term) { r.pane.search.clearDecorations(); findBar.countEl.textContent = ""; return; }
  const opts = { decorations: searchDecorations(), incremental: dir === 1 };
  if (dir === 1) r.pane.search.findNext(term, opts);
  else r.pane.search.findPrevious(term, { ...opts, incremental: false });
}

function closeFind(refocus = true) {
  if (!findBar) return;
  const r = findPane(findBar.paneId);
  r?.pane.search.clearDecorations();
  findBar.resultsSub.dispose();
  findBar.el.remove();
  const paneId = findBar.paneId;
  findBar = null;
  if (refocus) findPane(paneId)?.pane.term.focus();
}

// pane이 닫히거나 탭이 바뀔 때 남은 find bar를 치운다.
function closeFindIfPane(paneId: string) {
  if (findBar && findBar.paneId === paneId) closeFind(false);
}

function openFind() {
  const ap = getActivePane();
  if (!ap) return;
  // 이미 같은 pane에 열려 있으면 입력만 다시 잡는다.
  if (findBar && findBar.paneId === ap.pane.id) { findBar.input.select(); findBar.input.focus(); return; }
  closeFind(false);

  const el = document.createElement("div");
  el.className = "find-bar";
  el.innerHTML = `
    <input class="find-input" type="text" placeholder="검색" spellcheck="false" />
    <span class="find-count"></span>
    <button class="find-btn find-prev" title="이전 (Shift+Enter)">&#8593;</button>
    <button class="find-btn find-next" title="다음 (Enter)">&#8595;</button>
    <button class="find-btn find-close" title="닫기 (Esc)">${CLOSE_SVG}</button>
  `;
  ap.pane.paneEl.appendChild(el);

  const input = el.querySelector(".find-input") as HTMLInputElement;
  const countEl = el.querySelector(".find-count") as HTMLElement;
  const resultsSub = ap.pane.search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (!findBar || findBar.paneId !== ap.pane.id) return;
    findBar.countEl.textContent = resultCount === 0
      ? (findBar.input.value ? "결과 없음" : "")
      : `${resultIndex + 1}/${resultCount}`;
  });
  findBar = { el, input, countEl, paneId: ap.pane.id, resultsSub };

  // 선택된 텍스트가 있으면 검색어로 미리 채운다.
  if (ap.pane.term.hasSelection()) {
    const sel = ap.pane.term.getSelection();
    if (sel && !sel.includes("\n")) input.value = sel;
  }

  input.addEventListener("input", () => runFind(1));
  // 검색창 안에서는 앱 단축키가 아니라 검색 조작이 우선이다.
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); runFind(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
  }, { capture: true });

  el.querySelector(".find-prev")!.addEventListener("click", () => runFind(-1));
  el.querySelector(".find-next")!.addEventListener("click", () => runFind(1));
  el.querySelector(".find-close")!.addEventListener("click", () => closeFind());

  input.select();
  input.focus();
  if (input.value) runFind(1);
}

function hasSelectionInActivePane(): boolean {
  const ap = getActivePane();
  return !!ap && ap.pane.term.hasSelection();
}

// ---------- Keyboard shortcuts ----------
function isOurShortcut(e: KeyboardEvent): boolean {
  if (e.ctrlKey && e.shiftKey && e.code === "Digit5") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyW") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyB") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyC") return true;
  if (e.ctrlKey && e.shiftKey && e.code === "KeyV") return true;
  if (e.ctrlKey && e.shiftKey && e.key === "Enter") return true;
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC" && hasSelectionInActivePane()) return true;
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyV") return true;
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true;
  if (e.ctrlKey && !e.altKey && e.code === "KeyF") return true;
  // F12를 xterm이 PTY로 흘려보내지 않게 막는다.
  if (e.key === "F12") return true;
  return false;
}

function handleShortcut(e: KeyboardEvent): boolean {
  if (e.ctrlKey && e.shiftKey && e.code === "Digit5") {
    e.preventDefault();
    if (e.altKey) openSessionPickerForSplit();
    else splitActiveSameSession();
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyW") {
    e.preventDefault();
    const ap = getActivePane();
    if (ap) void closePane(ap.pane.id);
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    toggleZoomActive();
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyB") {
    e.preventDefault();
    toggleBroadcastActive();
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
    e.preventDefault();
    void copyActiveSelection();
    return true;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
    e.preventDefault();
    void pasteToActive();
    return true;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC" && hasSelectionInActivePane()) {
    e.preventDefault();
    void copyActiveSelection().then((ok) => {
      if (ok) getActivePane()?.pane.term.clearSelection();
    });
    return true;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyV") {
    e.preventDefault();
    void pasteToActive();
    return true;
  }
  if (e.ctrlKey && !e.altKey && e.code === "KeyF") {
    e.preventDefault();
    openFind();
    return true;
  }
  if (e.key === "F12") {
    e.preventDefault();
    void invoke("toggle_devtools");
    return true;
  }
  if (e.altKey && e.shiftKey && !e.ctrlKey) {
    if (e.key === "ArrowLeft") { e.preventDefault(); resizeActiveDivider(-0.03); return true; }
    if (e.key === "ArrowRight") { e.preventDefault(); resizeActiveDivider(+0.03); return true; }
  }
  if (e.altKey && !e.shiftKey && !e.ctrlKey) {
    if (e.key === "ArrowLeft") { e.preventDefault(); focusAdjacentPane(-1); return true; }
    if (e.key === "ArrowRight") { e.preventDefault(); focusAdjacentPane(+1); return true; }
  }
  return false;
}

// Run in capture phase so we beat xterm's own handlers.
// 단, IME 조합 중에는 손대지 않는다: 조합 중에도 e.code는 물리 키 그대로라
// 단축키로 오인해 preventDefault()를 부르면 한글 조합이 깨진다.
document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  // 진짜 입력 필드(find bar, 세션 피커 검색창 등)에 포커스가 있으면 손대지 않는다.
  // 안 그러면 Ctrl+V가 입력창이 아니라 PTY로 가버린다.
  // xterm의 숨은 textarea는 예외 — 그건 터미널 입력이므로 단축키가 적용돼야 한다.
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")
        && !t.classList.contains("xterm-helper-textarea")) return;
  handleShortcut(e);
}, { capture: true });

// ---------- Tab DnD (reorder within tab bar + drag-out for detach/merge) ----------
let dragSrcTabEl: HTMLElement | null = null;

tabsEl.addEventListener("dragstart", (e) => {
  const t = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (!t || !tabsEl.contains(t)) return;
  dragSrcTabEl = t;
  t.classList.add("tab-dragging");
  e.dataTransfer?.setData("text/plain", t.dataset.tabId || "");
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
});

tabsEl.addEventListener("dragend", (e) => {
  if (!dragSrcTabEl) return;
  const srcEl = dragSrcTabEl;
  const srcTabId = srcEl.dataset.tabId;
  srcEl.classList.remove("tab-dragging");
  dragSrcTabEl = null;
  tabsEl.querySelectorAll(".tab-drop-before,.tab-drop-after").forEach(el =>
    el.classList.remove("tab-drop-before", "tab-drop-after"));
  clearSplitDropZones();
  if (srcTabId && e.dataTransfer?.dropEffect === "none") {
    void dropTab(srcTabId, e.screenX, e.screenY);
  }
});

function computeInsertBeforeTab(clientX: number): HTMLElement | null {
  for (const child of Array.from(tabsEl.children) as HTMLElement[]) {
    if (child === dragSrcTabEl) continue;
    const rect = child.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return child;
  }
  return null;
}

tabsEl.addEventListener("dragover", (e) => {
  if (!dragSrcTabEl) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  tabsEl.querySelectorAll(".tab-drop-before,.tab-drop-after").forEach(el =>
    el.classList.remove("tab-drop-before", "tab-drop-after"));
  const hoverTab = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (hoverTab === dragSrcTabEl) return;
  const insertBefore = computeInsertBeforeTab(e.clientX);
  if (insertBefore) {
    insertBefore.classList.add("tab-drop-before");
  } else {
    const nonSrc = (Array.from(tabsEl.children) as HTMLElement[]).filter(el => el !== dragSrcTabEl);
    const last = nonSrc[nonSrc.length - 1];
    if (last) last.classList.add("tab-drop-after");
  }
});

tabsEl.addEventListener("drop", (e) => {
  if (!dragSrcTabEl) return;
  e.preventDefault();
  const insertBefore = computeInsertBeforeTab(e.clientX);
  if (insertBefore) tabsEl.insertBefore(dragSrcTabEl, insertBefore);
  else tabsEl.appendChild(dragSrcTabEl);
});

// ---------- Tab → another tab's panes-wrap (split drop) ----------

function clearSplitDropZones() {
  document.querySelectorAll(".drop-zone-left,.drop-zone-right").forEach(el =>
    el.classList.remove("drop-zone-left", "drop-zone-right"));
}

termsEl.addEventListener("dragover", (e) => {
  if (!dragSrcTabEl) return;
  const wrap = (e.target as HTMLElement).closest(".panes-wrap") as HTMLElement | null;
  if (!wrap) return;
  const targetTabId = wrap.dataset.tabId!;
  const srcTabId = dragSrcTabEl.dataset.tabId;
  if (!srcTabId || srcTabId === targetTabId) return;
  const source = tabs.get(srcTabId);
  const target = tabs.get(targetTabId);
  if (!source || !target) return;
  if (target.panes.length + source.panes.length > MAX_PANES_PER_TAB) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  clearSplitDropZones();
  const rect = wrap.getBoundingClientRect();
  const isLeft = e.clientX < rect.left + rect.width / 2;
  wrap.classList.add(isLeft ? "drop-zone-left" : "drop-zone-right");
});

termsEl.addEventListener("dragleave", () => {
  // only clear if we're leaving the whole terms area
});

termsEl.addEventListener("drop", (e) => {
  if (!dragSrcTabEl) return;
  const wrap = (e.target as HTMLElement).closest(".panes-wrap") as HTMLElement | null;
  if (!wrap) return;
  const targetTabId = wrap.dataset.tabId!;
  const srcTabId = dragSrcTabEl.dataset.tabId;
  if (!srcTabId || srcTabId === targetTabId) return;
  const source = tabs.get(srcTabId);
  const target = tabs.get(targetTabId);
  if (!source || !target) return;
  if (target.panes.length + source.panes.length > MAX_PANES_PER_TAB) return;
  e.preventDefault();
  clearSplitDropZones();
  const rect = wrap.getBoundingClientRect();
  const isLeft = e.clientX < rect.left + rect.width / 2;
  if (isLeft) {
    let at = 0;
    while (source.panes.length > 0) {
      movePaneAcrossTabs(source, 0, target, at);
      at++;
    }
  } else {
    while (source.panes.length > 0) {
      movePaneAcrossTabs(source, 0, target, target.panes.length);
    }
  }
  setActiveTab(target.id);
});

async function dropTab(tabId: string, screenX: number, screenY: number) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  // For v1 scope: only drag tabs with a single pane across windows — multi-pane tabs
  // are moved/detached whole with the panes intact.
  const primary = tab.panes[tab.panes.length > 0 ? 0 : 0];
  if (!primary) return;
  // Serialize currently focused pane's content (just the focused one for now)
  const fp = tab.panes.find(p => p.id === tab.focusedPaneId) ?? primary;
  const content = fp.serialize.serialize();
  let moved: boolean;
  try {
    moved = await invoke<boolean>("drop_tab", {
      sourceLabel: myLabel,
      terminalId: fp.id,
      title: fp.baseTitle,
      sshArgs: fp.sshArgs,
      cwd: fp.cwd,
      initialContent: content,
      screenX, screenY,
      isLastTab: tabs.size === 1,
    });
  } catch {
    return;
  }
  if (!moved) return;
  // The PTY fp.id is now adopted elsewhere; remove its pane locally (keep other panes)
  const r = findPane(fp.id);
  if (!r) return;
  const { tab: t, pane, index } = r;
  pane.term.dispose();
  t.panes.splice(index, 1);
  t.ratios.splice(index, 1);
  if (t.panes.length === 0) {
    await closeTab(t.id);
  } else {
    normalizeRatios(t);
    if (t.focusedPaneId === fp.id) t.focusedPaneId = t.panes[Math.min(index, t.panes.length - 1)].id;
    if (t.zoomedPaneId === fp.id) t.zoomedPaneId = null;
    renderTabLayout(t);
    applyFocusStyles(t);
  }
}

// ---------- merge-tab event (from another window) ----------
listen<MergeTabPayload>("merge-tab", async (event) => {
  const p = event.payload;
  await addTab({
    terminal_id: p.terminal_id,
    title: p.title,
    ssh_args: p.ssh_args,
    cwd: p.cwd ?? null,
    adopt: true,
    initial_content: p.initial_content,
  });
  await getCurrentWindow().setFocus();
}, scoped);

// ---------- add-tab (create tab in this window) ----------
listen<AddTabPayload>("add-tab", (event) => {
  void addTab(event.payload);
}, scoped);

// ---------- Context menus ----------
interface MenuItem { label: string; action: () => void; danger?: boolean; }

function showContextMenu(x: number, y: number, items: MenuItem[]) {
  document.querySelectorAll(".ctx-menu").forEach(el => el.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.innerHTML = items.map((it, i) =>
    it.label === "-"
      ? `<div class="ctx-sep"></div>`
      : `<div class="ctx-item ${it.danger ? "ctx-item-danger" : ""}" data-idx="${i}">${it.label}</div>`
  ).join("");
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  let adjX = x, adjY = y;
  if (rect.right > window.innerWidth) adjX = Math.max(4, window.innerWidth - rect.width - 4);
  if (rect.bottom > window.innerHeight) adjY = Math.max(4, window.innerHeight - rect.height - 4);
  menu.style.left = adjX + "px";
  menu.style.top = adjY + "px";
  menu.style.visibility = "";

  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("blur", close);
  };
  const outside = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node)) close(); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") close(); };

  menu.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest(".ctx-item") as HTMLElement | null;
    if (!el) return;
    const idx = Number(el.dataset.idx);
    close();
    items[idx]?.action();
  });
  setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  document.addEventListener("keydown", onKey);
  window.addEventListener("blur", close);
}

// Tab button right-click menu
tabsEl.addEventListener("contextmenu", (e) => {
  const tabEl = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (!tabEl) return;
  e.preventDefault();
  e.stopPropagation();
  const tabId = tabEl.dataset.tabId!;
  const tab = tabs.get(tabId);
  if (!tab) return;
  const ap = tab.panes.find(p => p.id === tab.focusedPaneId) ?? tab.panes[0];
  const items: MenuItem[] = [];
  if (ap && ap.sshArgs.length > 0) {
    items.push({ label: "같은 창에 탭 복제", action: () => void duplicateFromPane(ap, false) });
    items.push({ label: "새 창에 탭 복제", action: () => void duplicateFromPane(ap, true) });
    items.push({ label: "-", action: () => {} });
    items.push({ label: "세로로 분할 (같은 세션)", action: () => { setActiveTab(tabId); splitActiveSameSession(); } });
    items.push({ label: "세로로 분할 (다른 세션...)", action: () => { setActiveTab(tabId); openSessionPickerForSplit(); } });
    items.push({ label: "-", action: () => {} });
  }
  items.push({ label: tab.broadcast ? "브로드캐스트 OFF" : "브로드캐스트 ON", action: () => { setActiveTab(tabId); toggleBroadcastActive(); } });
  items.push({ label: "-", action: () => {} });
  items.push({ label: "탭 닫기", action: () => void closeTab(tabId), danger: true });
  showContextMenu(e.clientX, e.clientY, items);
});

// Pane header right-click menu
termsEl.addEventListener("contextmenu", (e) => {
  const header = (e.target as HTMLElement).closest(".pane-header") as HTMLElement | null;
  const xtermArea = (e.target as HTMLElement).closest(".pane-xterm") as HTMLElement | null;
  const paneEl = (header ?? xtermArea)?.closest(".term-pane") as HTMLElement | null;
  if (!paneEl) return;
  e.preventDefault();
  e.stopPropagation();
  const paneId = paneEl.dataset.paneId!;
  const r = findPane(paneId);
  if (!r) return;
  const { tab, pane } = r;
  setActiveTab(tab.id);
  tab.focusedPaneId = paneId;
  applyFocusStyles(tab);
  const items: MenuItem[] = [];
  if (xtermArea) {
    const hasSel = pane.term.hasSelection();
    items.push({
      label: hasSel ? "복사" : "복사 (선택 없음)",
      action: () => { void copyActiveSelection().then((ok) => { if (ok) pane.term.clearSelection(); }); },
    });
    items.push({ label: "붙여넣기", action: () => void pasteToActive() });
    items.push({ label: "-", action: () => {} });
  }
  if (tab.panes.length < MAX_PANES_PER_TAB && pane.sshArgs.length > 0) {
    items.push({ label: "세로로 분할 (같은 세션)", action: () => splitActiveSameSession() });
    items.push({ label: "세로로 분할 (다른 세션...)", action: () => openSessionPickerForSplit() });
    items.push({ label: "-", action: () => {} });
  }
  items.push({ label: tab.zoomedPaneId === paneId ? "전체화면 해제" : "전체화면", action: () => toggleZoomForPane(tab, paneId) });
  items.push({ label: "-", action: () => {} });
  items.push({ label: "pane 닫기", action: () => void closePane(paneId), danger: true });
  showContextMenu(e.clientX, e.clientY, items);
});

// ---------- Duplicate (from any pane) ----------
async function duplicateFromPane(pane: Pane, newWindow: boolean) {
  if (!pane.sshArgs.length) return;
  try {
    await invoke("spawn_terminal", {
      sshArgs: pane.sshArgs,
      cwd: pane.cwd,
      title: pane.baseTitle,
      newWindow,
      sourceLabel: myLabel,
    });
  } catch (e) { console.error("duplicate failed", e); }
}

// ---------- Session picker for split (different session) ----------
interface SessionOption { title: string; ssh_args: string[]; }

async function openSessionPickerForSplit() {
  const ap = getActivePane();
  if (!ap) return;
  if (ap.tab.panes.length >= MAX_PANES_PER_TAB) return;

  // Fetch the session tree
  let data: any;
  try { data = await invoke("get_all_data"); }
  catch { return; }

  const overlay = document.createElement("div");
  overlay.className = "picker-overlay";
  overlay.innerHTML = `
    <div class="picker-modal">
      <div class="picker-header">
        <span class="picker-title">다른 세션으로 분할</span>
        <button class="picker-close" title="닫기">${CLOSE_SVG}</button>
      </div>
      <input class="picker-search" type="text" placeholder="검색..." autofocus />
      <div class="picker-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector(".picker-list") as HTMLElement;
  const searchEl = overlay.querySelector(".picker-search") as HTMLInputElement;

  const folderOf = (id: string | null) => {
    if (!id) return "미분류";
    return (data.folders ?? []).find((f: any) => f.id === id)?.name ?? "미분류";
  };

  const renderList = (q: string) => {
    const query = q.toLowerCase();
    const sessions = (data.sessions ?? [])
      .slice()
      .sort((a: any, b: any) => a.order - b.order)
      .filter((s: any) => !query
        || s.name.toLowerCase().includes(query)
        || s.host.toLowerCase().includes(query)
        || folderOf(s.folder_id).toLowerCase().includes(query));
    if (sessions.length === 0) {
      listEl.innerHTML = `<div class="picker-empty">결과 없음</div>`;
      return;
    }
    listEl.innerHTML = sessions.map((s: any) => `
      <div class="picker-item" data-session-id="${s.id}">
        <div class="picker-item-folder">${folderOf(s.folder_id)}</div>
        <div class="picker-item-name">${escapeHtml(s.name)}</div>
        <div class="picker-item-host">${escapeHtml(s.user)}@${escapeHtml(s.host)}:${s.port}</div>
      </div>
    `).join("");
  };

  const escapeHtml = (s: string) => {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  };

  const close = () => overlay.remove();
  overlay.querySelector(".picker-close")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  searchEl.addEventListener("input", () => renderList(searchEl.value));

  listEl.addEventListener("click", async (e) => {
    const el = (e.target as HTMLElement).closest(".picker-item") as HTMLElement | null;
    if (!el) return;
    const id = el.dataset.sessionId!;
    close();
    try {
      const resp = await invoke<SessionOption>("get_ssh_args_for_session", { id });
      const ap2 = getActivePane();
      if (!ap2) return;
      await splitTab(ap2.tab, ap2.pane, resp.ssh_args, stripSuffix(resp.title));
    } catch (err) { console.error("split session failed", err); }
  });

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);

  renderList("");
  setTimeout(() => searchEl.focus(), 0);
}

// ---------- Pane DnD (drag from header) ----------
let dragSrcPane: { tabId: string; paneId: string; el: HTMLElement } | null = null;

termsEl.addEventListener("dragstart", (e) => {
  const header = (e.target as HTMLElement).closest(".pane-header") as HTMLElement | null;
  if (!header) return;
  const paneEl = header.closest(".term-pane") as HTMLElement;
  const r = findPane(paneEl.dataset.paneId!);
  if (!r) return;
  dragSrcPane = { tabId: r.tab.id, paneId: r.pane.id, el: paneEl };
  paneEl.classList.add("pane-dragging");
  e.dataTransfer?.setData("text/plain", r.pane.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
});

termsEl.addEventListener("dragend", (e) => {
  if (!dragSrcPane) return;
  const { paneId, el } = dragSrcPane;
  el.classList.remove("pane-dragging");
  const effect = e.dataTransfer?.dropEffect ?? "none";
  dragSrcPane = null;
  document.querySelectorAll(".pane-drop-before,.pane-drop-after").forEach(el =>
    el.classList.remove("pane-drop-before", "pane-drop-after"));
  tabsEl.querySelectorAll(".tab-pane-drop").forEach(el => el.classList.remove("tab-pane-drop"));
  // Dropped with no accepted handler → detach. Inside our window's tab bar empty
  // area becomes "extract to new tab"; otherwise (outside webview) we ask Rust to
  // merge-or-create-new-window just like a tab drag-out.
  if (effect === "none") {
    void detachPane(paneId, e.screenX, e.screenY);
  }
});

async function detachPane(paneId: string, screenX: number, screenY: number) {
  const r = findPane(paneId);
  if (!r) return;
  const { tab, pane, index } = r;

  // Outside window → Rust decides: merge into another term window or new window.
  // (Drops inside this window's tab bar empty area are handled separately by the
  //  tabsEl drop handler and won't reach here because that handler accepts the drop.)
  const content = pane.serialize.serialize();
  let moved = false;
  try {
    moved = await invoke<boolean>("drop_tab", {
      sourceLabel: myLabel,
      terminalId: paneId,
      title: pane.baseTitle,
      sshArgs: pane.sshArgs,
      cwd: pane.cwd,
      initialContent: content,
      screenX, screenY,
      isLastTab: tab.panes.length === 1 && tabs.size === 1,
    });
  } catch {}
  if (!moved) return;
  pane.term.dispose();
  tab.panes.splice(index, 1);
  tab.ratios.splice(index, 1);
  if (tab.panes.length === 0) {
    await closeTab(tab.id);
  } else {
    normalizeRatios(tab);
    if (tab.focusedPaneId === paneId) {
      tab.focusedPaneId = tab.panes[Math.min(index, tab.panes.length - 1)].id;
    }
    if (tab.zoomedPaneId === paneId) tab.zoomedPaneId = null;
    renderTabLayout(tab);
    applyFocusStyles(tab);
  }
}

function extractPaneToNewTab(srcTab: Tab, srcIdx: number) {
  const pane = srcTab.panes[srcIdx];
  if (!pane) return;
  // Create a fresh tab hosting this pane.
  pane.paneEl.remove();
  srcTab.panes.splice(srcIdx, 1);
  srcTab.ratios.splice(srcIdx, 1);
  normalizeRatios(srcTab);
  if (srcTab.focusedPaneId === pane.id) {
    srcTab.focusedPaneId = srcTab.panes[Math.min(srcIdx, srcTab.panes.length - 1)].id;
  }
  if (srcTab.zoomedPaneId === pane.id) srcTab.zoomedPaneId = null;
  // Sync tab button title when collapsing back to a single pane
  if (srcTab.panes.length === 1) {
    (srcTab.tabBtnEl.querySelector(".tab-title") as HTMLElement).textContent = srcTab.panes[0].title;
  }
  renderTabLayout(srcTab);
  applyFocusStyles(srcTab);

  // Build a new tab around the extracted pane
  const newTabId = uid();
  const tabBtnEl = document.createElement("div");
  tabBtnEl.className = "tab";
  tabBtnEl.dataset.tabId = newTabId;
  tabBtnEl.draggable = true;
  tabBtnEl.innerHTML = `
    <span class="tab-broadcast" title="broadcast"></span>
    <span class="tab-title"></span>
    <span class="tab-close" title="닫기">${CLOSE_SVG}</span>
  `;
  (tabBtnEl.querySelector(".tab-title") as HTMLElement).textContent = pane.title;
  tabsEl.appendChild(tabBtnEl);

  const panesWrapEl = document.createElement("div");
  panesWrapEl.className = "panes-wrap";
  panesWrapEl.dataset.tabId = newTabId;
  termsEl.appendChild(panesWrapEl);

  const newTab: Tab = {
    id: newTabId, tabBtnEl, panesWrapEl,
    panes: [pane], ratios: [1],
    focusedPaneId: pane.id,
    zoomedPaneId: null, broadcast: false,
  };
  tabs.set(newTabId, newTab);

  tabBtnEl.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    setActiveTab(newTabId);
  });
  tabBtnEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
    e.stopPropagation();
    void closeTab(newTabId);
  });
  tabBtnEl.addEventListener("auxclick", (e) => {
    if ((e as MouseEvent).button === 1) void closeTab(newTabId);
  });

  setActiveTab(newTabId);
}

termsEl.addEventListener("dragover", (e) => {
  if (!dragSrcPane) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".pane-drop-before,.pane-drop-after").forEach(el =>
    el.classList.remove("pane-drop-before", "pane-drop-after"));
  const hoverPane = (e.target as HTMLElement).closest(".term-pane") as HTMLElement | null;
  if (!hoverPane) return;
  if (hoverPane === dragSrcPane.el) return;
  const rect = hoverPane.getBoundingClientRect();
  const before = e.clientX < rect.left + rect.width / 2;
  hoverPane.classList.add(before ? "pane-drop-before" : "pane-drop-after");
});

termsEl.addEventListener("drop", (e) => {
  if (!dragSrcPane) return;
  e.preventDefault();
  const hoverPane = (e.target as HTMLElement).closest(".term-pane") as HTMLElement | null;
  if (!hoverPane || hoverPane === dragSrcPane.el) return;
  const targetPaneId = hoverPane.dataset.paneId!;
  const srcR = findPane(dragSrcPane.paneId);
  const dstR = findPane(targetPaneId);
  if (!srcR || !dstR) return;
  const before = (() => {
    const rect = hoverPane.getBoundingClientRect();
    return e.clientX < rect.left + rect.width / 2;
  })();
  if (srcR.tab === dstR.tab) {
    // same tab: reorder
    const t = srcR.tab;
    const srcIdx = srcR.index;
    const dstIdx = dstR.index + (before ? 0 : 1);
    const adjusted = dstIdx > srcIdx ? dstIdx - 1 : dstIdx;
    if (adjusted === srcIdx) return;
    const [movedPane] = t.panes.splice(srcIdx, 1);
    const [movedRatio] = t.ratios.splice(srcIdx, 1);
    t.panes.splice(adjusted, 0, movedPane);
    t.ratios.splice(adjusted, 0, movedRatio);
    renderTabLayout(t);
  } else {
    // different tab: move (respect 3-pane cap in destination)
    if (dstR.tab.panes.length >= MAX_PANES_PER_TAB) return;
    movePaneAcrossTabs(srcR.tab, srcR.index, dstR.tab, dstR.index + (before ? 0 : 1));
  }
});

// Pane drag over tabsEl: accept on tab buttons (merge) OR empty area (extract-to-new-tab)
tabsEl.addEventListener("dragover", (e) => {
  if (!dragSrcPane) return;
  const tabBtn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (tabBtn) {
    const tid = tabBtn.dataset.tabId!;
    if (tid === dragSrcPane.tabId) return;
    const target = tabs.get(tid);
    if (!target || target.panes.length >= MAX_PANES_PER_TAB) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    tabBtn.classList.add("tab-pane-drop");
    tabsEl.classList.remove("tab-bar-drop-empty");
    return;
  }
  // Empty tab bar area → will extract into a new tab (only makes sense for multi-pane tabs)
  const srcR = findPane(dragSrcPane.paneId);
  if (!srcR || srcR.tab.panes.length <= 1) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  tabsEl.classList.add("tab-bar-drop-empty");
  tabsEl.querySelectorAll(".tab-pane-drop").forEach(el => el.classList.remove("tab-pane-drop"));
});

tabsEl.addEventListener("dragleave", (e) => {
  const tabBtn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (tabBtn) tabBtn.classList.remove("tab-pane-drop");
  // If we left tabsEl entirely, clear the empty-area indicator
  if (!tabsEl.contains(e.relatedTarget as Node)) {
    tabsEl.classList.remove("tab-bar-drop-empty");
  }
});

tabsEl.addEventListener("drop", (e) => {
  if (!dragSrcPane) return;
  const srcR = findPane(dragSrcPane.paneId);
  if (!srcR) return;
  const tabBtn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
  if (tabBtn) {
    const tid = tabBtn.dataset.tabId!;
    if (tid === dragSrcPane.tabId) return;
    const dst = tabs.get(tid);
    if (!dst || dst.panes.length >= MAX_PANES_PER_TAB) return;
    e.preventDefault();
    tabBtn.classList.remove("tab-pane-drop");
    movePaneAcrossTabs(srcR.tab, srcR.index, dst, dst.panes.length);
    return;
  }
  // Empty area → extract pane to new tab (single-pane tabs bail)
  if (srcR.tab.panes.length <= 1) return;
  e.preventDefault();
  tabsEl.classList.remove("tab-bar-drop-empty");
  extractPaneToNewTab(srcR.tab, srcR.index);
});

function movePaneAcrossTabs(srcTab: Tab, srcIdx: number, dstTab: Tab, dstIdx: number) {
  const pane = srcTab.panes[srcIdx];
  if (!pane) return;
  // Remove from src DOM
  pane.paneEl.remove();
  srcTab.panes.splice(srcIdx, 1);
  srcTab.ratios.splice(srcIdx, 1);
  if (srcTab.panes.length === 0) {
    // If this tab was the active tab drag source, reset the reference before removing it
    // from the DOM — otherwise stale dragSrcTabEl causes ghost tabs when a pane-drag
    // later drops on the same tabsEl (both drop handlers fire).
    if (dragSrcTabEl?.dataset.tabId === srcTab.id) dragSrcTabEl = null;
    void closeTab(srcTab.id);
  } else {
    normalizeRatios(srcTab);
    if (srcTab.focusedPaneId === pane.id) srcTab.focusedPaneId = srcTab.panes[Math.min(srcIdx, srcTab.panes.length - 1)].id;
    if (srcTab.zoomedPaneId === pane.id) srcTab.zoomedPaneId = null;
    if (srcTab.panes.length === 1) {
      (srcTab.tabBtnEl.querySelector(".tab-title") as HTMLElement).textContent = srcTab.panes[0].title;
    }
    renderTabLayout(srcTab);
    applyFocusStyles(srcTab);
  }
  // Insert into dst. Pane event handlers resolve their current tab via findPane()
  // at call time, so no rewiring is needed after a move.
  dstTab.panes.splice(dstIdx, 0, pane);
  // Rename only on actual collision within the destination tab
  if (dstTab.panes.filter(p => p.title === pane.title).length > 1) {
    pane.title = chooseTitle(pane.baseTitle);
    (pane.headerEl.querySelector(".pane-header-title") as HTMLElement).textContent = pane.title;
  }
  const share = 1 / (dstTab.panes.length);
  dstTab.ratios = dstTab.panes.map(() => share);
  dstTab.focusedPaneId = pane.id;
  renderTabLayout(dstTab);
  applyFocusStyles(dstTab);
  setActiveTab(dstTab.id);
}

// ---------- Window close: kill all PTYs ----------
// Unlike closeTab, this one must actually wait: destroy() on the last window
// exits the process, and a half-finished kill would leave a claude.exe orphan.
// The kills run in parallel in the backend, but a tree can still take a beat,
// so show an overlay if it does not finish promptly.
function showClosingOverlay(): () => void {
  const el = document.createElement("div");
  el.className = "closing-overlay";
  el.innerHTML = `<div class="closing-spinner"></div><div>세션 정리 중…</div>`;
  // Delay the paint: most closes finish fast enough that flashing an overlay
  // would look worse than a brief pause.
  const timer = window.setTimeout(() => document.body.appendChild(el), 150);
  return () => { window.clearTimeout(timer); el.remove(); };
}

getCurrentWindow().onCloseRequested(async (event) => {
  if (tabs.size === 0) return;
  event.preventDefault();
  const ids: string[] = [];
  for (const tab of tabs.values()) for (const p of tab.panes) ids.push(p.id);
  tabs.clear();
  const hideOverlay = showClosingOverlay();
  try { await invoke("pty_kill_many", { terminalIds: ids }); } catch {}
  hideOverlay();
  await getCurrentWindow().destroy();
});

// ---------- Window resize ----------
let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const t = getActiveTab();
    if (!t) return;
    for (const p of t.panes) {
      if (!p.exited) {
        try { p.fit.fit(); } catch {}
        sendResize(p);
      }
    }
  }, 50);
});

// ---------- Container resize (sidebar drag / tab-bar show-hide / etc.) ----------
// Window resize listener above only fires on OS window size changes. When the
// sidebar is resized or toggled, #terminals changes width but the window stays
// the same. Use a ResizeObserver on #terminals so xterm refits as its
// container width/height changes.
let containerResizeTimer: number | undefined;
const containerObserver = new ResizeObserver(() => {
  if (containerResizeTimer) window.clearTimeout(containerResizeTimer);
  containerResizeTimer = window.setTimeout(() => {
    const t = getActiveTab();
    if (!t) return;
    for (const p of t.panes) {
      if (!p.exited) {
        try { p.fit.fit(); } catch {}
        sendResize(p);
      }
    }
  }, 30);
});
containerObserver.observe(termsEl);

// ---------- Bootstrap ----------
(async () => {
  try {
    const saved = await invoke<string | null>("get_terminal_theme");
    if (saved) applyThemeToAllPanes(getTheme(saved));
    const initial = await invoke<AddTabPayload | null>("pty_take_pending", { windowLabel: myLabel });
    if (initial) await addTab(initial);
  } catch (e) {
    console.error("bootstrap failed:", e);
  }
})();
