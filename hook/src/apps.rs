use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use serde_json::Value;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CACHE_FOR: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, PartialEq)]
pub struct App {
    pub name: String,
    pub id: String,
}

fn cache_file() -> Option<PathBuf> {
    crate::snapshot::data_dir().map(|d| d.join("apps.json"))
}

pub fn parse_start_apps(text: &str) -> Vec<App> {
    let value: Value = serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).unwrap_or(Value::Null);
    let items = match value {
        Value::Array(items) => items,
        Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    items
        .iter()
        .filter_map(|v| {
            let name = v.get("Name")?.as_str()?.trim().to_string();
            let id = v.get("AppID")?.as_str()?.trim().to_string();
            (!name.is_empty() && !id.is_empty()).then_some(App { name, id })
        })
        .collect()
}

fn load() -> Vec<App> {
    if let Some(file) = cache_file() {
        let fresh = std::fs::metadata(&file)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .map(|age| age < CACHE_FOR)
            .unwrap_or(false);
        if fresh {
            if let Ok(text) = std::fs::read_to_string(&file) {
                let apps = parse_start_apps(&text);
                if !apps.is_empty() {
                    return apps;
                }
            }
        }
    }
    let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress";
    let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let apps = parse_start_apps(&text);
    if !apps.is_empty() {
        if let Some(file) = cache_file() {
            let _ = std::fs::write(file, &text);
        }
    }
    apps
}

pub fn normalize(s: &str) -> String {
    let folded: String = s
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' | 'á' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' | 'í' => 'i',
            'ô' | 'ö' | 'ó' => 'o',
            'ù' | 'û' | 'ü' | 'ú' => 'u',
            'ç' => 'c',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn score(name: &str, query: &str) -> u32 {
    let n = normalize(name);
    let base = if n == query {
        100
    } else if n.starts_with(query) {
        80
    } else if n.split(' ').any(|w| w == query) {
        70
    } else if n.contains(query) {
        60
    } else if query.split(' ').all(|w| n.contains(w)) {
        40
    } else {
        0
    };
    let helper = ["uninstall", "desinstall", "readme", "help", "aide", "documentation"].iter().any(|w| n.contains(w));
    if helper && !query.contains("uninstall") && !query.contains("desinstall") {
        base / 4
    } else {
        base
    }
}

pub fn rank<'a>(apps: &'a [App], query: &str) -> Vec<&'a App> {
    let q = normalize(query);
    if q.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(u32, &App)> = apps.iter().map(|a| (score(&a.name, &q), a)).filter(|(s, _)| *s > 0).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.name.len().cmp(&b.1.name.len())));
    scored.into_iter().map(|(_, a)| a).collect()
}

pub fn open(name: &str) -> (bool, String) {
    let apps = load();
    if apps.is_empty() {
        return (false, "The list of installed apps is unavailable right now.".into());
    }
    let ranked = rank(&apps, name);
    let Some(app) = ranked.first() else {
        return (false, format!("No installed app matches \"{name}\". Ask the user for the exact name."));
    };
    match Command::new("explorer.exe").arg(format!("shell:AppsFolder\\{}", app.id)).spawn() {
        Ok(_) => {
            let others: Vec<&str> = ranked.iter().skip(1).take(3).map(|a| a.name.as_str()).collect();
            let mut text = format!("Opened {}. It stays open until the user closes it.", app.name);
            if !others.is_empty() {
                text.push_str(&format!(" Other close matches: {}.", others.join(", ")));
            }
            (true, text)
        }
        Err(err) => (false, format!("Couldn't open {}: {err}", app.name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps() -> Vec<App> {
        parse_start_apps(r#"[{"Name":"Spotify","AppID":"SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"},{"Name":"Bloc-notes","AppID":"Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"},{"Name":"Discord","AppID":"com.squirrel.Discord.Discord"},{"Name":"Uninstall Spotify","AppID":"x"},{"Name":"Visual Studio Code","AppID":"Microsoft.VisualStudioCode"}]"#)
    }

    #[test]
    fn start_apps_are_parsed_from_one_or_many_entries() {
        assert_eq!(apps().len(), 5);
        assert_eq!(parse_start_apps(r#"{"Name":"Paint","AppID":"Microsoft.Paint_8wekyb3d8bbwe!App"}"#).len(), 1);
        assert!(parse_start_apps("not json").is_empty());
    }

    #[test]
    fn names_match_regardless_of_case_accents_and_helpers() {
        let list = apps();
        assert_eq!(rank(&list, "spotify")[0].name, "Spotify");
        assert_eq!(rank(&list, "BLOC NOTES")[0].name, "Bloc-notes");
        assert_eq!(rank(&list, "code")[0].name, "Visual Studio Code");
        assert!(rank(&list, "").is_empty());
        assert!(rank(&list, "photoshop").is_empty());
    }
}
