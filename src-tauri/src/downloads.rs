use std::collections::HashMap;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_secs(1);
const CALM: Duration = Duration::from_millis(2500);
const OFF: Duration = Duration::from_secs(3);
const MARK_CHECKS: u32 = 4;
const TEMP_EXTS: &[&str] = &["crdownload", "part", "partial", "download", "opdownload"];
const SAFE_TO_OPEN: &[&str] = &[
    "pdf", "txt", "md", "csv", "json", "log", "rtf", "odt", "ods", "odp", "docx", "xlsx", "pptx", "epub",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "avif", "tif", "tiff",
    "mp3", "wav", "flac", "m4a", "ogg", "opus", "aac", "mp4", "mkv", "webm", "mov", "avi", "m4v",
    "zip", "7z", "rar", "tar", "gz",
];
const HIDDEN: u32 = 0x2;
const SYSTEM: u32 = 0x4;

static ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub speed: u64,
    pub state: &'static str,
    pub runnable: bool,
}

struct Entry {
    size: u64,
    temp: bool,
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn dir() -> Option<PathBuf> {
    unsafe {
        let raw = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None).ok()?;
        let path = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const _));
        path.map(PathBuf::from)
    }
}

fn extension(name: &str) -> String {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn is_temp(name: &str) -> bool {
    TEMP_EXTS.contains(&extension(name).as_str())
}

pub fn is_runnable(name: &str) -> bool {
    !SAFE_TO_OPEN.contains(&extension(name).as_str())
}

fn plain(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

pub fn display_name(temp: &str) -> String {
    let stem = Path::new(temp).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if stem.starts_with("Unconfirmed ") || stem.starts_with(".com.google.Chrome") {
        String::new()
    } else {
        stem
    }
}

fn list(dir: &Path) -> HashMap<String, Entry> {
    let mut out = HashMap::new();
    let Ok(read) = std::fs::read_dir(dir) else { return out };
    for item in read.flatten() {
        let Ok(meta) = item.metadata() else { continue };
        if !meta.is_file() || meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();
        let temp = is_temp(&name);
        out.insert(name, Entry { size: meta.len(), temp });
    }
    out
}

fn inside_downloads(path: &str) -> Option<PathBuf> {
    let base = dir()?.canonicalize().ok()?;
    let file = PathBuf::from(path).canonicalize().ok()?;
    (file.parent() == Some(base.as_path()) && file.is_file()).then_some(file)
}

pub fn reveal(path: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let Some(file) = inside_downloads(path) else { return false };
    let target = plain(&file);
    if target.contains('"') {
        return false;
    }
    std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{target}\"")).spawn().is_ok()
}

pub fn open(path: &str) -> bool {
    let Some(file) = inside_downloads(path) else { return false };
    if is_runnable(&file.to_string_lossy()) {
        return reveal(path);
    }
    std::process::Command::new("explorer.exe").arg(plain(&file)).spawn().is_ok()
}

fn from_web(folder: &Path, name: &str) -> bool {
    let mut stream = folder.join(name).into_os_string();
    stream.push(":Zone.Identifier");
    std::fs::metadata(stream).is_ok()
}

fn done(name: &str, size: u64, folder: &Path) -> Download {
    Download {
        name: name.to_string(),
        path: folder.join(name).to_string_lossy().to_string(),
        bytes: size,
        speed: 0,
        state: "done",
        runnable: is_runnable(name),
    }
}

struct Changes {
    events: Vec<Download>,
    unmarked: Vec<String>,
}

fn diff(previous: &HashMap<String, Entry>, now: &HashMap<String, Entry>, folder: &Path, elapsed: f64, marked: &dyn Fn(&str) -> bool) -> Changes {
    let mut out = Vec::new();
    let mut unmarked = Vec::new();
    let mut finished: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (name, entry) in now {
        if !entry.temp {
            continue;
        }
        let before = previous.get(name).map(|p| p.size);
        if before != Some(entry.size) {
            let speed = before.map(|b| (entry.size.saturating_sub(b) as f64 / elapsed) as u64).unwrap_or(0);
            out.push(Download { name: display_name(name), path: String::new(), bytes: entry.size, speed, state: "active", runnable: false });
        }
    }
    let renamed = now.keys().any(|k| is_temp(k) && !previous.contains_key(k));
    for (name, entry) in previous {
        if !entry.temp || now.contains_key(name) {
            continue;
        }
        let stem = Path::new(name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        match now.get(&stem) {
            Some(file) if !file.temp && file.size > 0 => {
                finished.insert(stem.clone());
                out.push(done(&stem, file.size, folder));
            }
            _ if renamed => {}
            _ => {
                let fresh = now.iter().any(|(k, e)| !e.temp && e.size > 0 && !previous.contains_key(k));
                if !fresh {
                    out.push(Download { name: display_name(name), path: String::new(), bytes: 0, speed: 0, state: "cancelled", runnable: false });
                }
            }
        }
    }
    for (name, entry) in now {
        if entry.temp || entry.size == 0 || finished.contains(name) {
            continue;
        }
        let appeared = !previous.contains_key(name);
        let filled = previous.get(name).is_some_and(|p| p.size == 0);
        if appeared || filled {
            finished.insert(name.clone());
            if marked(name) {
                out.push(done(name, entry.size, folder));
            } else {
                unmarked.push(name.clone());
            }
        }
    }
    Changes { events: out, unmarked }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(folder) = dir() else {
            crate::log::line("downloads: folder not found");
            return;
        };
        let mut previous: Option<HashMap<String, Entry>> = None;
        let mut waiting: HashMap<String, u32> = HashMap::new();
        let mut at = Instant::now();
        let mut pause = EVERY;
        loop {
            std::thread::sleep(pause);
            if !ENABLED.load(Ordering::Relaxed) {
                previous = None;
                waiting.clear();
                pause = OFF;
                continue;
            }
            let now = list(&folder);
            let elapsed = at.elapsed().as_secs_f64().max(0.2);
            at = Instant::now();
            let Some(before) = previous.take() else {
                pause = if now.values().any(|e| e.temp) { EVERY } else { CALM };
                previous = Some(now);
                continue;
            };
            let changes = diff(&before, &now, &folder, elapsed, &|name| from_web(&folder, name));
            for event in changes.events {
                let _ = app.emit_to(WINDOW_LABEL, "download", event);
            }
            waiting.retain(|name, left| {
                let Some(entry) = now.get(name).filter(|e| e.size > 0) else { return false };
                if from_web(&folder, name) {
                    let _ = app.emit_to(WINDOW_LABEL, "download", done(name, entry.size, &folder));
                    return false;
                }
                *left -= 1;
                *left > 0
            });
            for name in changes.unmarked {
                waiting.insert(name, MARK_CHECKS);
            }
            pause = if now.values().any(|e| e.temp) || !waiting.is_empty() { EVERY } else { CALM };
            previous = Some(now);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_partial_files_are_recognised() {
        assert!(is_temp("setup.zip.crdownload"));
        assert!(is_temp("film.mkv.part"));
        assert!(is_temp("photo.jpg.opdownload"));
        assert!(!is_temp("notes.txt"));
        assert!(!is_temp("archive.tar.gz"));
    }

    #[test]
    fn the_real_name_comes_out_of_the_partial_one() {
        assert_eq!(display_name("setup.zip.crdownload"), "setup.zip");
        assert_eq!(display_name("Unconfirmed 812345.crdownload"), "");
        assert_eq!(display_name("film.mkv.part"), "film.mkv");
    }

    #[test]
    fn programs_are_only_shown_never_run() {
        assert!(is_runnable("installer.EXE"));
        assert!(is_runnable("script.ps1"));
        assert!(is_runnable("image.iso"));
        assert!(is_runnable("raccourci.url"));
        assert!(is_runnable("macro.docm"));
        assert!(!is_runnable("rapport.pdf"));
        assert!(!is_runnable("musique.mp3"));
    }

    fn entry(size: u64, temp: bool) -> Entry {
        Entry { size, temp }
    }

    fn states(changes: &Changes) -> Vec<(String, &'static str)> {
        let mut v: Vec<_> = changes.events.iter().map(|d| (d.name.clone(), d.state)).collect();
        v.sort();
        v
    }

    fn web(_: &str) -> bool {
        true
    }

    fn local(_: &str) -> bool {
        false
    }

    #[test]
    fn a_chrome_download_finishes_on_rename() {
        let folder = Path::new(r"C:\Downloads");
        let before = HashMap::from([("film.mkv.crdownload".to_string(), entry(900, true))]);
        let after = HashMap::from([("film.mkv".to_string(), entry(1000, false))]);
        assert_eq!(states(&diff(&before, &after, folder, 1.0, &local)), vec![("film.mkv".to_string(), "done")]);
    }

    #[test]
    fn a_firefox_download_with_an_empty_placeholder_still_finishes() {
        let folder = Path::new(r"C:\Downloads");
        let before = HashMap::from([("doc.pdf".to_string(), entry(0, false)), ("doc.pdf.part".to_string(), entry(500, true))]);
        let after = HashMap::from([("doc.pdf".to_string(), entry(800, false))]);
        assert_eq!(states(&diff(&before, &after, folder, 1.0, &web)), vec![("doc.pdf".to_string(), "done")]);
    }

    #[test]
    fn chrome_renaming_its_unconfirmed_file_is_not_a_cancel() {
        let folder = Path::new(r"C:\Downloads");
        let before = HashMap::from([("Unconfirmed 4242.crdownload".to_string(), entry(100, true))]);
        let after = HashMap::from([("setup.zip.crdownload".to_string(), entry(200, true))]);
        assert_eq!(states(&diff(&before, &after, folder, 1.0, &web)), vec![("setup.zip".to_string(), "active")]);
    }

    #[test]
    fn a_vanished_partial_file_is_a_cancel() {
        let folder = Path::new(r"C:\Downloads");
        let before = HashMap::from([("gros.iso.crdownload".to_string(), entry(100, true))]);
        let after = HashMap::new();
        assert_eq!(states(&diff(&before, &after, folder, 1.0, &web)), vec![("gros.iso".to_string(), "cancelled")]);
    }

    #[test]
    fn a_small_download_without_a_partial_file_needs_the_web_mark() {
        let folder = Path::new(r"C:\Downloads");
        let before = HashMap::from([("old.txt".to_string(), entry(10, false))]);
        let after = HashMap::from([("old.txt".to_string(), entry(10, false)), ("facture.pdf".to_string(), entry(5000, false))]);
        assert_eq!(states(&diff(&before, &after, folder, 1.0, &web)), vec![("facture.pdf".to_string(), "done")]);
        let saved = diff(&before, &after, folder, 1.0, &local);
        assert!(saved.events.is_empty());
        assert_eq!(saved.unmarked, vec!["facture.pdf".to_string()]);
    }

    #[test]
    fn the_web_mark_is_read_from_the_zone_stream() {
        let dir = std::env::temp_dir().join(format!("tako-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("saved.txt"), b"x").unwrap();
        std::fs::write(dir.join("got.txt"), b"x").unwrap();
        let marked = std::fs::write(dir.join("got.txt:Zone.Identifier"), b"[ZoneTransfer]\r\nZoneId=3\r\n").is_ok();
        assert!(!from_web(&dir, "saved.txt"));
        if marked {
            assert!(from_web(&dir, "got.txt"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
