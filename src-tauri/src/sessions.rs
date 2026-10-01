use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use similar::{ChangeTag, TextDiff};
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::{log, settings};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
const TAIL_BYTES: u64 = 4 * 1024 * 1024;
const KEEP_FOR_MS: u128 = 3 * 24 * 3600 * 1000;
const CONTEXT_EVERY: Duration = Duration::from_millis(1500);
const MAX_TASK_CHARS: usize = 4000;
const MAX_DIFF_CHARS: usize = 60_000;
const INHERITED_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
];

pub fn session_vars() -> Vec<std::ffi::OsString> {
    std::env::vars_os()
        .map(|(key, _)| key)
        .filter(|key| INHERITED_SESSION_VARS.contains(&key.to_string_lossy().to_uppercase().as_str()))
        .collect()
}
const MAX_STORE_BYTES: u64 = 1024 * 1024 * 1024;

const SECRET_NAMES: &[&str] = &[
    ".env", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials", "credentials.json", "secrets.json",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
];
const SECRET_EXTENSIONS: &[&str] = &["pem", "key", "pfx", "p12", "keystore", "jks", "kdbx", "ovpn"];
const SECRET_DIRS: &[&str] = &[".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker"];

pub fn sensitive(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if SECRET_NAMES.iter().any(|s| name == *s || name.starts_with(&format!("{s}."))) {
        return true;
    }
    if name.starts_with("id_") && !name.contains('.') {
        return true;
    }
    if let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_lowercase()) {
        if SECRET_EXTENSIONS.contains(&ext.as_str()) {
            return true;
        }
    }
    path.components().any(|c| {
        let part = c.as_os_str().to_string_lossy().to_lowercase();
        SECRET_DIRS.contains(&part.as_str())
    })
}

#[derive(Default)]
pub struct Sessions {
    last_context: Mutex<HashMap<String, Instant>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub session_id: String,
    pub used: u64,
    pub window: u64,
    pub model: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub added: usize,
    pub removed: usize,
    pub created: bool,
    pub skipped: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TurnSummary {
    pub session_id: String,
    pub files: Vec<FileChange>,
    pub added: usize,
    pub removed: usize,
    pub duration_ms: u64,
    pub tokens: u64,
    pub output_tokens: u64,
    pub git: bool,
    pub undone: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub restored: Vec<String>,
    pub skipped: Vec<String>,
}

struct Entry {
    path: PathBuf,
    existed: bool,
    skipped: bool,
    backup: Option<PathBuf>,
    before_hash: Option<String>,
    after_hash: Option<String>,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

pub fn safe_id(raw: &str) -> Option<String> {
    let id: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    (!id.is_empty()).then_some(id)
}

fn fnv(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn plain(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_lowercase()
}

fn transcript_ok(path: &Path) -> bool {
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return false;
    }
    let Some(home) = std::env::var_os("USERPROFILE") else { return false };
    let root = PathBuf::from(home).join(".claude").join("projects");
    match (fs::canonicalize(path), fs::canonicalize(&root)) {
        (Ok(file), Ok(root)) => plain(&file).starts_with(&format!("{}\\", plain(&root))),
        _ => false,
    }
}

fn read_tail(path: &Path, max: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(max).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    Some(if start > 0 {
        text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default()
    } else {
        text
    })
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let num = |a: usize, b: usize| s.get(a..b).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut ms = 0;
    if s.get(19..20) == Some(".") {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).collect();
        let padded = format!("{frac:0<3}");
        ms = padded.get(..3).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    }
    Some((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se) * 1000 + ms)
}

fn usage_of(line: &Value) -> Option<(&Value, &Value)> {
    if line.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let message = line.get("message")?;
    Some((message, message.get("usage")?))
}

fn tokens(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(Value::as_u64).unwrap_or(0)
}

pub fn window_for(model: &str, used: u64) -> u64 {
    let m = model.to_lowercase();
    let large = m.contains("[1m]")
        || ["opus-5", "sonnet-5", "fable-5", "haiku-5", "opus-4-7", "opus-4-8"].iter().any(|k| m.contains(k));
    if large || used > 200_000 { 1_000_000 } else { 200_000 }
}

pub fn context_from(text: &str) -> Option<(u64, String)> {
    for raw in text.lines().rev() {
        let Ok(line) = serde_json::from_str::<Value>(raw) else { continue };
        if line.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let Some((message, usage)) = usage_of(&line) else { continue };
        let used = tokens(usage, "input_tokens")
            + tokens(usage, "cache_creation_input_tokens")
            + tokens(usage, "cache_read_input_tokens");
        if used == 0 {
            continue;
        }
        let model = message.get("model").and_then(Value::as_str).unwrap_or_default().to_string();
        return Some((used, model));
    }
    None
}

pub fn turn_tokens(text: &str, since_ms: i64) -> (u64, u64) {
    let mut seen = HashSet::new();
    let (mut total, mut output) = (0u64, 0u64);
    for raw in text.lines() {
        let Ok(line) = serde_json::from_str::<Value>(raw) else { continue };
        let Some((message, usage)) = usage_of(&line) else { continue };
        let at = line.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(0);
        if at < since_ms {
            continue;
        }
        let id = message.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        if !id.is_empty() && !seen.insert(id) {
            continue;
        }
        let out = tokens(usage, "output_tokens");
        output += out;
        total += out
            + tokens(usage, "input_tokens")
            + tokens(usage, "cache_creation_input_tokens")
            + tokens(usage, "cache_read_input_tokens");
    }
    (total, output)
}

#[cfg(test)]
thread_local! {
    static TEST_DIR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn data_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(dir) = TEST_DIR.with(|d| d.borrow().clone()) {
        return dir;
    }
    settings::local_dir()
}

fn turn_of(session: &str) -> Option<(String, PathBuf)> {
    let dir = data_dir();
    let id = fs::read_to_string(dir.join("turns").join(session)).ok()?.trim().to_string();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let store = dir.join("snapshots").join(session).join(&id);
    Some((id, store))
}

fn entries(store: &Path) -> Vec<Entry> {
    let mut out = Vec::new();
    let Ok(list) = fs::read_dir(store) else { return out };
    for item in list.flatten() {
        let file = item.path();
        if file.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = file.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        let Ok(text) = fs::read_to_string(&file) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(path) = v.get("path").and_then(Value::as_str).map(PathBuf::from) else { continue };
        if !path.is_absolute() {
            continue;
        }
        let backup = store.join(format!("{stem}.bak"));
        out.push(Entry {
            path,
            existed: v.get("existed").and_then(Value::as_bool).unwrap_or(true),
            skipped: v.get("skipped").and_then(Value::as_bool).unwrap_or(false),
            backup: backup.is_file().then_some(backup),
            before_hash: v.get("hash").and_then(Value::as_str).map(str::to_string),
            after_hash: fs::read_to_string(store.join(format!("{stem}.after"))).ok().map(|s| s.trim().to_string()),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn before_text(entry: &Entry) -> Option<String> {
    if !entry.existed {
        return Some(String::new());
    }
    String::from_utf8(fs::read(entry.backup.as_ref()?).ok()?).ok()
}

fn current_text(path: &Path) -> Option<String> {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).ok(),
        Err(_) => Some(String::new()),
    }
}

fn count(before: &str, after: &str) -> (usize, usize) {
    let diff = TextDiff::from_lines(before, after);
    let (mut added, mut removed) = (0, 0);
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

fn git_root(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(".git").exists() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

pub fn summary(session: &str, cwd: &str, transcript: Option<&Path>) -> Option<TurnSummary> {
    let (turn, store) = turn_of(session)?;
    let started = turn.parse::<u128>().ok()?;
    let mut files = Vec::new();
    let (mut added, mut removed) = (0, 0);
    for entry in entries(&store) {
        let (a, r) = match (before_text(&entry), current_text(&entry.path)) {
            (Some(before), Some(after)) if !entry.skipped => count(&before, &after),
            _ => (0, 0),
        };
        if a == 0 && r == 0 && !entry.skipped {
            continue;
        }
        added += a;
        removed += r;
        files.push(FileChange {
            path: entry.path.to_string_lossy().to_string(),
            added: a,
            removed: r,
            created: !entry.existed,
            skipped: entry.skipped,
        });
    }
    let (tokens, output_tokens) = transcript
        .and_then(|p| read_tail(p, TAIL_BYTES))
        .map(|text| turn_tokens(&text, started as i64))
        .unwrap_or((0, 0));
    Some(TurnSummary {
        session_id: session.to_string(),
        files,
        added,
        removed,
        duration_ms: now_ms().saturating_sub(started) as u64,
        tokens,
        output_tokens,
        git: !cwd.is_empty() && git_root(Path::new(cwd)).is_some(),
        undone: store.join("undone").exists(),
    })
}

pub fn observe(app: &AppHandle, event: &str, payload: &Value, transcript: PathBuf) {
    if payload.get("tako_origin").and_then(Value::as_str) == Some("chat") {
        return;
    }
    if !matches!(event, "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "PreCompact" | "PostCompact") {
        return;
    }
    let Some(session) = payload.get("session_id").and_then(Value::as_str).and_then(safe_id) else { return };
    if event == "PostToolUse" {
        let state = app.state::<Sessions>();
        let mut last = state.last_context.lock().unwrap();
        if last.get(&session).map(|t| t.elapsed() < CONTEXT_EVERY).unwrap_or(false) {
            return;
        }
        last.insert(session.clone(), Instant::now());
    }
    let raw_session = payload.get("session_id").and_then(Value::as_str).unwrap_or_default().to_string();
    let cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
    let stop = event == "Stop";
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !transcript_ok(&transcript) {
            return;
        }
        if let Some(text) = read_tail(&transcript, 512 * 1024) {
            if let Some((used, model)) = context_from(&text) {
                let info = ContextInfo { session_id: raw_session.clone(), used, window: window_for(&model, used), model };
                let _ = app.emit_to(WINDOW_LABEL, "session-context", info);
            }
        }
        if stop {
            if let Some(mut summary) = summary(&session, &cwd, Some(&transcript)) {
                summary.session_id = raw_session;
                let _ = app.emit_to(WINDOW_LABEL, "session-turn", summary);
            }
        }
    });
}

pub fn undo(session: &str) -> Result<UndoReport, String> {
    let session = safe_id(session).ok_or("Unknown session.")?;
    let (_, store) = turn_of(&session).ok_or("Nothing to undo.")?;
    if store.join("undone").exists() {
        return Err("This turn was already undone.".into());
    }
    let mut report = UndoReport::default();
    for entry in entries(&store) {
        let shown = entry.path.to_string_lossy().to_string();
        if entry.skipped {
            report.skipped.push(format!("{shown} — too big to have been saved"));
            continue;
        }
        let current = match fs::read(&entry.path) {
            Ok(bytes) => fnv(&bytes),
            Err(_) => "missing".to_string(),
        };
        let original = if entry.existed { entry.before_hash.clone() } else { Some("missing".to_string()) };
        if original.as_deref() == Some(current.as_str()) {
            continue;
        }
        match &entry.after_hash {
            Some(after) if after != &current => {
                report.skipped.push(format!("{shown} — changed since Claude edited it"));
                continue;
            }
            None => {
                report.skipped.push(format!("{shown} — no record of Claude's edit, left as is"));
                continue;
            }
            _ => {}
        }
        let result = if entry.existed {
            match &entry.backup {
                Some(backup) => fs::read(backup).and_then(|bytes| {
                    if let Some(parent) = entry.path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::write(&entry.path, bytes)
                }),
                None => Err(std::io::Error::other("no saved copy")),
            }
        } else {
            fs::remove_file(&entry.path)
        };
        match result {
            Ok(()) => report.restored.push(shown),
            Err(err) => report.skipped.push(format!("{shown} — {err}")),
        }
    }
    let _ = fs::write(store.join("undone"), now_ms().to_string());
    log::line(format!("undo: {} restored, {} skipped", report.restored.len(), report.skipped.len()));
    Ok(report)
}

fn unified(session: &str) -> Result<(String, Vec<PathBuf>), String> {
    let session = safe_id(session).ok_or("Unknown session.")?;
    let (_, store) = turn_of(&session).ok_or("No changes recorded for this turn.")?;
    let mut text = String::new();
    let mut files = Vec::new();
    for entry in entries(&store) {
        if sensitive(&entry.path) {
            let name = entry.path.to_string_lossy().replace('\\', "/");
            text.push_str(&format!("--- a/{name}\n+++ b/{name}\n@@ sensitive file, contents hidden @@\n"));
            files.push(entry.path);
            continue;
        }
        let (Some(before), Some(after)) = (before_text(&entry), current_text(&entry.path)) else { continue };
        if before == after {
            continue;
        }
        let name = entry.path.to_string_lossy().replace('\\', "/");
        let old = if entry.existed { format!("a/{name}") } else { "/dev/null".to_string() };
        let diff = TextDiff::from_lines(&before, &after);
        text.push_str(&diff.unified_diff().context_radius(3).header(&old, &format!("b/{name}")).to_string());
        files.push(entry.path);
    }
    if files.is_empty() {
        return Err("No changes left in this turn.".into());
    }
    Ok((text, files))
}

pub fn open_diff(session: &str, project: &str) -> Result<(), String> {
    let (text, _) = unified(session)?;
    let dir = settings::local_dir().join("diffs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name: String = project.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(40).collect();
    let file = dir.join(format!("{}-{}.diff", if name.is_empty() { "turn" } else { &name }, now_ms()));
    fs::write(&file, text).map_err(|e| e.to_string())?;
    if !crate::launch_vscode(Some(file.to_string_lossy().to_string())) {
        let _ = Command::new("explorer").arg(&file).spawn();
    }
    Ok(())
}

fn repo_files(session: &str, cwd: &str) -> Result<(PathBuf, Vec<String>), String> {
    let root = git_root(Path::new(cwd)).ok_or("This project isn't a git repository.")?;
    let root = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let (_, files) = unified(session)?;
    let mut relative = Vec::new();
    for path in files {
        if sensitive(&path) {
            continue;
        }
        let Ok(full) = fs::canonicalize(&path) else { continue };
        let Ok(rest) = full.strip_prefix(&root) else { continue };
        relative.push(rest.to_string_lossy().replace('\\', "/"));
    }
    if relative.is_empty() {
        return Err("None of the changed files can be committed from here (outside the repository, or sensitive).".into());
    }
    Ok((root, relative))
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let exe = crate::find_on_path("git").ok_or("Git isn't installed.")?;
    let output = Command::new(exe)
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if err.is_empty() { "git failed.".to_string() } else { err })
    }
}

fn clean_message(raw: &str) -> String {
    let mut lines: Vec<&str> = raw
        .trim()
        .lines()
        .filter(|l| !l.trim_start().starts_with("```"))
        .filter(|l| !l.to_lowercase().starts_with("co-authored-by"))
        .collect();
    while lines.first().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.remove(0);
    }
    let text = lines.join("\n").trim().to_string();
    text.chars().take(2000).collect()
}

pub async fn commit_message(session: String, cwd: String) -> Result<String, String> {
    let (root, files) = repo_files(&session, &cwd)?;
    let (mut diff, _) = unified(&session)?;
    if diff.len() > MAX_DIFF_CHARS {
        let mut end = MAX_DIFF_CHARS;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        diff.truncate(end);
        diff.push_str("\n…");
    }
    let exe = crate::claude_cli::find().ok_or("Claude Code isn't installed.")?;
    let dir = settings::local_dir().join("chat");
    let _ = fs::create_dir_all(&dir);
    let prompt = format!(
        "Write a git commit message for these changes in the repository {}. Reply with the message only: a subject line under 72 characters in the imperative mood, then optionally a blank line and a few short bullet points. No code fences, no trailers.\n\nFiles: {}\n\n{}",
        root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        files.join(", "),
        diff
    );
    let mut cmd = tokio::process::Command::new(exe);
    cmd.current_dir(&dir)
        .args(["-p", "--output-format", "json", "--model", "haiku", "--setting-sources", "project,local", "--strict-mcp-config", "--tools", ""])
        .env("TAKO_ORIGIN", "chat")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    for key in session_vars() {
        cmd.env_remove(key);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let output = tokio::time::timeout(Duration::from_secs(90), child.wait_with_output())
        .await
        .map_err(|_| "Claude Code took too long.".to_string())?
        .map_err(|e| e.to_string())?;
    let text = serde_json::from_slice::<Value>(&output.stdout)
        .ok()
        .and_then(|v| v.get("result").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let message = clean_message(&text);
    if message.is_empty() {
        return Err("Claude didn't write a message.".into());
    }
    Ok(message)
}

pub fn commit(session: &str, cwd: &str, message: &str) -> Result<String, String> {
    let message = clean_message(message);
    if message.is_empty() {
        return Err("The commit message is empty.".into());
    }
    let (root, files) = repo_files(session, cwd)?;
    let mut add = vec!["add", "--"];
    add.extend(files.iter().map(String::as_str));
    git(&root, &add)?;
    let mut commit = vec!["commit", "-m", message.as_str(), "--"];
    commit.extend(files.iter().map(String::as_str));
    git(&root, &commit)?;
    let hash = git(&root, &["rev-parse", "--short", "HEAD"])?;
    log::line(format!("committed {hash} ({} files)", files.len()));
    Ok(hash)
}

pub fn start_mission(task: &str, cwd: &str) -> Result<(), String> {
    let task: String = task.replace('\0', "").trim().chars().take(MAX_TASK_CHARS).collect();
    if task.is_empty() {
        return Err("Describe the mission first.".into());
    }
    let dir = PathBuf::from(cwd);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("Pick an existing project folder.".into());
    }
    let exe = crate::claude_cli::find().ok_or("Claude Code isn't installed.")?;
    let task = if task.starts_with('-') { format!(" {task}") } else { task };
    let mut cmd = Command::new(exe);
    cmd.arg(task).current_dir(&dir).env("TAKO_ORIGIN", "mission").creation_flags(CREATE_NEW_CONSOLE);
    for key in session_vars() {
        cmd.env_remove(key);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    log::line(format!("mission started in {}", dir.display()));
    Ok(())
}

pub fn set_review_flag(on: bool) {
    let dir = settings::local_dir();
    let flag = dir.join("review-mode");
    if on {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(&flag, "on");
    } else {
        let _ = fs::remove_file(&flag);
    }
}

pub fn cleanup() {
    let dir = settings::local_dir();
    let cutoff = now_ms().saturating_sub(KEEP_FOR_MS);
    if let Ok(sessions) = fs::read_dir(dir.join("snapshots")) {
        for session in sessions.flatten() {
            let Ok(turns) = fs::read_dir(session.path()) else { continue };
            let mut left = 0;
            for turn in turns.flatten() {
                let old = turn.file_name().to_str().and_then(|n| n.parse::<u128>().ok()).map(|t| t < cutoff).unwrap_or(true);
                if old {
                    let _ = fs::remove_dir_all(turn.path());
                } else {
                    left += 1;
                }
            }
            if left == 0 {
                let _ = fs::remove_dir(session.path());
            }
        }
    }
    for sub in ["turns", "diffs"] {
        let Ok(list) = fs::read_dir(dir.join(sub)) else { continue };
        for item in list.flatten() {
            let old = item
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() < cutoff)
                .unwrap_or(false);
            if old {
                let _ = fs::remove_file(item.path());
            }
        }
    }
}

fn dir_size(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|list| list.flatten().map(|i| i.metadata().map(|m| m.len()).unwrap_or(0)).sum())
        .unwrap_or(0)
}

pub fn enforce_quota() {
    let root = settings::local_dir().join("snapshots");
    let mut turns: Vec<(u128, PathBuf, u64)> = Vec::new();
    let Ok(sessions) = fs::read_dir(&root) else { return };
    for session in sessions.flatten() {
        let Ok(list) = fs::read_dir(session.path()) else { continue };
        for turn in list.flatten() {
            let id = turn.file_name().to_str().and_then(|n| n.parse::<u128>().ok()).unwrap_or(0);
            let size = dir_size(&turn.path());
            turns.push((id, turn.path(), size));
        }
    }
    let mut total: u64 = turns.iter().map(|t| t.2).sum();
    turns.sort_by_key(|t| t.0);
    for (_, path, size) in turns {
        if total <= MAX_STORE_BYTES {
            break;
        }
        if fs::remove_dir_all(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

pub fn start_cleanup() {
    tauri::async_runtime::spawn(async {
        loop {
            let _ = tauri::async_runtime::spawn_blocking(|| {
                cleanup();
                enforce_quota();
            })
            .await;
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_timestamps_become_unix_milliseconds() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-10-01T16:10:32.5Z"), Some(1_790_871_032_500));
        assert_eq!(parse_iso_ms("nope"), None);
    }

    #[test]
    fn context_is_read_from_the_last_main_assistant_message() {
        let text = [
            r#"{"type":"assistant","message":{"id":"a","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"cache_read_input_tokens":1000,"output_tokens":50}}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"id":"s","model":"claude-haiku-4-5","usage":{"input_tokens":9999}}}"#,
            r#"{"type":"user","message":{"content":"hi"}}"#,
        ]
        .join("\n");
        assert_eq!(context_from(&text), Some((1010, "claude-sonnet-4-6".to_string())));
    }

    #[test]
    fn windows_follow_the_model() {
        assert_eq!(window_for("claude-sonnet-4-6", 50_000), 200_000);
        assert_eq!(window_for("claude-opus-5-5", 50_000), 1_000_000);
        assert_eq!(window_for("claude-sonnet-4-6[1m]", 50_000), 1_000_000);
        assert_eq!(window_for("claude-haiku-4-5-20251001", 250_000), 1_000_000);
    }

    #[test]
    fn turn_tokens_skip_older_lines_and_duplicates() {
        let text = [
            r#"{"type":"assistant","timestamp":"2026-10-01T10:00:00.000Z","message":{"id":"old","usage":{"input_tokens":5,"output_tokens":5}}}"#,
            r#"{"type":"assistant","timestamp":"2026-10-01T10:05:00.000Z","message":{"id":"m1","usage":{"input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":20}}}"#,
            r#"{"type":"assistant","timestamp":"2026-10-01T10:05:01.000Z","message":{"id":"m1","usage":{"input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":20}}}"#,
        ]
        .join("\n");
        let since = parse_iso_ms("2026-10-01T10:01:00.000Z").unwrap();
        assert_eq!(turn_tokens(&text, since), (1120, 20));
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let status = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git");
        assert!(status.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&status.stderr));
    }

    #[test]
    fn a_turn_is_summarised_committed_and_undone() {
        if crate::find_on_path("git").is_none() {
            return;
        }
        let root = std::env::temp_dir().join(format!("tako-turn-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let data = root.join("data");
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();
        TEST_DIR.with(|d| *d.borrow_mut() = Some(data.clone()));
        for (k, v) in [("GIT_AUTHOR_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@t"), ("GIT_COMMITTER_NAME", "t"), ("GIT_COMMITTER_EMAIL", "t@t")] {
            std::env::set_var(k, v);
        }
        git_ok(&repo, &["init", "-q"]);
        git_ok(&repo, &["config", "commit.gpgsign", "false"]);
        let edited = repo.join("a.txt");
        let created = repo.join("b.txt");
        fs::write(&edited, "one\ntwo\n").unwrap();
        git_ok(&repo, &["add", "a.txt"]);
        git_ok(&repo, &["commit", "-qm", "init"]);

        let turn = (now_ms() - 5000).to_string();
        fs::create_dir_all(data.join("turns")).unwrap();
        fs::write(data.join("turns").join("s1"), &turn).unwrap();
        let store = data.join("snapshots").join("s1").join(&turn);
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("e1.bak"), "one\ntwo\n").unwrap();
        fs::write(store.join("e1.json"), serde_json::json!({ "path": edited, "existed": true, "hash": fnv(b"one\ntwo\n") }).to_string()).unwrap();
        fs::write(store.join("e2.json"), serde_json::json!({ "path": created, "existed": false }).to_string()).unwrap();

        fs::write(&edited, "one\nTWO\nthree\n").unwrap();
        fs::write(store.join("e1.after"), fnv(b"one\nTWO\nthree\n")).unwrap();
        fs::write(&created, "new\n").unwrap();
        fs::write(store.join("e2.after"), fnv(b"new\n")).unwrap();

        let cwd = repo.to_string_lossy().to_string();
        let s = summary("s1", &cwd, None).expect("summary");
        assert_eq!(s.files.len(), 2);
        assert_eq!((s.added, s.removed), (3, 1));
        assert!(s.git);
        assert!(s.duration_ms >= 5000);

        let hash = commit("s1", &cwd, "Add b and change a\n\nCo-Authored-By: someone").expect("commit");
        assert!(!hash.is_empty());
        let log = Command::new("git").arg("-C").arg(&repo).args(["log", "-1", "--format=%B"]).output().unwrap();
        let body = String::from_utf8_lossy(&log.stdout).to_string();
        assert!(body.starts_with("Add b and change a"));
        assert!(!body.to_lowercase().contains("co-authored-by"));

        fs::write(&created, "new\nedited by the user\n").unwrap();
        let report = undo("s1").expect("undo");
        assert_eq!(report.restored.len(), 1);
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(fs::read_to_string(&edited).unwrap(), "one\ntwo\n");
        assert!(created.exists());
        assert!(undo("s1").is_err());

        TEST_DIR.with(|d| *d.borrow_mut() = None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sensitive_paths_match_the_relay() {
        assert!(sensitive(Path::new(r"C:\\p\\.env.production")));
        assert!(sensitive(Path::new(r"C:\\u\\.ssh\\known_hosts")));
        assert!(!sensitive(Path::new(r"C:\\p\\src\\env.rs")));
    }

    #[test]
    fn commit_messages_lose_fences_and_trailers() {
        assert_eq!(clean_message("```\nFix the parser\n\nCo-Authored-By: x\n```"), "Fix the parser");
    }
}
