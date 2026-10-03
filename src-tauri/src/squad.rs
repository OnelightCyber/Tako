use std::fs;
use std::io::{ErrorKind, Read};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
const GIT_LIMIT: Duration = Duration::from_secs(120);
const GIT_SLOW: Duration = Duration::from_secs(600);
const CLAUDE_LIMIT: Duration = Duration::from_secs(60);
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const IDLE_CHECKS: u32 = 2;
const MISSING_CHECKS: u32 = 3;
const NIGHT_FILE_TOOLS: &[&str] = &["Read", "Grep", "Glob", "Edit(/**)", "TodoWrite"];
const NIGHT_COMMANDS: &[&str] = &[
    "git status",
    "npm test", "npm run test", "npm run build", "npm run lint", "npx tsc",
    "pnpm test", "yarn test", "cargo test", "cargo check", "cargo build", "cargo clippy", "cargo fmt",
    "pytest", "python -m pytest", "go test", "go build", "dotnet test", "dotnet build",
];
const NIGHT_PROMPT: &str = "Tu travailles seul pendant la nuit, personne ne peut répondre à tes questions ni valider une action. Fais la tâche du mieux possible sans rien demander, lance les tests du projet si c'est possible, ne pousse rien et ne touche à rien en dehors de ce dossier. À la fin, résume en une ou deux phrases ce que tu as fait ou ce qui t'a bloqué.";
const BROKEN: &str = "Copie du projet abîmée : Tako n'y lance plus aucune commande git.";
const STARTING: &str = "La mission est en train de démarrer : réessaie dans un instant.";
const VANISHED: &str = "Claude s'est arrêté avant la fin (PC éteint ou agent coupé).";
const BLOCKED: &str = "Claude s'est arrêté sur une action refusée ou une question.";
const UNSURE: &str = "Tako n'arrive pas à vérifier la copie du projet : réessaie dans un instant.";

static JOBS: Mutex<Vec<Job>> = Mutex::new(Vec::new());
static LOADED: AtomicBool = AtomicBool::new(false);
static AWAKE: AtomicBool = AtomicBool::new(false);
static FORCED: AtomicBool = AtomicBool::new(false);
static NIGHT: Mutex<Option<Report>> = Mutex::new(None);
static SAVING: Mutex<()> = Mutex::new(());
static FILLING: Mutex<()> = Mutex::new(());
static LAUNCHING: Mutex<Vec<String>> = Mutex::new(Vec::new());
static SCRATCH: AtomicU64 = AtomicU64::new(0);

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
    #[serde(skip)]
    pub misses: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
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
    if LOADED.load(Ordering::Acquire) {
        return;
    }
    let _turn = SAVING.lock().unwrap_or_else(|e| e.into_inner());
    if LOADED.load(Ordering::Acquire) {
        return;
    }
    let path = store();
    let saved = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Saved>(&text).unwrap_or_else(|err| {
            set_aside(&path, &err.to_string());
            Saved::default()
        }),
        Err(err) if err.kind() == ErrorKind::NotFound => Saved::default(),
        Err(err) => {
            set_aside(&path, &err.to_string());
            Saved::default()
        }
    };
    let mut jobs = saved.jobs;
    prune(&mut jobs, now());
    *JOBS.lock().unwrap() = jobs;
    *NIGHT.lock().unwrap() = saved.report;
    LOADED.store(true, Ordering::Release);
}

fn set_aside(path: &Path, why: &str) {
    let backup = path.with_extension("json.bak");
    let _ = fs::rename(path, &backup);
    log::line(format!("squad: unreadable squad.json moved to {} ({why})", backup.display()));
}

fn save() {
    let _turn = SAVING.lock().unwrap_or_else(|e| e.into_inner());
    let saved = Saved { jobs: JOBS.lock().unwrap().clone(), report: NIGHT.lock().unwrap().clone() };
    let Ok(text) = serde_json::to_string_pretty(&saved) else { return };
    let _ = fs::create_dir_all(settings::config_dir());
    let path = store();
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, text).is_err() || fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&tmp);
        log::line("squad: could not save squad.json");
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

pub fn unique_slug(task: &str, salt: u64, taken: impl Fn(&str) -> bool) -> String {
    let mut candidate = slug(task, salt);
    for step in 1..=0xffffu64 {
        if !taken(&candidate) {
            break;
        }
        candidate = slug(task, salt.wrapping_add(step));
    }
    candidate
}

fn pipe<R: Read + Send + 'static>(source: Option<R>) -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    if let Some(mut source) = source {
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = source.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
    }
    rx
}

fn collect(rx: &Receiver<Vec<u8>>, into: &mut Vec<u8>, until: Instant) {
    while let Ok(chunk) = rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
        into.extend(chunk);
    }
}

fn run(cmd: &mut Command, limit: Duration) -> Result<Output, String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let out = pipe(child.stdout.take());
    let err = pipe(child.stderr.take());
    let deadline = Instant::now() + limit;
    let mut nap = 2;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timeout".into());
        }
        std::thread::sleep(Duration::from_millis(nap));
        nap = (nap * 2).min(25);
    };
    let grace = Instant::now() + Duration::from_secs(3);
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    collect(&out, &mut stdout, grace);
    collect(&err, &mut stderr, grace);
    Ok(Output { status, stdout, stderr })
}

fn git_exe() -> Result<PathBuf, String> {
    crate::find_on_path("git").ok_or_else(|| "Git n'est pas installé.".to_string())
}

fn git_with(dir: &Path, args: &[&str], index: Option<&Path>, limit: Duration) -> Result<String, String> {
    let mut cmd = Command::new(git_exe()?);
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    let output = run(&mut cmd, limit).map_err(|e| if e == "timeout" { "git ne répond plus.".to_string() } else { e })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if err.is_empty() { "git a échoué.".into() } else { err })
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_with(dir, args, None, GIT_LIMIT)
}

fn git_slow(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_with(dir, args, None, GIT_SLOW)
}

fn claude_run(args: &[&str], dir: &Path) -> Result<Output, String> {
    let exe = crate::claude_cli::find().ok_or("Claude Code n'est pas installé.")?;
    let mut cmd = Command::new(exe);
    cmd.args(args).current_dir(dir).env("TAKO_ORIGIN", "squad").creation_flags(CREATE_NO_WINDOW);
    for key in crate::sessions::session_vars() {
        cmd.env_remove(key);
    }
    run(&mut cmd, CLAUDE_LIMIT).map_err(|e| if e == "timeout" { "Claude Code ne répond plus.".to_string() } else { e })
}

fn claude(args: &[&str], dir: &Path) -> Result<String, String> {
    let output = claude_run(args, dir)?;
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

fn norm(path: &str) -> String {
    path.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

pub fn valid_worktree(worktree: &str, top: &str, git_dir: &str) -> bool {
    let wt = norm(worktree);
    let dir = norm(git_dir);
    !wt.is_empty() && norm(top) == wt && dir.contains("\\worktrees\\") && !dir.starts_with(&format!("{wt}\\"))
}

enum Health {
    Sound(PathBuf),
    Broken,
    Unknown,
}

fn health(job: &Job) -> Health {
    let wt = Path::new(&job.worktree);
    if !wt.join(".git").is_file() {
        return Health::Broken;
    }
    let Ok(out) = git(wt, &["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-path", "index"]) else { return Health::Unknown };
    let mut lines = out.lines();
    let (Some(top), Some(dir), Some(index)) = (lines.next(), lines.next(), lines.next()) else { return Health::Unknown };
    if !valid_worktree(&job.worktree, top, dir) {
        return Health::Broken;
    }
    let index = PathBuf::from(index.trim());
    Health::Sound(if index.is_absolute() { index } else { wt.join(index) })
}

fn checked(job: &Job) -> Result<PathBuf, String> {
    match health(job) {
        Health::Sound(index) => Ok(index),
        Health::Broken => Err(BROKEN.into()),
        Health::Unknown => Err(UNSURE.into()),
    }
}

fn sound(app: &AppHandle, job: &Job) -> Result<PathBuf, String> {
    let result = checked(job);
    if result.as_ref().is_err_and(|e| e == BROKEN) {
        mark_broken(app, &job.id);
    }
    result
}

fn owned_folder(job: &Job) -> bool {
    let wt = norm(&job.worktree);
    let base = format!("{}\\.claude\\worktrees\\tako-", norm(&job.repo));
    wt.len() > base.len() && wt.starts_with(&base) && !wt[base.len()..].contains('\\')
}

fn scratch_git(job: &Job, index: &Path, args: &[&str]) -> Result<String, String> {
    let dir = settings::local_dir().join("squad");
    let _ = fs::create_dir_all(&dir);
    let tmp = dir.join(format!("{}-{}.index", job.id, SCRATCH.fetch_add(1, Ordering::Relaxed)));
    if index.is_file() {
        fs::copy(index, &tmp).map_err(|e| e.to_string())?;
    }
    let wt = Path::new(&job.worktree);
    let result = git_with(wt, &["add", "-A", "-N"], Some(&tmp), GIT_LIMIT).and_then(|_| git_with(wt, args, Some(&tmp), GIT_LIMIT));
    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(tmp.with_extension("index.lock"));
    result
}

pub fn busy_op(git_dir: &Path) -> Option<&'static str> {
    if git_dir.join("MERGE_HEAD").exists() {
        Some("une fusion")
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("un rebase")
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Some("un cherry-pick")
    } else if git_dir.join("REVERT_HEAD").exists() {
        Some("un revert")
    } else if git_dir.join("BISECT_LOG").exists() {
        Some("un bisect")
    } else {
        None
    }
}

fn git_dir(root: &Path) -> Option<PathBuf> {
    git(root, &["rev-parse", "--absolute-git-dir"]).ok().map(PathBuf::from)
}

fn repo_busy(root: &Path) -> Option<&'static str> {
    busy_op(&git_dir(root)?)
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

fn taken(root: &Path, id: &str) -> bool {
    JOBS.lock().unwrap().iter().any(|j| j.id == id)
        || root.join(".claude").join("worktrees").join(format!("tako-{id}")).exists()
        || git(root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/tako/{id}")]).is_ok()
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
    if base == "HEAD" {
        return Err("Ton dépôt n'est sur aucune branche (HEAD détachée) : reviens sur une branche avant de lancer une mission.".into());
    }
    if let Some(op) = repo_busy(&root) {
        return Err(format!("Ton dépôt est au milieu d'{op} : termine-le avant de lancer une mission."));
    }
    let created = now();
    let id = unique_slug(&task, created ^ (created >> 17), |s| taken(&root, s));
    let worktree = root.join(".claude").join("worktrees").join(format!("tako-{id}"));
    let job = Job {
        id: id.clone(),
        repo: root.to_string_lossy().to_string(),
        task,
        branch: format!("tako/{id}"),
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
        misses: 0,
    };
    {
        let mut jobs = JOBS.lock().unwrap();
        if jobs.iter().filter(|j| is_open(j)).count() >= MAX_JOBS {
            return Err("Trop de missions ouvertes : fusionne ou jette les anciennes.".into());
        }
        if jobs.iter().any(|j| j.id == id) {
            return Err("Réessaie dans un instant.".into());
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

fn launching(id: &str) -> bool {
    LAUNCHING.lock().unwrap().iter().any(|l| l == id)
}

fn launch(job: &Job, night_policy: &str) -> Result<String, String> {
    let root = PathBuf::from(&job.repo);
    let worktree = PathBuf::from(&job.worktree);
    if worktree.exists() {
        checked(job)?;
    } else {
        exclude_worktrees(&root);
        git_slow(&root, &["worktree", "add", "-b", &job.branch, &job.worktree, &job.base_commit])?;
    }
    let prompt = if job.night { format!("{}\n\n{}", job.task, NIGHT_PROMPT) } else { job.task.clone() };
    let mut args: Vec<String> = vec!["--bg".into(), positional(&prompt)];
    if job.night {
        args.push("--permission-mode".into());
        if night_policy == "auto" {
            args.push("auto".into());
        } else {
            args.push("dontAsk".into());
            args.push(format!("--allowedTools={}", night_tools().join(",")));
        }
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = claude(&refs, &worktree)?;
    agent_id(&output).ok_or_else(|| "Claude Code n'a pas démarré l'agent.".to_string())
}

fn slots(jobs: &[Job], night: bool) -> usize {
    let s = settings::load();
    let limit = if night { s.night_parallel.clamp(1, 4) } else { s.squad_parallel.clamp(1, 6) } as usize;
    limit.saturating_sub(jobs.iter().filter(|j| is_active(j) && j.night == night).count())
}

fn fill(app: &AppHandle) {
    let _turn = FILLING.lock().unwrap_or_else(|e| e.into_inner());
    let policy = settings::load().night_policy;
    let night_now = night_window() || FORCED.load(Ordering::Relaxed);
    let mut started = false;
    loop {
        let next = {
            let jobs = JOBS.lock().unwrap();
            let day = slots(&jobs, false);
            let night = slots(&jobs, true);
            let job = jobs
                .iter()
                .find(|j| j.status == "queued" && if j.night { night_now && night > 0 } else { day > 0 })
                .cloned();
            if let Some(job) = &job {
                LAUNCHING.lock().unwrap().push(job.id.clone());
            }
            job
        };
        let Some(job) = next else { break };
        let result = launch(&job, &policy);
        {
            let mut jobs = JOBS.lock().unwrap();
            if let Some(j) = jobs.iter_mut().find(|j| j.id == job.id) {
                match result {
                    Ok(agent) => {
                        j.agent = Some(agent);
                        j.status = "running".into();
                        j.started = Some(now());
                        j.misses = 0;
                        log::line(format!("squad: started {}", j.id));
                    }
                    Err(err) => {
                        j.status = "failed".into();
                        j.note = err;
                        j.finished = Some(now());
                    }
                }
            }
            LAUNCHING.lock().unwrap().retain(|id| id != &job.id);
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

fn agents() -> Option<Vec<Agent>> {
    let output = claude_run(&["agents", "--json", "--all"], &settings::local_dir()).ok()?;
    if !output.status.success() {
        return None;
    }
    parse_agents(&String::from_utf8_lossy(&output.stdout))
}

fn parse_agents(text: &str) -> Option<Vec<Agent>> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    if end < start {
        return None;
    }
    let values: Vec<Value> = serde_json::from_str(&text[start..=end]).ok()?;
    Some(values.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Working(&'static str),
    Unsure(u32),
    Ended(&'static str),
}

pub fn judge(seen: Option<(bool, Option<&str>)>, misses: u32) -> Verdict {
    match seen {
        Some((true, state)) => Verdict::Working(if state == Some("blocked") { "waiting" } else { "running" }),
        Some((false, state)) if misses + 1 >= IDLE_CHECKS => Verdict::Ended(match state {
            None | Some("done") => "",
            Some("blocked") => BLOCKED,
            Some(_) => VANISHED,
        }),
        None if misses + 1 >= MISSING_CHECKS => Verdict::Ended(VANISHED),
        _ => Verdict::Unsure(misses + 1),
    }
}

fn counts(job: &Job, index: &Path) -> Option<(u32, u32, u32)> {
    scratch_git(job, index, &["diff", "--shortstat", &job.base_commit]).ok().map(|s| shortstat(&s))
}

fn refresh(app: &AppHandle) {
    let active: Vec<Job> = JOBS.lock().unwrap().iter().filter(|j| is_active(j)).cloned().collect();
    if active.is_empty() {
        return;
    }
    let Some(list) = agents() else { return };
    let mut changed = false;
    let mut halt: Vec<(String, String)> = Vec::new();
    for job in active {
        let found = job.agent.as_deref().and_then(|id| list.iter().find(|a| a.id.as_deref() == Some(id)));
        let seen = found.map(|a| (a.status.as_deref() == Some("busy"), a.state.clone()));
        let session = found.and_then(|a| a.session_id.clone());
        let state = health(&job);
        let fresh = match &state {
            Health::Sound(index) => counts(&job, index),
            _ => None,
        };
        let mut jobs = JOBS.lock().unwrap();
        let Some(j) = jobs.iter_mut().find(|j| j.id == job.id) else { continue };
        if !is_active(j) {
            continue;
        }
        if matches!(state, Health::Broken) {
            j.status = "failed".into();
            j.note = BROKEN.into();
            j.finished = Some(now());
            if let Some(agent) = &j.agent {
                halt.push((agent.clone(), j.repo.clone()));
            }
            log::line(format!("squad: {} broken worktree", j.id));
            changed = true;
            continue;
        }
        if j.session.is_none() && session.is_some() {
            j.session = session;
            changed = true;
        }
        if let Some((files, added, removed)) = fresh {
            if (j.files, j.added, j.removed) != (files, added, removed) {
                j.files = files;
                j.added = added;
                j.removed = removed;
                changed = true;
            }
        }
        match judge(seen.as_ref().map(|(busy, state)| (*busy, state.as_deref())), j.misses) {
            Verdict::Working(status) => {
                j.misses = 0;
                if j.status != status {
                    j.status = status.to_string();
                    changed = true;
                }
            }
            Verdict::Unsure(n) => j.misses = n,
            Verdict::Ended(note) => {
                j.misses = 0;
                j.status = if j.files > 0 { "done".into() } else { "empty".into() };
                j.finished = Some(now());
                if !note.is_empty() {
                    j.note = note.into();
                }
                log::line(format!("squad: {} {}", j.id, j.status));
                changed = true;
            }
        }
    }
    for (agent, repo) in halt {
        let _ = claude(&["stop", &agent], Path::new(&repo));
    }
    if changed {
        save();
        emit(app);
    }
}

fn reportable(job: &Job) -> bool {
    job.night && matches!(job.status.as_str(), "done" | "empty" | "failed" | "merged") && (job.started.is_some() || job.status == "failed")
}

pub fn night_over(jobs: &[Job], open: bool) -> bool {
    !jobs.iter().any(|j| j.night && (is_active(j) || (j.status == "queued" && open)))
}

pub fn merge_report(old: Option<&Report>, finished: &[Job]) -> Option<Report> {
    let mut report = old.filter(|r| !r.seen).cloned().unwrap_or_default();
    let mut grew = false;
    for job in finished {
        if report.jobs.contains(&job.id) {
            continue;
        }
        match job.status.as_str() {
            "done" | "merged" => report.done += 1,
            "empty" => report.empty += 1,
            _ => report.failed += 1,
        }
        report.jobs.push(job.id.clone());
        report.at = report.at.max(job.finished.unwrap_or(job.created));
        grew = true;
    }
    if !grew {
        return None;
    }
    report.at = report.at.max(1);
    report.seen = false;
    Some(report)
}

fn finish_night(app: &AppHandle) {
    let open = night_window() || FORCED.load(Ordering::Relaxed);
    let finished: Vec<Job> = {
        let jobs = JOBS.lock().unwrap();
        if !jobs.iter().any(|j| j.night && (j.status == "queued" || is_active(j))) {
            FORCED.store(false, Ordering::Relaxed);
        }
        if !night_over(&jobs, open) {
            return;
        }
        jobs.iter().filter(|j| reportable(j)).cloned().collect()
    };
    if finished.is_empty() {
        return;
    }
    let next = merge_report(NIGHT.lock().unwrap().as_ref(), &finished);
    if let Some(report) = &next {
        *NIGHT.lock().unwrap() = Some(report.clone());
    }
    {
        let mut jobs = JOBS.lock().unwrap();
        for j in jobs.iter_mut().filter(|j| finished.iter().any(|f| f.id == j.id)) {
            j.night = false;
        }
    }
    save();
    if next.is_some() {
        log::line("squad: night shift finished");
        let _ = app.emit_to(WINDOW_LABEL, "squad-dawn", ());
    }
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

pub fn prune(jobs: &mut Vec<Job>, at: u64) -> bool {
    let before = jobs.len();
    jobs.retain(|j| match j.status.as_str() {
        "discarded" => false,
        "merged" => at.saturating_sub(j.finished.unwrap_or(j.created)) < DAY_MS,
        _ => true,
    });
    jobs.len() != before
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
            let pruned = prune(&mut JOBS.lock().unwrap(), now());
            if pruned {
                save();
                emit(&app);
            }
            let (busy, night) = {
                let jobs = JOBS.lock().unwrap();
                (jobs.iter().any(is_active), jobs.iter().any(|j| j.night && (j.status == "queued" || is_active(j))))
            };
            keep_awake(night && settings::load().night_keep_awake);
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

fn mark_broken(app: &AppHandle, id: &str) {
    update(app, id, |j| {
        j.status = "failed".into();
        j.note = BROKEN.into();
        j.finished.get_or_insert_with(now);
    });
}

fn remove_worktree(job: &Job) -> Result<(), String> {
    let root = PathBuf::from(&job.repo);
    if let Some(agent) = &job.agent {
        let _ = claude(&["stop", agent], &root);
        let _ = claude(&["rm", agent], &root);
    }
    let wt = Path::new(&job.worktree);
    if wt.exists() && git(&root, &["worktree", "remove", "--force", &job.worktree]).is_err() && owned_folder(job) {
        let _ = fs::remove_dir_all(wt);
    }
    let _ = git(&root, &["worktree", "prune"]);
    if wt.exists() {
        return Err("Impossible de supprimer la copie du projet : ferme ce qui l'utilise (terminal, éditeur) puis réessaie.".into());
    }
    let branch = format!("refs/heads/{}", job.branch);
    if git(&root, &["show-ref", "--verify", "--quiet", &branch]).is_ok() {
        git(&root, &["branch", "-D", &job.branch]).map_err(|e| format!("La branche {} n'a pas pu être supprimée : {}", job.branch, first_line(&e, 120)))?;
    }
    Ok(())
}

pub fn stop(app: &AppHandle, id: &str) -> Result<(), String> {
    let job = find(id)?;
    if launching(id) {
        return Err(STARTING.into());
    }
    if let Some(agent) = &job.agent {
        claude(&["stop", agent], Path::new(&job.repo))?;
    }
    let state = health(&job);
    let fresh = match &state {
        Health::Sound(index) => counts(&job, index),
        _ => None,
    };
    update(app, id, |j| {
        if matches!(state, Health::Broken) {
            j.status = "failed".into();
            j.note = BROKEN.into();
        } else {
            if let Some((files, added, removed)) = fresh {
                j.files = files;
                j.added = added;
                j.removed = removed;
            }
            j.status = if j.files > 0 { "done".into() } else { "empty".into() };
            j.note = "Arrêtée".into();
        }
        j.finished = Some(now());
        j.misses = 0;
    });
    Ok(())
}

pub fn discard(app: &AppHandle, id: &str) -> Result<(), String> {
    let job = {
        let mut jobs = JOBS.lock().unwrap();
        let job = jobs.iter().find(|j| j.id == id).cloned().ok_or_else(|| "Mission introuvable.".to_string())?;
        if launching(id) {
            return Err(STARTING.into());
        }
        if job.status == "queued" {
            jobs.retain(|j| j.id != id);
            None
        } else {
            Some(job)
        }
    };
    if let Some(job) = job {
        if let Err(err) = remove_worktree(&job) {
            update(app, id, |j| j.note = err.clone());
            return Err(err);
        }
        JOBS.lock().unwrap().retain(|j| j.id != id);
    }
    save();
    emit(app);
    Ok(())
}

pub fn diff(id: &str) -> Result<(), String> {
    let job = find(id)?;
    let index = checked(&job)?;
    let text = scratch_git(&job, &index, &["diff", &job.base_commit])?;
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
    checked(&job)?;
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
    sound(app, &job)?;
    let output = claude(&["--bg", &positional(&text), "--resume", &session], Path::new(&job.worktree))?;
    let agent = agent_id(&output).or(job.agent.clone());
    update(app, id, |j| {
        j.agent = agent;
        j.status = "running".into();
        j.finished = None;
        j.misses = 0;
        j.note.clear();
    });
    Ok(())
}

pub fn merge_failure(merging: bool, conflict: bool, aborted: bool, dirty: bool, reason: &str) -> (String, String) {
    if merging && !aborted {
        return (
            "Fusion bloquée en cours de route.".into(),
            "La fusion s'est arrêtée et Tako n'a pas pu l'annuler : ton dépôt est en pleine fusion. Règle-la à la main ou lance « git merge --abort ».".into(),
        );
    }
    if merging && conflict {
        return (
            "Conflit : ouvre la mission pour le régler avec Claude.".into(),
            "Conflit avec ta branche : Tako a tout annulé. Ouvre la mission pour que Claude le règle.".into(),
        );
    }
    if merging {
        return ("Un hook git a refusé la fusion.".into(), format!("Un hook git a refusé la fusion, Tako a tout annulé : {reason}"));
    }
    if dirty {
        return (
            "Fusion interrompue.".into(),
            format!("La fusion s'est arrêtée en cours de route ({reason}) : vérifie ton dépôt avec git status."),
        );
    }
    ("Fusion impossible.".into(), format!("La fusion n'a pas pu démarrer : {reason}"))
}

pub fn merge(app: &AppHandle, id: &str) -> Result<String, String> {
    let job = find(id)?;
    if is_active(&job) {
        return Err("Attends que Claude ait fini (ou arrête la mission).".into());
    }
    if launching(id) {
        return Err(STARTING.into());
    }
    if job.base == "HEAD" {
        return Err("Cette mission a démarré sans branche (HEAD détachée) : fusionne-la à la main.".into());
    }
    let root = PathBuf::from(&job.repo);
    let wt = PathBuf::from(&job.worktree);
    let current = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current == "HEAD" {
        return Err(format!("Ton dépôt n'est sur aucune branche (HEAD détachée) : reviens sur « {} » pour fusionner.", job.base));
    }
    if let Some(op) = repo_busy(&root) {
        return Err(format!("Ton dépôt est au milieu d'{op} : termine-le avant de fusionner."));
    }
    if current != job.base {
        return Err(format!("Ton dépôt est sur « {current} », pas sur « {} ». Reviens sur cette branche pour fusionner.", job.base));
    }
    if !git(&root, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("Ton dossier a des modifications non commitées : commite-les ou mets-les de côté avant de fusionner.".into());
    }
    if wt.exists() {
        sound(app, &job)?;
        if !git(&wt, &["status", "--porcelain"])?.is_empty() {
            git(&wt, &["add", "-A"])?;
            let message = format!("Tako : {}", first_line(&job.task, 72));
            git_slow(&wt, &["commit", "-m", &message]).map_err(|e| format!("Le commit de la mission a été refusé : {}", first_line(&e, 160)))?;
        }
    }
    let ahead = git(&root, &["rev-list", "--count", &format!("{}..{}", job.base_commit, job.branch)]).unwrap_or_default();
    if ahead.trim() == "0" {
        return Err("Cette mission n'a rien changé.".into());
    }
    let message = format!("Tako : {}", first_line(&job.task, 72));
    if let Err(err) = git_slow(&root, &["merge", "--no-ff", "-m", &message, &job.branch]) {
        let reason = first_line(&err, 160);
        let merging = git_dir(&root).is_some_and(|d| d.join("MERGE_HEAD").exists());
        let conflict = merging && git(&root, &["diff", "--name-only", "--diff-filter=U"]).is_ok_and(|s| !s.trim().is_empty());
        let aborted = merging && git(&root, &["merge", "--abort"]).is_ok();
        let dirty = !merging && git(&root, &["status", "--porcelain", "--untracked-files=no"]).is_ok_and(|s| !s.is_empty());
        let (note, message) = merge_failure(merging, conflict, aborted, dirty, &reason);
        update(app, id, |j| j.note = note);
        log::line(format!("squad: merge failed {} ({reason})", job.id));
        return Err(message);
    }
    let hash = git(&root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    if let Err(err) = remove_worktree(&job) {
        log::line(format!("squad: cleanup after merge {} failed ({err})", job.id));
    }
    update(app, id, |j| {
        j.status = "merged".into();
        j.note = hash.clone();
        j.finished = Some(now());
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

    fn job(id: &str, status: &str, night: bool) -> Job {
        Job {
            id: id.into(),
            repo: r"C:\dev\app".into(),
            task: "t".into(),
            branch: format!("tako/{id}"),
            base: "main".into(),
            base_commit: "abc".into(),
            worktree: format!(r"C:\dev\app\.claude\worktrees\tako-{id}"),
            agent: None,
            session: None,
            status: status.into(),
            night,
            created: 1_000,
            started: Some(2_000),
            finished: Some(3_000),
            files: 0,
            added: 0,
            removed: 0,
            note: String::new(),
            misses: 0,
        }
    }

    #[test]
    fn slugs_are_short_ascii_and_unique() {
        assert_eq!(slug("Ajoute des tests sur le module de paiement", 0x1a2b), "ajoute-des-tests-sur-1a2b");
        assert_eq!(slug("Corrige l'écran réglages", 7), "corrige-ecran-reglages-0007");
        assert_eq!(slug("??", 1), "mission-0001");
        assert!(slug("un très très très très long titre de tâche vraiment interminable", 3).len() <= 33);
    }

    #[test]
    fn colliding_slugs_get_a_new_salt() {
        let used = ["corrige-bug-0007".to_string(), "corrige-bug-0008".to_string()];
        assert_eq!(unique_slug("Corrige le bug", 7, |s| used.iter().any(|u| u == s)), "corrige-bug-0009");
        assert_eq!(unique_slug("Corrige le bug", 0xffff, |s| s.ends_with("-ffff")), "corrige-bug-0000");
        assert_eq!(unique_slug("Corrige le bug", 3, |_| false), "corrige-bug-0003");
    }

    #[test]
    fn background_ids_are_read_from_the_cli() {
        assert_eq!(agent_id("Starting background service…\nbackgrounded · 6838f2e6\n  claude agents"), Some("6838f2e6".into()));
        assert_eq!(agent_id("Workspace not trusted."), None);
    }

    #[test]
    fn agent_listings_are_parsed_or_rejected() {
        let list = parse_agents("[{\"id\":\"6838f2e6\",\"state\":\"working\",\"status\":\"busy\",\"sessionId\":\"s1\"}]").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].status.as_deref(), Some("busy"));
        assert_eq!(list[0].session_id.as_deref(), Some("s1"));
        assert_eq!(parse_agents("[]").map(|l| l.len()), Some(0));
        assert!(parse_agents("").is_none());
        assert!(parse_agents("Error: not logged in").is_none());
        assert!(parse_agents("[oops").is_none());
        assert!(parse_agents("] then [").is_none());
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
    fn missions_end_only_after_repeated_signs() {
        assert_eq!(judge(Some((true, Some("working"))), 2), Verdict::Working("running"));
        assert_eq!(judge(Some((true, Some("blocked"))), 0), Verdict::Working("waiting"));
        assert_eq!(judge(Some((false, Some("done"))), 0), Verdict::Unsure(1));
        assert_eq!(judge(Some((false, Some("done"))), 1), Verdict::Ended(""));
        assert_eq!(judge(Some((false, Some("blocked"))), 1), Verdict::Ended(BLOCKED));
        assert_eq!(judge(Some((false, Some("working"))), 1), Verdict::Ended(VANISHED));
        assert_eq!(judge(Some((false, None)), 1), Verdict::Ended(""));
        assert_eq!(judge(None, 0), Verdict::Unsure(1));
        assert_eq!(judge(None, 1), Verdict::Unsure(2));
        assert_eq!(judge(None, 2), Verdict::Ended(VANISHED));
    }

    #[test]
    fn night_allowlist_keeps_edits_in_the_worktree() {
        let tools = night_tools();
        assert!(tools.contains(&"Edit(/**)".to_string()));
        assert!(!tools.iter().any(|t| matches!(t.as_str(), "Edit" | "Write" | "MultiEdit" | "NotebookEdit")));
        assert!(tools.contains(&"Bash(cargo test:*)".to_string()));
        assert!(tools.contains(&"PowerShell(npm test:*)".to_string()));
        assert!(tools.contains(&"Bash(git status:*)".to_string()));
        assert!(!tools.iter().any(|t| t.contains("git diff") || t.contains("git log") || t.contains("git show")));
        assert!(!tools.iter().any(|t| t.contains("push") || t.contains("rm ")));
    }

    #[test]
    fn git_shortstat_is_parsed() {
        assert_eq!(shortstat(" 3 files changed, 42 insertions(+), 5 deletions(-)"), (3, 42, 5));
        assert_eq!(shortstat(" 1 file changed, 1 insertion(+)"), (1, 1, 0));
        assert_eq!(shortstat(""), (0, 0, 0));
    }

    #[test]
    fn only_real_worktrees_are_trusted() {
        let wt = r"C:\dev\app\.claude\worktrees\tako-x";
        assert!(valid_worktree(wt, "C:/dev/app/.claude/worktrees/tako-x", "C:/dev/app/.git/worktrees/tako-x"));
        assert!(valid_worktree(wt, "c:/DEV/app/.claude/worktrees/tako-x/", "C:/dev/app/.git/worktrees/tako-x"));
        assert!(!valid_worktree(wt, "C:/dev/app", "C:/dev/app/.git"));
        assert!(!valid_worktree(wt, "C:/dev/app/.claude/worktrees/tako-x", "C:/dev/app/.claude/worktrees/tako-x/.git"));
        assert!(!valid_worktree(wt, "C:/dev/app/.claude/worktrees/tako-x", "C:/dev/app/.git"));
        assert!(!valid_worktree("", "", "C:/x/worktrees/y"));
    }

    #[test]
    fn only_tako_folders_may_be_deleted_by_hand() {
        assert!(owned_folder(&job("x-0001", "done", false)));
        let mut outside = job("x-0001", "done", false);
        outside.worktree = r"C:\dev\app".into();
        assert!(!owned_folder(&outside));
        outside.worktree = r"C:\dev\app\.claude\worktrees\tako-x\..\..".into();
        assert!(!owned_folder(&outside));
        outside.worktree = r"C:\dev\app\.claude\worktrees\tako-".into();
        assert!(!owned_folder(&outside));
    }

    #[test]
    fn repos_in_the_middle_of_something_are_detected() {
        let dir = std::env::temp_dir().join(format!("tako-busy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(busy_op(&dir), None);
        fs::create_dir_all(dir.join("rebase-merge")).unwrap();
        assert_eq!(busy_op(&dir), Some("un rebase"));
        fs::write(dir.join("MERGE_HEAD"), "x").unwrap();
        assert_eq!(busy_op(&dir), Some("une fusion"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_night_is_over_once_nothing_is_left_to_run() {
        let running = job("a", "running", true);
        let queued = job("b", "queued", true);
        let done = job("c", "done", true);
        assert!(!night_over(&[running.clone(), done.clone()], false));
        assert!(!night_over(&[queued.clone(), done.clone()], true));
        assert!(night_over(&[queued, done.clone()], false));
        assert!(night_over(&[done, job("d", "running", false)], true));
    }

    #[test]
    fn launch_failures_and_later_batches_join_the_same_report() {
        let mut failed = job("f", "failed", true);
        failed.started = None;
        failed.finished = Some(5_000);
        assert!(reportable(&failed));
        assert!(!reportable(&job("q", "queued", true)));
        let mut never = job("n", "empty", true);
        never.started = None;
        assert!(!reportable(&never));
        let first = merge_report(None, &[job("a", "done", true), failed]).unwrap();
        assert_eq!((first.done, first.empty, first.failed, first.at, first.seen), (1, 0, 1, 5_000, false));
        let second = merge_report(Some(&first), &[job("a", "done", true), job("b", "empty", true)]).unwrap();
        assert_eq!((second.done, second.empty, second.failed), (1, 1, 1));
        assert_eq!(second.jobs, vec!["a", "f", "b"]);
        assert!(merge_report(Some(&second), &[job("b", "empty", true)]).is_none());
        let seen = Report { seen: true, ..second };
        let fresh = merge_report(Some(&seen), &[job("c", "merged", true)]).unwrap();
        assert_eq!((fresh.done, fresh.jobs.len()), (1, 1));
    }

    #[test]
    fn merged_missions_are_dropped_after_a_day() {
        let mut jobs = vec![job("a", "merged", false), job("b", "done", false), job("c", "discarded", false)];
        assert!(prune(&mut jobs, 3_000 + DAY_MS));
        assert_eq!(jobs.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        let mut recent = vec![job("a", "merged", false)];
        assert!(!prune(&mut recent, 3_000 + DAY_MS - 1));
    }

    #[test]
    fn merge_failures_are_told_apart() {
        assert!(merge_failure(true, true, true, false, "x").1.starts_with("Conflit"));
        assert!(merge_failure(true, false, true, false, "commitlint").1.contains("hook"));
        assert!(merge_failure(true, true, false, false, "x").1.contains("git merge --abort"));
        assert!(merge_failure(false, false, false, false, "untracked files").1.contains("n'a pas pu démarrer"));
        assert!(merge_failure(false, false, false, true, "x").1.contains("git status"));
    }

    #[test]
    fn hung_processes_are_killed() {
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32");
        let started = Instant::now();
        let mut slow = Command::new(system.join("PING.EXE"));
        slow.args(["-n", "6", "127.0.0.1"]).creation_flags(CREATE_NO_WINDOW);
        assert_eq!(run(&mut slow, Duration::from_millis(300)).unwrap_err(), "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
        let mut quick = Command::new(system.join("cmd.exe"));
        quick.args(["/D", "/C", "echo bonjour"]).creation_flags(CREATE_NO_WINDOW);
        let out = run(&mut quick, Duration::from_secs(10)).unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "bonjour");
    }

    #[test]
    fn worktrees_are_checked_counted_and_removed_without_touching_the_index() {
        if git_exe().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!("tako-squad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let who = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false"];
        git(&root, &["init", "-q"]).unwrap();
        fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&root, &["add", "a.txt"]).unwrap();
        git(&root, &[&who[..], &["commit", "-q", "-m", "init"]].concat()).unwrap();
        let base = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let mut j = job("t-0001", "running", false);
        j.repo = root.to_string_lossy().to_string();
        j.worktree = root.join(".claude").join("worktrees").join("tako-t-0001").to_string_lossy().to_string();
        j.base_commit = base.clone();
        git(&root, &["worktree", "add", "-q", "-b", &j.branch, &j.worktree, &base]).unwrap();
        let wt = PathBuf::from(&j.worktree);
        fs::write(wt.join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(wt.join("b.txt"), "new\n").unwrap();
        let Health::Sound(index) = health(&j) else { panic!("worktree should be sound") };
        assert_eq!(counts(&j, &index), Some((2, 2, 0)));
        let status = git(&wt, &["status", "--porcelain"]).unwrap();
        assert!(status.contains("?? b.txt"), "{status}");
        assert!(!git(&wt, &["diff", "--cached", "--name-only"]).unwrap().contains("b.txt"));
        fs::remove_file(wt.join(".git")).unwrap();
        assert!(matches!(health(&j), Health::Broken));
        assert!(checked(&j).is_err());
        remove_worktree(&j).unwrap();
        assert!(!wt.exists());
        assert!(git(&root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{}", j.branch)]).is_err());
        assert!(fs::read_to_string(root.join("a.txt")).unwrap().starts_with("one"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hidden_fields_never_reach_the_ui() {
        let mut j = job("a", "running", false);
        j.misses = 2;
        let text = serde_json::to_string(&j).unwrap();
        assert!(!text.contains("misses"));
        let back: Job = serde_json::from_str(&text).unwrap();
        assert_eq!(back.misses, 0);
    }
}
