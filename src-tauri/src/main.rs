// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

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
    label: String,
    custom_title: String,
}

// Send + Sync for rayon
unsafe impl Send for SessionInfo {}

#[derive(Debug, Serialize, Clone)]
struct ProjectInfo {
    folder_name: String,
    project_path: String,
    session_count: u32,
}

// --- Labels ---

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
struct Labels {
    labels: HashMap<String, String>,
}

// --- Cache ---

#[derive(Default)]
struct AppCache {
    sessions: Vec<SessionInfo>,
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
    get_session_titles_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_session_titles(titles: &HashMap<String, String>) -> Result<(), String> {
    let path = get_session_titles_path().ok_or("Cannot find home directory")?;
    let json = serde_json::to_string_pretty(titles).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn load_labels() -> Labels {
    get_labels_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_labels(labels: &Labels) -> Result<(), String> {
    let path = get_labels_path().ok_or("Cannot find home directory")?;
    let json = serde_json::to_string_pretty(labels).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn load_project_labels() -> HashMap<String, String> {
    get_project_labels_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_project_labels(labels: &HashMap<String, String>) -> Result<(), String> {
    let path = get_project_labels_path().ok_or("Cannot find home directory")?;
    let json = serde_json::to_string_pretty(labels).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Fast first-prompt extraction: reads raw bytes, finds first "user" message
fn extract_first_prompt_from_jsonl(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::with_capacity(16384, file);

    for line in reader.lines().take(30) {
        let line = line.ok()?;
        // Quick pre-filter: skip lines that can't be user messages
        if !line.contains("\"type\":\"user\"") && !line.contains("\"type\": \"user\"") {
            continue;
        }
        // Parse only candidate lines
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let msg = v.get("message")?;
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let content = msg.get("content")?;
        match content {
            serde_json::Value::String(s) => {
                return Some(s.chars().take(200).collect());
            }
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
    fs::metadata(path)
        .map(|m| std::cmp::max(1, (m.len() / 2048) as u32))
        .unwrap_or(1)
}

fn file_time_to_rfc3339(path: &Path, use_modified: bool) -> String {
    fs::metadata(path)
        .ok()
        .and_then(|m| {
            if use_modified {
                m.modified().ok()
            } else {
                m.created().ok()
            }
        })
        .map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339()
        })
        .unwrap_or_default()
}

fn decode_folder_to_path(folder: &str) -> String {
    // Encoding: `--` = `:\`, single `-` = either `\` or literal `-`
    // Strategy: decode `--` first, then resolve ambiguous `-` by checking filesystem
    let mut result = String::new();
    let mut chars = folder.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '-' {
            if chars.peek() == Some(&'-') {
                chars.next();
                result.push(':');
                result.push('\\');
            } else {
                // Placeholder for ambiguous `-`
                result.push('\x00');
            }
        } else {
            result.push(ch);
        }
    }

    // Resolve ambiguous `-` (could be `\` or literal `-`)
    // Try filesystem: greedily match longest existing path segments
    resolve_ambiguous_path(&result)
}

fn resolve_ambiguous_path(template: &str) -> String {
    let parts: Vec<&str> = template.split('\x00').collect();
    if parts.len() <= 1 {
        return template.replace('\x00', "-");
    }

    fn find_best(parts: &[&str], idx: usize, current: String) -> Option<String> {
        if idx >= parts.len() {
            // Final path — check if it exists
            if Path::new(&current).exists() {
                return Some(current);
            }
            return None;
        }

        if idx == 0 {
            return find_best(parts, 1, parts[0].to_string());
        }

        // Try `\` (path separator) first — more common
        let with_sep = format!("{}\\{}", current, parts[idx]);
        if let Some(result) = find_best(parts, idx + 1, with_sep) {
            return Some(result);
        }

        // Try `-` (literal hyphen)
        let with_hyphen = format!("{}-{}", current, parts[idx]);
        if let Some(result) = find_best(parts, idx + 1, with_hyphen) {
            return Some(result);
        }

        None
    }

    // Try to find existing path via backtracking
    if let Some(resolved) = find_best(&parts, 0, String::new()) {
        return resolved;
    }

    // Fallback: treat all as `\`
    parts.join("\\")
}

/// Scan a single project directory — designed to run in parallel
fn scan_project(
    project_dir: &Path,
    folder_name: &str,
    labels: &Labels,
    titles: &HashMap<String, String>,
) -> Vec<SessionInfo> {
    let mut sessions = Vec::new();

    // Load index if available
    let index_path = project_dir.join("sessions-index.json");
    let index: Option<SessionsIndex> = if index_path.exists() {
        fs::read_to_string(&index_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    } else {
        None
    };

    let project_path = index
        .as_ref()
        .and_then(|i| i.original_path.clone())
        .unwrap_or_else(|| decode_folder_to_path(folder_name));

    // Index lookup
    let indexed: HashMap<String, &IndexEntry> = index
        .as_ref()
        .map(|idx| {
            idx.entries
                .iter()
                .map(|e| (e.session_id.clone(), e))
                .collect()
        })
        .unwrap_or_default();

    // Collect top-level .jsonl file paths first (no subagent dirs)
    let jsonl_files: Vec<_> = fs::read_dir(project_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let p = e.path();
            !p.is_dir()
                && p.extension().map(|ext| ext == "jsonl").unwrap_or(false)
        })
        .collect();

    for file_entry in jsonl_files {
        let file_path = file_entry.path();
        let session_id = file_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let label = labels.labels.get(&session_id).cloned().unwrap_or_default();
        let custom_title = titles.get(&session_id).cloned().unwrap_or_default();

        if let Some(idx) = indexed.get(&session_id) {
            sessions.push(SessionInfo {
                session_id,
                first_prompt: idx.first_prompt.clone().unwrap_or_default(),
                summary: idx.summary.clone().unwrap_or_default(),
                message_count: idx.message_count,
                created: idx.created.clone().unwrap_or_default(),
                modified: idx.modified.clone().unwrap_or_default(),
                git_branch: idx.git_branch.clone().unwrap_or_default(),
                project_path: project_path.clone(),
                project_folder: folder_name.to_string(),
                label,
                custom_title,
            });
        } else {
            // Fallback: minimal JSONL read
            let first_prompt =
                extract_first_prompt_from_jsonl(&file_path).unwrap_or_default();
            let msg_count = estimate_message_count(&file_path);
            let modified = file_time_to_rfc3339(&file_path, true);
            let created = file_time_to_rfc3339(&file_path, false);

            sessions.push(SessionInfo {
                session_id,
                first_prompt,
                summary: String::new(),
                message_count: msg_count,
                created,
                modified,
                git_branch: String::new(),
                project_path: project_path.clone(),
                project_folder: folder_name.to_string(),
                label,
                custom_title,
            });
        }
    }

    sessions
}

fn scan_all_sessions() -> Result<Vec<SessionInfo>, String> {
    let projects_dir = get_claude_projects_dir().ok_or("Cannot find .claude/projects")?;
    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let labels = load_labels();
    let titles = load_session_titles();

    // Collect project directories
    let project_dirs: Vec<_> = fs::read_dir(&projects_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .collect();

    // Parallel scan across all projects
    let mut all_sessions: Vec<SessionInfo> = project_dirs
        .par_iter()
        .flat_map(|dir| {
            let folder = dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            scan_project(dir, &folder, &labels, &titles)
        })
        .collect();

    // Sort by modified descending
    all_sessions.par_sort_unstable_by(|a, b| b.modified.cmp(&a.modified));

    Ok(all_sessions)
}

// --- Tauri Commands ---

#[tauri::command]
fn get_sessions(cache: State<Mutex<AppCache>>) -> Result<Vec<SessionInfo>, String> {
    let sessions = scan_all_sessions()?;
    if let Ok(mut c) = cache.lock() {
        c.sessions = sessions.clone();
    }
    Ok(sessions)
}

#[tauri::command]
fn get_projects() -> Result<Vec<ProjectInfo>, String> {
    let projects_dir = get_claude_projects_dir().ok_or("Cannot find .claude/projects")?;
    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let project_dirs: Vec<_> = fs::read_dir(&projects_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .collect();

    let mut projects: Vec<ProjectInfo> = project_dirs
        .par_iter()
        .map(|path| {
            let folder_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

            let session_count = fs::read_dir(path)
                .map(|entries| {
                    entries
                        .flatten()
                        .filter(|e| {
                            let p = e.path();
                            !p.is_dir() && p.extension().map(|ext| ext == "jsonl").unwrap_or(false)
                        })
                        .count() as u32
                })
                .unwrap_or(0);

            let index_path = path.join("sessions-index.json");
            let project_path = if index_path.exists() {
                fs::read_to_string(&index_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<SessionsIndex>(&s).ok())
                    .and_then(|i| i.original_path)
                    .unwrap_or_else(|| decode_folder_to_path(&folder_name))
            } else {
                decode_folder_to_path(&folder_name)
            };

            ProjectInfo {
                folder_name,
                project_path,
                session_count,
            }
        })
        .collect();

    projects.sort_by(|a, b| a.project_path.cmp(&b.project_path));
    Ok(projects)
}

#[tauri::command]
fn get_project_labels() -> Result<HashMap<String, String>, String> {
    Ok(load_project_labels())
}

#[tauri::command]
fn set_project_label(project_folder: String, label: String) -> Result<(), String> {
    let mut labels = load_project_labels();
    if label.is_empty() {
        labels.remove(&project_folder);
    } else {
        labels.insert(project_folder, label);
    }
    save_project_labels(&labels)
}

#[tauri::command]
fn set_session_title(session_id: String, title: String) -> Result<(), String> {
    let mut titles = load_session_titles();
    if title.is_empty() {
        titles.remove(&session_id);
    } else {
        titles.insert(session_id, title);
    }
    save_session_titles(&titles)
}

#[tauri::command]
fn set_label(session_id: String, label: String) -> Result<(), String> {
    let mut labels = load_labels();
    if label.is_empty() {
        labels.labels.remove(&session_id);
    } else {
        labels.labels.insert(session_id, label);
    }
    save_labels(&labels)
}

#[tauri::command]
fn delete_session(session_id: String, project_folder: String) -> Result<(), String> {
    let projects_dir = get_claude_projects_dir().ok_or("Cannot find .claude/projects")?;
    let project_dir = projects_dir.join(&project_folder);

    // Delete .jsonl
    let jsonl_path = project_dir.join(format!("{}.jsonl", session_id));
    if jsonl_path.exists() {
        fs::remove_file(&jsonl_path).map_err(|e| e.to_string())?;
    }

    // Delete data dir
    let data_dir = project_dir.join(&session_id);
    if data_dir.exists() && data_dir.is_dir() {
        fs::remove_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }

    // Update index
    let index_path = project_dir.join("sessions-index.json");
    if index_path.exists() {
        if let Ok(content) = fs::read_to_string(&index_path) {
            if let Ok(mut index) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(entries) = index.get_mut("entries").and_then(|e| e.as_array_mut()) {
                    entries.retain(|e| {
                        e.get("sessionId").and_then(|s| s.as_str()) != Some(&session_id)
                    });
                }
                let _ = fs::write(&index_path, serde_json::to_string_pretty(&index).unwrap_or_default());
            }
        }
    }

    // Remove label & title
    let mut labels = load_labels();
    labels.labels.remove(&session_id);
    let _ = save_labels(&labels);

    let mut titles = load_session_titles();
    titles.remove(&session_id);
    let _ = save_session_titles(&titles);

    cleanup_empty_project(&project_dir);
    Ok(())
}

#[tauri::command]
fn delete_project_sessions(project_folder: String) -> Result<u32, String> {
    let projects_dir = get_claude_projects_dir().ok_or("Cannot find .claude/projects")?;
    let project_dir = projects_dir.join(&project_folder);
    if !project_dir.exists() {
        return Ok(0);
    }

    let mut deleted = 0u32;
    let mut labels = load_labels();
    let mut titles = load_session_titles();

    let entries: Vec<_> = fs::read_dir(&project_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    for entry in &entries {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

        if name.ends_with(".jsonl") {
            let sid = name.trim_end_matches(".jsonl");
            labels.labels.remove(sid);
            titles.remove(sid);
            let data_dir = project_dir.join(sid);
            if data_dir.is_dir() {
                let _ = fs::remove_dir_all(&data_dir);
            }
            let _ = fs::remove_file(&path);
            deleted += 1;
        }
    }

    let _ = save_labels(&labels);
    let _ = save_session_titles(&titles);
    let _ = fs::remove_file(project_dir.join("sessions-index.json"));
    cleanup_empty_project(&project_dir);
    Ok(deleted)
}

fn cleanup_empty_project(project_dir: &Path) {
    let has_sessions = fs::read_dir(project_dir)
        .map(|entries| {
            entries.flatten().any(|e| {
                let p = e.path();
                !p.is_dir() && p.extension().map(|ext| ext == "jsonl").unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if !has_sessions {
        let _ = fs::remove_dir_all(project_dir);
    }
}

#[tauri::command]
fn resume_session(session_id: String, project_path: String, skip_permissions: bool) -> Result<(), String> {
    use std::process::Command;

    let skip_flag = if skip_permissions { " --dangerously-skip-permissions" } else { "" };
    let temp_dir = std::env::temp_dir();
    let bat_path = temp_dir.join("kcsm_resume.bat");
    let bat_content = format!(
        "@echo off\r\ncd /d \"{}\"\r\nclaude --resume {}{}\r\n",
        project_path, session_id, skip_flag
    );
    fs::write(&bat_path, &bat_content).map_err(|e| e.to_string())?;

    Command::new("cmd")
        .args(["/c", "start", "cmd", "/k", bat_path.to_str().unwrap_or("")])
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn open_claude(project_path: String, skip_permissions: bool) -> Result<(), String> {
    use std::process::Command;

    let skip_flag = if skip_permissions { " --dangerously-skip-permissions" } else { "" };
    let temp_dir = std::env::temp_dir();
    let bat_path = temp_dir.join("kcsm_open.bat");
    let bat_content = format!(
        "@echo off\r\ncd /d \"{}\"\r\nclaude{}\r\n",
        project_path, skip_flag
    );
    fs::write(&bat_path, &bat_content).map_err(|e| e.to_string())?;

    Command::new("cmd")
        .args(["/c", "start", "cmd", "/k", bat_path.to_str().unwrap_or("")])
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(AppCache::default()))
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            get_projects,
            get_project_labels,
            set_project_label,
            set_label,
            set_session_title,
            delete_session,
            delete_project_sessions,
            resume_session,
            open_claude
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
