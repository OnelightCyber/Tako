use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use std::collections::HashMap;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, FILETIME};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_QWORD,
};
use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_millis(1500);
const SLACK: u64 = 30_000_000;
const PACKAGED_MAX: u64 = 8 * 3600 * 10_000_000;
const ROOT: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
const NAMES: &[(&str, &str)] = &[
    ("discord", "Discord"),
    ("discordptb", "Discord"),
    ("discordcanary", "Discord"),
    ("msedgewebview2", "Appli web"),
    ("msedge", "Edge"),
    ("chrome", "Chrome"),
    ("opera", "Opera"),
    ("opera_gx", "Opera GX"),
    ("firefox", "Firefox"),
    ("brave", "Brave"),
    ("ms-teams", "Teams"),
    ("msteams", "Teams"),
    ("teams", "Teams"),
    ("zoom", "Zoom"),
    ("slack", "Slack"),
    ("whatsapp", "WhatsApp"),
    ("whatsapp.root", "WhatsApp"),
    ("telegram", "Telegram"),
    ("skype", "Skype"),
    ("signal", "Signal"),
    ("teamspeak", "TeamSpeak"),
    ("ts3client_win64", "TeamSpeak"),
    ("signalrgb", "SignalRGB"),
    ("obs64", "OBS"),
    ("obs32", "OBS"),
    ("steamwebhelper", "Steam"),
    ("steam", "Steam"),
    ("voicemeeter", "Voicemeeter"),
    ("voicemeeterpro", "Voicemeeter"),
    ("windowscamera", "Caméra"),
    ("windowssoundrecorder", "Enregistreur vocal"),
    ("xboxgamingoverlay", "Xbox Game Bar"),
    ("gamingapp", "Xbox"),
    ("screensketch", "Capture d'écran"),
    ("5319275a.whatsappdesktop", "WhatsApp"),
];

static ENABLED: AtomicBool = AtomicBool::new(true);
static LAST: Mutex<Option<Privacy>> = Mutex::new(None);

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Use {
    pub app: String,
    pub since: i64,
}

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Privacy {
    pub mic: Vec<Use>,
    pub cam: Vec<Use>,
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn in_use(start: u64, stop: u64) -> bool {
    start > 0 && (stop == 0 || start > stop)
}

pub fn unix_ms(filetime: u64) -> i64 {
    (filetime / 10_000) as i64 - 11_644_473_600_000
}

pub fn app_name(key: &str) -> String {
    let leaf = key.rsplit('#').next().unwrap_or(key);
    let stem = leaf.strip_suffix(".exe").or_else(|| leaf.strip_suffix(".EXE")).unwrap_or(leaf);
    let stem = stem.split('_').next().unwrap_or(stem);
    let stem = if leaf.contains('#') { stem } else { stem.rsplit('.').next().unwrap_or(stem) };
    let lower = stem.to_lowercase();
    NAMES
        .iter()
        .find(|(k, _)| lower == *k)
        .map(|(_, n)| n.to_string())
        .unwrap_or_else(|| stem.to_string())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn subkeys(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut key = HKEY::default();
    let p = wide(path);
    unsafe {
        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(p.as_ptr()), Some(0), KEY_READ, &mut key) != ERROR_SUCCESS {
            return out;
        }
        let mut index = 0u32;
        loop {
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            if RegEnumKeyExW(key, index, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) != ERROR_SUCCESS {
                break;
            }
            out.push(String::from_utf16_lossy(&buf[..len as usize]));
            index += 1;
        }
        let _ = RegCloseKey(key);
    }
    out
}

fn qword(path: &str, name: &str) -> u64 {
    let p = wide(path);
    let n = wide(name);
    let mut value = 0u64;
    let mut size = std::mem::size_of::<u64>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(p.as_ptr()),
            PCWSTR(n.as_ptr()),
            RRF_RT_REG_QWORD,
            None,
            Some(&mut value as *mut u64 as *mut _),
            Some(&mut size),
        )
    };
    if status == ERROR_SUCCESS { value } else { 0 }
}

fn exe_of(key: &str) -> Option<String> {
    key.contains('#').then(|| key.rsplit('#').next().unwrap_or(key).to_lowercase())
}

fn now_filetime() -> u64 {
    let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    (unix + 11_644_473_600_000) * 10_000
}

pub fn alive(start: u64, launches: Option<&Vec<u64>>, packaged: bool, now: u64) -> bool {
    if packaged {
        return now.saturating_sub(start) < PACKAGED_MAX;
    }
    launches.is_some_and(|times| times.iter().any(|t| *t <= start + SLACK))
}

fn launches(wanted: &[String]) -> HashMap<String, Vec<u64>> {
    let mut out: HashMap<String, Vec<u64>> = HashMap::new();
    if wanted.is_empty() {
        return out;
    }
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase();
            if wanted.contains(&name) {
                if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID) {
                    let mut created = FILETIME::default();
                    let mut exited = FILETIME::default();
                    let mut kernel = FILETIME::default();
                    let mut user = FILETIME::default();
                    if GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user).is_ok() {
                        let at = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
                        out.entry(name).or_default().push(at);
                    }
                    let _ = CloseHandle(process);
                }
            }
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

fn scan(capability: &str) -> Vec<Use> {
    let base = format!(r"{ROOT}\{capability}");
    let mut paths: Vec<String> = Vec::new();
    for name in subkeys(&base) {
        if name == "NonPackaged" {
            let np = format!(r"{base}\NonPackaged");
            paths.extend(subkeys(&np).into_iter().map(|leaf| format!(r"{np}\{leaf}")));
        } else {
            paths.push(format!(r"{base}\{name}"));
        }
    }
    let mut open: Vec<(String, u64)> = Vec::new();
    for path in paths {
        let start = qword(&path, "LastUsedTimeStart");
        let stop = qword(&path, "LastUsedTimeStop");
        if in_use(start, stop) {
            open.push((path.rsplit('\\').next().unwrap_or(&path).to_string(), start));
        }
    }
    let wanted: Vec<String> = open.iter().filter_map(|(key, _)| exe_of(key)).collect();
    let running = launches(&wanted);
    let now = now_filetime();
    let mut out: Vec<Use> = Vec::new();
    for (key, start) in open {
        let exe = exe_of(&key);
        if !alive(start, exe.as_ref().and_then(|e| running.get(e)), exe.is_none(), now) {
            continue;
        }
        let key = key.as_str();
        let app = app_name(key);
        if app.eq_ignore_ascii_case("tako") || out.iter().any(|u| u.app == app) {
            continue;
        }
        out.push(Use { app, since: unix_ms(start) });
    }
    out.sort_by(|a, b| a.app.cmp(&b.app));
    out
}

pub fn status() -> Privacy {
    LAST.lock().unwrap().clone().unwrap_or_default()
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(EVERY);
        let now = if ENABLED.load(Ordering::Relaxed) { Privacy { mic: scan("microphone"), cam: scan("webcam") } } else { Privacy::default() };
        let changed = LAST.lock().unwrap().as_ref() != Some(&now);
        if changed {
            *LAST.lock().unwrap() = Some(now.clone());
            let _ = app.emit_to(WINDOW_LABEL, "privacy", now);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_is_in_use_until_its_stop_time_is_written() {
        assert!(in_use(134_322_257_782_735_648, 0));
        assert!(in_use(134_322_257_782_735_648, 134_322_200_000_000_000));
        assert!(!in_use(134_322_257_782_735_648, 134_322_258_143_986_904));
        assert!(!in_use(0, 0));
    }

    #[test]
    fn registry_keys_become_app_names() {
        assert_eq!(app_name(r"C:#Users#me#AppData#Local#DiscordPTB#app-1.0.1#DiscordPTB.exe"), "Discord");
        assert_eq!(app_name(r"C:#Program Files#Google#Chrome#Application#chrome.exe"), "Chrome");
        assert_eq!(app_name("Microsoft.WindowsCamera_8wekyb3d8bbwe"), "Caméra");
        assert_eq!(app_name(r"C:#Games#cod.exe"), "cod");
        assert_eq!(app_name(r"C:#Program Files#TeamSpeak#TeamSpeak.exe"), "TeamSpeak");
        assert_eq!(app_name(r"C:#Program Files#SignalRgb#SignalRgb.exe"), "SignalRGB");
        assert_eq!(app_name("MSTeams_8wekyb3d8bbwe"), "Teams");
    }

    #[test]
    fn stale_entries_from_closed_or_restarted_apps_are_ignored() {
        let start = 134_000_000_000_000_000u64;
        assert!(alive(start, Some(&vec![start - 50_000_000]), false, start + 1));
        assert!(alive(start, Some(&vec![start + 10_000_000]), false, start + 1));
        assert!(!alive(start, Some(&vec![start + 9_000_000_000]), false, start + 1));
        assert!(!alive(start, None, false, start + 1));
        assert!(alive(start, None, true, start + 3600 * 10_000_000));
        assert!(!alive(start, None, true, start + 9 * 3600 * 10_000_000));
    }

    #[test]
    fn filetimes_turn_into_unix_milliseconds() {
        assert_eq!(unix_ms(116_444_736_000_000_000), 0);
        assert_eq!(unix_ms(116_444_736_000_000_000 + 10_000_000), 1000);
    }
}
