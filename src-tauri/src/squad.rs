use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};

use crate::island::WINDOW_LABEL;
use crate::{log, settings};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
const MAX_TASK: usize = 4_000;
const MAX_JOBS: usize = 24;
const NIGHT_FILE_TOOLS: &[&str] = &["Read", "Grep", "Glob", "Edit", "MultiEdit", "Write", "NotebookEdit", "TodoWrite"];
const NIGHT_COMMANDS: &[&str] = &[
    "git status", "git diff", "git log", "git show",
    "npm test", "npm run test", "npm run build", "npm run lint", "npx tsc",
    "pnpm test", "yarn test", "cargo test", "cargo check", "cargo build", "cargo clippy", "cargo fmt",
    "pytest", "python -m pytest", "go test", "go build", "dotnet test", "dotnet build",
];
const NIGHT_PROMPT: &str = "Tu travailles seul pendant la nuit, personne ne peut répondre à tes questions ni valider une action. Fais la tâche du mieux possible sans rien demander, lance les tests du projet si c'est possible, ne pousse rien et ne touche à rien en dehors de ce dossier. À la fin, résume en une ou deux phrases ce que tu as fait ou ce qui t'a bloqué.";

static JOBS: Mutex<Vec<Job>> = Mutex::new(Vec::new());
static LOADED: AtomicBool = AtomicBool::new(false);
static AWAKE: AtomicBool = AtomicBool::new(false);
static FORCED: AtomicBool = AtomicBool::new(false);
static NIGHT: Mutex<Option<Report>> = Mutex::new(None);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub repo: String,
    pub task: String,
    pub branch: String,
    pub base: String,
    pub base_commit: String,
    pub worktree: String,
    pub agent: Option<String>,
    pub session: Option<String>,
    pub status: String,
    pub night: bool,
    pub created: u64,
    pub started: Option<u64>,
    pub finished: Option<u64>,
    pub files: u32,
    pub added: u32,
    pub removed: u32,
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub at: u64,
    pub done: u32,
    pub empty: u32,
    pub failed: u32,
    pub jobs: Vec<String>,
    pub seen: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Saved {
    jobs: Vec<Job>,
    report: Option<Report>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub jobs: Vec<Job>,
    pub report: Option<Report>,
    pub night_armed: bool,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn store() -> PathBuf {
    settings::config_dir().join("squad.json")
}

fn load() {
    if LOADED.swap(true, Ordering::SeqCst) {
        return;
    }
    let saved: Saved = fs::read_to_string(store()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    *JOBS.lock().unwrap() = saved.jobs;
    *NIGHT.lock().unwrap() = saved.report;
}

fn save() {
    let saved = Saved { jobs: JOBS.lock().unwrap().clone(), report: NIGHT.lock().unwrap().clone() };
    if let Ok(text) = serde_json::to_string_pretty(&saved) {
        let _ = fs::create_dir_all(settings::config_dir());
        let _ = fs::write(store(), text);
    }
}

pub fn board() -> Board {
    load();
    let jobs = JOBS.lock().unwrap().clone();
    let night_armed = jobs.iter().any(|j| j.night && j.status == "queued");
    Board { jobs, report: NIGHT.lock().unwrap().clone(), night_armed }
}

fn emit(app: &AppHandle) {
    let _ = app.emit_to(WINDOW_LABEL, "squad", board());
}

pub fn slug(task: &str, salt: u64) -> String {
    let lower = task.to_lowercase();
    let folded: String = lower
        .chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' | 'á' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            c if c.is_ascii_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    let mut words: Vec<&str> = folded.split_whitespace().filter(|w| w.len() > 2).take(4).collect();
    if words.is_empty() {
        words.push("mission");
    }
    let mut base = words.join("-");
    base.truncate(28);
    let base = base.trim_end_matches('-').to_string();
    format!("{base}-{:04x}", salt & 0xffff)
}

fn git_exe() -> Result<PathBuf, String> {
    crate::find_on_path("git").ok_or_else(|| "Git n'est pas installé.".to_string())
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(git_exe()?)
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if err.is_empty() { "git a échoué.".into() } else { err })
    }
}

fn claude(args: &[&str], dir: &Path, extra: &[String]) -> Result<String, String> {
    let exe = crate::claude_cli::find().ok_or("Claude Code n'est pas installé.")?;
    let mut cmd = Command::new(exe);
    cmd.args(args).args(extra).current_dir(dir).env("TAKO_ORIGIN", "squad").stdin(Stdio::null()).creation_flags(CREATE_NO_WINDOW);
    for key in crate::sessions::session_vars() {
        cmd.env_remove(key);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        Ok(text)
    } else {
        Err(text.trim().lines().find(|l| !l.trim().is_empty() && !l.contains("Starting background")).unwrap_or("Claude Code a échoué.").to_string())
    }
}

pub fn agent_id(output: &str) -> Option<String> {
    let at = output.find("backgrounded")?;
    output[at..]
        .split(|c: char| !c.is_ascii_hexdigit())
        .find(|part| part.len() >= 6)
        .map(|s| s.to_string())
}

pub fn shortstat(text: &str) -> (u32, u32, u32) {
    let mut out = (0, 0, 0);
    for part in text.split(',') {
        let part = part.trim();
        let n: u32 = part.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
        if part.contains("file") {
            out.0 = n;
        } else if part.contains("insertion") {
            out.1 = n;
        } else if part.contains("deletion") {
            out.2 = n;
        }
    }
    out
}

fn exclude_worktrees(repo: &Path) {
    let Ok(common) = git(repo, &["rev-parse", "--git-common-dir"]) else { return };
    let common = if Path::new(&common).is_absolute() { PathBuf::from(common) } else { repo.join(common) };
    let file = common.join("info").join("exclude");
    let current = fs::read_to_string(&file).unwrap_or_default();
    if current.lines().any(|l| l.trim() == ".claude/worktrees/") {
        return;
    }
    let _ = fs::create_dir_all(file.parent().unwrap_or(&common));
    let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    let _ = fs::write(&file, format!("{current}{sep}.claude/worktrees/\n"));
}

pub fn add(app: &AppHandle, repo: &str, task: &str, night: bool) -> Result<Board, String> {
    load();
    let task: String = task.replace('\0', "").trim().chars().take(MAX_TASK).collect();
    if task.is_empty() {
        return Err("Décris la tâche d'abord.".into());
    }
    let dir = PathBuf::from(repo);
    if !dir.is_dir() {
        return Err("Choisis un dossier de projet existant.".into());
    }
    let root = git(&dir, &["rev-parse", "--show-toplevel"]).map_err(|_| "Ce dossier n'est pas un dépôt git.".to_string())?;
    let root = PathBuf::from(root.replace('/', "\\"));
    let base_commit = git(&root, &["rev-parse", "HEAD"]).map_err(|_| "Ce dépôt n'a encore aucun commit.".to_string())?;
    let base = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
    let created = now();
    let slug = slug(&task, created ^ (created >> 17));
    let worktree = root.join(".claude").join("worktrees").join(format!("tako-{slug}"));
    let job = Job {
        id: slug.clone(),
        repo: root.to_string_lossy().to_string(),
        task,
        branch: format!("tako/{slug}"),
        base,
        base_commit,
        worktree: worktree.to_string_lossy().to_string(),
        agent: None,
        session: None,
        status: "queued".into(),
        night,
        created,
        started: None,
        finished: None,
        files: 0,
        added: 0,
        removed: 0,
        note: String::new(),
    };
    {
        let mut jobs = JOBS.lock().unwrap();
        if jobs.iter().filter(|j| is_open(j)).count() >= MAX_JOBS {
            return Err("Trop de missions ouvertes : fusionne ou jette les anciennes.".into());
        }
        jobs.push(job);
    }
    save();
    if !night {
        fill(app);
    }
    emit(app);
    Ok(board())
}

fn is_open(job: &Job) -> bool {
    !matches!(job.status.as_str(), "merged" | "discarded")
}

fn is_active(job: &Job) -> bool {
    matches!(job.status.as_str(), "running" | "waiting")
}

fn launch(job: &Job, night_policy: &str) -> Result<String, String> {
    let root = PathBuf::from(&job.repo);
    let worktree = PathBuf::from(&job.worktree);
    if !worktree.exists() {
        exclude_worktrees(&root);
        git(&root, &["worktree", "add", "-b", &job.branch, &job.worktree, &job.base_commit])?;
    }
    let prompt = if job.night { format!("{}\n\n{}", job.task, NIGHT_PROMPT) } else { job.task.clone() };
    let mut args: Vec<String> = vec!["--bg".into(), positional(&prompt)];
    if job.night && night_policy != "auto" {
        args.push("--permission-mode".into());
        args.push("dontAsk".into());
        args.push(format!("--allowedTools={}", night_tools().join(",")));
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = claude(&refs, &worktree, &[])?;
    agent_id(&output).ok_or_else(|| "Claude Code n'a pas démarré l'agent.".to_string())
}

fn slots(jobs: &[Job], night: bool) -> usize {
    let s = settings::load();
    let limit = if night { s.night_parallel.clamp(1, 4) } else { s.squad_parallel.clamp(1, 6) } as usize;
    limit.saturating_sub(jobs.iter().filter(|j| is_active(j) && j.night == night).count())
}

fn fill(app: &AppHandle) {
    let policy = settings::load().night_policy;
    let night_now = night_window() || FORCED.load(Ordering::Relaxed);
    let mut started = false;
    loop {
        let next = {
            let jobs = JOBS.lock().unwrap();
            let day = slots(&jobs, false);
            let night = slots(&jobs, true);
            jobs.iter()
                .find(|j| j.status == "queued" && if j.night { night_now && night > 0 } else { day > 0 })
                .cloned()
        };
        let Some(job) = next else { break };
        let result = launch(&job, &policy);
        let mut jobs = JOBS.lock().unwrap();
        if let Some(j) = jobs.iter_mut().find(|j| j.id == job.id) {
            match result {
                Ok(agent) => {
                    j.agent = Some(agent);
                    j.status = "running".into();
                    j.started = Some(now());
                    log::line(format!("squad: started {}", j.id));
                }
                Err(err) => {
                    j.status = "failed".into();
                    j.note = err;
                    j.finished = Some(now());
                }
            }
        }
        started = true;
    }
    if started {
        save();
        emit(app);
    }
}

pub fn in_night(hour: u32, start: u32) -> bool {
    let start = start.min(23);
    if start >= 7 {
        hour >= start || hour < 7
    } else {
        hour >= start && hour < 7
    }
}

pub fn night_window() -> bool {
    in_night(local_hour(), settings::load().night_hour)
}

fn local_hour() -> u32 {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    unsafe { GetLocalTime().wHour as u32 }
}

#[derive(Deserialize)]
struct Agent {
    id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    state: Option<String>,
    status: Option<String>,
}

fn agents() -> Vec<Agent> {
    let home = settings::local_dir();
    let Ok(text) = claude(&["agents", "--json", "--all"], &home, &[]) else { return Vec::new() };
    let start = text.find('[').unwrap_or(0);
    let end = text.rfind(']').map(|e| e + 1).unwrap_or(text.len());
    serde_json::from_str::<Vec<Value>>(&text[start..end])
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect()
}

pub fn phase(busy: bool, blocked: bool) -> &'static str {
    match (busy, blocked) {
        (true, true) => "waiting",
        (true, false) => "running",
        _ => "finished",
    }
}

fn stats(job: &Job) -> (u32, u32, u32) {
    let wt = PathBuf::from(&job.worktree);
    if !wt.exists() {
        return (0, 0, 0);
    }
    let _ = git(&wt, &["add", "-A", "-N"]);
    git(&wt, &["diff", "--shortstat", &job.base_commit]).map(|s| shortstat(&s)).unwrap_or((0, 0, 0))
}

fn refresh(app: &AppHandle) {
    let active: Vec<Job> = JOBS.lock().unwrap().iter().filter(|j| is_active(j)).cloned().collect();
    if active.is_empty() {
        return;
    }
    let list = agents();
    let mut changed = false;
    for job in active {
        let found = list.iter().find(|a| a.id.as_deref() == job.agent.as_deref() && job.agent.is_some());
        let (busy, blocked, session) = match found {
            Some(a) => (a.status.as_deref() == Some("busy"), a.state.as_deref() == Some("blocked"), a.session_id.clone()),
            None => (false, false, None),
        };
        let next = phase(busy, blocked);
        let (files, added, removed) = stats(&job);
        let mut jobs = JOBS.lock().unwrap();
        let Some(j) = jobs.iter_mut().find(|j| j.id == job.id) else { continue };
        if j.session.is_none() && session.is_some() {
            j.session = session;
            changed = true;
        }
        if (j.files, j.added, j.removed) != (files, added, removed) {
            j.files = files;
            j.added = added;
            j.removed = removed;
            changed = true;
        }
        let status = if next == "finished" { if files > 0 { "done" } else { "empty" } } else { next };
        if j.status != status {
            j.status = status.to_string();
            if next == "finished" {
                j.finished = Some(now());
                if blocked {
                    j.note = "Claude s'est arrêté sur une action refusée ou une question.".into();
                }
                log::line(format!("squad: {} {}", j.id, status));
            }
            changed = true;
        }
    }
    if changed {
        save();
        emit(app);
    }
}

fn finish_night(app: &AppHandle) {
    let (pending, finished): (Vec<Job>, Vec<Job>) = {
        let jobs = JOBS.lock().unwrap();
        let night: Vec<Job> = jobs.iter().filter(|j| j.night && j.started.is_some() && j.status != "discarded").cloned().collect();
        night.into_iter().partition(|j| matches!(j.status.as_str(), "queued" | "running" | "waiting"))
    };
    if !pending.is_empty() || finished.is_empty() {
        return;
    }
    let mut report = NIGHT.lock().unwrap();
    let last = finished.iter().filter_map(|j| j.finished).max().unwrap_or(0);
    if report.as_ref().is_some_and(|r| r.at >= last) {
        return;
    }
    *report = Some(Report {
        at: last.max(1),
        done: finished.iter().filter(|j| j.status == "done" || j.status == "merged").count() as u32,
        empty: finished.iter().filter(|j| j.status == "empty").count() as u32,
        failed: finished.iter().filter(|j| j.status == "failed").count() as u32,
        jobs: finished.iter().map(|j| j.id.clone()).collect(),
        seen: false,
    });
    drop(report);
    {
        let mut jobs = JOBS.lock().unwrap();
        for j in jobs.iter_mut().filter(|j| j.night && j.started.is_some()) {
            j.night = false;
        }
    }
    FORCED.store(false, Ordering::Relaxed);
    log::line("squad: night shift finished");
    save();
    let _ = app.emit_to(WINDOW_LABEL, "squad-dawn", ());
    emit(app);
}

fn keep_awake(on: bool) {
    if AWAKE.swap(on, Ordering::SeqCst) == on {
        return;
    }
    unsafe {
        let _ = SetThreadExecutionState(if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS });
    }
}

pub fn start(app: AppHandle) {
    load();
    std::thread::spawn(move || {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
        loop {
            fill(&app);
            refresh(&app);
            finish_night(&app);
            let (busy, night) = {
                let jobs = JOBS.lock().unwrap();
                (jobs.iter().any(is_active), jobs.iter().any(|j| j.night && matches!(j.status.as_str(), "queued" | "running" | "waiting")))
            };
            let running_night = night && (night_window() || FORCED.load(Ordering::Relaxed));
            keep_awake(running_night && settings::load().night_keep_awake);
            std::thread::sleep(if busy { Duration::from_secs(4) } else { Duration::from_secs(30) });
        }
    });
}

fn find(id: &str) -> Result<Job, String> {
    load();
    JOBS.lock().unwrap().iter().find(|j| j.id == id).cloned().ok_or_else(|| "Mission introuvable.".to_string())
}

fn update(app: &AppHandle, id: &str, change: impl FnOnce(&mut Job)) {
    if let Some(j) = JOBS.lock().unwrap().iter_mut().find(|j| j.id == id) {
        change(j);
    }
    save();
    emit(app);
}

fn remove_worktree(job: &Job) {
    let root = PathBuf::from(&job.repo);
    if let Some(agent) = &job.agent {
        let _ = claude(&["stop", agent], &root, &[]);
        let _ = claude(&["rm", agent], &root, &[]);
    }
    if Path::new(&job.worktree).exists() {
        let _ = git(&root, &["worktree", "remove", "--force", &job.worktree]);
    }
    let _ = git(&root, &["worktree", "prune"]);
    let _ = git(&root, &["branch", "-D", &job.branch]);
}

pub fn stop(app: &AppHandle, id: &str) -> Result<(), String> {
    let job = find(id)?;
    if let Some(agent) = &job.agent {
        claude(&["stop", agent], Path::new(&job.repo), &[])?;
    }
    let (files, added, removed) = stats(&job);
    update(app, id, |j| {
        j.status = if files > 0 { "done".into() } else { "empty".into() };
        j.files = files;
        j.added = added;
        j.removed = removed;
        j.finished = Some(now());
        j.note = "Arrêtée".into();
    });
    Ok(())
}

pub fn discard(app: &AppHandle, id: &str) -> Result<(), String> {
    let job = find(id)?;
    if job.status == "queued" {
        JOBS.lock().unwrap().retain(|j| j.id != id);
        save();
        emit(app);
        return Ok(());
    }
    remove_worktree(&job);
    update(app, id, |j| j.status = "discarded".into());
    JOBS.lock().unwrap().retain(|j| j.id != id);
    save();
    emit(app);
    Ok(())
}

pub fn diff(id: &str) -> Result<(), String> {
    let job = find(id)?;
    let wt = PathBuf::from(&job.worktree);
    let _ = git(&wt, &["add", "-A", "-N"]);
    let text = git(&wt, &["diff", &job.base_commit])?;
    if text.trim().is_empty() {
        return Err("Aucun changement pour l'instant.".into());
    }
    let dir = settings::local_dir().join("diffs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.diff", job.id));
    fs::write(&file, text).map_err(|e| e.to_string())?;
    if !crate::launch_vscode(Some(file.to_string_lossy().to_string())) {
        let _ = Command::new("explorer").arg(&file).spawn();
    }
    Ok(())
}

pub fn open(id: &str) -> Result<(), String> {
    let job = find(id)?;
    let exe = crate::claude_cli::find().ok_or("Claude Code n'est pas installé.")?;
    let mut cmd = Command::new(exe);
    match (&job.agent, &job.session, job.status.as_str()) {
        (Some(agent), _, "running" | "waiting") => {
            cmd.args(["attach", agent]);
        }
        (_, Some(session), _) => {
            cmd.args(["--resume", session]);
        }
        _ => {}
    }
    cmd.current_dir(&job.worktree).env("TAKO_ORIGIN", "squad").creation_flags(CREATE_NEW_CONSOLE);
    for key in crate::sessions::session_vars() {
        cmd.env_remove(key);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn reply(app: &AppHandle, id: &str, text: &str) -> Result<(), String> {
    let job = find(id)?;
    let session = job.session.clone().ok_or("Cette mission n'a pas encore de session.")?;
    let text: String = text.trim().chars().take(MAX_TASK).collect();
    if text.is_empty() {
        return Err("Écris ce que Claude doit faire ensuite.".into());
    }
    let output = claude(&["--bg", &positional(&text), "--resume", &session], Path::new(&job.worktree), &[])?;
    let agent = agent_id(&output).or(job.agent.clone());
    update(app, id, |j| {
        j.agent = agent;
        j.status = "running".into();
        j.finished = None;
        j.note.clear();
    });
    Ok(())
}

pub fn merge(app: &AppHandle, id: &str) -> Result<String, String> {
    let job = find(id)?;
    if is_active(&job) {
        return Err("Attends que Claude ait fini (ou arrête la mission).".into());
    }
    let root = PathBuf::from(&job.repo);
    let wt = PathBuf::from(&job.worktree);
    let current = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current != job.base {
        return Err(format!("Ton dépôt est sur « {current} », pas sur « {} ». Reviens sur cette branche pour fusionner.", job.base));
    }
    if !git(&root, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("Ton dossier a des modifications non commitées : commite-les ou mets-les de côté avant de fusionner.".into());
    }
    if wt.exists() && !git(&wt, &["status", "--porcelain"])?.is_empty() {
        git(&wt, &["add", "-A"])?;
        let message = format!("Tako : {}", first_line(&job.task, 72));
        git(&wt, &["commit", "-m", &message])?;
    }
    let ahead = git(&root, &["rev-list", "--count", &format!("{}..{}", job.base_commit, job.branch)]).unwrap_or_default();
    if ahead.trim() == "0" {
        return Err("Cette mission n'a rien changé.".into());
    }
    let message = format!("Tako : {}", first_line(&job.task, 72));
    if let Err(err) = git(&root, &["merge", "--no-ff", "-m", &message, &job.branch]) {
        let _ = git(&root, &["merge", "--abort"]);
        update(app, id, |j| j.note = "Conflit : ouvre la mission pour le régler avec Claude.".into());
        log::line(format!("squad: merge conflict {} ({})", job.id, first_line(&err, 120)));
        return Err("Conflit avec ta branche : Tako a tout annulé. Ouvre la mission pour que Claude le règle.".into());
    }
    let hash = git(&root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    remove_worktree(&job);
    update(app, id, |j| {
        j.status = "merged".into();
        j.note = hash.clone();
    });
    log::line(format!("squad: merged {} as {hash}", job.id));
    Ok(hash)
}

pub fn clear_finished(app: &AppHandle) {
    JOBS.lock().unwrap().retain(|j| j.status != "merged");
    save();
    emit(app);
}

pub fn run_night_now(app: &AppHandle) {
    let any = JOBS.lock().unwrap().iter().any(|j| j.night && j.status == "queued");
    if any {
        FORCED.store(true, Ordering::Relaxed);
        fill(app);
        emit(app);
    }
}

pub fn seen_report(app: &AppHandle) {
    if let Some(r) = NIGHT.lock().unwrap().as_mut() {
        r.seen = true;
    }
    save();
    emit(app);
}

pub fn night_tools() -> Vec<String> {
    let mut tools: Vec<String> = NIGHT_FILE_TOOLS.iter().map(|t| t.to_string()).collect();
    for shell in ["Bash", "PowerShell"] {
        tools.extend(NIGHT_COMMANDS.iter().map(|c| format!("{shell}({c}:*)")));
    }
    tools
}

pub fn positional(text: &str) -> String {
    if text.starts_with('-') {
        format!(" {text}")
    } else {
        text.to_string()
    }
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    line.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_short_ascii_and_unique() {
        assert_eq!(slug("Ajoute des tests sur le module de paiement", 0x1a2b), "ajoute-des-tests-sur-1a2b");
        assert_eq!(slug("Corrige l'écran réglages", 7), "corrige-ecran-reglages-0007");
        assert_eq!(slug("??", 1), "mission-0001");
        assert!(slug("un très très très très long titre de tâche vraiment interminable", 3).len() <= 33);
    }

    #[test]
    fn background_ids_are_read_from_the_cli() {
        assert_eq!(agent_id("Starting background service…\nbackgrounded · 6838f2e6\n  claude agents"), Some("6838f2e6".into()));
        assert_eq!(agent_id("Workspace not trusted."), None);
    }

    #[test]
    fn the_night_starts_at_the_chosen_hour_and_ends_at_seven() {
        assert!(in_night(1, 1));
        assert!(in_night(6, 1));
        assert!(!in_night(7, 1));
        assert!(!in_night(0, 1));
        assert!(in_night(23, 22));
        assert!(in_night(3, 22));
        assert!(!in_night(12, 22));
        assert!(!in_night(21, 22));
    }

    #[test]
    fn agent_states_map_to_mission_phases() {
        assert_eq!(phase(true, false), "running");
        assert_eq!(phase(true, true), "waiting");
        assert_eq!(phase(false, true), "finished");
        assert_eq!(phase(false, false), "finished");
    }

    #[test]
    fn night_allowlist_covers_both_shells() {
        let tools = night_tools();
        assert!(tools.contains(&"Edit".to_string()));
        assert!(tools.contains(&"Bash(cargo test:*)".to_string()));
        assert!(tools.contains(&"PowerShell(npm test:*)".to_string()));
        assert!(!tools.iter().any(|t| t.contains("push") || t.contains("rm ")));
    }

    #[test]
    fn git_shortstat_is_parsed() {
        assert_eq!(shortstat(" 3 files changed, 42 insertions(+), 5 deletions(-)"), (3, 42, 5));
        assert_eq!(shortstat(" 1 file changed, 1 insertion(+)"), (1, 1, 0));
        assert_eq!(shortstat(""), (0, 0, 0));
    }
}
