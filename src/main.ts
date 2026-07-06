import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  THEMES,
  THEME_GROUPS,
  THEME_ORDER,
  DEFAULT_THEME,
  getTheme,
  applyUiTheme,
  type TerminalTheme,
} from "./themes";

const myLabel = getCurrentWindow().label;
const IS_TERMINAL_WINDOW = myLabel.startsWith("term-");

// Block DevTools shortcuts + status-bar toggle (Ctrl+Shift+B).
window.addEventListener(
  "keydown",
  (e) => {
    const k = e.key;
    if (k === "F12") { e.preventDefault(); e.stopPropagation(); return; }
    if (e.ctrlKey && e.shiftKey && (k === "I" || k === "i" || k === "J" || k === "j" || k === "C" || k === "c")) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey && e.shiftKey && (k === "B" || k === "b")) {
      e.preventDefault();
      e.stopPropagation();
      if (!IS_TERMINAL_WINDOW) {
        setStatusBarVisible(!statusBarVisible);
      } else {
        // In term-* window, broadcast a toggle request; main will flip state + emit back.
        void emit("statusbar-toggle-request");
      }
    }
  },
  true
);

if (IS_TERMINAL_WINDOW) {
  void import("./terminal");
}

// --- Types ---

interface SessionInfo {
  session_id: string;
  first_prompt: string;
  summary: string;
  message_count: number;
  created: string;
  modified: string;
  git_branch: string;
  project_path: string;
  project_folder: string;
  labels: string[];
  custom_title: string;
  account_name?: string;
}

interface Account {
  name: string;
  config_dir?: string | null;
  alias?: string | null;
  email?: string | null;
  subscription?: string | null;
  org_name?: string | null;
  logged_in?: boolean;
}

interface AccountOauthUsage {
  account_name: string;
  alias?: string | null;
  email?: string | null;
  subscription?: string | null;
  org_name?: string | null;
  logged_in?: boolean;
  usage?: OauthUsage | null;
  error?: string | null;
}

const DEFAULT_ACCOUNT_NAME = "default";

// --- State ---

interface UsageTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  messages: number;
}
interface SessionUsage {
  session_id: string;
  model: string | null;
  totals: UsageTotals;
  duration_min: number;
  first_ts: string | null;
  last_ts: string | null;
}
interface UsageReport {
  today: UsageTotals;
  week: UsageTotals;
  all_time: UsageTotals;
  by_model_today: Record<string, UsageTotals>;
  by_model_week: Record<string, UsageTotals>;
  active_session: SessionUsage | null;
}

interface OauthQuota {
  utilization: number;
  resets_at: string | null;
}
interface OauthUsage {
  fiveHour: OauthQuota;
  sevenDay: OauthQuota;
  sevenDaySonnet: OauthQuota;
}

let allSessions: SessionInfo[] = [];
let projectLabels: Record<string, string> = {};
let favoriteSessions: Set<string> = new Set();
let lastUsageReport: UsageReport | null = null;
let lastOauthUsage: OauthUsage | null = null;
let lastOauthError: string | null = null;
let allAccounts: Account[] = [];
let labelAccountMap: Record<string, string> = {};
let sessionAccountMap: Record<string, string> = {};
let lastOauthMulti: AccountOauthUsage[] = [];
let searchQuery = "";

// Resolve the account used for a session. Priority:
// 1. explicit session→account mapping
// 2. any label→account mapping match
// 3. session_info.account_name (where its jsonl actually lives)
// 4. "default"
function resolveSessionAccountName(s: SessionInfo | undefined, sessionId?: string): string {
  const sid = sessionId || s?.session_id;
  if (sid && sessionAccountMap[sid]) return sessionAccountMap[sid];
  if (s) {
    for (const l of s.labels) {
      if (labelAccountMap[l]) return labelAccountMap[l];
    }
  }
  if (s?.account_name) return s.account_name;
  return DEFAULT_ACCOUNT_NAME;
}

function accountDisplay(acc: Account): string {
  if (acc.alias && acc.alias.trim()) return acc.alias;
  if (acc.email && acc.email.includes("@")) return acc.email.split("@")[0];
  return acc.name;
}

function accountByName(name: string): Account | undefined {
  return allAccounts.find((a) => a.name === name);
}
const COLLAPSED_STORAGE_KEY = "kc-collapsed-projects";
function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch { return new Set(); }
}
function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsedProjects]));
  } catch {}
}
let collapsedProjects = loadCollapsed();
let filterProjectLabel: string | null = null;
let filterSessionLabel: string | null = null;
let filtersPanelOpen = false;
let globalSkipPermissions = true;
let globalNewWindow = false;

// --- Sidebar layout prefs (localStorage) ---

const SIDEBAR_POSITION_KEY = "kc-sidebar-position";
const SIDEBAR_HIDDEN_KEY = "kc-sidebar-hidden";
const STATUSBAR_VISIBLE_KEY = "kc-statusbar-visible";
let statusBarVisible: boolean = localStorage.getItem(STATUSBAR_VISIBLE_KEY) !== "0"; // default on

type SidebarPosition = "left" | "right";
let sidebarPosition: SidebarPosition =
  (localStorage.getItem(SIDEBAR_POSITION_KEY) as SidebarPosition) === "right" ? "right" : "left";
let sidebarHidden: boolean = localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1";

function applySidebarLayout() {
  document.body.classList.toggle("sidebar-right", sidebarPosition === "right");
  document.body.classList.toggle("sidebar-hidden", sidebarHidden);
  document.body.classList.toggle("statusbar-hidden", !statusBarVisible);
}

function setStatusBarVisible(on: boolean) {
  statusBarVisible = on;
  localStorage.setItem(STATUSBAR_VISIBLE_KEY, on ? "1" : "0");
  applySidebarLayout();
  // Broadcast to term-* windows so they sync instantly.
  void emit("statusbar-visibility", { visible: on });
}

function setSidebarPosition(pos: SidebarPosition) {
  sidebarPosition = pos;
  localStorage.setItem(SIDEBAR_POSITION_KEY, pos);
  applySidebarLayout();
}
function toggleSidebarHidden() {
  sidebarHidden = !sidebarHidden;
  localStorage.setItem(SIDEBAR_HIDDEN_KEY, sidebarHidden ? "1" : "0");
  applySidebarLayout();
}

// --- Icons ---

const ICONS = {
  search: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
  refresh: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>`,
  edit: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/></svg>`,
  chevronDown: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>`,
  chevronRight: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>`,
  chevronLeft: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>`,
  terminal: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  newWindow: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><path d="M10 14L21 3"/></svg>`,
  folderOpen: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`,
  filter: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>`,
  tag: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  claude: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 00-3 3v2a3 3 0 106 0V5a3 3 0 00-3-3z"/><path d="M5 11a3 3 0 00-3 3v1a3 3 0 006 0v-1a3 3 0 00-3-3z"/><path d="M19 11a3 3 0 00-3 3v1a3 3 0 006 0v-1a3 3 0 00-3-3z"/><path d="M9 16h6"/><path d="M12 19v3"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  settings: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
  download: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  upload: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  star: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  starOutline: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  cpu: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`,
};

// --- Usage helpers ---

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function totalTokens(t: UsageTotals): number {
  return t.input + t.output + t.cache_read + t.cache_write;
}
function formatResetCountdown(resetsAtIso: string | null): string {
  if (!resetsAtIso) return "";
  const target = new Date(resetsAtIso).getTime();
  if (!isFinite(target)) return "";
  const diff = target - Date.now();
  if (diff <= 0) return "리셋됨";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}분 후 리셋`;
  const hours = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hours < 24) return rm > 0 ? `${hours}h ${rm}m 후 리셋` : `${hours}h 후 리셋`;
  const days = Math.floor(hours / 24);
  const rh = hours % 24;
  return rh > 0 ? `${days}d ${rh}h 후 리셋` : `${days}d 후 리셋`;
}

function formatResetClock(resetsAtIso: string | null): string {
  if (!resetsAtIso) return "";
  const d = new Date(resetsAtIso);
  if (!isFinite(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  if (isTomorrow) return `내일 ${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? `${days}일 ${remH}시간` : `${days}일`;
}

function modelDotColor(model: string | null): string {
  if (model === "sonnet") return "var(--blue)";
  if (model === "opus") return "#a78bfa";
  if (model === "haiku") return "var(--green, #22c55e)";
  return "var(--text-tertiary)";
}

function pctBar(pct: number, color: string): string {
  const clamped = Math.max(0, Math.min(100, pct));
  return `<span class="usage-bar"><span class="usage-bar-fill" style="width:${clamped}%; background:${color}"></span></span>`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return "var(--red, #ef4444)";
  if (pct >= 70) return "var(--orange, #f59e0b)";
  return "var(--accent)";
}

// Helper: per-account utilization pill. Compact, one chip per account.
function renderAccountUsageChip(a: AccountOauthUsage): string {
  const acc: Account = {
    name: a.account_name,
    alias: a.alias,
    email: a.email,
    subscription: a.subscription,
    org_name: a.org_name,
    logged_in: a.logged_in,
  };
  const display = accountDisplay(acc);
  const tipParts: string[] = [];
  if (a.email) tipParts.push(a.email);
  if (a.subscription) tipParts.push(a.subscription);
  if (a.org_name) tipParts.push(a.org_name);
  const tip = tipParts.join(" · ") || a.account_name;

  if (a.error || !a.usage) {
    const msg = a.error ? a.error : "로그인 필요";
    return `<span class="usage-account is-error" title="${escapeHtml(display + " — " + msg)}">
      <span class="usage-account-name">${escapeHtml(display)}</span>
      <span class="usage-account-err">!</span>
    </span>`;
  }

  const f = Math.round(a.usage.fiveHour.utilization);
  const w = Math.round(a.usage.sevenDay.utilization);
  const fillColor = pctColor(Math.max(f, w));
  return `<span class="usage-account" title="${escapeHtml(tip)}">
    <span class="usage-account-dot" style="background:${fillColor}"></span>
    <span class="usage-account-name">${escapeHtml(display)}</span>
    <span class="usage-account-pct">${f}%<span class="usage-account-pct-sep">/</span>${w}%</span>
  </span>`;
}

function renderUsageStatus(_report: UsageReport | null) {
  const el = document.getElementById("usage-status");
  if (!el) return;
  const report = _report;

  // Decide what to display. Prefer the multi-account data when present, fall
  // back to the legacy single-account oauth payload so we still work even
  // before the first multi-account poll fires.
  let accountChips: AccountOauthUsage[] = lastOauthMulti.length > 0
    ? lastOauthMulti
    : [];
  if (accountChips.length === 0 && lastOauthUsage) {
    const a = allAccounts[0];
    accountChips = [{
      account_name: a?.name || DEFAULT_ACCOUNT_NAME,
      alias: a?.alias,
      email: a?.email,
      subscription: a?.subscription,
      org_name: a?.org_name,
      logged_in: a?.logged_in,
      usage: lastOauthUsage,
    }];
  }

  let html = "";

  // Live session line (local jsonl-derived, updates every 3s)
  if (report?.active_session) {
    const s = report.active_session;
    const total = formatTokens(totalTokens(s.totals));
    const dot = `<span class="usage-dot" style="background:${modelDotColor(s.model)}"></span>`;
    const modelName = s.model ? s.model[0].toUpperCase() + s.model.slice(1) : "?";
    html += `<div class="usage-line usage-line-session">
      ${dot}<span class="usage-label">세션</span>
      <span class="usage-value">${total}</span>
      <span class="usage-sub">${escapeHtml(modelName)} · ${formatDuration(s.duration_min)}</span>
    </div>`;
  }

  // Multi-account rate-limit pills (compact, one per registered account).
  if (accountChips.length > 0) {
    const pills = accountChips.map(renderAccountUsageChip).join("");
    html += `<div class="usage-accounts">${pills}</div>`;
  } else if (lastOauthError) {
    html += `<div class="usage-rate-error" title="${escapeHtml(lastOauthError)}">rate limit 조회 실패</div>`;
  }

  el.innerHTML = html;
}

async function refreshUsage() {
  try {
    const report = await invoke<UsageReport>("get_usage_report");
    lastUsageReport = report;
    renderUsageStatus(report);
    renderUsagePanelIfOpen(report);
  } catch {}
}

function renderDonut(segments: { label: string; value: number; color: string }[], size = 160): string {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return `<div class="donut-empty">데이터 없음</div>`;
  const r = size / 2 - 10;
  const cx = size / 2;
  const cy = size / 2;
  const innerR = r * 0.62;
  let angle = -Math.PI / 2;
  const paths = segments.map((seg) => {
    const frac = seg.value / total;
    const delta = frac * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + delta;
    angle = a1;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const xi1 = cx + innerR * Math.cos(a1);
    const yi1 = cy + innerR * Math.sin(a1);
    const xi0 = cx + innerR * Math.cos(a0);
    const yi0 = cy + innerR * Math.sin(a0);
    const large = delta > Math.PI ? 1 : 0;
    const d = `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${innerR} ${innerR} 0 ${large} 0 ${xi0} ${yi0} Z`;
    return `<path d="${d}" fill="${seg.color}" data-label="${escapeHtml(seg.label)}" data-value="${seg.value}" class="donut-seg" />`;
  }).join("");
  return `
    <div class="donut-wrap">
      <svg class="donut-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        ${paths}
        <circle cx="${cx}" cy="${cy}" r="${innerR - 1}" fill="var(--bg-elevated)"/>
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-center-value">${formatTokens(total)}</text>
        <text x="${cx}" y="${cy + 12}" text-anchor="middle" class="donut-center-label">tokens</text>
      </svg>
      <div class="donut-legend">
        ${segments.map((s) => {
          const pct = total > 0 ? ((s.value / total) * 100).toFixed(1) : "0";
          return `<div class="donut-legend-item">
            <span class="donut-legend-dot" style="background:${s.color}"></span>
            <span class="donut-legend-label">${escapeHtml(s.label)}</span>
            <span class="donut-legend-value">${pct}%</span>
          </div>`;
        }).join("")}
      </div>
    </div>
  `;
}

function renderUsagePanelIfOpen(report?: UsageReport | null) {
  const body = document.getElementById("usage-panel-body");
  if (!body) return;
  const r = report ?? lastUsageReport;
  const oauth = lastOauthUsage;

  // --- Rate limit bars from Anthropic OAuth endpoint ---
  let oauthHtml = "";
  if (oauth) {
    const rows: [string, OauthQuota][] = [
      ["세션 (5시간)", oauth.fiveHour],
      ["주간 (전체)", oauth.sevenDay],
      ["주간 Sonnet", oauth.sevenDaySonnet],
    ];
    oauthHtml = `
      <div class="usage-ratelimit-block">
        <div class="usage-ratelimit-title">Rate Limit <span class="usage-ratelimit-source">Anthropic · /usage</span></div>
        ${rows.map(([label, q]) => `
          <div class="usage-ratelimit-row">
            <div class="usage-ratelimit-top">
              <span class="usage-ratelimit-label">${escapeHtml(label)}</span>
              <span class="usage-ratelimit-pct">${Math.round(q.utilization)}%</span>
            </div>
            <div class="usage-ratelimit-bar-big">
              <span class="usage-ratelimit-bar-fill" style="width:${Math.min(100, q.utilization)}%; background:${pctColor(q.utilization)}"></span>
            </div>
            <div class="usage-ratelimit-reset">${escapeHtml([formatResetCountdown(q.resets_at), formatResetClock(q.resets_at)].filter(Boolean).join(" · "))}</div>
          </div>
        `).join("")}
      </div>
    `;
  } else if (lastOauthError) {
    oauthHtml = `<div class="usage-ratelimit-block">
      <div class="usage-ratelimit-title">Rate Limit</div>
      <div class="usage-ratelimit-err">조회 실패: ${escapeHtml(lastOauthError)}</div>
      <div class="usage-ratelimit-hint">Claude Code 에 로그인된 상태에서만 조회됩니다. <code>~/.claude/.credentials.json</code> 확인.</div>
    </div>`;
  }

  // --- Local jsonl cards + donuts ---
  let localHtml = "";
  if (r) {
    const todayTotal = totalTokens(r.today);
    const weekTotal = totalTokens(r.week);
    const allTotal = totalTokens(r.all_time);

    const makeDonut = (byModel: Record<string, UsageTotals>) => {
      const segments = Object.entries(byModel)
        .map(([model, totals]) => ({
          label: model[0].toUpperCase() + model.slice(1),
          value: totalTokens(totals),
          color: modelDotColor(model),
        }))
        .filter((s) => s.value > 0)
        .sort((a, b) => b.value - a.value);
      return renderDonut(segments);
    };

    localHtml = `
      <div class="usage-cards">
        <div class="usage-card">
          <div class="usage-card-label">오늘</div>
          <div class="usage-card-value">${formatTokens(todayTotal)}</div>
          <div class="usage-card-sub">${r.today.messages.toLocaleString()}개 메시지</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-label">이번 주</div>
          <div class="usage-card-value">${formatTokens(weekTotal)}</div>
          <div class="usage-card-sub">${r.week.messages.toLocaleString()}개 메시지</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-label">전체</div>
          <div class="usage-card-value">${formatTokens(allTotal)}</div>
          <div class="usage-card-sub">${r.all_time.messages.toLocaleString()}개 메시지</div>
        </div>
      </div>

      <div class="usage-donuts">
        <div class="usage-donut-block">
          <div class="usage-donut-title">오늘 모델별</div>
          ${makeDonut(r.by_model_today)}
        </div>
        <div class="usage-donut-block">
          <div class="usage-donut-title">이번 주 모델별</div>
          ${makeDonut(r.by_model_week)}
        </div>
      </div>
    `;
  }

  body.innerHTML = oauthHtml + localHtml;
}

// --- Helpers ---

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return "";
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  if (diffHour < 24) return `${diffHour}시간 전`;
  if (diffDay < 30) return `${diffDay}일 전`;
  return date.toLocaleDateString("ko-KR");
}

function getProjectLabel(folder: string): string {
  return projectLabels[folder] || "";
}

function lastPathSegment(path: string): string {
  const norm = path.replace(/\\/g, "/");
  return norm.split("/").filter(Boolean).pop() || norm;
}

function getProjectDisplayName(folder: string, path: string): string {
  const label = getProjectLabel(folder);
  return label || lastPathSegment(path);
}

function getProjects(): { folder: string; path: string }[] {
  const map = new Map<string, string>();
  for (const s of allSessions) {
    if (!map.has(s.project_folder)) map.set(s.project_folder, s.project_path);
  }
  return Array.from(map.entries())
    .map(([folder, path]) => ({ folder, path }))
    .sort((a, b) => {
      const la = getProjectLabel(a.folder);
      const lb = getProjectLabel(b.folder);
      if (la && !lb) return -1;
      if (!la && lb) return 1;
      const da = la || lastPathSegment(a.path);
      const db = lb || lastPathSegment(b.path);
      return da.localeCompare(db, "ko");
    });
}

function getFoldersForProjectLabel(label: string): Set<string> {
  const folders = new Set<string>();
  for (const [folder, l] of Object.entries(projectLabels)) {
    if (l === label) folders.add(folder);
  }
  return folders;
}

function getFilteredSessions(): SessionInfo[] {
  const q = searchQuery.toLowerCase();
  return allSessions.filter((s) => {
    const projLabel = getProjectLabel(s.project_folder).toLowerCase();
    const matchesSearch =
      !q ||
      s.first_prompt.toLowerCase().includes(q) ||
      s.summary.toLowerCase().includes(q) ||
      s.labels.some((l) => l.toLowerCase().includes(q)) ||
      s.custom_title.toLowerCase().includes(q) ||
      s.project_path.toLowerCase().includes(q) ||
      s.git_branch.toLowerCase().includes(q) ||
      projLabel.includes(q);

    let matchesProject = true;
    if (filterProjectLabel !== null) {
      const folders = getFoldersForProjectLabel(filterProjectLabel);
      matchesProject = folders.has(s.project_folder);
    }

    const matchesLabel =
      filterSessionLabel === null ||
      (filterSessionLabel === ""
        ? s.labels.length === 0
        : s.labels.includes(filterSessionLabel));

    return matchesSearch && matchesProject && matchesLabel;
  });
}

function getProjectLabelGroups(): { label: string; projectCount: number; sessionCount: number }[] {
  const map = new Map<string, { folders: Set<string>; sessionCount: number }>();
  for (const s of allSessions) {
    const label = getProjectLabel(s.project_folder);
    if (!label) continue;
    let entry = map.get(label);
    if (!entry) {
      entry = { folders: new Set(), sessionCount: 0 };
      map.set(label, entry);
    }
    entry.folders.add(s.project_folder);
    entry.sessionCount++;
  }
  return Array.from(map.entries())
    .map(([label, data]) => ({
      label,
      projectCount: data.folders.size,
      sessionCount: data.sessionCount,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko"));
}

function getSessionLabelsForChips(): { name: string; count: number }[] {
  const filtered = allSessions.filter((s) => {
    if (filterProjectLabel !== null) {
      const folders = getFoldersForProjectLabel(filterProjectLabel);
      return folders.has(s.project_folder);
    }
    return true;
  });
  const map = new Map<string, number>();
  let unlabeled = 0;
  for (const s of filtered) {
    if (s.labels.length > 0) {
      for (const l of s.labels) map.set(l, (map.get(l) || 0) + 1);
    } else {
      unlabeled++;
    }
  }
  const labels = Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  if (unlabeled > 0) labels.push({ name: "", count: unlabeled });
  return labels;
}

function buildTabTitle(sessionId: string | null, projectPath: string, projectFolder: string): string {
  const projectName = getProjectLabel(projectFolder) || lastPathSegment(projectPath);
  if (sessionId) {
    const s = allSessions.find((x) => x.session_id === sessionId);
    if (s) {
      const t = s.custom_title || s.labels[0] || s.first_prompt?.slice(0, 40) || "";
      if (projectName && t) return `${projectName}:${t}`;
      if (projectName) return projectName;
      if (t) return t;
    }
  }
  return projectName || "Claude";
}

// --- Custom dialogs ---

function customAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog-box">
        <div class="dialog-message">${escapeHtml(message)}</div>
        <div class="dialog-footer">
          <button class="dialog-btn dialog-btn-ok">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); resolve(); };
    overlay.querySelector(".dialog-btn-ok")!.addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") { close(); document.removeEventListener("keydown", esc); }
    };
    document.addEventListener("keydown", esc);
    (overlay.querySelector(".dialog-btn-ok") as HTMLElement).focus();
  });
}

function customConfirm(message: string, title?: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog-box">
        ${title ? `<div class="dialog-title">${escapeHtml(title)}</div>` : ""}
        <div class="dialog-message">${escapeHtml(message)}</div>
        <div class="dialog-footer">
          <button class="dialog-btn dialog-btn-cancel">취소</button>
          <button class="dialog-btn dialog-btn-ok ${danger ? "dialog-btn-danger" : ""}">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = (val: boolean) => { overlay.remove(); resolve(val); };
    overlay.querySelector(".dialog-btn-ok")!.addEventListener("click", () => close(true));
    overlay.querySelector(".dialog-btn-cancel")!.addEventListener("click", () => close(false));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(false); });
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(false); document.removeEventListener("keydown", esc); }
    };
    document.addEventListener("keydown", esc);
    (overlay.querySelector(".dialog-btn-ok") as HTMLElement).focus();
  });
}

function customPrompt(message: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog-box">
        <div class="dialog-message">${escapeHtml(message)}</div>
        <input class="dialog-input" type="text" value="${escapeHtml(defaultValue)}" />
        <div class="dialog-footer">
          <button class="dialog-btn dialog-btn-cancel">취소</button>
          <button class="dialog-btn dialog-btn-ok">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector(".dialog-input") as HTMLInputElement;
    const close = (val: string | null) => { overlay.remove(); resolve(val); };
    overlay.querySelector(".dialog-btn-ok")!.addEventListener("click", () => close(input.value));
    overlay.querySelector(".dialog-btn-cancel")!.addEventListener("click", () => close(null));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") close(input.value);
      else if (e.key === "Escape") close(null);
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// --- Context menu ---

interface CtxMenuItem {
  label: string;
  icon?: string;
  action: () => void;
  danger?: boolean;
}

function showContextMenu(x: number, y: number, items: CtxMenuItem[]) {
  document.querySelectorAll(".ctx-menu").forEach((el) => el.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.innerHTML = items.map((it, i) =>
    it.label === "-"
      ? `<div class="ctx-sep"></div>`
      : `<div class="ctx-item ${it.danger ? "ctx-item-danger" : ""}" data-idx="${i}">${it.icon || ""}<span>${escapeHtml(it.label)}</span></div>`
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

// --- Sidebar resize ---

function initSidebarResizer() {
  const resizer = document.getElementById("sidebar-resizer");
  const sidebar = document.getElementById("sidebar");
  if (!resizer || !sidebar) return;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    document.body.classList.add("sidebar-resizing");
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    // When sidebar is on the right, cursor moving right should SHRINK it.
    const direction = sidebarPosition === "right" ? -1 : 1;
    const w = Math.max(240, Math.min(640, startW + direction * (e.clientX - startX)));
    sidebar.style.width = w + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("sidebar-resizing");
    localStorage.setItem("sidebar-w", String(sidebar.offsetWidth));
    // Explicit final resize signal so any ResizeObserver debounce fires its
    // tail — prevents stale xterm canvas on the right edge after drag.
    window.dispatchEvent(new Event("resize"));
  });
}

// --- Welcome screen visibility ---

function hideWelcome() {
  const el = document.getElementById("welcome-screen");
  if (el) el.style.display = "none";
}
function showWelcomeIfNoTabs() {
  const tabs = document.getElementById("tabs");
  const el = document.getElementById("welcome-screen");
  if (!el) return;
  el.style.display = tabs && tabs.children.length > 0 ? "none" : "";
}

// --- Actions ---

async function resumeSession(
  sessionId: string,
  projectPath: string,
  projectFolder: string,
  newWindow: boolean,
  model?: string,
  account?: string,
) {
  const title = buildTabTitle(sessionId, projectPath, projectFolder);
  hideWelcome();
  // If caller didn't pin an account, resolve from explicit/label/info mappings
  // so the right CLAUDE_CONFIG_DIR is used to find the session's jsonl.
  const s = allSessions.find((x) => x.session_id === sessionId);
  const finalAccount = account ?? resolveSessionAccountName(s, sessionId);
  try {
    await invoke("open_session", {
      sessionId,
      projectPath,
      skipPermissions: globalSkipPermissions,
      newWindow,
      title,
      model: model ?? null,
      account: finalAccount,
    });
    void refreshUsage();
  } catch (e) {
    await customAlert("실행 실패: " + e);
    showWelcomeIfNoTabs();
  }
}

async function startNewSessionInProject(
  projectPath: string,
  projectFolder: string,
  newWindow: boolean,
  model?: string,
  account?: string,
) {
  const title = buildTabTitle(null, projectPath, projectFolder);
  hideWelcome();
  try {
    await invoke("open_session", {
      sessionId: null,
      projectPath,
      skipPermissions: globalSkipPermissions,
      newWindow,
      title,
      model: model ?? null,
      account: account ?? null,
    });
  } catch (e) {
    await customAlert("실행 실패: " + e);
    showWelcomeIfNoTabs();
  }
}

async function resumeWithAccountPicker(sessionId: string, projectPath: string, projectFolder: string) {
  const picked = await customAccountPicker(allAccounts);
  if (!picked) return;
  await resumeSession(sessionId, projectPath, projectFolder, globalNewWindow, undefined, picked);
}

async function startWithAccountPicker(projectPath: string, projectFolder: string) {
  const picked = await customAccountPicker(allAccounts);
  if (!picked) return;
  await startNewSessionInProject(projectPath, projectFolder, globalNewWindow, undefined, picked);
}

async function pinSessionAccount(sessionId: string) {
  const current = sessionAccountMap[sessionId];
  const currentDisplay = current
    ? (accountByName(current) ? accountDisplay(accountByName(current)!) : current)
    : "(자동)";
  const ok = await customConfirm(
    `현재 고정: ${currentDisplay}\n\n새 계정을 선택해 고정하거나 취소해 자동(라벨 매핑/기본)으로 되돌립니다.`,
    "세션 계정 고정",
    false
  );
  if (!ok) {
    // Cancel = clear pin
    try {
      sessionAccountMap = await invoke("set_session_account_mapping", { sessionId, account: null });
      renderTree();
    } catch (err) { await customAlert("실패: " + err); }
    return;
  }
  const picked = await customAccountPicker(allAccounts);
  if (!picked) return;
  try {
    sessionAccountMap = await invoke("set_session_account_mapping", { sessionId, account: picked });
    renderTree();
  } catch (err) { await customAlert("실패: " + err); }
}

async function openClaudeHere(newWindow: boolean, account?: string) {
  const selected = await open({ directory: true, multiple: false, title: "Claude를 열 폴더 선택" });
  if (!selected) return;
  const path = typeof selected === "string" ? selected : String(selected);
  hideWelcome();
  try {
    await invoke("open_session", {
      sessionId: null,
      projectPath: path,
      skipPermissions: globalSkipPermissions,
      newWindow,
      title: lastPathSegment(path) || "Claude",
      model: null,
      account: account ?? null,
    });
  } catch (e) {
    await customAlert("실행 실패: " + e);
    showWelcomeIfNoTabs();
  }
}

async function editSessionTitle(sessionId: string) {
  const s = allSessions.find((x) => x.session_id === sessionId);
  const current = s?.custom_title || "";
  const title = await customPrompt("커스텀 제목 (비우면 삭제):", current);
  if (title === null) return;
  try {
    await invoke("set_session_title", { sessionId, title });
    if (s) s.custom_title = title;
    renderTree();
  } catch (e) {
    await customAlert("제목 저장 실패: " + e);
  }
}

async function editSessionLabels(sessionId: string) {
  const s = allSessions.find((x) => x.session_id === sessionId);
  const current = s?.labels.join(", ") || "";
  const input = await customPrompt("세션 라벨 (쉼표로 구분, 비우면 삭제):", current);
  if (input === null) return;
  const labels = input.split(",").map((l) => l.trim()).filter((l) => l.length > 0);
  try {
    await invoke("set_labels", { sessionId, labels });
    if (s) s.labels = labels;
    renderChips();
    renderTree();
  } catch (e) {
    await customAlert("라벨 저장 실패: " + e);
  }
}

async function editProjectLabel(folder: string, currentPath: string) {
  const current = getProjectLabel(folder);
  const label = await customPrompt(`프로젝트 라벨 (비우면 삭제):\n${currentPath}`, current);
  if (label === null) return;
  try {
    await invoke("set_project_label", { projectFolder: folder, label });
    if (label) projectLabels[folder] = label;
    else delete projectLabels[folder];
    renderChips();
    renderTree();
  } catch (e) {
    await customAlert("프로젝트 라벨 저장 실패: " + e);
  }
}

async function editGroupLabel(oldLabel: string) {
  const folders = Array.from(getFoldersForProjectLabel(oldLabel));
  if (folders.length === 0) return;
  const label = await customPrompt(
    `그룹 라벨 이름 변경 (비우면 ${folders.length}개 프로젝트 라벨 전부 삭제):`,
    oldLabel
  );
  if (label === null) return;
  try {
    for (const f of folders) {
      await invoke("set_project_label", { projectFolder: f, label });
      if (label) projectLabels[f] = label;
      else delete projectLabels[f];
    }
    renderChips();
    renderTree();
  } catch (e) {
    await customAlert("그룹 라벨 저장 실패: " + e);
  }
}

async function toggleFavorite(sessionId: string) {
  const nextFav = !favoriteSessions.has(sessionId);
  try {
    const list = await invoke<string[]>("set_session_favorite", { sessionId, favorite: nextFav });
    favoriteSessions = new Set(list);
    renderTree();
  } catch (e) {
    await customAlert("즐겨찾기 저장 실패: " + e);
  }
}

async function deleteGroupSessions(label: string) {
  const folders = Array.from(getFoldersForProjectLabel(label));
  if (folders.length === 0) return;
  const affected = allSessions.filter((s) => folders.includes(s.project_folder));
  const ok = await customConfirm(
    `"${label}" 라벨 그룹의 세션 ${affected.length}개를 전부 삭제할까요?\n(되돌릴 수 없습니다)`,
    "그룹 세션 전체 삭제",
    true
  );
  if (!ok) return;
  try {
    for (const f of folders) {
      await invoke("delete_project_sessions", { projectFolder: f, accountName: null });
      delete projectLabels[f];
    }
    allSessions = allSessions.filter((s) => !folders.includes(s.project_folder));
    renderChips();
    renderTree();
  } catch (e) {
    await customAlert("삭제 실패: " + e);
  }
}

let deleteInProgress = false;
async function deleteSession(sessionId: string, projectFolder: string) {
  if (deleteInProgress) return;
  deleteInProgress = true;
  try {
    const s = allSessions.find((x) => x.session_id === sessionId);
    const desc = s?.custom_title || s?.labels[0] || s?.first_prompt?.slice(0, 40) || sessionId;
    const ok = await customConfirm(`"${desc}" 세션을 삭제할까요?`, "세션 삭제", true);
    if (!ok) return;
    await invoke("delete_session", { sessionId, projectFolder, accountName: s?.account_name ?? null });
    allSessions = allSessions.filter((x) => x.session_id !== sessionId);
    renderChips();
    renderTree();
  } catch (e) {
    await customAlert("삭제 실패: " + e);
  } finally {
    deleteInProgress = false;
  }
}

async function deleteProjectSessions(folder: string, path: string) {
  const sessions = allSessions.filter((s) => s.project_folder === folder);
  if (sessions.length === 0) return;
  const displayName = getProjectDisplayName(folder, path);
  const ok = await customConfirm(
    `"${displayName}" 프로젝트의 세션 ${sessions.length}개를 모두 삭제할까요?\n(되돌릴 수 없습니다)`,
    "프로젝트 세션 전체 삭제",
    true
  );
  if (!ok) return;
  try {
    await invoke("delete_project_sessions", { projectFolder: folder, accountName: null });
    allSessions = allSessions.filter((s) => s.project_folder !== folder);
    delete projectLabels[folder];
    renderChips();
    renderTree();
  } catch (e) {
    await customAlert("삭제 실패: " + e);
  }
}

// --- Render ---

function renderSessionRow(s: SessionInfo, showPathHint = false): string {
  const title = s.custom_title || s.first_prompt?.trim() || "(내용 없음)";
  const labels = s.labels
    .slice(0, 3)
    .map((l) => `<span class="session-label">${escapeHtml(l)}</span>`)
    .join("");
  const branch = s.git_branch
    ? `<span class="session-branch">${escapeHtml(s.git_branch)}</span>`
    : "";
  const pathHint = showPathHint
    ? `<span class="session-path">${escapeHtml(lastPathSegment(s.project_path))}</span>`
    : "";
  const isFav = favoriteSessions.has(s.session_id);
  const favIcon = isFav ? `<span class="session-fav">${ICONS.star}</span>` : "";

  // Account badge — show only when not the default account, since the vast
  // majority of sessions live there. Tooltip carries the email/subscription.
  const resolvedAcc = resolveSessionAccountName(s);
  let accountBadge = "";
  if (resolvedAcc !== DEFAULT_ACCOUNT_NAME) {
    const acc = accountByName(resolvedAcc);
    const display = acc ? accountDisplay(acc) : resolvedAcc;
    const tip = acc && acc.email
      ? `${acc.email}${acc.subscription ? " · " + acc.subscription : ""}`
      : resolvedAcc;
    accountBadge = `<span class="session-account" title="${escapeHtml(tip)}">${escapeHtml(display)}</span>`;
  }

  return `
    <div class="tree-session ${isFav ? "is-favorite" : ""}" data-session-id="${s.session_id}" data-project-folder="${escapeHtml(s.project_folder)}" data-project-path="${escapeHtml(s.project_path)}" data-account-name="${escapeHtml(s.account_name || "")}">
      <div class="session-title">${favIcon}${escapeHtml(title)}</div>
      <div class="session-meta">
        ${pathHint}
        ${accountBadge}
        ${labels}
        ${branch}
        <span class="session-time">${timeAgo(s.modified)}</span>
      </div>
    </div>
  `;
}

function renderStats() {
  const el = document.getElementById("stats");
  if (!el) return;
  const filtered = getFilteredSessions();
  el.textContent = `전체 ${allSessions.length} · 표시 ${filtered.length}`;
}

function renderChips() {
  const container = document.getElementById("chips-area");
  if (!container) return;

  const groups = getProjectLabelGroups();
  const sessionLabels = getSessionLabelsForChips();

  let html = "";

  if (groups.length > 0) {
    html += `<div class="filter-section">
      <div class="filter-section-title">프로젝트 라벨</div>
      <div class="chip-row">
        <button class="chip ${filterProjectLabel === null ? "active" : ""}" data-project-chip="__all__">전체</button>`;
    for (const g of groups) {
      const isActive = filterProjectLabel === g.label;
      const count = g.projectCount > 1 ? `<span class="chip-count">${g.projectCount}</span>` : "";
      html += `<button class="chip ${isActive ? "active" : ""}" data-project-chip="${escapeHtml(g.label)}">${escapeHtml(g.label)}${count}</button>`;
    }
    html += `</div></div>`;
  }

  if (sessionLabels.length > 0) {
    html += `<div class="filter-section">
      <div class="filter-section-title">세션 태그</div>
      <div class="chip-row">
        <button class="chip ${filterSessionLabel === null ? "active" : ""}" data-session-chip="__all__">전체</button>`;
    for (const l of sessionLabels) {
      const isActive =
        (l.name === "" && filterSessionLabel === "") ||
        (l.name !== "" && filterSessionLabel === l.name);
      const displayName = l.name || "라벨 없음";
      const value = l.name === "" ? "__none__" : l.name;
      html += `<button class="chip ${isActive ? "active" : ""}" data-session-chip="${escapeHtml(value)}">${escapeHtml(displayName)}<span class="chip-count">${l.count}</span></button>`;
    }
    html += `</div></div>`;
  }

  if (!html) html = `<div class="filter-empty">라벨이 없습니다</div>`;
  container.innerHTML = html;
}

interface FolderNode {
  key: string;              // unique: label || folder_id
  displayName: string;
  label: string | null;
  isGroup: boolean;         // true when multiple project folders share the label
  folders: string[];        // underlying project_folders
  paths: string[];          // underlying project_paths (unique)
  sessions: SessionInfo[];  // combined, sorted by modified desc
}

function buildFolderNodes(filtered: SessionInfo[]): FolderNode[] {
  const byFolder = new Map<string, SessionInfo[]>();
  for (const s of filtered) {
    if (!byFolder.has(s.project_folder)) byFolder.set(s.project_folder, []);
    byFolder.get(s.project_folder)!.push(s);
  }
  const allProjects = getProjects().filter((p) => byFolder.has(p.folder));

  // Group by label (empty label → unique group per folder)
  const groups = new Map<string, { label: string | null; items: typeof allProjects }>();
  for (const p of allProjects) {
    const label = getProjectLabel(p.folder);
    const key = label || `__unlabeled__:${p.folder}`;
    let g = groups.get(key);
    if (!g) {
      g = { label: label || null, items: [] };
      groups.set(key, g);
    }
    g.items.push(p);
  }

  const nodes: FolderNode[] = [];
  for (const [key, g] of groups) {
    const sessions: SessionInfo[] = [];
    for (const p of g.items) sessions.push(...byFolder.get(p.folder)!);
    sessions.sort((a, b) => b.modified.localeCompare(a.modified));
    const isGroup = g.label !== null && g.items.length > 1;
    const paths = Array.from(new Set(g.items.map((p) => p.path)));
    const displayName =
      g.label || lastPathSegment(g.items[0].path) || g.items[0].path;
    nodes.push({
      key,
      displayName,
      label: g.label,
      isGroup,
      folders: g.items.map((p) => p.folder),
      paths,
      sessions,
    });
  }

  // Sort: labeled first (alpha), then unlabeled (alpha by display)
  nodes.sort((a, b) => {
    const la = a.label !== null;
    const lb = b.label !== null;
    if (la && !lb) return -1;
    if (!la && lb) return 1;
    return a.displayName.localeCompare(b.displayName, "ko");
  });

  return nodes;
}

function renderTree() {
  const container = document.getElementById("content-area");
  if (!container) return;

  if (allSessions.length === 0) {
    container.innerHTML = '<div class="empty">세션이 없습니다</div>';
    renderStats();
    return;
  }

  const filteredSessions = getFilteredSessions();
  if (filteredSessions.length === 0) {
    container.innerHTML = '<div class="empty">검색 결과 없음</div>';
    renderStats();
    return;
  }

  const nodes = buildFolderNodes(filteredSessions);

  container.innerHTML = nodes
    .map((n) => {
      const isCollapsed = collapsedProjects.has(n.key);
      const chevron = isCollapsed ? ICONS.chevronRight : ICONS.chevronDown;
      const subLabelHtml = n.isGroup
        ? `<span class="folder-sublabel">${n.paths.length}개 프로젝트</span>`
        : n.label
        ? `<span class="folder-sublabel">${escapeHtml(lastPathSegment(n.paths[0]))}</span>`
        : "";
      const sessionsHtml = isCollapsed
        ? ""
        : `<div class="tree-children">${n.sessions
            .map((s) => renderSessionRow(s, n.isGroup))
            .join("")}</div>`;
      const folderAttrs = n.isGroup
        ? `data-group-label="${escapeHtml(n.label!)}"`
        : `data-folder-id="${escapeHtml(n.folders[0])}" data-folder-path="${escapeHtml(n.paths[0])}"`;
      return `
        <div class="tree-folder ${n.isGroup ? "is-group" : ""}" ${folderAttrs}>
          <div class="tree-folder-header" data-folder-toggle="${escapeHtml(n.key)}">
            <span class="folder-chevron">${chevron}</span>
            <span class="folder-name">${escapeHtml(n.displayName)}</span>
            ${subLabelHtml}
            <span class="folder-count">${n.sessions.length}</span>
          </div>
          ${sessionsHtml}
        </div>
      `;
    })
    .join("");

  renderStats();
}

// --- Settings modal ---

async function openSettings() {
  const currentThemeName: string = (await invoke<string | null>("get_terminal_theme")) ?? DEFAULT_THEME;
  const currentLogDir: string = await invoke<string>("get_log_dir");
  const currentVerbose: boolean = await invoke<boolean>("get_claude_verbose");
  const metaPaths = await invoke<{ claude_dir: string; session_labels: string; project_labels: string; session_titles: string }>("get_metadata_paths");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  let selectedName = currentThemeName;
  const rankMap = new Map<string, number>();
  THEME_ORDER.forEach((n, i) => rankMap.set(n, i + 1));

  const renderCard = (t: TerminalTheme) => {
    const x = t.xterm;
    const selected = t.name === selectedName;
    const rank = rankMap.get(t.name) ?? 0;
    const swatches = [x.red, x.green, x.yellow, x.blue, x.magenta, x.cyan]
      .map((c) => `<span class="theme-dot" style="background:${c}"></span>`).join("");
    return `
      <div class="theme-card ${selected ? "selected" : ""}" data-theme-name="${t.name}" style="background:${x.background}; border-color:${selected ? t.ui.accent : "transparent"}">
        <div class="theme-card-rank" style="color:${t.ui.fgDim}; border-color:${t.ui.border}">#${rank}</div>
        <div class="theme-card-header">
          <span class="theme-card-title" style="color:${x.foreground}">${escapeHtml(t.displayName)}</span>
          <span class="theme-card-check" style="color:${t.ui.accent}; ${selected ? "" : "visibility:hidden"}">${ICONS.check}</span>
        </div>
        <div class="theme-card-sample" style="color:${x.foreground}">
          <div><span style="color:${x.green}">$</span> <span style="color:${x.blue}">claude</span> <span style="color:${x.cyan}">--resume</span></div>
          <div><span style="color:${x.magenta}">user</span> <span style="color:${x.foreground}">></span> <span style="color:${x.yellow}">hello</span></div>
        </div>
        <div class="theme-card-dots">${swatches}</div>
        <div class="theme-card-blurb">${escapeHtml(t.blurb)}</div>
      </div>
    `;
  };

  const renderGroup = (g: { label: string; names: string[] }) => `
    <div class="theme-group">
      <div class="theme-group-header">
        <span class="theme-group-label">${escapeHtml(g.label)}</span>
        <span class="theme-group-count">${g.names.length}</span>
      </div>
      <div class="theme-grid">${g.names.map((n) => renderCard(THEMES[n])).join("")}</div>
    </div>
  `;

  overlay.innerHTML = `
    <div class="modal modal-settings">
      <header class="settings-header">
        <div class="settings-title">설정</div>
        <button class="settings-close" title="닫기">${ICONS.close}</button>
      </header>
      <div class="settings-body">
        <aside class="settings-nav">
          <button class="settings-nav-item active" data-section="usage">사용량</button>
          <button class="settings-nav-item" data-section="accounts">계정</button>
          <button class="settings-nav-item" data-section="theme">테마</button>
          <button class="settings-nav-item" data-section="layout">외관</button>
          <button class="settings-nav-item" data-section="log">로그</button>
          <button class="settings-nav-item" data-section="data">데이터</button>
        </aside>
        <div class="settings-content">
          <section class="settings-panel" data-section="usage">
            <div class="settings-panel-title">사용량</div>
            <div class="settings-panel-subtitle">Claude Code는 rate limit 기반 구독제입니다. 토큰 누적과 모델 비율이 중요합니다.</div>
            <div id="usage-panel-body"></div>
          </section>
          <section class="settings-panel" data-section="accounts" hidden>
            <div class="settings-panel-title">계정</div>
            <div class="settings-panel-subtitle">세션마다 다른 Claude 계정을 사용할 수 있습니다. 계정은 자체 <code>CLAUDE_CONFIG_DIR</code>을 가지며, 로그인은 그 디렉토리에서 별도로 진행됩니다.</div>

            <div class="settings-row-label">등록된 계정</div>
            <div id="accounts-list" class="accounts-list"></div>
            <div class="settings-btn-row">
              <button class="btn-secondary-sm" id="add-account-btn">${ICONS.plus}<span>계정 추가</span></button>
              <button class="btn-secondary-sm" id="refresh-accounts-btn">${ICONS.refresh}<span>전체 새로고침</span></button>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row-label">라벨 → 계정 자동 매핑</div>
            <div class="settings-panel-subtitle">특정 라벨이 붙은 세션은 자동으로 매핑된 계정에서 resume됩니다.</div>
            <div id="label-mappings" class="label-mappings"></div>
            <div class="settings-btn-row">
              <button class="btn-secondary-sm" id="add-label-mapping-btn">${ICONS.plus}<span>매핑 추가</span></button>
            </div>
          </section>
          <section class="settings-panel" data-section="theme" hidden>
            <div class="settings-panel-title">터미널 테마</div>
            <div class="settings-panel-subtitle">랭킹 순 · 선택하면 즉시 적용됩니다.</div>
            <div class="theme-groups">${THEME_GROUPS.map(renderGroup).join("")}</div>
          </section>
          <section class="settings-panel" data-section="layout" hidden>
            <div class="settings-panel-title">외관</div>
            <div class="settings-panel-subtitle">사이드바 위치를 지정합니다. 숨김/펼침은 사이드바 상단의 화살표 버튼으로 언제든 토글할 수 있습니다.</div>

            <div class="settings-row-label">사이드바 위치</div>
            <div class="settings-radio-row">
              <label class="settings-radio">
                <input type="radio" name="sidebar-pos" value="left" ${sidebarPosition === "left" ? "checked" : ""} />
                <span>왼쪽</span>
              </label>
              <label class="settings-radio">
                <input type="radio" name="sidebar-pos" value="right" ${sidebarPosition === "right" ? "checked" : ""} />
                <span>오른쪽</span>
              </label>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row-label">터미널 상태 바</div>
            <label class="settings-toggle-row">
              <input type="checkbox" id="settings-statusbar" ${statusBarVisible ? "checked" : ""}>
              <span class="toggle-mini-track"><span class="toggle-mini-thumb"></span></span>
              <span class="settings-toggle-text">탭 바 아래에 세션 토큰·모델·시간·rate limit을 표시합니다 (새 창 포함)</span>
            </label>
          </section>
          <section class="settings-panel" data-section="log" hidden>
            <div class="settings-panel-title">로그</div>
            <div class="settings-panel-subtitle">Verbose 모드가 켜지면 PTY 출력 전체가 파일로 저장됩니다.</div>

            <div class="settings-row-label">로그 폴더</div>
            <div class="settings-path-row">
              <code class="settings-path" id="settings-log-path">${escapeHtml(currentLogDir)}</code>
            </div>
            <div class="settings-btn-row">
              <button class="btn-secondary-sm" id="settings-log-open-folder">${ICONS.folderOpen}<span>폴더 열기</span></button>
              <button class="btn-secondary-sm" id="settings-log-change-dir">${ICONS.edit}<span>경로 변경</span></button>
              <button class="btn-secondary-sm" id="settings-log-reset-dir">기본값</button>
              <button class="btn-secondary-sm" id="settings-log-clear" style="margin-left:auto">${ICONS.trash}<span>전체 삭제</span></button>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row-label">Verbose 로깅</div>
            <label class="settings-toggle-row">
              <input type="checkbox" id="settings-claude-verbose" ${currentVerbose ? "checked" : ""}>
              <span class="toggle-mini-track"><span class="toggle-mini-thumb"></span></span>
              <span class="settings-toggle-text">세션마다 PTY 출력 전체를 <code>{로그폴더}/claude-*.log</code>에 tee</span>
            </label>
            <div class="settings-panel-hint">문제 재현 / 응답 내용 보관 / 디버깅에 유용. 각 세션마다 파일 1개가 생성됩니다.</div>
          </section>
          <section class="settings-panel" data-section="data" hidden>
            <div class="settings-panel-title">데이터</div>
            <div class="settings-panel-subtitle">라벨·태그·커스텀 제목은 <code>~/.claude/</code> 안의 JSON 3개로 관리됩니다. 세션 본체(jsonl)는 Claude CLI가 관리하므로 여기선 건드리지 않습니다.</div>

            <div class="settings-row-label">Claude 디렉토리</div>
            <div class="settings-path-row">
              <code class="settings-path">${escapeHtml(metaPaths.claude_dir)}</code>
            </div>
            <div class="settings-btn-row">
              <button class="btn-secondary-sm" id="settings-data-open-folder">${ICONS.folderOpen}<span>폴더 열기</span></button>
            </div>

            <div class="settings-divider"></div>

            <div class="settings-row-label">라벨·제목 내보내기 / 가져오기</div>
            <div class="settings-btn-row">
              <button class="btn-secondary-sm" id="settings-data-export">${ICONS.download}<span>내보내기 (JSON)</span></button>
              <button class="btn-secondary-sm" id="settings-data-import">${ICONS.upload}<span>가져오기 (JSON)</span></button>
            </div>
            <div class="settings-panel-hint">세션 라벨 + 프로젝트 라벨 + 커스텀 제목을 1개 JSON으로 묶어 내보냅니다. 가져오면 현재 메타데이터가 <strong>대체</strong>됩니다.</div>
          </section>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); };
  overlay.querySelector(".settings-close")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  // Nav switching
  overlay.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.section;
      if (!target) return;
      overlay.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((b) =>
        b.classList.toggle("active", b.dataset.section === target));
      overlay.querySelectorAll<HTMLElement>(".settings-panel").forEach((p) => {
        if (p.dataset.section === target) p.removeAttribute("hidden");
        else p.setAttribute("hidden", "");
      });
    });
  });

  // Log section
  const logPathEl = overlay.querySelector("#settings-log-path") as HTMLElement;
  overlay.querySelector("#settings-log-open-folder")!.addEventListener("click", async () => {
    try { await invoke("open_path_in_os", { path: logPathEl.textContent || "" }); }
    catch (err) { await customAlert("폴더 열기 실패: " + err); }
  });
  overlay.querySelector("#settings-log-change-dir")!.addEventListener("click", async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: "로그 폴더 선택" });
      if (typeof picked !== "string") return;
      const resolved = await invoke<string>("set_log_dir", { path: picked });
      logPathEl.textContent = resolved;
    } catch (err) { await customAlert("경로 변경 실패: " + err); }
  });
  overlay.querySelector("#settings-log-reset-dir")!.addEventListener("click", async () => {
    try {
      const resolved = await invoke<string>("set_log_dir", { path: null });
      logPathEl.textContent = resolved;
    } catch (err) { await customAlert("기본값 설정 실패: " + err); }
  });
  overlay.querySelector("#settings-log-clear")!.addEventListener("click", async () => {
    if (!await customConfirm(`로그 폴더의 모든 *.log 파일을 삭제합니다.\n${logPathEl.textContent}`, "로그 삭제", true)) return;
    try {
      const n = await invoke<number>("clear_logs");
      await customAlert(`${n}개 로그 파일을 삭제했습니다.`);
    } catch (err) { await customAlert("로그 삭제 실패: " + err); }
  });
  overlay.querySelector("#settings-claude-verbose")!.addEventListener("change", async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    try { await invoke("set_claude_verbose", { value: checked }); }
    catch (err) { await customAlert("설정 실패: " + err); }
  });

  // Data section
  overlay.querySelector("#settings-data-open-folder")!.addEventListener("click", async () => {
    try { await invoke("open_path_in_os", { path: metaPaths.claude_dir }); }
    catch (err) { await customAlert("폴더 열기 실패: " + err); }
  });
  overlay.querySelector("#settings-data-export")!.addEventListener("click", async () => {
    try {
      const picked = await save({
        defaultPath: "claude-session-metadata.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;
      await invoke("export_metadata_to", { targetPath: picked });
      await customAlert(`내보내기 완료\n${picked}`);
    } catch (err) { await customAlert("내보내기 실패: " + err); }
  });
  overlay.querySelector("#settings-data-import")!.addEventListener("click", async () => {
    try {
      const picked = await open({
        multiple: false,
        title: "가져올 JSON 파일 선택",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;
      if (!await customConfirm("현재 라벨·태그·제목이 모두 대체됩니다. 계속할까요?", "가져오기", true)) return;
      await invoke("import_metadata_from", { sourcePath: picked });
      await loadSessions();
      await customAlert("가져오기 완료. 사이드바가 새로고침되었습니다.");
    } catch (err) { await customAlert("가져오기 실패: " + err); }
  });

  // Layout section
  overlay.querySelectorAll<HTMLInputElement>('input[name="sidebar-pos"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) setSidebarPosition(r.value as SidebarPosition);
    });
  });
  overlay.querySelector("#settings-statusbar")!.addEventListener("change", (e) => {
    setStatusBarVisible((e.target as HTMLInputElement).checked);
  });

  // Theme section
  const root = overlay.querySelector(".theme-groups") as HTMLElement;
  root.addEventListener("click", async (e) => {
    const card = (e.target as HTMLElement).closest(".theme-card") as HTMLElement | null;
    if (!card) return;
    const name = card.dataset.themeName!;
    if (name === selectedName) return;
    selectedName = name;
    root.querySelectorAll(".theme-card").forEach((el) => {
      const cardName = (el as HTMLElement).dataset.themeName!;
      const isActive = cardName === name;
      el.classList.toggle("selected", isActive);
      const check = el.querySelector(".theme-card-check") as HTMLElement;
      if (check) check.style.visibility = isActive ? "" : "hidden";
      (el as HTMLElement).style.borderColor = isActive ? THEMES[cardName].ui.accent : "transparent";
    });
    try { await invoke("set_terminal_theme", { name }); }
    catch (err) { await customAlert("테마 적용 실패: " + err); }
  });

  // Initial usage panel render (modal default section is "usage").
  void refreshUsage();

  // Accounts section
  const accountsListEl = overlay.querySelector("#accounts-list") as HTMLElement;
  const labelMappingsEl = overlay.querySelector("#label-mappings") as HTMLElement;

  function renderAccountsListUi() {
    if (!accountsListEl) return;
    accountsListEl.innerHTML = allAccounts.map((a) => {
      const display = accountDisplay(a);
      const isDefault = a.name === DEFAULT_ACCOUNT_NAME;
      const statusBits: string[] = [];
      if (a.email) statusBits.push(`<span class="account-email">${escapeHtml(a.email)}</span>`);
      if (a.subscription) statusBits.push(`<span class="account-sub">${escapeHtml(a.subscription)}</span>`);
      const status = statusBits.length > 0
        ? statusBits.join(" · ")
        : `<span class="account-warning">로그인 안 됨</span>`;
      return `
        <div class="account-card" data-account-name="${escapeHtml(a.name)}">
          <div class="account-row-main">
            <div class="account-name-row">
              <span class="account-name">${escapeHtml(display)}</span>
              ${isDefault ? '<span class="account-tag">기본</span>' : ''}
              ${a.alias ? `<span class="account-id">${escapeHtml(a.name)}</span>` : ""}
            </div>
            <div class="account-meta">${status}</div>
          </div>
          <div class="account-actions">
            ${!a.logged_in && !isDefault ? `<button class="btn-secondary-sm" data-action="login">로그인</button>` : ""}
            <button class="btn-ghost-sm" data-action="alias" title="별명 편집">${ICONS.edit}</button>
            <button class="btn-ghost-sm" data-action="refresh" title="상태 새로고침">${ICONS.refresh}</button>
            ${!isDefault ? `<button class="btn-ghost-sm" data-action="delete" title="계정 삭제">${ICONS.trash}</button>` : ""}
          </div>
        </div>
      `;
    }).join("");
  }

  function renderLabelMappingsUi() {
    if (!labelMappingsEl) return;
    const entries = Object.entries(labelAccountMap);
    if (entries.length === 0) {
      labelMappingsEl.innerHTML = `<div class="label-mappings-empty">매핑이 없습니다</div>`;
      return;
    }
    labelMappingsEl.innerHTML = entries.map(([label, accountName]) => {
      const acc = accountByName(accountName);
      const display = acc ? accountDisplay(acc) : accountName;
      return `
        <div class="label-mapping-row" data-label="${escapeHtml(label)}">
          <span class="label-mapping-label">${escapeHtml(label)}</span>
          <span class="label-mapping-arrow">→</span>
          <span class="label-mapping-account">${escapeHtml(display)}<span class="label-mapping-id">${escapeHtml(accountName)}</span></span>
          <button class="btn-ghost-sm" data-mapping-action="delete" title="매핑 삭제">${ICONS.trash}</button>
        </div>
      `;
    }).join("");
  }

  accountsListEl.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-action]") as HTMLButtonElement | null;
    if (!btn) return;
    const card = btn.closest("[data-account-name]") as HTMLElement;
    if (!card) return;
    const name = card.dataset.accountName!;
    const action = btn.dataset.action;
    try {
      if (action === "alias") {
        const acc = accountByName(name);
        const aliasInput = await customPrompt("별명 (비우면 이메일/이름 자동):", acc?.alias || "");
        if (aliasInput === null) return;
        const aliasVal = aliasInput.trim() || null;
        allAccounts = await invoke("set_account_alias", { name, alias: aliasVal });
        renderAccountsListUi();
        renderLabelMappingsUi();
        renderUsageStatus(lastUsageReport);
        renderTree();
      } else if (action === "refresh") {
        allAccounts = await invoke("refresh_account_info", { name });
        renderAccountsListUi();
        renderUsageStatus(lastUsageReport);
      } else if (action === "delete") {
        const ok = await customConfirm(
          `계정 "${name}"을 매니저에서 제거할까요?\nClaude 자격증명 디렉토리 자체는 디스크에 남습니다.`,
          "계정 삭제", true);
        if (!ok) return;
        await invoke("remove_account", { name });
        allAccounts = await invoke("get_accounts");
        labelAccountMap = await invoke("get_label_account_map");
        renderAccountsListUi();
        renderLabelMappingsUi();
        renderUsageStatus(lastUsageReport);
        renderTree();
      } else if (action === "login") {
        await invoke("open_login_session_for_account", { accountName: name });
        await customAlert(
          "새 창이 열렸습니다.\n안에서 /login 을 실행하고 OAuth 인증을 마친 뒤,\n창을 닫고 여기서 '상태 새로고침'을 눌러주세요."
        );
      }
    } catch (err) {
      await customAlert("실패: " + err);
    }
  });

  overlay.querySelector("#add-account-btn")!.addEventListener("click", async () => {
    const name = await customPrompt(
      "계정 이름 (디렉토리/식별자로 쓰입니다, 예: tradelab, work, personal):",
      ""
    );
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      allAccounts = await invoke("add_account", { name: trimmed, alias: null, configDir: null });
      renderAccountsListUi();
      await customAlert(
        `계정 "${trimmed}" 추가됨.\n\n다음 단계:\n1. 행에서 '로그인' 클릭\n2. 새 창에서 /login 실행\n3. 인증 후 창 닫고 '상태 새로고침' 클릭`
      );
    } catch (err) {
      await customAlert("실패: " + err);
    }
  });

  overlay.querySelector("#refresh-accounts-btn")!.addEventListener("click", async () => {
    try {
      allAccounts = await invoke("refresh_all_accounts");
      renderAccountsListUi();
      renderUsageStatus(lastUsageReport);
    } catch (err) {
      await customAlert("실패: " + err);
    }
  });

  labelMappingsEl.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-mapping-action]") as HTMLButtonElement | null;
    if (!btn) return;
    const row = btn.closest("[data-label]") as HTMLElement;
    if (!row) return;
    const label = row.dataset.label!;
    if (btn.dataset.mappingAction === "delete") {
      try {
        labelAccountMap = await invoke("set_label_account_mapping", { label, account: null });
        renderLabelMappingsUi();
        renderTree();
      } catch (err) {
        await customAlert("실패: " + err);
      }
    }
  });

  overlay.querySelector("#add-label-mapping-btn")!.addEventListener("click", async () => {
    const labelStr = await customPrompt("라벨 이름 (이 라벨이 붙은 세션에 자동 적용):", "");
    if (labelStr === null) return;
    const label = labelStr.trim();
    if (!label) return;
    const nonDefault = allAccounts.filter((a) => a.name !== DEFAULT_ACCOUNT_NAME);
    if (nonDefault.length === 0) {
      await customAlert("기본 계정 외 등록된 계정이 없습니다. 먼저 계정을 추가해주세요.");
      return;
    }
    const accountName = await customAccountPicker(allAccounts);
    if (!accountName) return;
    try {
      labelAccountMap = await invoke("set_label_account_mapping", { label, account: accountName });
      renderLabelMappingsUi();
      renderTree();
    } catch (err) {
      await customAlert("실패: " + err);
    }
  });

  renderAccountsListUi();
  renderLabelMappingsUi();

  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  };
  document.addEventListener("keydown", esc);
}

function customAccountPicker(accounts: Account[]): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    const options = accounts.map((a) => {
      const display = accountDisplay(a);
      const meta = a.email
        ? a.email + (a.subscription ? " · " + a.subscription : "")
        : (a.logged_in ? "" : "로그인 안 됨");
      const tag = a.name === DEFAULT_ACCOUNT_NAME ? '<span class="account-tag">기본</span>' : "";
      return `<button class="account-picker-row" data-name="${escapeHtml(a.name)}">
        <span class="account-picker-main">
          <span class="account-picker-name">${escapeHtml(display)} ${tag}</span>
          ${meta ? `<span class="account-picker-meta">${escapeHtml(meta)}</span>` : ""}
        </span>
      </button>`;
    }).join("");
    overlay.innerHTML = `
      <div class="dialog-box" style="min-width:340px">
        <div class="dialog-title">계정 선택</div>
        <div class="account-picker-list">${options}</div>
        <div class="dialog-footer">
          <button class="dialog-btn dialog-btn-cancel">취소</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = (val: string | null) => { overlay.remove(); resolve(val); };
    overlay.querySelector(".dialog-btn-cancel")!.addEventListener("click", () => close(null));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });
    overlay.querySelectorAll<HTMLElement>(".account-picker-row").forEach((btn) => {
      btn.addEventListener("click", () => close(btn.dataset.name!));
    });
    const escFn = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(null); document.removeEventListener("keydown", escFn); }
    };
    document.addEventListener("keydown", escFn);
  });
}

// --- Shell ---

function renderShell() {
  const app = document.getElementById("app")!;
  const savedWidth = parseInt(localStorage.getItem("sidebar-w") || "300");
  const sidebarWidth = Math.max(240, Math.min(640, savedWidth));

  app.innerHTML = `
    <div id="app-layout">
      <aside id="sidebar" style="width: ${sidebarWidth}px">
        <div class="sidebar-top">
          <div class="search-wrap">
            <span class="search-icon">${ICONS.search}</span>
            <input type="text" id="search" placeholder="세션 / 라벨 / 경로 검색..." />
          </div>
          <button class="btn-ghost-sm" id="filter-toggle-btn" title="라벨 필터">${ICONS.filter}</button>
          <button class="btn-ghost-sm" id="sidebar-hide-btn" title="사이드바 숨기기">${ICONS.chevronLeft}</button>
        </div>
        <div id="filters-area" class="filters-area" style="display:none">
          <div id="chips-area"></div>
        </div>
        <div id="content-area" class="tree-list"></div>
        <div class="sidebar-bottom">
          <div class="sidebar-actions">
            <button class="btn-secondary-sm" id="open-here-btn">${ICONS.folderOpen}<span>폴더 열기</span></button>
            <div class="sidebar-actions-spacer"></div>
            <label class="toggle-global-nw" title="--dangerously-skip-permissions">
              <input type="checkbox" id="global-skip" ${globalSkipPermissions ? "checked" : ""} />
              <span class="toggle-mini-track"><span class="toggle-mini-thumb"></span></span>
              <span class="toggle-label-text">권한 무시</span>
            </label>
            <label class="toggle-global-nw" title="기본적으로 새 창에서 열기">
              <input type="checkbox" id="global-newwin" />
              <span class="toggle-mini-track"><span class="toggle-mini-thumb"></span></span>
              <span class="toggle-label-text">새 창</span>
            </label>
            <button class="btn-ghost-sm" id="settings-btn" title="설정">${ICONS.settings}</button>
            <button class="btn-ghost-sm" id="refresh-btn" title="새로고침">${ICONS.refresh}</button>
          </div>
          <div class="stats" id="stats"></div>
        </div>
      </aside>
      <div id="sidebar-resizer"></div>
      <div id="terminal-area">
        <div id="tabs"></div>
        <div id="terminals">
          <div id="welcome-screen" class="welcome-screen">
            <h1>Claude Code 세션을 선택하세요</h1>
            <p>사이드바에서 세션을 <b>더블클릭</b>하여 열거나,<br>프로젝트 옆 <b>+</b> 버튼으로 새 세션을 시작하세요.</p>
          </div>
        </div>
        <div id="terminal-status-bar" class="terminal-status-bar"></div>
      </div>
      <button id="sidebar-edge-trigger" class="sidebar-edge-trigger" title="사이드바 열기">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  `;

  applySidebarLayout();
  const edgeTrigger = document.getElementById("sidebar-edge-trigger");
  if (edgeTrigger) edgeTrigger.addEventListener("click", toggleSidebarHidden);
  const hideBtn = document.getElementById("sidebar-hide-btn");
  if (hideBtn) hideBtn.addEventListener("click", toggleSidebarHidden);

  initSidebarResizer();

  const searchInput = document.getElementById("search") as HTMLInputElement;
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    renderTree();
  });

  document.getElementById("filter-toggle-btn")!.addEventListener("click", () => {
    filtersPanelOpen = !filtersPanelOpen;
    const area = document.getElementById("filters-area")!;
    area.style.display = filtersPanelOpen ? "" : "none";
    const btn = document.getElementById("filter-toggle-btn")!;
    btn.classList.toggle("active", filtersPanelOpen);
    if (filtersPanelOpen) renderChips();
  });

  document.getElementById("open-here-btn")!.addEventListener("click", () => {
    void openClaudeHere(globalNewWindow);
  });
  document.getElementById("refresh-btn")!.addEventListener("click", () => void loadSessions());
  document.getElementById("settings-btn")!.addEventListener("click", () => void openSettings());

  (document.getElementById("global-skip") as HTMLInputElement).addEventListener("change", async (e) => {
    globalSkipPermissions = (e.target as HTMLInputElement).checked;
    try { await invoke("set_skip_permissions", { value: globalSkipPermissions }); } catch {}
  });
  (document.getElementById("global-newwin") as HTMLInputElement).addEventListener("change", (e) => {
    globalNewWindow = (e.target as HTMLInputElement).checked;
  });

  // Filter chips
  document.getElementById("chips-area")!.addEventListener("click", (e) => {
    const pc = (e.target as HTMLElement).closest("[data-project-chip]") as HTMLElement | null;
    if (pc) {
      const val = pc.dataset.projectChip!;
      filterProjectLabel = val === "__all__" ? null : (filterProjectLabel === val ? null : val);
      filterSessionLabel = null;
      renderChips();
      renderTree();
      return;
    }
    const sc = (e.target as HTMLElement).closest("[data-session-chip]") as HTMLElement | null;
    if (sc) {
      const val = sc.dataset.sessionChip!;
      if (val === "__all__") filterSessionLabel = null;
      else if (val === "__none__") filterSessionLabel = filterSessionLabel === "" ? null : "";
      else filterSessionLabel = filterSessionLabel === val ? null : val;
      renderChips();
      renderTree();
    }
  });

  const contentArea = document.getElementById("content-area")!;

  // Folder/label-group toggle + folder add-btn
  contentArea.addEventListener("click", (e) => {
    const addBtn = (e.target as HTMLElement).closest('[data-action="new-in-folder"]') as HTMLElement | null;
    if (addBtn) {
      e.stopPropagation();
      const folder = addBtn.dataset.folderId!;
      const path = addBtn.dataset.folderPath!;
      void startNewSessionInProject(path, folder, globalNewWindow);
      return;
    }
    const header = (e.target as HTMLElement).closest("[data-folder-toggle]") as HTMLElement | null;
    if (header) {
      const fid = header.dataset.folderToggle!;
      if (collapsedProjects.has(fid)) collapsedProjects.delete(fid);
      else collapsedProjects.add(fid);
      saveCollapsed();
      renderTree();
    }
  });

  // Double-click session → open as tab
  contentArea.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest("[data-session-id]") as HTMLElement | null;
    if (!row) return;
    const sid = row.dataset.sessionId!;
    const folder = row.dataset.projectFolder!;
    const path = row.dataset.projectPath!;
    void resumeSession(sid, path, folder, globalNewWindow);
  });

  // Right-click context menu (sessions & folders)
  contentArea.addEventListener("contextmenu", (e) => {
    const sessionEl = (e.target as HTMLElement).closest("[data-session-id]") as HTMLElement | null;
    if (sessionEl) {
      e.preventDefault();
      const sid = sessionEl.dataset.sessionId!;
      const folder = sessionEl.dataset.projectFolder!;
      const path = sessionEl.dataset.projectPath!;
      const isFav = favoriteSessions.has(sid);
      const s = allSessions.find((x) => x.session_id === sid);
      const resolvedAcc = resolveSessionAccountName(s);
      const accLabel = (() => {
        const a = accountByName(resolvedAcc);
        return a ? accountDisplay(a) : resolvedAcc;
      })();
      showContextMenu(e.clientX, e.clientY, [
        { label: `재개 (${accLabel})`, icon: ICONS.terminal, action: () => void resumeSession(sid, path, folder, false) },
        { label: "새 창에서 재개", icon: ICONS.newWindow, action: () => void resumeSession(sid, path, folder, true) },
        { label: "-", action: () => {} },
        { label: "Sonnet으로 재개", icon: ICONS.cpu, action: () => void resumeSession(sid, path, folder, false, "sonnet") },
        { label: "Opus로 재개", icon: ICONS.cpu, action: () => void resumeSession(sid, path, folder, false, "opus") },
        { label: "-", action: () => {} },
        { label: "다른 계정으로 재개...", icon: ICONS.claude, action: () => void resumeWithAccountPicker(sid, path, folder) },
        { label: "이 세션의 계정 고정...", icon: ICONS.tag, action: () => void pinSessionAccount(sid) },
        { label: "-", action: () => {} },
        { label: isFav ? "즐겨찾기 해제" : "즐겨찾기 추가", icon: isFav ? ICONS.starOutline : ICONS.star, action: () => void toggleFavorite(sid) },
        { label: "-", action: () => {} },
        { label: "제목 편집", icon: ICONS.edit, action: () => void editSessionTitle(sid) },
        { label: "라벨 편집", icon: ICONS.tag, action: () => void editSessionLabels(sid) },
        { label: "-", action: () => {} },
        { label: "삭제", icon: ICONS.trash, action: () => void deleteSession(sid, folder), danger: true },
      ]);
      return;
    }
    const groupEl = (e.target as HTMLElement).closest("[data-group-label]") as HTMLElement | null;
    if (groupEl) {
      e.preventDefault();
      const label = groupEl.dataset.groupLabel!;
      showContextMenu(e.clientX, e.clientY, [
        { label: "그룹 라벨 편집", icon: ICONS.edit, action: () => void editGroupLabel(label) },
        { label: "-", action: () => {} },
        { label: "그룹 세션 전체 삭제", icon: ICONS.trash, action: () => void deleteGroupSessions(label), danger: true },
      ]);
      return;
    }
    const folderEl = (e.target as HTMLElement).closest("[data-folder-id]") as HTMLElement | null;
    if (folderEl) {
      e.preventDefault();
      const folder = folderEl.dataset.folderId!;
      const path = folderEl.dataset.folderPath!;
      showContextMenu(e.clientX, e.clientY, [
        { label: "새 세션 시작", icon: ICONS.plus, action: () => void startNewSessionInProject(path, folder, false) },
        { label: "새 창에서 새 세션", icon: ICONS.newWindow, action: () => void startNewSessionInProject(path, folder, true) },
        { label: "-", action: () => {} },
        { label: "Sonnet으로 새 세션", icon: ICONS.cpu, action: () => void startNewSessionInProject(path, folder, false, "sonnet") },
        { label: "Opus로 새 세션", icon: ICONS.cpu, action: () => void startNewSessionInProject(path, folder, false, "opus") },
        { label: "-", action: () => {} },
        { label: "계정 선택해서 새 세션...", icon: ICONS.claude, action: () => void startWithAccountPicker(path, folder) },
        { label: "-", action: () => {} },
        { label: "프로젝트 라벨 편집", icon: ICONS.edit, action: () => void editProjectLabel(folder, path) },
        { label: "-", action: () => {} },
        { label: "프로젝트 세션 전체 삭제", icon: ICONS.trash, action: () => void deleteProjectSessions(folder, path), danger: true },
      ]);
    }
  });

  // Session double-click safety: ensure welcome hides when first tab appears
  const tabsEl = document.getElementById("tabs")!;
  const tabsObserver = new MutationObserver(() => {
    const welcome = document.getElementById("welcome-screen");
    if (!welcome) return;
    welcome.style.display = tabsEl.children.length > 0 ? "none" : "";
  });
  tabsObserver.observe(tabsEl, { childList: true });

  renderChips();
  renderTree();
}

// --- Load ---

async function loadSessions() {
  try {
    const [sessions, labels] = await Promise.all([
      invoke<SessionInfo[]>("get_sessions"),
      invoke<Record<string, string>>("get_project_labels"),
    ]);
    allSessions = sessions;
    projectLabels = labels;
    renderChips();
    renderTree();
  } catch (e) {
    const area = document.getElementById("content-area");
    if (area) area.innerHTML = `<div class="empty" style="color:#ff6b6b">세션 로드 실패: ${e}</div>`;
  }
}

// --- Bootstrap ---

if (!IS_TERMINAL_WINDOW) {
  (async () => {
    // Pre-apply saved theme to :root BEFORE rendering so the initial paint uses
    // the user's theme (no flash from default → saved).
    try {
      const savedTheme = await invoke<string | null>("get_terminal_theme");
      if (savedTheme) applyUiTheme(getTheme(savedTheme).ui);
    } catch {}
    // Load saved global toggles before rendering so the checkbox reflects state.
    try { globalSkipPermissions = await invoke<boolean>("get_skip_permissions"); } catch {}
    try {
      const favs = await invoke<string[]>("get_favorite_sessions");
      favoriteSessions = new Set(favs);
    } catch {}
    // Hydrate account state before first render so badges/mappings show up.
    try { allAccounts = await invoke<Account[]>("get_accounts"); } catch {}
    try { labelAccountMap = await invoke<Record<string, string>>("get_label_account_map"); } catch {}
    try { sessionAccountMap = await invoke<Record<string, string>>("get_session_account_map"); } catch {}
    try {
      lastOauthMulti = await invoke<AccountOauthUsage[]>("get_cached_oauth_usages_per_account");
    } catch {}
    renderShell();
    // Now that the first paint with correct theme is done, reveal the window.
    // (tauri.conf.json has visible:false so window-state can restore size without flash.)
    try { await getCurrentWindow().show(); } catch {}
    await loadSessions();
    // Load terminal module AFTER the DOM is ready so it can mount into
    // #tabs / #terminals created by renderShell.
    await import("./terminal");
    // Kick off usage: initial snapshot + live listener.
    void refreshUsage();
    listen<UsageReport>("usage-update", (event) => {
      lastUsageReport = event.payload;
      renderUsageStatus(event.payload);
    });
    // Anthropic OAuth rate-limit endpoint (real /usage data, 60s poll).
    listen<OauthUsage>("usage-oauth-update", (event) => {
      lastOauthUsage = event.payload;
      lastOauthError = null;
      renderUsageStatus(lastUsageReport);
      renderUsagePanelIfOpen(lastUsageReport ?? undefined);
    });
    listen<AccountOauthUsage[]>("usage-oauth-multi-update", (event) => {
      lastOauthMulti = event.payload || [];
      renderUsageStatus(lastUsageReport);
    });
    listen<Account[]>("accounts-update", (event) => {
      allAccounts = event.payload || [];
      renderUsageStatus(lastUsageReport);
      renderTree();
    });
    listen<string>("usage-oauth-error", (event) => {
      lastOauthError = event.payload;
      renderUsageStatus(lastUsageReport);
    });
    // Cross-window toggle: a term-* window pressed Ctrl+Shift+B — flip + broadcast.
    listen("statusbar-toggle-request", () => setStatusBarVisible(!statusBarVisible));
  })();
}
