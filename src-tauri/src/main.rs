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
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
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
    #[serde(default)]
    account_name: String,
}

unsafe impl Send for SessionInfo {}

#[derive(Debug, Serialize, Clone)]
struct ProjectInfo {
    folder_name: String,
    project_path: String,
    session_count: u32,
    // For multi-account: which accounts this project folder appears under.
    #[serde(default)]
    account_names: Vec<String>,
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

// ---------- Windows Job Object: kernel-guaranteed tree cleanup ----------
//
// `taskkill /T` walks the tree that exists *at the moment it runs*. That is the
// wrong shape for this problem: when the PTY's `claude.exe` exits on its own
// (session end, crash, /exit), Windows does not cascade the death to its
// children, so the MCP servers it spawned are orphaned instantly. By the time a
// tab close calls taskkill, the walk starts from a pid that is already gone and
// reaps nothing. Measured on 2026-08-27: ~100 orphaned `npx @jetbrains/mcp-proxy`
// processes accumulated over 44h, ~6GB of commit, still growing ~1/min.
//
// A job object does not walk anything. Every process assigned to the job - and
// everything they spawn, transitively - is a member, and membership cannot be
// escaped. With JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, closing the last handle to
// the job terminates every member atomically. That holds when the tree exits
// cleanly, when an intermediate process dies first, and when this app is killed
// outright: process teardown closes our handles for us. Chrome and VS Code use
// the same mechanism.
//
// Raw FFI on purpose - this needs five kernel32 calls and no new dependency.
#[cfg(windows)]
mod job {
    use std::os::raw::c_void;

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_SET_QUOTA: u32 = 0x0100;

    #[repr(C)]
    struct IoCounters {
        read_op: u64,
        write_op: u64,
        other_op: u64,
        read_tx: u64,
        write_tx: u64,
        other_tx: u64,
    }

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time: i64,
        per_job_user_time: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *const c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    // Owns the job handle. Dropping it closes the handle, which is what actually
    // kills the tree - so it must outlive the PTY it guards, i.e. it lives in
    // PtyInstance and dies when the instance leaves AppState::ptys.
    pub struct JobHandle(*mut c_void);

    // The handle is only ever closed (in Drop) or passed to AssignProcessToJob-
    // Object, both of which the kernel serializes internally.
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl Drop for JobHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // Closing the last handle is what triggers KILL_ON_JOB_CLOSE.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// Create an unnamed job that kills all members when its last handle closes.
    pub fn create_kill_on_close() -> Option<JobHandle> {
        let h = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if h.is_null() {
            return None;
        }
        let mut info: ExtendedLimitInformation = unsafe { std::mem::zeroed() };
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                h,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &info as *const _ as *const c_void,
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            )
        };
        if ok == 0 {
            // Without the flag the job kills nothing, so it is worse than
            // useless - drop it and let the taskkill path handle cleanup.
            unsafe { CloseHandle(h) };
            return None;
        }
        Some(JobHandle(h))
    }

    /// Put `pid` (and everything it goes on to spawn) into the job.
    ///
    /// Nested jobs are supported since Windows 8, so this succeeds even when the
    /// target already belongs to another job.
    pub fn assign_pid(job: &JobHandle, pid: u32) -> bool {
        let proc = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if proc.is_null() {
            return false;
        }
        let ok = unsafe { AssignProcessToJobObject(job.0, proc) };
        unsafe { CloseHandle(proc) };
        ok != 0
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        // A wrong #[repr(C)] layout here would not fail to compile - it would
        // hand SetInformationJobObject a garbage limit_flags and silently give
        // us a job that kills nothing, which is exactly the bug this module
        // exists to fix. Pin the offsets against the Win32 SDK definition.
        #[test]
        fn extended_limit_information_matches_win32_layout() {
            use std::mem::{align_of, size_of};

            // x64: 8-byte alignment throughout, two 4-byte holes in the basic
            // struct (after limit_flags and after active_process_limit).
            assert_eq!(size_of::<BasicLimitInformation>(), 64);
            assert_eq!(size_of::<IoCounters>(), 48);
            assert_eq!(size_of::<ExtendedLimitInformation>(), 144);
            assert_eq!(align_of::<ExtendedLimitInformation>(), 8);
        }

        // The flag is what makes the job lethal; a typo yields a job that
        // silently leaks instead of reaping.
        #[test]
        fn kill_on_job_close_flag_value() {
            assert_eq!(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 0x2000);
            assert_eq!(JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, 9);
        }

        // End-to-end: a job with the flag set must reap a real process tree the
        // moment its last handle closes, with no taskkill involved.
        #[test]
        fn dropping_the_job_kills_the_spawned_tree() {
            use std::os::windows::process::CommandExt;
            use std::process::{Command, Stdio};

            const CREATE_NO_WINDOW: u32 = 0x0800_0000;

            let jh = create_kill_on_close().expect("job creation failed");
            // Long-lived child so it is definitely alive when we drop the job.
            let mut child = Command::new("cmd.exe")
                .args(["/c", "timeout", "/t", "30", "/nobreak"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn failed");
            let pid = child.id();
            assert!(assign_pid(&jh, pid), "assign to job failed");
            assert!(
                child.try_wait().expect("try_wait failed").is_none(),
                "child died before the job was dropped"
            );

            drop(jh); // closing the last handle must terminate the member

            // Termination is synchronous from the kernel's side, but the exit
            // status still has to be reaped; poll briefly rather than sleep a
            // fixed amount.
            let mut exited = false;
            for _ in 0..50 {
                if child.try_wait().expect("try_wait failed").is_some() {
                    exited = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            if !exited {
                let _ = child.kill();
            }
            assert!(exited, "job did not kill its member on handle close");
        }
    }
}

// Non-Windows stub so PtyInstance and pty_spawn stay platform-independent.
// Unix already has real process groups; portable-pty's kill covers it there.
#[cfg(not(windows))]
mod job {
    pub struct JobHandle;
    pub fn create_kill_on_close() -> Option<JobHandle> {
        None
    }
    pub fn assign_pid(_job: &JobHandle, _pid: u32) -> bool {
        false
    }
}

struct PtyInstance {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    // Kills the whole spawned tree when this instance is dropped. None when the
    // job could not be created (or on non-Windows); kill_pty_tree still runs.
    _job: Option<job::JobHandle>,
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
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    account_name: Option<String>,
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
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    account_name: Option<String>,
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

fn scan_project(project_dir: &Path, folder_name: &str, account_name: &str, labels: &Labels, titles: &HashMap<String, String>) -> Vec<SessionInfo> {
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
            sessions.push(SessionInfo { session_id, first_prompt: idx.first_prompt.clone().unwrap_or_default(), summary: idx.summary.clone().unwrap_or_default(), message_count: idx.message_count, created: idx.created.clone().unwrap_or_default(), modified: idx.modified.clone().unwrap_or_default(), git_branch: idx.git_branch.clone().unwrap_or_default(), project_path: project_path.clone(), project_folder: folder_name.to_string(), labels: labels_vec, custom_title, account_name: account_name.to_string() });
        } else {
            let first_prompt = extract_first_prompt_from_jsonl(&file_path).unwrap_or_default();
            let msg_count = estimate_message_count(&file_path);
            let modified = file_time_to_rfc3339(&file_path, true);
            let created = file_time_to_rfc3339(&file_path, false);
            sessions.push(SessionInfo { session_id, first_prompt, summary: String::new(), message_count: msg_count, created, modified, git_branch: String::new(), project_path: project_path.clone(), project_folder: folder_name.to_string(), labels: labels_vec, custom_title, account_name: account_name.to_string() });
        }
    }
    sessions
}

fn scan_all_sessions() -> Result<Vec<SessionInfo>, String> {
    let labels = load_labels();
    let titles = load_session_titles();
    let mut all_sessions: Vec<SessionInfo> = Vec::new();
    for (account_name, projects_dir) in all_projects_dirs() {
        if !projects_dir.exists() { continue; }
        let project_dirs: Vec<_> = match fs::read_dir(&projects_dir) {
            Ok(r) => r.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect(),
            Err(_) => continue,
        };
        let mut scanned: Vec<SessionInfo> = project_dirs.par_iter().flat_map(|dir| {
            let folder = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            scan_project(dir, &folder, &account_name, &labels, &titles)
        }).collect();
        all_sessions.append(&mut scanned);
    }
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
    // Aggregate across all account dirs. If two accounts have the same project
    // folder, we merge them: one ProjectInfo with summed session_count and
    // both account names listed.
    let mut by_folder: HashMap<String, ProjectInfo> = HashMap::new();
    for (account_name, projects_dir) in all_projects_dirs() {
        if !projects_dir.exists() { continue; }
        let project_dirs: Vec<_> = match fs::read_dir(&projects_dir) {
            Ok(r) => r.flatten().filter(|e| e.path().is_dir()).map(|e| e.path()).collect(),
            Err(_) => continue,
        };
        let scanned: Vec<ProjectInfo> = project_dirs.par_iter().map(|path| {
            let folder_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let session_count = fs::read_dir(path).map(|entries| entries.flatten().filter(|e| { let p = e.path(); !p.is_dir() && p.extension().map(|ext| ext == "jsonl").unwrap_or(false) }).count() as u32).unwrap_or(0);
            let index_path = path.join("sessions-index.json");
            let project_path = if index_path.exists() { fs::read_to_string(&index_path).ok().and_then(|s| serde_json::from_str::<SessionsIndex>(&s).ok()).and_then(|i| i.original_path).unwrap_or_else(|| decode_folder_to_path(&folder_name)) } else { decode_folder_to_path(&folder_name) };
            ProjectInfo { folder_name, project_path, session_count, account_names: vec![account_name.clone()] }
        }).collect();
        for p in scanned {
            by_folder
                .entry(p.folder_name.clone())
                .and_modify(|existing| {
                    existing.session_count += p.session_count;
                    if !existing.account_names.contains(&account_name) {
                        existing.account_names.push(account_name.clone());
                    }
                })
                .or_insert(p);
        }
    }
    let mut projects: Vec<ProjectInfo> = by_folder.into_values().collect();
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

fn projects_dir_for_account_name(name: &str) -> Option<PathBuf> {
    load_accounts().iter().find(|a| a.name == name).and_then(account_projects_dir)
}

#[tauri::command]
fn delete_session(session_id: String, project_folder: String, account_name: Option<String>) -> Result<(), String> {
    let projects_dir = match account_name.as_deref() {
        Some(n) => projects_dir_for_account_name(n).ok_or("계정 dir 없음")?,
        None => get_claude_projects_dir().ok_or("Cannot find .claude/projects")?,
    };
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
    let mut smap = load_session_account_map(); smap.remove(&session_id); let _ = save_session_account_map(&smap);
    cleanup_empty_project(&project_dir);
    Ok(())
}

#[tauri::command]
fn delete_project_sessions(project_folder: String, account_name: Option<String>) -> Result<u32, String> {
    // If account_name given, only that one. Otherwise wipe the project folder
    // across every account (the "nuke this project" semantic).
    let target_dirs: Vec<PathBuf> = match account_name.as_deref() {
        Some(n) => projects_dir_for_account_name(n).into_iter().map(|d| d.join(&project_folder)).collect(),
        None => all_projects_dirs().into_iter().map(|(_, d)| d.join(&project_folder)).collect(),
    };
    let mut deleted = 0u32;
    let mut labels = load_labels();
    let mut titles = load_session_titles();
    let mut smap = load_session_account_map();
    for project_dir in target_dirs {
        if !project_dir.exists() { continue; }
        let entries: Vec<_> = match fs::read_dir(&project_dir) {
            Ok(r) => r.flatten().collect(),
            Err(_) => continue,
        };
        for entry in &entries {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if name.ends_with(".jsonl") {
                let sid = name.trim_end_matches(".jsonl");
                labels.labels.remove(sid); titles.remove(sid); smap.remove(sid);
                let data_dir = project_dir.join(sid);
                if data_dir.is_dir() { let _ = fs::remove_dir_all(&data_dir); }
                let _ = fs::remove_file(&path);
                deleted += 1;
            }
        }
        let _ = fs::remove_file(project_dir.join("sessions-index.json"));
        cleanup_empty_project(&project_dir);
    }
    let _ = save_labels(&labels);
    let _ = save_session_titles(&titles);
    let _ = save_session_account_map(&smap);
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
    account: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(sid) = &session_id {
        args.push("--resume".to_string());
        args.push(sid.clone());
    }
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(m);
    }
    if skip_permissions {
        args.push("--dangerously-skip-permissions".to_string());
    }

    // Resolve which account this session belongs to.
    let accounts = load_accounts();
    let account_name = match account.filter(|s| !s.trim().is_empty()) {
        Some(a) if accounts.iter().any(|x| x.name == a) => a,
        _ => {
            let labels = session_id.as_deref().map(labels_for_session).unwrap_or_default();
            resolve_account_name(session_id.as_deref(), &labels, &accounts)
        }
    };
    let acc = accounts.iter().find(|a| a.name == account_name).cloned()
        .unwrap_or_else(default_account);

    let mut env = HashMap::new();
    if let Some(dir) = account_config_dir(&acc) {
        // Ensure the dir exists so Claude can write its session jsonl there.
        let _ = fs::create_dir_all(&dir);
        env.insert("CLAUDE_CONFIG_DIR".to_string(), dir.to_string_lossy().to_string());
    }

    let terminal_id = Uuid::new_v4().to_string();
    let payload = AddTabPayload {
        terminal_id,
        title: title.clone(),
        ssh_args: args,
        cwd: Some(project_path),
        adopt: false,
        initial_content: String::new(),
        env,
        account_name: Some(account_name.clone()),
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
    env: Option<HashMap<String, String>>,
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
    if let Some(extra) = env {
        for (k, v) in extra {
            cmd.env(k, v);
        }
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn failed: {}", e))?;
    drop(pair.slave);
    // Cage the child immediately, before `cmd.exe /c claude` has had time to
    // start Node and its MCP servers, so the entire tree becomes a job member
    // and dies with the handle instead of depending on a taskkill walk that a
    // dead intermediate process would break. Best effort throughout: on any
    // failure we drop the job and fall back to kill_pty_tree.
    let job = match job::create_kill_on_close() {
        Some(j) => match child.process_id() {
            Some(pid) if job::assign_pid(&j, pid) => Some(j),
            // Job holds nothing, so keeping the handle would only be
            // misleading about who is responsible for cleanup.
            _ => None,
        },
        None => None,
    };
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("clone reader failed: {}", e))?;
    let writer = pair.master.take_writer().map_err(|e| format!("take writer failed: {}", e))?;
    let instance = Arc::new(PtyInstance { master: Mutex::new(pair.master), writer: Mutex::new(writer), child: Mutex::new(child), _job: job });
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

// Kill a PTY together with everything it spawned.
//
// Since pty_spawn assigns the child to a kill-on-close job object, dropping the
// PtyInstance already reaps the tree in the kernel; this is the belt to that
// braces. It still earns its place: it covers a job that failed to be created,
// and the sub-millisecond window between spawn_command and AssignProcessToJob-
// Object in which a grandchild could in principle escape.
//
// On Windows the direct child is the `cmd.exe` shim that wraps `claude`
// (see pty_spawn), and there is no process-group semantics: `.kill()` reaps
// only the shim, leaving the real `claude.exe` alive and reparented — a
// ~400MB orphan per closed tab. `taskkill /T` walks the tree instead.
// Killing the whole tree also closes the ConPTY pipe, which lets the reader
// thread in pty_spawn return from its blocking read and actually exit.
fn kill_pty_tree(pty: &PtyInstance) {
    #[cfg(windows)]
    {
        let pid = pty.child.lock().ok().and_then(|c| c.process_id());
        if let Some(pid) = pid {
            // Spawn and walk away — do NOT use `.output()`. That waits for
            // taskkill to exit *and* for its stdout/stderr pipes to reach EOF,
            // which measured ~9.8s per tree and froze the close path solid.
            // Spawning alone costs ~10ms, and taskkill is an independent
            // process: it finishes reaping the tree whether or not we are still
            // alive, so nothing orphans. Null stdio so no pipes exist at all.
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
    // Still reap the direct child: on Unix this is the actual kill, and on
    // Windows it releases the handle if taskkill could not resolve the pid.
    if let Ok(mut c) = pty.child.lock() { let _ = c.kill(); }
}

// Kill a batch of PTYs off the main thread.
//
// This is an `async` command on purpose: a *sync* #[tauri::command] runs on the
// main thread, so any cost here lands directly on the UI. kill_pty_tree is cheap
// now, but spawning a process is still a syscall per pane, so it stays on the
// blocking pool and the panes go in parallel.
//
// Entries stay in the map until their kill returns. If the app exits mid-kill,
// the RunEvent::Exit fallback still sees them and reaps them; killing an
// already-dead tree is a harmless no-op.
async fn kill_terminals(ids: Vec<String>, state: &AppState) {
    let targets: Vec<(String, Arc<PtyInstance>)> = {
        let ptys = state.ptys.lock().unwrap();
        ids.iter().filter_map(|id| ptys.get(id).map(|p| (id.clone(), p.clone()))).collect()
    };
    let jobs: Vec<_> = targets
        .into_iter()
        .map(|(id, pty)| tauri::async_runtime::spawn_blocking(move || { kill_pty_tree(&pty); id }))
        .collect();
    for job in jobs {
        if let Ok(id) = job.await {
            // Dropping the entry also drops the ConPTY master.
            state.ptys.lock().unwrap().remove(&id);
        }
    }
}

#[tauri::command]
async fn pty_kill_many(terminal_ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    kill_terminals(terminal_ids, &state).await;
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
    // Hit-test in PHYSICAL pixels via OS cursor. dragend.screenX/Y from
    // Chromium / WebView2 is unreliable when the drop lands outside the
    // source window (cross-window drags often report (0,0)). Querying
    // the OS gives ground truth and physical-pixel comparison handles
    // multi-monitor mixed-DPI setups correctly.
    let cur_pos = app.cursor_position().ok();
    let src_scale = app.get_webview_window(&source_label)
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let (cur_x, cur_y) = match cur_pos {
        Some(p) => (p.x, p.y),
        None => (screen_x * src_scale, screen_y * src_scale),
    };
    for (label, window) in app.webview_windows() {
        // "main" is also a valid merge target — without this, dragging a
        // tab from a sub-window back into the main window silently fails.
        if label != "main" && !label.starts_with("term-") { continue; }
        if label == source_label { continue; }
        let Ok(pos) = window.outer_position() else { continue };
        let Ok(size) = window.outer_size() else { continue };
        let x0 = pos.x as f64;
        let y0 = pos.y as f64;
        let x1 = x0 + size.width as f64;
        let y1 = y0 + size.height as f64;
        if cur_x >= x0 && cur_x < x1 && cur_y >= y0 && cur_y < y1 {
            window.emit_to(label.as_str(), "merge-tab", MergeTabPayload { terminal_id, title, ssh_args, cwd, initial_content, screen_x, screen_y, env: HashMap::new(), account_name: None }).map_err(|e| e.to_string())?;
            let _ = window.set_focus();
            return Ok(true);
        }
    }
    // Block the "detach into a clone" case for term-* sources — moving
    // the only tab out of a sub-window into a fresh window of the same
    // kind is a no-op. Main keeps a placeholder when its last tab leaves,
    // so detaching from main is meaningful.
    if is_last_tab && source_label.starts_with("term-") { return Ok(false); }
    let label = format!("term-{}", Uuid::new_v4().simple());
    let payload = AddTabPayload { terminal_id, title: title.clone(), ssh_args, cwd, adopt: true, initial_content, env: HashMap::new(), account_name: None };
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
    let payload = AddTabPayload { terminal_id, title: title.clone(), ssh_args, cwd, adopt: false, initial_content: String::new(), env: HashMap::new(), account_name: None };
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
    else if s.contains("fable") { Some("fable".into()) }
    else { None }
}

fn aggregate_usage(active_session_id: Option<&str>) -> Result<UsageReport, String> {
    use chrono::{Local, TimeZone};
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

    for (_account, projects) in all_projects_dirs() {
        let Ok(entries) = fs::read_dir(&projects) else { continue };
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
    }

    Ok(UsageReport { today, week, all_time, by_model_today, by_model_week, active_session })
}

#[derive(Default)]
struct UsageState {
    last_signature: Mutex<Option<u64>>, // today_total
    cached_oauth: Mutex<Option<OauthUsage>>,
    cached_oauth_multi: Mutex<HashMap<String, OauthUsage>>,
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

#[tauri::command]
fn get_cached_oauth_usages_per_account(usage_state: State<'_, Arc<UsageState>>) -> Result<Vec<AccountOauthUsage>, String> {
    let cache = usage_state.cached_oauth_multi.lock()
        .map_err(|_| "lock 실패".to_string())?
        .clone();
    let accounts = load_accounts();
    let mut out = Vec::with_capacity(accounts.len());
    for acc in accounts {
        let usage = cache.get(&acc.name).cloned();
        out.push(AccountOauthUsage {
            account_name: acc.name,
            alias: acc.alias,
            email: acc.email,
            subscription: acc.subscription,
            org_name: acc.org_name,
            logged_in: acc.logged_in,
            usage,
            error: None,
        });
    }
    Ok(out)
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
    let threshold = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since_ms.max(0) as u64);
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for (_account, projects) in all_projects_dirs() {
        let Ok(entries) = fs::read_dir(&projects) else { continue };
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
    }
    Ok(best.map(|(_, s)| s))
}

#[tauri::command]
fn get_session_usage(session_id: String) -> Result<Option<SessionUsage>, String> {
    use chrono::Local;
    for (_account, projects) in all_projects_dirs() {
    let Ok(proj_entries) = fs::read_dir(&projects) else { continue };
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
    }
    Ok(None)
}

// -----------------------------------------------------------------------
// Anthropic undocumented OAuth usage endpoint — exact /usage data
// Ref: community discovery via claude-code-statusline
// Returns live session (5h) + weekly + weekly-sonnet utilization + resets.
// -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OauthQuota {
    pub utilization: f64,
    #[serde(alias = "resetsAt")]
    pub resets_at: Option<String>,
}
// Weekly quota scoped to a specific model (e.g. "Fable"). Since the Claude 5
// rollout the API reports this via the `limits` array (kind = "weekly_scoped")
// instead of the old fixed `seven_day_sonnet` field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopedQuota {
    pub label: Option<String>,
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthUsage {
    #[serde(alias = "five_hour")]
    pub five_hour: OauthQuota,
    #[serde(alias = "seven_day")]
    pub seven_day: OauthQuota,
    // Nullable since the Claude 5 rollout (2026-07): the API now sends null here.
    #[serde(alias = "seven_day_sonnet", default)]
    pub seven_day_sonnet: Option<OauthQuota>,
    #[serde(alias = "seven_day_scoped", default)]
    pub seven_day_scoped: Option<ScopedQuota>,
}

// Raw shape of GET /api/oauth/usage. Every field optional so future schema
// changes degrade gracefully instead of failing the whole poll.
#[derive(Deserialize)]
struct ApiOauthUsage {
    five_hour: Option<OauthQuota>,
    seven_day: Option<OauthQuota>,
    seven_day_sonnet: Option<OauthQuota>,
    #[serde(default)]
    limits: Vec<ApiLimit>,
}

#[derive(Deserialize)]
struct ApiLimit {
    kind: Option<String>,
    percent: Option<f64>,
    resets_at: Option<String>,
    scope: Option<ApiLimitScope>,
}

#[derive(Deserialize)]
struct ApiLimitScope {
    model: Option<ApiLimitScopeModel>,
}

#[derive(Deserialize)]
struct ApiLimitScopeModel {
    display_name: Option<String>,
}

impl ApiOauthUsage {
    fn limit(&self, kind: &str) -> Option<&ApiLimit> {
        self.limits.iter().find(|l| l.kind.as_deref() == Some(kind))
    }

    fn into_usage(self) -> Result<OauthUsage, String> {
        let from_limit = |l: &ApiLimit| OauthQuota {
            utilization: l.percent.unwrap_or(0.0),
            resets_at: l.resets_at.clone(),
        };
        let five_hour = self.five_hour.clone()
            .or_else(|| self.limit("session").map(from_limit))
            .ok_or("응답에 5시간(session) 한도 없음 — API 스키마 변경 가능")?;
        let seven_day = self.seven_day.clone()
            .or_else(|| self.limit("weekly_all").map(from_limit))
            .ok_or("응답에 주간(weekly_all) 한도 없음 — API 스키마 변경 가능")?;
        let seven_day_scoped = self.limit("weekly_scoped").map(|l| ScopedQuota {
            label: l.scope.as_ref()
                .and_then(|s| s.model.as_ref())
                .and_then(|m| m.display_name.clone()),
            utilization: l.percent.unwrap_or(0.0),
            resets_at: l.resets_at.clone(),
        });
        Ok(OauthUsage {
            five_hour,
            seven_day,
            seven_day_sonnet: self.seven_day_sonnet,
            seven_day_scoped,
        })
    }
}

fn oauth_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("oauth-usage-cache.json"))
}

fn oauth_cache_multi_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("oauth-usage-cache-multi.json"))
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

fn load_oauth_cache_multi_from_disk() -> HashMap<String, OauthUsage> {
    let Some(p) = oauth_cache_multi_path() else { return HashMap::new(); };
    fs::read_to_string(&p).ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, OauthUsage>>(&s).ok())
        .unwrap_or_default()
}

fn save_oauth_cache_multi_to_disk(data: &HashMap<String, OauthUsage>) {
    let Some(p) = oauth_cache_multi_path() else { return };
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    if let Ok(json) = serde_json::to_string(data) {
        let _ = fs::write(&p, json);
    }
}

fn read_oauth_token_for_root(claude_root: &Path) -> Result<String, String> {
    let p = claude_root.join(".credentials.json");
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

async fn fetch_oauth_usage_for_account(account: &Account) -> Result<OauthUsage, String> {
    let root = account_claude_root(account).ok_or("home 못 찾음")?;
    let token = read_oauth_token_for_root(&root)?;
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
    let raw = resp.json::<ApiOauthUsage>().await.map_err(|e| format!("JSON 파싱 실패: {}", e))?;
    raw.into_usage()
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountOauthUsage {
    pub account_name: String,
    pub alias: Option<String>,
    pub email: Option<String>,
    pub subscription: Option<String>,
    pub org_name: Option<String>,
    pub logged_in: bool,
    pub usage: Option<OauthUsage>,
    pub error: Option<String>,
}

#[tauri::command]
async fn get_oauth_usage() -> Result<OauthUsage, String> {
    let acc = load_accounts().into_iter().next().unwrap_or_else(default_account);
    fetch_oauth_usage_for_account(&acc).await
}

#[tauri::command]
async fn get_oauth_usages_per_account() -> Result<Vec<AccountOauthUsage>, String> {
    let accounts = load_accounts();
    let mut out: Vec<AccountOauthUsage> = Vec::with_capacity(accounts.len());
    for acc in accounts {
        let (usage, error) = match fetch_oauth_usage_for_account(&acc).await {
            Ok(u) => (Some(u), None),
            Err(e) => (None, Some(e)),
        };
        out.push(AccountOauthUsage {
            account_name: acc.name,
            alias: acc.alias,
            email: acc.email,
            subscription: acc.subscription,
            org_name: acc.org_name,
            logged_in: acc.logged_in,
            usage,
            error,
        });
    }
    Ok(out)
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

// =========================================================================
// Accounts — multi-account support via CLAUDE_CONFIG_DIR
// =========================================================================

pub const DEFAULT_ACCOUNT_NAME: &str = "default";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub name: String,
    // None = use ~/.claude (the default account)
    #[serde(default)]
    pub config_dir: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    // Cached metadata, refreshed via `claude auth status`
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub subscription: Option<String>,
    #[serde(default)]
    pub org_name: Option<String>,
    #[serde(default)]
    pub logged_in: bool,
}

fn accounts_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("home")?;
    Ok(home.join(".claude").join("accounts.json"))
}

fn default_account() -> Account {
    Account {
        name: DEFAULT_ACCOUNT_NAME.to_string(),
        config_dir: None,
        alias: None,
        email: None,
        subscription: None,
        org_name: None,
        logged_in: false,
    }
}

fn load_accounts() -> Vec<Account> {
    let Ok(p) = accounts_path() else { return vec![default_account()]; };
    if !p.exists() { return vec![default_account()]; }
    let mut list: Vec<Account> = fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| vec![default_account()]);
    if !list.iter().any(|a| a.name == DEFAULT_ACCOUNT_NAME) {
        list.insert(0, default_account());
    }
    list
}

fn save_accounts(list: &[Account]) -> Result<(), String> {
    let p = accounts_path()?;
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())
}

// Resolve the config_dir for an account name. The default account has no
// config_dir (uses ~/.claude). Other accounts default to ~/.claude-accounts/{name}
// if their stored config_dir is empty.
fn account_config_dir(account: &Account) -> Option<PathBuf> {
    if account.name == DEFAULT_ACCOUNT_NAME { return None; }
    if let Some(s) = account.config_dir.as_ref().filter(|s| !s.trim().is_empty()) {
        return Some(PathBuf::from(s));
    }
    dirs::home_dir().map(|h| h.join(".claude-accounts").join(&account.name))
}

// Returns the .claude dir (or its override) for an account. Used to compute
// the projects/, .credentials.json, etc. paths.
fn account_claude_root(account: &Account) -> Option<PathBuf> {
    match account_config_dir(account) {
        Some(dir) => Some(dir),
        None => dirs::home_dir().map(|h| h.join(".claude")),
    }
}

fn account_projects_dir(account: &Account) -> Option<PathBuf> {
    account_claude_root(account).map(|r| r.join("projects"))
}

// All accounts + their projects dirs, in priority order (default first).
fn all_projects_dirs() -> Vec<(String, PathBuf)> {
    load_accounts()
        .into_iter()
        .filter_map(|a| account_projects_dir(&a).map(|p| (a.name.clone(), p)))
        .collect()
}

#[tauri::command]
fn get_accounts() -> Result<Vec<Account>, String> {
    Ok(load_accounts())
}

#[tauri::command]
fn add_account(name: String, alias: Option<String>, config_dir: Option<String>) -> Result<Vec<Account>, String> {
    let name = name.trim().to_string();
    if name.is_empty() { return Err("계정 이름이 비어있음".into()); }
    if name == DEFAULT_ACCOUNT_NAME { return Err("기본 계정 이름은 예약됨".into()); }
    let mut list = load_accounts();
    if list.iter().any(|a| a.name == name) {
        return Err(format!("이미 존재하는 계정: {}", name));
    }
    let new = Account {
        name: name.clone(),
        config_dir: config_dir.filter(|s| !s.trim().is_empty()),
        alias: alias.filter(|s| !s.trim().is_empty()),
        email: None,
        subscription: None,
        org_name: None,
        logged_in: false,
    };
    // Create the config dir on disk so the user can `claude /login` into it.
    if let Some(dir) = account_config_dir(&new) {
        let _ = fs::create_dir_all(&dir);
    }
    list.push(new);
    save_accounts(&list)?;
    Ok(list)
}

#[tauri::command]
fn remove_account(name: String) -> Result<Vec<Account>, String> {
    if name == DEFAULT_ACCOUNT_NAME { return Err("기본 계정은 삭제 불가".into()); }
    let mut list = load_accounts();
    list.retain(|a| a.name != name);
    save_accounts(&list)?;
    // Also strip mapping entries referring to this account.
    let mut lmap = load_label_account_map();
    lmap.retain(|_, v| v != &name);
    let _ = save_label_account_map(&lmap);
    let mut smap = load_session_account_map();
    smap.retain(|_, v| v != &name);
    let _ = save_session_account_map(&smap);
    Ok(list)
}

#[tauri::command]
fn set_account_alias(name: String, alias: Option<String>) -> Result<Vec<Account>, String> {
    let mut list = load_accounts();
    let Some(acc) = list.iter_mut().find(|a| a.name == name) else {
        return Err(format!("계정 없음: {}", name));
    };
    acc.alias = alias.filter(|s| !s.trim().is_empty());
    save_accounts(&list)?;
    Ok(list)
}

// --- Label / session → account mapping ---

fn label_account_map_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("home")?;
    Ok(home.join(".claude").join("label-account-map.json"))
}
fn session_account_map_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("home")?;
    Ok(home.join(".claude").join("session-account-map.json"))
}

fn load_label_account_map() -> HashMap<String, String> {
    label_account_map_path().ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn save_label_account_map(m: &HashMap<String, String>) -> Result<(), String> {
    let p = label_account_map_path()?;
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    let json = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    fs::write(p, json).map_err(|e| e.to_string())
}

fn load_session_account_map() -> HashMap<String, String> {
    session_account_map_path().ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn save_session_account_map(m: &HashMap<String, String>) -> Result<(), String> {
    let p = session_account_map_path()?;
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    let json = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    fs::write(p, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_label_account_map() -> HashMap<String, String> { load_label_account_map() }

#[tauri::command]
fn set_label_account_mapping(label: String, account: Option<String>) -> Result<HashMap<String, String>, String> {
    let mut m = load_label_account_map();
    match account.filter(|s| !s.trim().is_empty()) {
        Some(a) => { m.insert(label, a); }
        None => { m.remove(&label); }
    }
    save_label_account_map(&m)?;
    Ok(m)
}

#[tauri::command]
fn get_session_account_map() -> HashMap<String, String> { load_session_account_map() }

#[tauri::command]
fn set_session_account_mapping(session_id: String, account: Option<String>) -> Result<HashMap<String, String>, String> {
    let mut m = load_session_account_map();
    match account.filter(|s| !s.trim().is_empty()) {
        Some(a) => { m.insert(session_id, a); }
        None => { m.remove(&session_id); }
    }
    save_session_account_map(&m)?;
    Ok(m)
}

// Priority: explicit session→account > any label→account match > default.
// Returns the account name. Falls back to default if the resolved name isn't
// in the registered account list.
fn resolve_account_name(
    session_id: Option<&str>,
    labels: &[String],
    accounts: &[Account],
) -> String {
    let known: std::collections::HashSet<&str> =
        accounts.iter().map(|a| a.name.as_str()).collect();
    if let Some(sid) = session_id {
        if let Some(name) = load_session_account_map().get(sid) {
            if known.contains(name.as_str()) { return name.clone(); }
        }
    }
    let lmap = load_label_account_map();
    for l in labels {
        if let Some(name) = lmap.get(l) {
            if known.contains(name.as_str()) { return name.clone(); }
        }
    }
    DEFAULT_ACCOUNT_NAME.to_string()
}

// Look up a session_id's labels by scanning the labels file. Cheap (HashMap).
fn labels_for_session(session_id: &str) -> Vec<String> {
    load_labels().labels.get(session_id).cloned().unwrap_or_default()
}

// --- `claude auth status` integration ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountAuthInfo {
    pub logged_in: bool,
    pub email: Option<String>,
    pub subscription: Option<String>,
    pub org_name: Option<String>,
}

fn run_claude_auth_status(config_dir: Option<&Path>) -> Result<AccountAuthInfo, String> {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd.exe");
        c.arg("/c").arg("claude").arg("auth").arg("status");
        c
    } else {
        let mut c = std::process::Command::new("claude");
        c.arg("auth").arg("status");
        c
    };
    if let Some(dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().map_err(|e| format!("claude auth status 실행 실패: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output looks like: "Not logged in · Please run /login" when no credentials.
    let v: serde_json::Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(_) => {
            return Ok(AccountAuthInfo {
                logged_in: false,
                email: None,
                subscription: None,
                org_name: None,
            });
        }
    };
    Ok(AccountAuthInfo {
        logged_in: v.get("loggedIn").and_then(|x| x.as_bool()).unwrap_or(false),
        email: v.get("email").and_then(|x| x.as_str()).map(String::from),
        subscription: v.get("subscriptionType").and_then(|x| x.as_str()).map(String::from),
        org_name: v.get("orgName").and_then(|x| x.as_str()).map(String::from),
    })
}

#[tauri::command]
fn refresh_account_info(name: String) -> Result<Vec<Account>, String> {
    let mut list = load_accounts();
    let dir_opt = list.iter().find(|a| a.name == name).and_then(|a| account_config_dir(a));
    let info = run_claude_auth_status(dir_opt.as_deref())?;
    if let Some(acc) = list.iter_mut().find(|a| a.name == name) {
        acc.logged_in = info.logged_in;
        acc.email = info.email;
        acc.subscription = info.subscription;
        acc.org_name = info.org_name;
    }
    save_accounts(&list)?;
    Ok(list)
}

#[tauri::command]
fn refresh_all_accounts() -> Result<Vec<Account>, String> {
    let mut list = load_accounts();
    for acc in list.iter_mut() {
        let dir = account_config_dir(acc);
        if let Ok(info) = run_claude_auth_status(dir.as_deref()) {
            acc.logged_in = info.logged_in;
            acc.email = info.email;
            acc.subscription = info.subscription;
            acc.org_name = info.org_name;
        }
    }
    save_accounts(&list)?;
    Ok(list)
}

// Quick command: spawn an interactive Claude session in a brand-new window
// scoped to a specific account's CLAUDE_CONFIG_DIR. User can then run /login.
#[tauri::command]
async fn open_login_session_for_account(
    account_name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let accounts = load_accounts();
    let acc = accounts.iter().find(|a| a.name == account_name)
        .ok_or_else(|| format!("계정 없음: {}", account_name))?;
    let dir = account_config_dir(acc);
    if let Some(d) = dir.as_ref() { let _ = fs::create_dir_all(d); }

    let mut env = HashMap::new();
    if let Some(d) = dir.as_ref() {
        env.insert("CLAUDE_CONFIG_DIR".to_string(), d.to_string_lossy().to_string());
    }

    let terminal_id = Uuid::new_v4().to_string();
    let payload = AddTabPayload {
        terminal_id,
        title: format!("로그인: {}", account_name),
        ssh_args: vec![],
        cwd: None,
        adopt: false,
        initial_content: String::new(),
        env,
        account_name: Some(account_name.clone()),
    };

    let label = format!("term-{}", Uuid::new_v4().simple());
    state.pending_tabs.lock().unwrap().insert(label.clone(), payload);
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(format!("Claude 로그인 — {}", account_name))
        .inner_size(900.0, 600.0)
        .min_inner_size(640.0, 400.0)
        .resizable(true)
        .disable_drag_drop_handler()
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("Failed to create tokio runtime");

    let usage_state = Arc::new(UsageState::default());
    // Hydrate oauth cache from disk so windows opened before first poll still see data.
    if let Some(disk) = load_oauth_cache_from_disk() {
        if let Ok(mut c) = usage_state.cached_oauth.lock() { *c = Some(disk); }
    }
    let disk_multi = load_oauth_cache_multi_from_disk();
    if !disk_multi.is_empty() {
        if let Ok(mut c) = usage_state.cached_oauth_multi.lock() { *c = disk_multi; }
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
                // 90s polling for OAuth rate-limit endpoint, per account.
                // /usage data doesn't change sub-second and this endpoint is
                // undocumented, so be gentle.
                let handle2 = app.handle().clone();
                let oauth_state = usage_state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        // Refresh `claude auth status` for each account (cheap
                        // subprocess) so emails/subscriptions stay current if
                        // the user logs in/out via the embedded terminal.
                        if let Ok(refreshed) = (|| -> Result<Vec<Account>, String> {
                            let mut list = load_accounts();
                            for acc in list.iter_mut() {
                                let dir = account_config_dir(acc);
                                if let Ok(info) = run_claude_auth_status(dir.as_deref()) {
                                    acc.logged_in = info.logged_in;
                                    acc.email = info.email;
                                    acc.subscription = info.subscription;
                                    acc.org_name = info.org_name;
                                }
                            }
                            save_accounts(&list)?;
                            Ok(list)
                        })() {
                            let _ = handle2.emit("accounts-update", &refreshed);
                        }

                        let accounts = load_accounts();
                        let mut per_account: Vec<AccountOauthUsage> = Vec::with_capacity(accounts.len());
                        let mut cache_map: HashMap<String, OauthUsage> = HashMap::new();
                        let mut default_for_legacy: Option<OauthUsage> = None;
                        for acc in &accounts {
                            let result = fetch_oauth_usage_for_account(acc).await;
                            let (usage, error) = match result {
                                Ok(u) => {
                                    cache_map.insert(acc.name.clone(), u.clone());
                                    if acc.name == DEFAULT_ACCOUNT_NAME {
                                        default_for_legacy = Some(u.clone());
                                    }
                                    (Some(u), None)
                                }
                                Err(e) => (None, Some(e)),
                            };
                            per_account.push(AccountOauthUsage {
                                account_name: acc.name.clone(),
                                alias: acc.alias.clone(),
                                email: acc.email.clone(),
                                subscription: acc.subscription.clone(),
                                org_name: acc.org_name.clone(),
                                logged_in: acc.logged_in,
                                usage,
                                error,
                            });
                        }
                        if let Ok(mut c) = oauth_state.cached_oauth_multi.lock() { *c = cache_map.clone(); }
                        save_oauth_cache_multi_to_disk(&cache_map);
                        if let Some(d) = default_for_legacy {
                            if let Ok(mut c) = oauth_state.cached_oauth.lock() { *c = Some(d.clone()); }
                            save_oauth_cache_to_disk(&d);
                            let _ = handle2.emit("usage-oauth-update", &d);
                        }
                        let _ = handle2.emit("usage-oauth-multi-update", &per_account);
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
            pty_spawn, pty_write, pty_resize, pty_kill_many, pty_take_pending,
            drop_tab, spawn_terminal,
            get_terminal_theme, set_terminal_theme,
            get_log_dir, set_log_dir, clear_logs,
            get_claude_verbose, set_claude_verbose,
            get_skip_permissions, set_skip_permissions,
            open_path_in_os,
            get_metadata_paths, export_metadata_to, import_metadata_from,
            get_usage_report, get_session_usage, find_new_session_since, get_oauth_usage, get_cached_oauth_usage,
            get_oauth_usages_per_account, get_cached_oauth_usages_per_account,
            get_favorite_sessions, set_session_favorite,
            get_accounts, add_account, remove_account, set_account_alias,
            get_label_account_map, set_label_account_mapping,
            get_session_account_map, set_session_account_mapping,
            refresh_account_info, refresh_all_accounts, open_login_session_for_account
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Last-resort PTY cleanup. The frontend kills PTYs in onCloseRequested,
        // but that never runs when a window is destroyed directly or the webview
        // dies, so any PTY still registered here would be orphaned on exit.
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let Some(state) = app.try_state::<AppState>() else { return };
                // Drain first, then kill outside the lock. This runs on the main
                // thread during shutdown, which is only acceptable because
                // kill_pty_tree merely spawns taskkill (~10ms) instead of
                // waiting on it — see the note there.
                let leftover: Vec<Arc<PtyInstance>> = match state.ptys.lock() {
                    Ok(mut m) => m.drain().map(|(_, v)| v).collect(),
                    Err(_) => return,
                };
                for pty in &leftover { kill_pty_tree(pty); }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from the live endpoint on 2026-07-06 (Claude 5 era): the old
    // seven_day_sonnet field is null and scoped weekly moved into `limits`.
    #[test]
    fn oauth_usage_parses_claude5_schema() {
        let json = r#"{
            "five_hour": {"utilization": 10.0, "resets_at": "2026-07-06T04:10:00.165913+00:00", "limit_dollars": null},
            "seven_day": {"utilization": 55.0, "resets_at": "2026-07-09T02:00:00.165937+00:00"},
            "seven_day_sonnet": null,
            "seven_day_opus": null,
            "limits": [
                {"kind": "session", "group": "session", "percent": 10, "severity": "normal", "resets_at": "2026-07-06T04:10:00.165913+00:00", "scope": null, "is_active": false},
                {"kind": "weekly_all", "group": "weekly", "percent": 55, "severity": "normal", "resets_at": "2026-07-09T02:00:00.165937+00:00", "scope": null, "is_active": false},
                {"kind": "weekly_scoped", "group": "weekly", "percent": 69, "severity": "normal", "resets_at": "2026-07-09T02:00:00.166177+00:00", "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null}, "is_active": true}
            ],
            "extra_usage": {"is_enabled": false},
            "spend": {"percent": 0}
        }"#;
        let usage = serde_json::from_str::<ApiOauthUsage>(json).unwrap().into_usage().unwrap();
        assert_eq!(usage.five_hour.utilization, 10.0);
        assert_eq!(usage.seven_day.utilization, 55.0);
        assert!(usage.seven_day_sonnet.is_none());
        let scoped = usage.seven_day_scoped.expect("weekly_scoped 파싱돼야 함");
        assert_eq!(scoped.label.as_deref(), Some("Fable"));
        assert_eq!(scoped.utilization, 69.0);
        assert!(scoped.resets_at.is_some());
    }

    // Pre-Claude5 schema: seven_day_sonnet present, no limits array.
    #[test]
    fn oauth_usage_parses_legacy_schema() {
        let json = r#"{
            "five_hour": {"utilization": 0.0, "resets_at": null},
            "seven_day": {"utilization": 53.0, "resets_at": "2026-07-02T01:59:59+00:00"},
            "seven_day_sonnet": {"utilization": 7.0, "resets_at": "2026-07-02T01:59:59+00:00"}
        }"#;
        let usage = serde_json::from_str::<ApiOauthUsage>(json).unwrap().into_usage().unwrap();
        assert_eq!(usage.seven_day.utilization, 53.0);
        assert_eq!(usage.seven_day_sonnet.unwrap().utilization, 7.0);
        assert!(usage.seven_day_scoped.is_none());
    }

    // Old on-disk cache (camelCase, no new fields) must still deserialize so a
    // stale cache never breaks startup.
    #[test]
    fn oauth_usage_cache_roundtrip_and_legacy_cache() {
        let legacy_cache = r#"{"fiveHour":{"utilization":0.0,"resets_at":null},"sevenDay":{"utilization":53.0,"resets_at":"2026-07-02T01:59:59+00:00"},"sevenDaySonnet":{"utilization":7.0,"resets_at":"2026-07-02T01:59:59+00:00"}}"#;
        let parsed = serde_json::from_str::<OauthUsage>(legacy_cache).unwrap();
        assert_eq!(parsed.seven_day.utilization, 53.0);

        let modern = OauthUsage {
            five_hour: OauthQuota { utilization: 10.0, resets_at: None },
            seven_day: OauthQuota { utilization: 55.0, resets_at: None },
            seven_day_sonnet: None,
            seven_day_scoped: Some(ScopedQuota { label: Some("Fable".into()), utilization: 69.0, resets_at: None }),
        };
        let roundtrip: OauthUsage = serde_json::from_str(&serde_json::to_string(&modern).unwrap()).unwrap();
        assert_eq!(roundtrip.seven_day_scoped.unwrap().label.as_deref(), Some("Fable"));
    }

    #[test]
    fn normalize_model_recognizes_fable() {
        assert_eq!(normalize_model(&Some("claude-fable-5".into())).as_deref(), Some("fable"));
        assert_eq!(normalize_model(&Some("claude-sonnet-5".into())).as_deref(), Some("sonnet"));
        assert_eq!(normalize_model(&Some("unknown-model".into())), None);
    }
}
