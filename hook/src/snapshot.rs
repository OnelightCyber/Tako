use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

pub const EDIT_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write", "NotebookEdit"];

const MAX_SNAPSHOT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_FILES_PER_TURN: usize = 400;

pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Tako"))
}

pub fn safe_id(raw: &str) -> Option<String> {
    let id: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    (!id.is_empty()).then_some(id)
}

pub fn fnv(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn turn_file(dir: &Path, session: &str) -> PathBuf {
    dir.join("turns").join(session)
}

pub fn start_turn(dir: &Path, session: &str) {
    let _ = fs::create_dir_all(dir.join("turns"));
    let _ = fs::write(turn_file(dir, session), now_ms().to_string());
}

pub fn read_turn(dir: &Path, session: &str) -> Option<String> {
    let text = fs::read_to_string(turn_file(dir, session)).ok()?;
    let id = text.trim();
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_digit())).then(|| id.to_string())
}

fn current_turn(dir: &Path, session: &str) -> String {
    if let Some(id) = read_turn(dir, session) {
        return id;
    }
    start_turn(dir, session);
    read_turn(dir, session).unwrap_or_else(|| now_ms().to_string())
}

pub fn target_path(tool: &str, input: &Value, cwd: &str) -> Option<PathBuf> {
    if !EDIT_TOOLS.contains(&tool) {
        return None;
    }
    let key = if tool == "NotebookEdit" { "notebook_path" } else { "file_path" };
    let raw = input.get(key)?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        Some(path)
    } else if !cwd.is_empty() {
        Some(PathBuf::from(cwd).join(path))
    } else {
        None
    }
}

pub fn entry_name(path: &Path) -> String {
    format!("{:016x}", fnv(path.to_string_lossy().to_lowercase().as_bytes()))
}

pub fn before(dir: &Path, session: &str, path: &Path) {
    let turn = current_turn(dir, session);
    let store = dir.join("snapshots").join(session).join(&turn);
    if fs::create_dir_all(&store).is_err() {
        return;
    }
    let name = entry_name(path);
    if store.join(format!("{name}.json")).exists() {
        return;
    }
    if fs::read_dir(&store).map(|d| d.count()).unwrap_or(0) >= MAX_FILES_PER_TURN * 3 {
        return;
    }
    let Ok(mut meta) = OpenOptions::new().write(true).create_new(true).open(store.join(format!("{name}.json"))) else {
        return;
    };
    let entry = match fs::metadata(path) {
        Ok(m) if m.is_file() && m.len() <= MAX_SNAPSHOT_BYTES => match fs::read(path) {
            Ok(bytes) if fs::write(store.join(format!("{name}.bak")), &bytes).is_ok() => json!({
                "path": path,
                "existed": true,
                "hash": format!("{:016x}", fnv(&bytes)),
            }),
            _ => json!({ "path": path, "existed": true, "skipped": true }),
        },
        Ok(_) => json!({ "path": path, "existed": true, "skipped": true }),
        Err(_) => json!({ "path": path, "existed": false }),
    };
    let _ = meta.write_all(entry.to_string().as_bytes());
}

pub fn after(dir: &Path, session: &str, path: &Path) {
    let Some(turn) = read_turn(dir, session) else { return };
    let store = dir.join("snapshots").join(session).join(turn);
    let name = entry_name(path);
    if !store.join(format!("{name}.json")).exists() {
        return;
    }
    let hash = match fs::read(path) {
        Ok(bytes) => format!("{:016x}", fnv(&bytes)),
        Err(_) => "missing".to_string(),
    };
    let _ = fs::write(store.join(format!("{name}.after")), hash);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tako-snap-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ids_keep_only_safe_characters() {
        assert_eq!(safe_id("abc-123_DEF").as_deref(), Some("abc-123_DEF"));
        assert_eq!(safe_id("../../etc").as_deref(), Some("etc"));
        assert_eq!(safe_id("..\\").as_deref(), None);
    }

    #[test]
    fn the_first_version_of_a_file_wins_within_a_turn() {
        let dir = scratch("first");
        let file = dir.join("a.txt");
        fs::write(&file, "one").unwrap();
        start_turn(&dir, "s1");
        before(&dir, "s1", &file);
        fs::write(&file, "two").unwrap();
        after(&dir, "s1", &file);
        before(&dir, "s1", &file);
        let turn = read_turn(&dir, "s1").unwrap();
        let store = dir.join("snapshots").join("s1").join(turn);
        let name = entry_name(&file);
        assert_eq!(fs::read_to_string(store.join(format!("{name}.bak"))).unwrap(), "one");
        assert_eq!(fs::read_to_string(store.join(format!("{name}.after"))).unwrap(), format!("{:016x}", fnv(b"two")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_file_is_recorded_as_not_existing() {
        let dir = scratch("new");
        let file = dir.join("new.txt");
        before(&dir, "s2", &file);
        let turn = read_turn(&dir, "s2").unwrap();
        let meta = dir.join("snapshots").join("s2").join(turn).join(format!("{}.json", entry_name(&file)));
        let v: Value = serde_json::from_str(&fs::read_to_string(meta).unwrap()).unwrap();
        assert_eq!(v["existed"], false);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_edit_tools_have_a_target() {
        let input = json!({ "file_path": "C:\\x\\a.rs", "notebook_path": "C:\\x\\n.ipynb" });
        assert_eq!(target_path("Edit", &input, ""), Some(PathBuf::from("C:\\x\\a.rs")));
        assert_eq!(target_path("NotebookEdit", &input, ""), Some(PathBuf::from("C:\\x\\n.ipynb")));
        assert_eq!(target_path("Read", &input, ""), None);
        assert_eq!(target_path("Write", &json!({ "file_path": "rel.txt" }), "C:\\p"), Some(PathBuf::from("C:\\p").join("rel.txt")));
    }
}
