import { invoke } from "@tauri-apps/api/core";
import { open, confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";

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
  label: string;
  custom_title: string;
}

// --- State ---

let allSessions: SessionInfo[] = [];
let projectLabels: Record<string, string> = {}; // folder_name -> label
let searchQuery = "";
let filterProject = ""; // project_path (from select)
let filterProjectLabel: string | null = null; // null=all, "CCC"=grouped by project label
let filterSessionLabel: string | null = null; // null=all, ""=unlabeled, "xxx"=specific

// --- Helpers ---

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

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function getProjectLabel(folder: string): string {
  return projectLabels[folder] || "";
}

function getProjectDisplayName(folder: string, path: string): string {
  const label = getProjectLabel(folder);
  return label ? `${label} / ${path}` : path;
}

/** Get folders that match a project label */
function getFoldersForProjectLabel(label: string): Set<string> {
  const folders = new Set<string>();
  for (const [folder, l] of Object.entries(projectLabels)) {
    if (l === label) folders.add(folder);
  }
  return folders;
}

// --- Filters ---

function getFilteredSessions(): SessionInfo[] {
  const q = searchQuery.toLowerCase();
  return allSessions.filter((s) => {
    const projLabel = getProjectLabel(s.project_folder).toLowerCase();
    const matchesSearch =
      !q ||
      s.first_prompt.toLowerCase().includes(q) ||
      s.summary.toLowerCase().includes(q) ||
      s.label.toLowerCase().includes(q) ||
      s.custom_title.toLowerCase().includes(q) ||
      s.project_path.toLowerCase().includes(q) ||
      s.git_branch.toLowerCase().includes(q) ||
      projLabel.includes(q);

    // Project filter: select takes priority, then chip
    let matchesProject = true;
    if (filterProject) {
      matchesProject = s.project_path === filterProject;
    } else if (filterProjectLabel !== null) {
      const folders = getFoldersForProjectLabel(filterProjectLabel);
      matchesProject = folders.has(s.project_folder);
    }

    const matchesLabel =
      filterSessionLabel === null ||
      (filterSessionLabel === "" ? !s.label : s.label === filterSessionLabel);

    return matchesSearch && matchesProject && matchesLabel;
  });
}

function getProjects(): { folder: string; path: string }[] {
  const map = new Map<string, string>();
  for (const s of allSessions) {
    if (!map.has(s.project_path)) {
      map.set(s.project_path, s.project_folder);
    }
  }
  return Array.from(map.entries())
    .map(([path, folder]) => ({ path, folder }))
    .sort((a, b) => {
      const la = getProjectLabel(a.folder);
      const lb = getProjectLabel(b.folder);
      if (la && !lb) return -1;
      if (!la && lb) return 1;
      if (la && lb) return la.localeCompare(lb, "ko");
      return a.path.localeCompare(b.path, "ko");
    });
}

/** Get grouped project labels for chips: { label, count (projects), sessionCount } */
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

/** Get session labels for currently active filter */
function getSessionLabelsForChips(): { name: string; count: number }[] {
  // Get sessions matching current project filter (select or chip)
  const filtered = allSessions.filter((s) => {
    if (filterProject) return s.project_path === filterProject;
    if (filterProjectLabel !== null) {
      const folders = getFoldersForProjectLabel(filterProjectLabel);
      return folders.has(s.project_folder);
    }
    return true;
  });

  const map = new Map<string, number>();
  let unlabeled = 0;
  for (const s of filtered) {
    if (s.label) {
      map.set(s.label, (map.get(s.label) || 0) + 1);
    } else {
      unlabeled++;
    }
  }
  const labels = Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  if (unlabeled > 0) {
    labels.push({ name: "", count: unlabeled });
  }
  return labels;
}

// --- Actions ---

function buildTabTitle(sessionId: string): string {
  const session = allSessions.find(s => s.session_id === sessionId);
  if (!session) return "Claude Session";
  // project name: use label > last segment of project_path
  const pp = session.project_path.replace(/\\/g, "/");
  const lastSegment = pp.split("/").filter(Boolean).pop() || "";
  const projectName = getProjectLabel(session.project_folder) || lastSegment;
  const title = session.custom_title || session.label || session.first_prompt?.slice(0, 50) || "";
  if (projectName && title) return `${projectName}:${title}`;
  if (projectName) return projectName;
  if (title) return title;
  // fallback: drive:/last2
  const parts = pp.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const drive = parts[0].replace(":", "");
    return `${drive}:/${parts.slice(-2).join("/")}`;
  }
  return pp || parts[0] || "Claude";
}

async function resumeSession(sessionId: string, projectPath: string, skipPermissions: boolean) {
  const perSession = document.querySelector(`input[data-newwin-for="${sessionId}"]`) as HTMLInputElement | null;
  const globalEl = document.getElementById("global-new-window") as HTMLInputElement | null;
  const newWindow = perSession?.checked ?? globalEl?.checked ?? false;
  const tabTitle = buildTabTitle(sessionId);
  try {
    await invoke("resume_session", { sessionId, projectPath, skipPermissions, newWindow, tabTitle });
  } catch (e) {
    alert("실행 실패: " + e);
  }
}

async function openClaudeHere() {
  const selected = await open({ directory: true, multiple: false, title: "Claude를 열 폴더 선택" });
  if (!selected) return;

  const path = typeof selected === "string" ? selected : selected;
  const skipEl = document.getElementById("open-here-skip") as HTMLInputElement | null;
  const skip = skipEl?.checked ?? false;

  try {
    await invoke("open_claude", { projectPath: path, skipPermissions: skip });
  } catch (e) {
    alert("실행 실패: " + e);
  }
}

async function setSessionTitle(sessionId: string) {
  const session = allSessions.find((s) => s.session_id === sessionId);
  const current = session?.custom_title || "";
  const title = prompt("커스텀 제목 입력 (비우면 삭제):", current);
  if (title === null) return;

  try {
    await invoke("set_session_title", { sessionId, title });
    if (session) session.custom_title = title;
    renderList();
  } catch (e) {
    alert("제목 저장 실패: " + e);
  }
}

async function setSessionLabel(sessionId: string) {
  const session = allSessions.find((s) => s.session_id === sessionId);
  const current = session?.label || "";
  const label = prompt("세션 라벨 입력 (비우면 삭제):", current);
  if (label === null) return;

  try {
    await invoke("set_label", { sessionId, label });
    if (session) session.label = label;
    renderChips();
    renderList();
  } catch (e) {
    alert("라벨 저장 실패: " + e);
  }
}

async function setProjectLabel(folder: string, currentPath: string) {
  const current = getProjectLabel(folder);
  const label = prompt(
    `프로젝트 라벨 입력 (비우면 삭제):\n${currentPath}`,
    current
  );
  if (label === null) return;

  try {
    await invoke("set_project_label", { projectFolder: folder, label });
    if (label) {
      projectLabels[folder] = label;
    } else {
      delete projectLabels[folder];
    }
    renderProjectFilter();
    renderChips();
    renderList();
  } catch (e) {
    alert("프로젝트 라벨 저장 실패: " + e);
  }
}

let deleteInProgress = false;
async function deleteSession(sessionId: string, projectFolder: string) {
  if (deleteInProgress) return;
  deleteInProgress = true;
  try {
    const session = allSessions.find((s) => s.session_id === sessionId);
    const desc = session?.custom_title || session?.label || session?.first_prompt?.slice(0, 40) || sessionId;
    const ok = await tauriConfirm(`"${desc}" 세션을 삭제할까요?`, { title: "세션 삭제", kind: "warning" });
    if (!ok) return;

    await invoke("delete_session", { sessionId, projectFolder });
    allSessions = allSessions.filter((s) => s.session_id !== sessionId);
    renderChips();
    renderList();
    renderProjectFilter();
  } catch (e) {
    alert("삭제 실패: " + e);
  } finally {
    deleteInProgress = false;
  }
}

async function deleteCurrentProject() {
  if (!filterProject) return;
  const sessions = allSessions.filter((s) => s.project_path === filterProject);
  const folder = sessions[0]?.project_folder;
  if (!folder) return;

  const ok = await tauriConfirm(
    `"${getProjectDisplayName(folder, filterProject)}" 프로젝트의 세션 ${sessions.length}개를 모두 삭제할까요?\n\n(되돌릴 수 없습니다)`,
    { title: "프로젝트 세션 전체 삭제", kind: "warning" }
  );
  if (!ok) return;

  try {
    await invoke("delete_project_sessions", { projectFolder: folder });
    allSessions = allSessions.filter((s) => s.project_folder !== folder);
    delete projectLabels[folder];
    filterProject = "";
    filterProjectLabel = null;
    filterSessionLabel = null;
    renderProjectFilter();
    renderChips();
    renderList();
  } catch (e) {
    alert("삭제 실패: " + e);
  }
}

// --- Render ---

function renderStats() {
  const el = document.getElementById("stats");
  if (!el) return;
  const filtered = getFilteredSessions();
  el.textContent = `전체 ${allSessions.length}개 세션 · ${filtered.length}개 표시`;
}

function renderProjectFilter() {
  const el = document.getElementById("project-filter") as HTMLSelectElement | null;
  if (!el) return;
  const projects = getProjects();
  el.innerHTML =
    `<option value="">전체 프로젝트</option>` +
    projects
      .map((p) => {
        const display = getProjectDisplayName(p.folder, p.path);
        return `<option value="${escapeHtml(p.path)}" ${p.path === filterProject ? "selected" : ""}>${escapeHtml(display)}</option>`;
      })
      .join("");

  const deleteBtn = document.getElementById("delete-project-btn") as HTMLElement | null;
  if (deleteBtn) deleteBtn.style.display = filterProject ? "flex" : "none";

  const editBtn = document.getElementById("edit-project-label-btn") as HTMLElement | null;
  if (editBtn) editBtn.style.display = filterProject ? "flex" : "none";
}

function renderChips() {
  const container = document.getElementById("chips-area");
  if (!container) return;

  // --- Project label chips (1st row) — grouped by label name ---
  const groups = getProjectLabelGroups();
  let projectChipsHtml = "";
  if (groups.length > 0) {
    const isAllActive = filterProjectLabel === null && !filterProject;
    projectChipsHtml =
      `<div class="chip-row">` +
      `<button class="chip ${isAllActive ? "active" : ""}" data-project-chip="__all__">전체</button>` +
      groups
        .map((g) => {
          const isActive = filterProjectLabel === g.label;
          const countSuffix = g.projectCount > 1 ? ` (${g.projectCount})` : "";
          return `<button class="chip ${isActive ? "active" : ""}" data-project-chip="${escapeHtml(g.label)}">${escapeHtml(g.label)}${countSuffix}</button>`;
        })
        .join("") +
      `</div>`;
  }

  // --- Session label chips (2nd row, when project or project-label is selected) ---
  let sessionChipsHtml = "";
  if (filterProject || filterProjectLabel !== null) {
    const sessionLabels = getSessionLabelsForChips();
    if (sessionLabels.length > 0) {
      sessionChipsHtml =
        `<div class="chip-row chip-row-sub">` +
        `<button class="chip chip-sub ${filterSessionLabel === null ? "active" : ""}" data-session-chip="__all__">전체</button>` +
        sessionLabels
          .map((l) => {
            const isActive =
              (l.name === "" && filterSessionLabel === "") ||
              (l.name !== "" && filterSessionLabel === l.name);
            const displayName = l.name || "라벨 없음";
            const value = l.name === "" ? "__none__" : l.name;
            return `<button class="chip chip-sub ${isActive ? "active" : ""}" data-session-chip="${escapeHtml(value)}">${escapeHtml(displayName)}<span class="chip-count">${l.count}</span></button>`;
          })
          .join("") +
        `</div>`;
    }
  }

  container.innerHTML = projectChipsHtml + sessionChipsHtml;
}

function renderList() {
  const container = document.getElementById("content-area");
  if (!container) return;

  const sessions = getFilteredSessions();

  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty">세션이 없습니다</div>';
    renderStats();
    return;
  }

  container.innerHTML = sessions
    .map(
      (s) => `
    <div class="card">
      <div class="card-top">
        <div class="card-left">
          <span class="label-btn ${s.label ? "active" : ""}" data-action="label" data-id="${s.session_id}">
            ${s.label ? escapeHtml(s.label) : "라벨 추가"}
          </span>
          <span class="time">${timeAgo(s.modified)}</span>
        </div>
        <div class="card-right">
          <button class="btn-icon btn-delete" data-action="delete" data-id="${s.session_id}" data-folder="${escapeHtml(s.project_folder)}" title="삭제">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/></svg>
          </button>
        </div>
      </div>
      <div class="card-prompt">
        ${s.custom_title
          ? `<span class="custom-title">${escapeHtml(s.custom_title)}</span>`
          : `<span>${escapeHtml(s.first_prompt || "(내용 없음)")}</span>`}
        <button class="btn-icon btn-title" data-action="title" data-id="${s.session_id}" title="커스텀 제목 편집">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
      ${s.summary ? `<div class="card-summary">${escapeHtml(s.summary)}</div>` : ""}
      <div class="card-tags">
        <span class="tag tag-project">${escapeHtml(getProjectLabel(s.project_folder) || s.project_path)}</span>
        ${s.git_branch ? `<span class="tag tag-branch">${escapeHtml(s.git_branch)}</span>` : ""}
        <span class="tag">${s.message_count}개 메시지</span>
      </div>
      <div class="card-actions">
        <label class="toggle-skip" title="--dangerously-skip-permissions">
          <input type="checkbox" data-skip-for="${s.session_id}" checked />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-text">퍼미션 스킵</span>
        </label>
        <label class="toggle-skip" title="New Window (OFF = attach as tab)">
          <input type="checkbox" data-newwin-for="${s.session_id}" />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-text">New Window</span>
        </label>
        <button class="btn-resume" data-action="resume" data-id="${s.session_id}" data-project="${escapeHtml(s.project_path)}">
          Resume
        </button>
      </div>
    </div>
  `
    )
    .join("");

  renderStats();
}

function renderShell() {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="container">
      <header>
        <div class="toolbar">
          <div class="search-wrap">
            <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <input type="text" id="search" placeholder="검색..." />
          </div>
          <button id="refresh-btn" class="btn-ghost" title="새로고침">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>
          </button>
        </div>
        <div class="open-here-bar">
          <button id="open-here-btn" class="btn-open-here">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            폴더에서 Claude 열기
          </button>
          <label class="toggle-skip" title="--dangerously-skip-permissions">
            <input type="checkbox" id="open-here-skip" checked />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-text">퍼미션 스킵</span>
          </label>
          <label class="toggle-skip" title="New Window (OFF = attach as tab in existing terminal)">
            <input type="checkbox" id="global-new-window" />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
            <span class="toggle-text">New Window</span>
          </label>
        </div>
        <div class="toolbar-row2">
          <select id="project-filter"></select>
          <button id="edit-project-label-btn" class="btn-ghost btn-sm" style="display:none" title="프로젝트 라벨 편집">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button id="delete-project-btn" class="btn-danger" style="display:none" title="현재 프로젝트 세션 전체 삭제">
            전체 삭제
          </button>
        </div>
        <div id="chips-area"></div>
        <div class="stats" id="stats"></div>
      </header>
      <div id="content-area" class="session-list"></div>
    </div>
  `;

  // Search
  const searchInput = document.getElementById("search") as HTMLInputElement;
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    renderList();
  });

  // Open Claude here — folder picker
  document.getElementById("open-here-btn")!.addEventListener("click", openClaudeHere);

  // Project filter select — specific project
  const projectFilter = document.getElementById("project-filter") as HTMLSelectElement;
  projectFilter.addEventListener("change", () => {
    filterProject = projectFilter.value;
    // When select is used, clear chip filter
    if (filterProject) {
      filterProjectLabel = null;
    }
    filterSessionLabel = null;
    renderProjectFilter();
    renderChips();
    renderList();
  });

  document.getElementById("refresh-btn")!.addEventListener("click", loadSessions);
  document.getElementById("delete-project-btn")!.addEventListener("click", deleteCurrentProject);

  // Edit project label
  document.getElementById("edit-project-label-btn")!.addEventListener("click", () => {
    if (!filterProject) return;
    const folder = allSessions.find((s) => s.project_path === filterProject)?.project_folder;
    if (folder) setProjectLabel(folder, filterProject);
  });

  // Chips — event delegation
  document.getElementById("chips-area")!.addEventListener("click", (e) => {
    const projectChip = (e.target as HTMLElement).closest("[data-project-chip]") as HTMLElement | null;
    if (projectChip) {
      const val = projectChip.dataset.projectChip!;
      if (val === "__all__") {
        filterProjectLabel = null;
      } else {
        filterProjectLabel = filterProjectLabel === val ? null : val;
      }
      // Clear select when using chips
      filterProject = "";
      const sel = document.getElementById("project-filter") as HTMLSelectElement;
      if (sel) sel.value = "";
      filterSessionLabel = null;
      renderProjectFilter();
      renderChips();
      renderList();
      return;
    }

    const sessionChip = (e.target as HTMLElement).closest("[data-session-chip]") as HTMLElement | null;
    if (sessionChip) {
      const val = sessionChip.dataset.sessionChip!;
      if (val === "__all__") {
        filterSessionLabel = null;
      } else if (val === "__none__") {
        filterSessionLabel = filterSessionLabel === "" ? null : "";
      } else {
        filterSessionLabel = filterSessionLabel === val ? null : val;
      }
      renderChips();
      renderList();
    }
  });

  // Card actions
  document.getElementById("content-area")!.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!target) return;
    e.stopPropagation();

    const action = target.dataset.action;
    if (action === "resume") {
      const sessionId = target.dataset.id!;
      const projectPath = target.dataset.project!;
      const skipCb = document.querySelector(`input[data-skip-for="${sessionId}"]`) as HTMLInputElement | null;
      const skip = skipCb?.checked ?? false;
      resumeSession(sessionId, projectPath, skip);
    } else if (action === "title") {
      setSessionTitle(target.dataset.id!);
    } else if (action === "label") {
      setSessionLabel(target.dataset.id!);
    } else if (action === "delete") {
      deleteSession(target.dataset.id!, target.dataset.folder!);
    }
  });

  renderProjectFilter();
  renderChips();
  renderList();
}

async function loadSessions() {
  try {
    const [sessions, labels] = await Promise.all([
      invoke<SessionInfo[]>("get_sessions"),
      invoke<Record<string, string>>("get_project_labels"),
    ]);
    allSessions = sessions;
    projectLabels = labels;
    renderProjectFilter();
    renderChips();
    renderList();
  } catch (e) {
    const area = document.getElementById("content-area");
    if (area)
      area.innerHTML = `<div class="empty" style="color:#ff6b6b">세션 로드 실패: ${e}</div>`;
  }
}

(async () => {
  renderShell();
  await loadSessions();
})();
