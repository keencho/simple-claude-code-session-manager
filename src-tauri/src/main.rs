#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

// --- sessions-index.json structures ---

#[derive(Debug, Deserialize)]
struct IndexEntry {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "firstPrompt", default)]
    first_prompt: Option<String>,
    summary: Option<String>,
    #[serde(rename = "messageCount", default)]
    message_count: u32,
    created: Option<String>,
    modified: Option<String>,
    #[serde(rename = "gitBranch", default)]
    git_branch: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionsIndex {
    #[serde(default)]
    entries: Vec<IndexEntry>,
    #[serde(rename = "originalPath", default)]
    original_path: Option<String>,
}

// --- Output structures ---

#[derive(Debug, Serialize, Clone)]
struct SessionInfo {
    session_id: String,
    first_prompt: String,
    summary: String,
    message_count: u32,
    created: String,
    modified: String,
    git_branch: String,
    project_path: String,
    project_folder: String,
    labels: Vec<String>,
    custom_title: String,
}

unsafe impl Send for SessionInfo {}

#[derive(Debug, Serialize, Clone)]
struct ProjectInfo {
    folder_name: String,
    project_path: String,
    session_count: u32,
}

// --- Labels ---

#[derive(Debug, Clone, Default)]
struct Labels {
    labels: HashMap<String, Vec<String>>,
}

impl<'de> Deserialize<'de> for Labels {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawLabels {
            #[serde(default)]
            labels: HashMap<String, serde_json::Value>,
        }
        let raw = RawLabels::deserialize(deserializer)?;
        let mut labels = HashMap::new();
        for (k, v) in raw.labels {
            let vec = match v {
                serde_json::Value::String(s) => if s.is_empty() { vec![] } else { vec![s] },
                serde_json::Value::Array(arr) => arr.into_iter().filter_map(|item| item.as_str().map(String::from)).collect(),
                _ => vec![],
            };
            labels.insert(k, vec);
        }
        Ok(Labels { labels })
    }
}

impl Serialize for Labels {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: serde::Serializer {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry("labels", &self.labels)?;
        map.end()
    }
}

// --- PTY types ---

struct PtyInstance {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    terminal_id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    terminal_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct AddTabPayload {
    terminal_id: String,
    title: String,
    ssh_args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    adopt: bool,
    #[serde(default)]
    initial_content: String,
}

#[derive(Clone, Serialize)]
struct MergeTabPayload {
    terminal_id: String,
    title: String,
    ssh_args: Vec<String>,
    cwd: Option<String>,
    initial_content: String,
    screen_x: f64,
    screen_y: f64,
}

// --- App state ---

struct AppState {
    ptys: Mutex<HashMap<String, Arc<PtyInstance>>>,
    pending_tabs: Mutex<HashMap<String, AddTabPayload>>,
    #[allow(dead_code)]
    runtime: tokio::runtime::Runtime,
}

// --- Cache ---

#[derive(Default)]
struct AppCache {
    sessions: Vec<SessionInfo>,
}

// --- Config ---

#[derive(Serialize, Deserialize, Default)]
struct AppConfig {
    #[serde(default)]
    terminal_theme: Option<String>,
    #[serde(default)]
    log_dir: Option<String>,
    #[serde(default)]
    claude_verbose: Option<bool>,
    #[serde(default)]
    skip_permissions: Option<bool>,
}

fn get_config_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let new_dir = home.join(".simple-claude-manager");
    let old_dir = home.join(".keencho-claude");
    if !new_dir.exists() && old_dir.exists() {
        let _ = fs::rename(&old_dir, &new_dir);
    }
    if !new_dir.exists() {
        fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
    }
    Ok(new_dir)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(get_config_dir()?.join("config.json"))
}

fn load_config() -> AppConfig {
    let Ok(p) = config_path() else { return AppConfig::default() };
    fs::read_to_string(p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let p = config_path()?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(p, json).map_err(|e| e.to_string())
}

// --- Helpers ---

fn get_claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn get_labels_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("session-labels.json"))
}

fn get_project_labels_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("project-labels.json"))
}

fn get_session_titles_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("session-titles.json"))
}

fn load_session_titles() -> HashMap<String, String> {
    get_session_titles_path().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_session_titles(titles: &HashMap<String, String>) -> Result<(), String> {
    let path = get_session_titles_path().ok_or("Cannot find home directory")?;
    let json = serde_json::to_string_pretty(titles).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn load_labels() -> Labels {
    get_labels_path().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_labels(labels: &Labels) -> Result<(), String> {
    let path = get_labels_path().ok_or("Cannot find home directory")?;
    let json = serde_json::to_string_pretty(labels).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn load_project_labels() -> HashMap<String, String> {
    get_project_labels_path().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_project_labels(labels: &HashMap<String, String>) -> Result<(), String> {
    let path = get_project_labels_path().ok_or("Cannot find home directory")?;
    let json = serde_json::to_string_pretty(labels).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn extract_first_prompt_from_jsonl(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::with_capacity(16384, file);
    for line in reader.lines().take(30) {
        let line = line.ok()?;
        if !line.contains("\"type\":\"user\"") && !line.contains("\"type\": \"user\"") { continue; }
        let v: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue; }
        let msg = v.get("message")?;
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") { continue; }
        let content = msg.get("content")?;
        match content {
            serde_json::Value::String(s) => return Some(s.chars().take(200).collect()),
            serde_json::Value::Array(arr) => {
                for item in arr {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            return Some(text.chars().take(200).collect());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn estimate_message_count(path: &Path) -> u32 {
    fs::metadata(path).map(|m| std::cmp::max(1, (m.len() / 2048) as u32)).unwrap_or(1)
}

fn file_time_to_rfc3339(path: &Path, use_modified: bool) -> String {
    fs::metadata(path).ok()
        .and_then(|m| if use_modified { m.modified().ok() } else { m.created().ok() })
        .map(|t| { let dt: chrono::DateTime<chrono::Utc> = t.into(); dt.to_rfc3339() })
        .unwrap_or_default()
}

fn decode_folder_to_path(folder: &str) -> String {
    let mut result = String::new();
    let mut chars = folder.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '-' {
            if chars.peek() == Some(&'-') { chars.next(); result.push(':'); result.push('\\'); }
            else { result.push('\x00'); }
        } else { result.push(ch); }
    }
    resolve_ambiguous_path(&result)
}

fn resolve_ambiguous_path(template: &str) -> String {
    let parts: Vec<&str> = template.split('\x00').collect();
    if parts.len() <= 1 { return template.replace('\x00', "-"); }
    fn find_best(parts: &[&str], idx: usize, current: String) -> Option<String> {
        if idx >= parts.len() { return if Path::new(&current).exists() { Some(current) } else { None }; }
        if idx == 0 { return find_best(parts, 1, parts[0].to_string()); }
        let with_sep = format!("{}\\{}", current, parts[idx]);
        if let Some(r) = find_best(parts, idx + 1, with_sep) { return Some(r); }
        let with_hyphen = format!("{}-{}", current, parts[idx]);
        find_best(parts, idx + 1, with_hyphen)
    }
    if let Some(resolved) = find_best(&parts, 0, String::new()) { return resolved; }
    parts.join("\\")
}

fn scan_project(project_dir: &Path, folder_name: &str, labels: &Labels, titles: &HashMap<String, String>) -> Vec<SessionInfo> {
    let mut sessions = Vec::new();
    let index_path = project_dir.join("sessions-index.json");
    let index: Option<SessionsIndex> = if index_path.exists() {
        fs::read_to_string(&index_path).ok().and_then(|s| serde_json::from_str(&s).ok())
    } else { None };
    let project_path = index.as_ref().and_then(|i| i.original_path.clone()).unwrap_or_else(|| decode_folder_to_path(folder_name));
    let indexed: HashMap<String, &IndexEntry> = index.as_ref()
        .map(|idx| idx.entries.iter().map(|e| (e.session_id.clone(), e)).collect())
        .unwrap_or_default();
    let jsonl_files: Vec<_> = fs::read_dir(project_dir).into_iter().flatten().flatten()
        .filter(|e| { let p = e.path(); !p.is_dir() && p.extension().map(|ext| ext == "jsonl").unwrap_or(false) })
        .collect();
    for file_entry in jsonl_files {
        let file_path = file_entry.path();
        let session_id = file_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let labels_vec = labels.labels.get(&session_id).cloned().unwrap_or_default();
        let custom_title = titles.get(&session_id).cloned().unwrap_or_default();
        if let Some(idx) = indexed.get(&session_id) {
            sessions.push(SessionInfo { session_id, first_prompt: idx.first_prompt.clone().unwrap_or_default(), summary: idx.summary.clone().unwrap_or_default(), message_count: idx.message_count, created: idx.created.clone().unwrap_or_default(), modified: idx.modified.clone().unwrap_or_default(), git_branch: idx.git_branch.clone().unwrap_or_default(), project_path: project_path.clone(), project_folder: folder_name.to_string(), labels: labels_vec, custom_title });
        } else {
            let first_prompt = extract_first_prompt_from_jsonl(&file_path).unwrap_or_default();
            let msg_count = estimate_message_count(&file_path);
            let modified = file_time_to_rfc3339(&file_path, true);
            let created = file_time_to_rfc3339(&file_path, false);
            sessions.push(SessionInfo { session_id, first_prompt, summary: String::new(), message_count: msg_count, created, modified, git_branch: String::new(), project_path: project_path.clone(), project_folder: folder_name.to_string(), labels: labels_vec, custom_title });
        }
    }
    sessions
}

fn scan_all_sessions() -> Result<Vec<SessionInfo>, String> {
    let projects_dir = get_claude_projects_dir().ok_or("Cannot find .claude/projects")?;
    if !projects_dir.exists() { return Ok(Vec::new()); }
    let labels = load_labels();
    let titles = load_session_titles();
    let project_dirs: Vec<_> = fs::read_dir(&projects_dir).map_err(|e| e.to_string())?.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect();
    let mut all_sessions: Vec<SessionInfo> = project_dirs.par_iter().flat_map(|dir| {
        let folder = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
        scan_project(dir, &folder, &labels, &titles)
    }).collect();
    all_sessions.par_sort_unstable_by(|a, b| b.modified.cmp(&a.modified));
    Ok(all_sessions)
}

fn cleanup_empty_project(project_dir: &Path) {
    let has_sessions = fs::read_dir(project_dir).map(|entries| entries.flatten().any(|e| { let p = e.path(); !p.is_dir() && p.extension().map(|ext| ext == "jsonl").unwrap_or(false) })).unwrap_or(false);
    if !has_sessions { let _ = fs::remove_dir_all(project_dir); }
}

// --- Tauri Commands: session management ---

#[tauri::command]
fn get_sessions(cache: State<Mutex<AppCache>>) -> Result<Vec<SessionInfo>, String> {
    let sessions = scan_all_sessions()?;
    if let Ok(mut c) = cache.lock() { c.sessions = sessions.clone(); }
    Ok(sessions)
}

#[tauri::command]
fn get_projects() -> Result<Vec<ProjectInfo>, String> {
    let projects_dir = get_claude_projects_dir().ok_or("Cannot find .claude/projects")?;
    if !projects_dir.exists() { return Ok(Vec::new()); }
    let project_dirs: Vec<_> = fs::read_dir(&projects_dir).map_err(|e| e.to_string())?.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect();
    let mut projects: Vec<ProjectInfo> = project_dirs.par_iter().map(|path| {
        let folder_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let session_count = fs::read_dir(path).map(|entries| entries.flatten().filter(|e| { let p = e.path(); !p.is_dir() && p.extension().map(|ext| ext == "jsonl").unwrap_or(false) }).count() as u32).unwrap_or(0);
        let index_path = path.join("sessions-index.json");
        let project_path = if index_path.exists() { fs::read_to_string(&index_path).ok().and_then(|s| serde_json::from_str::<SessionsIndex>(&s).ok()).and_then(|i| i.original_path).unwrap_or_else(|| decode_folder_to_path(&folder_name)) } else { decode_folder_to_path(&folder_name) };
        ProjectInfo { folder_name, project_path, session_count }
    }).collect();
    projects.sort_by(|a, b| a.project_path.cmp(&b.project_path));
    Ok(projects)
}

#[tauri::command]
fn get_project_labels() -> Result<HashMap<String, String>, String> { Ok(load_project_labels()) }

#[tauri::command]
fn set_project_label(project_folder: String, label: String) -> Result<(), String> {
    let mut labels = load_project_labels();
    if label.is_empty() { labels.remove(&project_folder); } else { labels.insert(project_folder, label); }
    save_project_labels(&labels)
}

#[tauri::command]
fn set_session_title(session_id: String, title: String) -> Result<(), String> {
    let mut titles = load_session_titles();
    if title.is_empty() { titles.remove(&session_id); } else { titles.insert(session_id, title); }
    save_session_titles(&titles)
}

#[tauri::command]
fn set_labels(session_id: String, labels: Vec<String>) -> Result<(), String> {
    let mut all_labels = load_labels();
    let filtered: Vec<String> = labels.into_iter().filter(|l| !l.is_empty()).collect();
    if filtered.is_empty() { all_labels.labels.remove(&session_id); } else { all_labels.labels.insert(session_id, filtered); }
    save_labels(&all_labels)
}

#[tauri::command]
fn delete_session(session_id: String, project_folder: String) -> Result<(), String> {
    let projects_dir = get_claude_projects_dir().ok_or("Cannot find .claude/projects")?;
    let project_dir = projects_dir.join(&project_folder);
    let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
    if jsonl_path.exists() { fs::remove_file(&jsonl_path).map_err(|e| e.to_string())?; }
    let data_dir = project_dir.join(&session_id);
    if data_dir.exists() && data_dir.is_dir() { fs::remove_dir_all(&data_dir).map_err(|e| e.to_string())?; }
    let index_path = project_dir.join("sessions-index.json");
    if index_path.exists() {
        if let Ok(content) = fs::read_to_string(&index_path) {
            if let Ok(mut index) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(entries) = index.get_mut("entries").and_then(|e| e.as_array_mut()) {
                    entries.retain(|e| e.get("sessionId").and_then(|s| s.as_str()) != Some(&session_id));
                }
                let _ = fs::write(&index_path, serde_json::to_string_pretty(&index).unwrap_or_default());
            }
        }
    }
    let mut labels = load_labels(); labels.labels.remove(&session_id); let _ = save_labels(&labels);
    let mut titles = load_session_titles(); titles.remove(&session_id); let _ = save_session_titles(&titles);
    cleanup_empty_project(&project_dir);
    Ok(())
}

#[tauri::command]
fn delete_project_sessions(project_folder: String) -> Result<u32, String> {
    let projects_dir = get_claude_projects_dir().ok_or("Cannot find .claude/projects")?;
    let project_dir = projects_dir.join(&project_folder);
    if !project_dir.exists() { return Ok(0); }
    let mut deleted = 0u32;
    let mut labels = load_labels();
    let mut titles = load_session_titles();
    let entries: Vec<_> = fs::read_dir(&project_dir).map_err(|e| e.to_string())?.flatten().collect();
    for entry in &entries {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if name.ends_with(".jsonl") {
            let sid = name.trim_end_matches(".jsonl");
            labels.labels.remove(sid); titles.remove(sid);
            let data_dir = project_dir.join(sid);
            if data_dir.is_dir() { let _ = fs::remove_dir_all(&data_dir); }
            let _ = fs::remove_file(&path);
            deleted += 1;
        }
    }
    let _ = save_labels(&labels); let _ = save_session_titles(&titles);
    let _ = fs::remove_file(project_dir.join("sessions-index.json"));
    cleanup_empty_project(&project_dir);
    Ok(deleted)
}

// --- Tauri Commands: terminal / PTY ---

#[tauri::command]
async fn open_session(
    session_id: Option<String>,
    project_path: String,
    skip_permissions: bool,
    title: String,
    new_window: bool,
    model: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(sid) = session_id {
        args.push("--resume".to_string());
        args.push(sid);
    }
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(m);
    }
    if skip_permissions {
        args.push("--dangerously-skip-permissions".to_string());
    }
    let terminal_id = Uuid::new_v4().to_string();
    let payload = AddTabPayload {
        terminal_id,
        title: title.clone(),
        ssh_args: args,
        cwd: Some(project_path),
        adopt: false,
        initial_content: String::new(),
    };
    let existing_label = if new_window {
        None
    } else if app.get_webview_window("main").is_some() {
        Some("main".to_string())
    } else {
        app.webview_windows().keys().find(|label| label.starts_with("term-")).cloned()
    };
    if let Some(label) = existing_label {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.unminimize();
            let _ = window.set_focus();
            window.emit_to(label.as_str(), "add-tab", payload).map_err(|e| e.to_string())?;
        }
    } else {
        let label = format!("term-{}", Uuid::new_v4().simple());
        state.pending_tabs.lock().unwrap().insert(label.clone(), payload);
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
            .title(title)
            .inner_size(1100.0, 720.0)
            .min_inner_size(640.0, 400.0)
            .resizable(true)
            .disable_drag_drop_handler()
            .build().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_take_pending(window_label: String, state: State<AppState>) -> Option<AddTabPayload> {
    state.pending_tabs.lock().unwrap().remove(&window_label)
}

#[tauri::command]
fn pty_spawn(
    terminal_id: String,
    ssh_args: Vec<String>,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("openpty failed: {}", e))?;
    // On Windows, `claude` is a Node.js shim (.cmd file). CreateProcessW
    // cannot execute .cmd directly, so we wrap through cmd.exe /c. On Unix,
    // `claude` is a shell script / binary and runs directly.
    let mut cmd = if cfg!(windows) {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/c");
        c.arg("claude");
        c
    } else {
        CommandBuilder::new("claude")
    };
    for a in &ssh_args { cmd.arg(a); }
    if let Some(dir) = &cwd { cmd.cwd(dir); }
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn failed: {}", e))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("clone reader failed: {}", e))?;
    let writer = pair.master.take_writer().map_err(|e| format!("take writer failed: {}", e))?;
    let instance = Arc::new(PtyInstance { master: Mutex::new(pair.master), writer: Mutex::new(writer), child: Mutex::new(child) });
    state.ptys.lock().unwrap().insert(terminal_id.clone(), instance);
    // When claude_verbose is on, tee PTY output to a timestamped log file.
    let verbose = load_config().claude_verbose.unwrap_or(false);
    let mut log_file: Option<File> = None;
    if verbose {
        if let Ok(dir) = resolve_log_dir() {
            let _ = fs::create_dir_all(&dir);
            let ts = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
            let name = format!("claude-{}-{}.log", ts, &terminal_id[..8]);
            log_file = File::create(dir.join(name)).ok();
        }
    }
    let app_clone = app.clone();
    let tid = terminal_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut log = log_file;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app_clone.emit("pty-output", PtyOutputPayload { terminal_id: tid.clone(), data: buf[..n].to_vec() });
                    if let Some(f) = log.as_mut() { let _ = f.write_all(&buf[..n]); }
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit("pty-exit", PtyExitPayload { terminal_id: tid });
    });
    Ok(())
}

#[tauri::command]
fn pty_write(terminal_id: String, data: Vec<u8>, state: State<AppState>) -> Result<(), String> {
    let ptys = state.ptys.lock().unwrap();
    let pty = ptys.get(&terminal_id).ok_or("Unknown terminal")?.clone();
    drop(ptys);
    let mut w = pty.writer.lock().unwrap();
    w.write_all(&data).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_resize(terminal_id: String, rows: u16, cols: u16, state: State<AppState>) -> Result<(), String> {
    let ptys = state.ptys.lock().unwrap();
    let pty = ptys.get(&terminal_id).ok_or("Unknown terminal")?.clone();
    drop(ptys);
    pty.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn pty_kill(terminal_id: String, state: State<AppState>) -> Result<(), String> {
    let pty = state.ptys.lock().unwrap().remove(&terminal_id);
    if let Some(pty) = pty { let _ = pty.child.lock().unwrap().kill(); }
    Ok(())
}

#[tauri::command]
async fn drop_tab(
    source_label: String,
    terminal_id: String,
    title: String,
    ssh_args: Vec<String>,
    cwd: Option<String>,
    initial_content: String,
    screen_x: f64,
    screen_y: f64,
    is_last_tab: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    for (label, window) in app.webview_windows() {
        if !label.starts_with("term-") || label == source_label { continue; }
        let Ok(pos) = window.outer_position() else { continue };
        let Ok(size) = window.outer_size() else { continue };
        let Ok(scale) = window.scale_factor() else { continue };
        let x0 = pos.x as f64 / scale; let y0 = pos.y as f64 / scale;
        let x1 = x0 + size.width as f64 / scale; let y1 = y0 + size.height as f64 / scale;
        if screen_x >= x0 && screen_x < x1 && screen_y >= y0 && screen_y < y1 {
            window.emit_to(label.as_str(), "merge-tab", MergeTabPayload { terminal_id, title, ssh_args, cwd, initial_content, screen_x, screen_y }).map_err(|e| e.to_string())?;
            let _ = window.set_focus();
            return Ok(true);
        }
    }
    if is_last_tab { return Ok(false); }
    let label = format!("term-{}", Uuid::new_v4().simple());
    let payload = AddTabPayload { terminal_id, title: title.clone(), ssh_args, cwd, adopt: true, initial_content };
    state.pending_tabs.lock().unwrap().insert(label.clone(), payload);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1100.0, 720.0)
        .min_inner_size(640.0, 400.0)
        .resizable(true)
        .position(screen_x - 100.0, screen_y - 20.0)
        .disable_drag_drop_handler()
        .build().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn spawn_terminal(
    ssh_args: Vec<String>,
    cwd: Option<String>,
    title: String,
    new_window: bool,
    source_label: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let terminal_id = Uuid::new_v4().to_string();
    let payload = AddTabPayload { terminal_id, title: title.clone(), ssh_args, cwd, adopt: false, initial_content: String::new() };
    if new_window {
        let label = format!("term-{}", Uuid::new_v4().simple());
        state.pending_tabs.lock().unwrap().insert(label.clone(), payload);
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
            .title(title).inner_size(1100.0, 720.0).min_inner_size(640.0, 400.0).resizable(true).disable_drag_drop_handler()
            .build().map_err(|e| e.to_string())?;
    } else if let Some(window) = app.get_webview_window(&source_label) {
        let _ = window.unminimize(); let _ = window.set_focus();
        window.emit_to(source_label.as_str(), "add-tab", payload).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_terminal_theme() -> Option<String> { load_config().terminal_theme }

#[tauri::command]
fn set_terminal_theme(name: String, app: AppHandle) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.terminal_theme = Some(name.clone());
    save_config(&cfg)?;
    app.emit("terminal-theme-changed", name).map_err(|e| e.to_string())?;
    Ok(())
}

fn default_log_dir() -> Result<PathBuf, String> {
    Ok(get_config_dir()?.join("logs"))
}

fn resolve_log_dir() -> Result<PathBuf, String> {
    let cfg = load_config();
    if let Some(custom) = cfg.log_dir.filter(|s| !s.trim().is_empty()) {
        return Ok(PathBuf::from(custom));
    }
    default_log_dir()
}

#[tauri::command]
fn get_log_dir() -> Result<String, String> {
    Ok(resolve_log_dir()?.to_string_lossy().to_string())
}

#[tauri::command]
fn set_log_dir(path: Option<String>) -> Result<String, String> {
    let mut cfg = load_config();
    cfg.log_dir = path.filter(|s| !s.trim().is_empty());
    save_config(&cfg)?;
    get_log_dir()
}

#[derive(Serialize)]
struct MetadataPaths {
    claude_dir: String,
    session_labels: String,
    project_labels: String,
    session_titles: String,
}

#[tauri::command]
fn get_metadata_paths() -> Result<MetadataPaths, String> {
    let home = dirs::home_dir().ok_or("home")?;
    let claude_dir = home.join(".claude");
    Ok(MetadataPaths {
        claude_dir: claude_dir.to_string_lossy().to_string(),
        session_labels: claude_dir.join("session-labels.json").to_string_lossy().to_string(),
        project_labels: claude_dir.join("project-labels.json").to_string_lossy().to_string(),
        session_titles: claude_dir.join("session-titles.json").to_string_lossy().to_string(),
    })
}

#[derive(Serialize, Deserialize)]
struct MetadataExport {
    session_labels: serde_json::Value,
    project_labels: serde_json::Value,
    session_titles: serde_json::Value,
}

#[tauri::command]
fn export_metadata_to(target_path: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("home")?;
    let claude = home.join(".claude");
    let read_json = |p: PathBuf| -> serde_json::Value {
        fs::read_to_string(&p).ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    };
    let data = MetadataExport {
        session_labels: read_json(claude.join("session-labels.json")),
        project_labels: read_json(claude.join("project-labels.json")),
        session_titles: read_json(claude.join("session-titles.json")),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&target_path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_metadata_from(source_path: String) -> Result<(), String> {
    let content = fs::read_to_string(&source_path).map_err(|e| e.to_string())?;
    let data: MetadataExport = serde_json::from_str(&content)
        .map_err(|e| format!("JSON 파싱 실패: {}", e))?;
    let home = dirs::home_dir().ok_or("home")?;
    let claude = home.join(".claude");
    fs::create_dir_all(&claude).map_err(|e| e.to_string())?;
    let write_file = |name: &str, v: &serde_json::Value| -> Result<(), String> {
        let json = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
        fs::write(claude.join(name), json).map_err(|e| e.to_string())
    };
    write_file("session-labels.json", &data.session_labels)?;
    write_file("project-labels.json", &data.project_labels)?;
    write_file("session-titles.json", &data.session_titles)
}

#[tauri::command]
fn clear_logs() -> Result<u32, String> {
    let dir = resolve_log_dir()?;
    if !dir.exists() { return Ok(0); }
    let mut count = 0u32;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() && path.extension().map(|e| e == "log").unwrap_or(false) {
            if fs::remove_file(&path).is_ok() { count += 1; }
        }
    }
    Ok(count)
}

#[tauri::command]
fn get_claude_verbose() -> bool { load_config().claude_verbose.unwrap_or(false) }

#[tauri::command]
fn set_claude_verbose(value: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.claude_verbose = Some(value);
    save_config(&cfg)
}

#[tauri::command]
fn get_skip_permissions() -> bool { load_config().skip_permissions.unwrap_or(true) }

#[tauri::command]
fn set_skip_permissions(value: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.skip_permissions = Some(value);
    save_config(&cfg)
}

#[tauri::command]
fn open_path_in_os(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    let _ = path;
    Ok(())
}

// =========================================================================
// Usage aggregation (Phase 6)
// =========================================================================

#[derive(Debug, Clone, Default, Serialize)]
struct UsageTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    messages: u32,
}
impl UsageTotals {
    fn add(&mut self, u: &JsonlUsage) {
        self.input += u.input_tokens;
        self.output += u.output_tokens;
        self.cache_read += u.cache_read_input_tokens;
        self.cache_write += u.cache_creation_input_tokens;
        self.messages += 1;
    }
    fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

#[derive(Debug, Clone, Serialize)]
struct SessionUsage {
    session_id: String,
    model: Option<String>,
    totals: UsageTotals,
    duration_min: u32,
    first_ts: Option<String>,
    last_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct UsageReport {
    today: UsageTotals,
    week: UsageTotals,
    all_time: UsageTotals,
    by_model_today: HashMap<String, UsageTotals>,
    by_model_week: HashMap<String, UsageTotals>,
    active_session: Option<SessionUsage>,
}

#[derive(Deserialize)]
struct JsonlEntry {
    timestamp: Option<String>,
    message: Option<JsonlMessage>,
}

#[derive(Deserialize)]
struct JsonlMessage {
    model: Option<String>,
    usage: Option<JsonlUsage>,
}

#[derive(Deserialize, Default, Clone, Copy)]
struct JsonlUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

fn normalize_model(m: &Option<String>) -> Option<String> {
    let s = m.as_deref()?.to_lowercase();
    if s.contains("sonnet") { Some("sonnet".into()) }
    else if s.contains("opus") { Some("opus".into()) }
    else if s.contains("haiku") { Some("haiku".into()) }
    else { None }
}

fn aggregate_usage(active_session_id: Option<&str>) -> Result<UsageReport, String> {
    use chrono::{Local, TimeZone};
    let projects = get_claude_projects_dir().ok_or("No ~/.claude/projects dir")?;
    let now = Local::now();
    let today_start = Local
        .from_local_datetime(&now.date_naive().and_hms_opt(0, 0, 0).unwrap())
        .unwrap();
    let week_start = today_start - chrono::Duration::days(6);

    let mut today = UsageTotals::default();
    let mut week = UsageTotals::default();
    let mut all_time = UsageTotals::default();
    let mut by_model_today: HashMap<String, UsageTotals> = HashMap::new();
    let mut by_model_week: HashMap<String, UsageTotals> = HashMap::new();
    let mut active_session: Option<SessionUsage> = None;

    let Ok(entries) = fs::read_dir(&projects) else { return Ok(UsageReport {
        today, week, all_time, by_model_today, by_model_week, active_session,
    }) };

    for proj in entries.flatten() {
        let proj_path = proj.path();
        if !proj_path.is_dir() { continue; }
        let Ok(files) = fs::read_dir(&proj_path) else { continue };
        for f in files.flatten() {
            let fp = f.path();
            if !fp.is_file() { continue; }
            if fp.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }

            let session_id = fp.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let Ok(content) = fs::read_to_string(&fp) else { continue };

            let mut s_totals = UsageTotals::default();
            let mut s_first: Option<chrono::DateTime<Local>> = None;
            let mut s_last: Option<chrono::DateTime<Local>> = None;
            let mut s_model: Option<String> = None;

            for line in content.lines() {
                if line.trim().is_empty() { continue; }
                let Ok(entry) = serde_json::from_str::<JsonlEntry>(line) else { continue };
                let Some(msg) = entry.message else { continue };
                let Some(usage) = msg.usage else { continue };
                let model = normalize_model(&msg.model);
                let ts = entry.timestamp.as_deref()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.with_timezone(&Local));

                all_time.add(&usage);
                s_totals.add(&usage);
                if s_first.is_none() { s_first = ts; }
                if ts.is_some() { s_last = ts; }
                if model.is_some() { s_model = model.clone(); }

                if let Some(t) = ts {
                    if t >= week_start {
                        week.add(&usage);
                        if let Some(m) = &model {
                            by_model_week.entry(m.clone()).or_default().add(&usage);
                        }
                    }
                    if t >= today_start {
                        today.add(&usage);
                        if let Some(m) = &model {
                            by_model_today.entry(m.clone()).or_default().add(&usage);
                        }
                    }
                }
            }

            if Some(session_id.as_str()) == active_session_id {
                let duration_min = match (s_first, s_last) {
                    (Some(a), Some(b)) => (b - a).num_minutes().max(0) as u32,
                    _ => 0,
                };
                active_session = Some(SessionUsage {
                    session_id: session_id.clone(),
                    model: s_model,
                    totals: s_totals,
                    duration_min,
                    first_ts: s_first.map(|t| t.to_rfc3339()),
                    last_ts: s_last.map(|t| t.to_rfc3339()),
                });
            }
        }
    }

    Ok(UsageReport { today, week, all_time, by_model_today, by_model_week, active_session })
}

#[derive(Default)]
struct UsageState {
    last_signature: Mutex<Option<u64>>, // today_total
    cached_oauth: Mutex<Option<OauthUsage>>,
}

#[tauri::command]
fn get_usage_report() -> Result<UsageReport, String> {
    aggregate_usage(None)
}

#[tauri::command]
fn get_cached_oauth_usage(usage_state: State<'_, Arc<UsageState>>) -> Result<OauthUsage, String> {
    usage_state.cached_oauth.lock()
        .ok()
        .and_then(|c| c.clone())
        .ok_or_else(|| "캐시 없음".into())
}

// Per-window session usage. Each window passes its own active pane's session_id.
// Walks ~/.claude/projects/** to find the matching session file and returns its
// totals. Much faster than full aggregate_usage because it only parses one file.
// For new sessions started without --resume, we don't yet know the session_id
// that Claude will assign. After the user sends a first message, Claude creates
// a jsonl file. This command finds the most-recently-modified jsonl across all
// projects whose mtime is >= `since_ms`. Caller tracks session start time so it
// knows which timestamp to pass. Returns None until a new file appears.
#[tauri::command]
fn find_new_session_since(since_ms: i64) -> Result<Option<String>, String> {
    let Some(projects) = get_claude_projects_dir() else { return Ok(None) };
    let Ok(entries) = fs::read_dir(&projects) else { return Ok(None) };
    let threshold = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since_ms.max(0) as u64);
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for proj in entries.flatten() {
        let pp = proj.path();
        if !pp.is_dir() { continue; }
        let Ok(files) = fs::read_dir(&pp) else { continue };
        for f in files.flatten() {
            let fp = f.path();
            if fp.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            let Ok(meta) = fs::metadata(&fp) else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            if mtime < threshold { continue; }
            let Some(sid) = fp.file_stem().and_then(|s| s.to_str()).map(String::from) else { continue };
            if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                best = Some((mtime, sid));
            }
        }
    }
    Ok(best.map(|(_, s)| s))
}

#[tauri::command]
fn get_session_usage(session_id: String) -> Result<Option<SessionUsage>, String> {
    use chrono::Local;
    let projects = get_claude_projects_dir().ok_or("No ~/.claude/projects dir")?;
    let Ok(proj_entries) = fs::read_dir(&projects) else { return Ok(None) };
    for proj in proj_entries.flatten() {
        let p = proj.path();
        if !p.is_dir() { continue; }
        let file = p.join(format!("{}.jsonl", session_id));
        if !file.is_file() { continue; }
        let Ok(content) = fs::read_to_string(&file) else { return Ok(None) };

        let mut totals = UsageTotals::default();
        let mut first: Option<chrono::DateTime<Local>> = None;
        let mut last: Option<chrono::DateTime<Local>> = None;
        let mut model: Option<String> = None;

        for line in content.lines() {
            if line.trim().is_empty() { continue; }
            let Ok(entry) = serde_json::from_str::<JsonlEntry>(line) else { continue };
            let Some(msg) = entry.message else { continue };
            let Some(usage) = msg.usage else { continue };
            let m = normalize_model(&msg.model);
            let ts = entry.timestamp.as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Local));
            totals.add(&usage);
            if first.is_none() { first = ts; }
            if ts.is_some() { last = ts; }
            if m.is_some() { model = m.clone(); }
        }

        let duration_min = match (first, last) {
            (Some(a), Some(b)) => (b - a).num_minutes().max(0) as u32,
            _ => 0,
        };
        return Ok(Some(SessionUsage {
            session_id,
            model,
            totals,
            duration_min,
            first_ts: first.map(|t| t.to_rfc3339()),
            last_ts: last.map(|t| t.to_rfc3339()),
        }));
    }
    Ok(None)
}

// -----------------------------------------------------------------------
// Anthropic undocumented OAuth usage endpoint — exact /usage data
// Ref: community discovery via claude-code-statusline
// Returns live session (5h) + weekly + weekly-sonnet utilization + resets.
// -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OauthQuota {
    utilization: f64,
    #[serde(alias = "resetsAt")]
    resets_at: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OauthUsage {
    #[serde(alias = "five_hour")]
    five_hour: OauthQuota,
    #[serde(alias = "seven_day")]
    seven_day: OauthQuota,
    #[serde(alias = "seven_day_sonnet")]
    seven_day_sonnet: OauthQuota,
}

fn oauth_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("oauth-usage-cache.json"))
}

fn load_oauth_cache_from_disk() -> Option<OauthUsage> {
    let p = oauth_cache_path()?;
    let content = fs::read_to_string(&p).ok()?;
    serde_json::from_str::<OauthUsage>(&content).ok()
}

fn save_oauth_cache_to_disk(data: &OauthUsage) {
    let Some(p) = oauth_cache_path() else { return };
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    if let Ok(json) = serde_json::to_string(data) {
        let _ = fs::write(&p, json);
    }
}

fn read_oauth_token() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("home 디렉토리 못 찾음")?;
    let p = home.join(".claude").join(".credentials.json");
    if !p.exists() {
        return Err(format!("{} 없음 — Claude Code 로그인 필요", p.display()));
    }
    let content = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    json.get("claudeAiOauth")
        .and_then(|v| v.get("accessToken"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or("accessToken 필드 없음 — credentials.json 구조 변경 가능".into())
}

#[tauri::command]
async fn get_oauth_usage() -> Result<OauthUsage, String> {
    let token = read_oauth_token()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("요청 실패: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("API {}: {}", status, body));
    }
    resp.json::<OauthUsage>().await.map_err(|e| format!("JSON 파싱 실패: {}", e))
}

// =========================================================================
// Favorites (Q1)
// =========================================================================

fn favorites_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("home")?;
    Ok(home.join(".claude").join("favorite-sessions.json"))
}

#[tauri::command]
fn get_favorite_sessions() -> Result<Vec<String>, String> {
    let p = favorites_path()?;
    if !p.exists() { return Ok(vec![]); }
    let content = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_session_favorite(session_id: String, favorite: bool) -> Result<Vec<String>, String> {
    let mut list = get_favorite_sessions().unwrap_or_default();
    if favorite {
        if !list.contains(&session_id) { list.push(session_id); }
    } else {
        list.retain(|s| s != &session_id);
    }
    let p = favorites_path()?;
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())?;
    Ok(list)
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("Failed to create tokio runtime");

    let usage_state = Arc::new(UsageState::default());
    // Hydrate oauth cache from disk so windows opened before first poll still see data.
    if let Some(disk) = load_oauth_cache_from_disk() {
        if let Ok(mut c) = usage_state.cached_oauth.lock() { *c = Some(disk); }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Mutex::new(AppCache::default()))
        .manage(AppState {
            ptys: Mutex::new(HashMap::new()),
            pending_tabs: Mutex::new(HashMap::new()),
            runtime,
        })
        .manage(usage_state.clone())
        .setup({
            let usage_state = usage_state.clone();
            move |app| {
                // 3s polling watcher for local jsonl aggregation.
                let handle = app.handle().clone();
                let state = usage_state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        let Ok(report) = aggregate_usage(None) else { continue };
                        let sig = report.today.total();
                        let mut last = state.last_signature.lock().unwrap();
                        if last.as_ref() != Some(&sig) {
                            *last = Some(sig);
                            let _ = handle.emit("usage-update", &report);
                        }
                    }
                });
                // 90s polling for OAuth rate-limit endpoint. /usage data doesn't
                // change sub-second and this endpoint is undocumented, so be gentle.
                let handle2 = app.handle().clone();
                let oauth_state = usage_state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        match get_oauth_usage().await {
                            Ok(data) => {
                                if let Ok(mut c) = oauth_state.cached_oauth.lock() { *c = Some(data.clone()); }
                                save_oauth_cache_to_disk(&data);
                                let _ = handle2.emit("usage-oauth-update", &data);
                            }
                            Err(e) => { let _ = handle2.emit("usage-oauth-error", &e); }
                        }
                        tokio::time::sleep(Duration::from_secs(90)).await;
                    }
                });
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions, get_projects,
            get_project_labels, set_project_label,
            set_labels, set_session_title,
            delete_session, delete_project_sessions,
            open_session,
            pty_spawn, pty_write, pty_resize, pty_kill, pty_take_pending,
            drop_tab, spawn_terminal,
            get_terminal_theme, set_terminal_theme,
            get_log_dir, set_log_dir, clear_logs,
            get_claude_verbose, set_claude_verbose,
            get_skip_permissions, set_skip_permissions,
            open_path_in_os,
            get_metadata_paths, export_metadata_to, import_metadata_from,
            get_usage_report, get_session_usage, find_new_session_since, get_oauth_usage, get_cached_oauth_usage,
            get_favorite_sessions, set_session_favorite
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
