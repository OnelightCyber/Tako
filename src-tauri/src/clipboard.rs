use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardOwner, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
    OpenClipboard, RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_millis(450);
const CF_UNICODETEXT: u32 = 13;
const MAX_READ: usize = 20_000;
const MAX_SEND: usize = 8_000;
const SECRET_FORMATS: &[&str] = &["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore", "CanIncludeInClipboardHistory"];
const SECRET_APPS: &[&str] = &[
    "keepass", "keepassxc", "1password", "bitwarden", "dashlane", "enpass", "lastpass", "nordpass", "protonpass", "roboform", "keeper",
];
const EN: &[&str] = &["the", "and", "is", "are", "you", "your", "to", "of", "for", "with", "this", "that", "it", "on", "be", "have", "not", "was", "will", "can", "we", "they", "what", "how"];
const FR: &[&str] = &["le", "la", "les", "et", "est", "des", "une", "un", "pour", "dans", "que", "qui", "pas", "vous", "je", "tu", "il", "nous", "sur", "avec", "ce", "mais", "du", "au"];

static ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lens {
    pub kind: &'static str,
    pub text: String,
}

struct Patterns {
    error: Regex,
    tracking: Regex,
    address: Regex,
    code: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        error: Regex::new(r"(?im)(traceback \(most recent call last\)|^\s*(error|fatal|panic|uncaught|exception)\b|\berror(\[[a-z]?\d+\])?:|\b(type|reference|syntax|range|attribute|key|value|index|name|import)error\b|\bpanicked at\b|\bnpm err!|\bsegmentation fault\b|\bexit code [1-9]\d*\b|\bat [\w.$<>]+ \(.+:\d+:\d+\)|\berror (ts|cs|c)\d{3,5}\b|\bfailed to compile\b|\bcannot find module\b|\bundefined reference to\b)").unwrap(),
        tracking: Regex::new(r"^(1Z[0-9A-Z]{16}|[A-Z]{2}\d{9}[A-Z]{2}|\d[A-Z]\d{11}|TBA\d{12}|\d{12,14}|JD\d{18}|[A-Z]{2}\d{11})$").unwrap(),
        address: Regex::new(r"(?i)^\d{1,4}\s?(bis|ter)?,?\s+(rue|avenue|av\.?|boulevard|bd|chemin|place|all[ée]e|impasse|route|quai|cours|square|passage|rte)\b[^\n]{2,60}?\b\d{5}\b\s*[a-zà-ÿ' -]{2,40}$").unwrap(),
        code: Regex::new(r"[{};=<>]").unwrap(),
    })
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphabetic() && c != '\'')
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

pub fn english(text: &str) -> bool {
    let list = words(text);
    if list.len() < 6 || text.len() > MAX_SEND {
        return false;
    }
    let symbols = patterns().code.find_iter(text).count();
    if symbols * 12 > text.len() {
        return false;
    }
    if text.chars().any(|c| "éèàùçêâîôû".contains(c)) {
        return false;
    }
    let en = list.iter().filter(|w| EN.contains(&w.as_str())).count();
    let fr = list.iter().filter(|w| FR.contains(&w.as_str())).count();
    en >= 3 && en > fr * 2
}

pub fn classify(text: &str) -> Option<&'static str> {
    let t = text.trim();
    if t.len() < 4 {
        return None;
    }
    let p = patterns();
    if t.len() <= 40 && !t.contains(char::is_whitespace) {
        let upper = t.to_uppercase();
        if p.tracking.is_match(&upper) && upper.chars().any(|c| c.is_ascii_digit()) && upper.chars().filter(|c| c.is_ascii_digit()).count() >= 9 {
            return Some("tracking");
        }
    }
    if t.len() <= 160 && p.address.is_match(&t.replace('\n', " ")) {
        return Some("address");
    }
    if t.len() >= 12 && p.error.is_match(t) {
        return Some("error");
    }
    if english(t) {
        return Some("english");
    }
    None
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn secret_marked() -> bool {
    SECRET_FORMATS.iter().any(|name| {
        let w = wide(name);
        let id = unsafe { RegisterClipboardFormatW(PCWSTR(w.as_ptr())) };
        id != 0 && unsafe { IsClipboardFormatAvailable(id) }.is_ok()
    })
}

fn owner_is_ignored() -> bool {
    unsafe {
        let Ok(owner) = GetClipboardOwner() else { return false };
        if owner.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(owner, Some(&mut pid));
        if pid == std::process::id() {
            return true;
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return false;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
        let file = path.rsplit(['\\', '/']).next().unwrap_or(&path).replace(".exe", "").replace([' ', '-', '_'], "");
        SECRET_APPS.iter().any(|a| file.contains(a))
    }
}

fn read_text() -> Option<String> {
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() {
            return None;
        }
        let mut opened = false;
        for _ in 0..4 {
            if OpenClipboard(Some(HWND::default())).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        if !opened {
            return None;
        }
        let text = (|| {
            let handle: HANDLE = GetClipboardData(CF_UNICODETEXT).ok()?;
            let global = HGLOBAL(handle.0);
            let ptr = GlobalLock(global) as *const u16;
            if ptr.is_null() {
                return None;
            }
            let max = (GlobalSize(global) / 2).min(MAX_READ * 2);
            let mut len = 0usize;
            while len < max && *ptr.add(len) != 0 {
                len += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
            let _ = GlobalUnlock(global);
            Some(text)
        })();
        let _ = CloseClipboard();
        text
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = unsafe { GetClipboardSequenceNumber() };
        let mut seen = String::new();
        loop {
            std::thread::sleep(EVERY);
            let now = unsafe { GetClipboardSequenceNumber() };
            if now == last {
                continue;
            }
            last = now;
            if !ENABLED.load(Ordering::Relaxed) || secret_marked() || owner_is_ignored() {
                continue;
            }
            let Some(text) = read_text() else { continue };
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed == seen {
                continue;
            }
            seen = trimmed.to_string();
            if let Some(kind) = classify(trimmed) {
                let text: String = trimmed.chars().take(MAX_SEND).collect();
                let _ = app.emit_to(WINDOW_LABEL, "lens", Lens { kind, text });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_recognised() {
        assert_eq!(classify("Traceback (most recent call last):\n  File \"a.py\", line 1"), Some("error"));
        assert_eq!(classify("TypeError: Cannot read properties of undefined (reading 'x')"), Some("error"));
        assert_eq!(classify("error[E0425]: cannot find value `x` in this scope"), Some("error"));
        assert_eq!(classify("thread 'main' panicked at src/main.rs:4:5"), Some("error"));
        assert_eq!(classify("    at Object.<anonymous> (C:\\app\\index.js:12:9)"), Some("error"));
    }

    #[test]
    fn english_text_is_recognised_but_not_french() {
        assert_eq!(classify("The meeting is moved to Thursday and you will need to bring the slides with you."), Some("english"));
        assert_eq!(classify("La réunion est déplacée à jeudi et tu dois apporter les slides avec toi."), None);
        assert_eq!(classify("ok"), None);
        assert_eq!(classify("fn main() { let x = 1; if x == 1 { return; } } and the value is for you"), None);
    }

    #[test]
    fn parcels_addresses_and_links() {
        assert_eq!(classify("1Z999AA10123456784"), Some("tracking"));
        assert_eq!(classify("CB123456789FR"), Some("tracking"));
        assert_eq!(classify("6A12345678901"), Some("tracking"));
        assert_eq!(classify("12 rue de la Paix 75002 Paris"), Some("address"));
        assert_eq!(classify("3 bis avenue Jean Jaurès, 69007 Lyon"), Some("address"));
        assert_eq!(classify("https://github.com/OnelightCyber/Tako"), None);
        assert_eq!(classify("hunter2"), None);
        assert_eq!(classify("0612345678"), None);
    }
}
