use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, GWL_STYLE,
    WS_CAPTION,
};

use crate::{log, Shared};

const EVERY: Duration = Duration::from_millis(1500);
const CALM_TICKS: u32 = 2;
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];
const WORK_APPS: &[&str] = &[
    "windowsterminal", "openconsole", "conhost", "cmd", "powershell", "pwsh", "wezterm-gui", "alacritty", "warp", "tabby", "hyper",
    "code", "code - insiders", "cursor", "windsurf", "zed", "devenv", "idea64", "pycharm64", "webstorm64", "rider64", "clion64",
    "goland64", "phpstorm64", "rustrover64", "datagrip64", "studio64", "sublime_text", "notepad++",
];
const NAMES: &[(&str, &str)] = &[
    ("robloxplayerbeta", "Roblox"),
    ("minecraft.windows", "Minecraft"),
    ("javaw", "Minecraft"),
    ("fortniteclient-win64-shipping", "Fortnite"),
    ("valorant-win64-shipping", "Valorant"),
    ("cs2", "Counter-Strike 2"),
    ("r5apex", "Apex Legends"),
    ("league of legends", "League of Legends"),
    ("gta5", "GTA V"),
    ("rocketleague", "Rocket League"),
    ("overwatch", "Overwatch 2"),
    ("eldenring", "Elden Ring"),
    ("rainbowsix", "Rainbow Six Siege"),
    ("dota2", "Dota 2"),
    ("cod", "Call of Duty"),
    ("helldivers2", "Helldivers 2"),
    ("marvel-win64-shipping", "Marvel Rivals"),
    ("chrome", "Chrome"),
    ("msedge", "Edge"),
    ("firefox", "Firefox"),
    ("vlc", "VLC"),
];

static ACTIVE: AtomicBool = AtomicBool::new(false);
static ENABLED: AtomicBool = AtomicBool::new(true);
static APP: Mutex<String> = Mutex::new(String::new());

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub active: bool,
    pub app: String,
}

pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn state() -> GameState {
    GameState { active: active(), app: APP.lock().unwrap().clone() }
}

pub fn covers(window: (i32, i32, i32, i32), monitor: (i32, i32, i32, i32), captioned: bool) -> bool {
    !captioned && window.0 <= monitor.0 && window.1 <= monitor.1 && window.2 >= monitor.2 && window.3 >= monitor.3
}

pub fn is_game(quns: i32, fills_screen: bool, shell: bool, own: bool) -> bool {
    if own || shell {
        return false;
    }
    quns == QUNS_RUNNING_D3D_FULL_SCREEN.0 || quns == QUNS_BUSY.0 || quns == QUNS_PRESENTATION_MODE.0 || fills_screen
}

pub fn is_work_app(exe_stem: &str) -> bool {
    let lower = exe_stem.to_lowercase();
    WORK_APPS.contains(&lower.as_str())
}

fn names(lower: &str, key: &str) -> bool {
    lower == key || lower.strip_prefix(key).is_some_and(|rest| rest.starts_with(['_', '-', '.', ' ']))
}

pub fn pretty(exe_stem: &str) -> String {
    let lower = exe_stem.to_lowercase();
    NAMES
        .iter()
        .find(|(key, _)| names(&lower, key))
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| exe_stem.to_string())
}

fn rect_tuple(r: RECT) -> (i32, i32, i32, i32) {
    (r.left, r.top, r.right, r.bottom)
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

fn exe_stem(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let file = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
        Some(file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(&file).to_string())
    }
}

fn detect() -> GameState {
    let quns = unsafe { SHQueryUserNotificationState() }.map(|s| s.0).unwrap_or(0);
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return GameState::default();
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let own = pid == std::process::id();
    let shell = SHELL_CLASSES.contains(&class_name(hwnd).as_str());

    let mut window = RECT::default();
    let mut fills = false;
    if unsafe { GetWindowRect(hwnd, &mut window) }.is_ok() {
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32;
            let captioned = style & WS_CAPTION.0 == WS_CAPTION.0;
            fills = covers(rect_tuple(window), rect_tuple(info.rcMonitor), captioned);
        }
    }

    if !is_game(quns, fills, shell, own) {
        return GameState::default();
    }
    let stem = exe_stem(pid).unwrap_or_default();
    if is_work_app(&stem) {
        return GameState::default();
    }
    GameState { active: true, app: pretty(&stem) }
}

fn apply(app: &AppHandle, now: &GameState) {
    ACTIVE.store(now.active, Ordering::Relaxed);
    *APP.lock().unwrap() = now.app.clone();
    let collapsed = app
        .try_state::<Shared>()
        .map(|s| s.gate.collapsed.load(Ordering::Relaxed))
        .unwrap_or(false);
    if collapsed {
        crate::island::set_ignore_cursor(app, now.active);
    }
    if let Some(shared) = app.try_state::<Shared>() {
        let settings = shared.settings.lock().unwrap().clone();
        crate::widget::sync(app, &settings);
    }
    log::line(if now.active { format!("game mode on ({})", now.app) } else { "game mode off".to_string() });
    let _ = app.emit("game-mode", now);
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut current = GameState::default();
        let mut calm = 0u32;
        loop {
            std::thread::sleep(EVERY);
            let seen = if ENABLED.load(Ordering::Relaxed) { detect() } else { GameState::default() };
            if seen.active {
                calm = 0;
                if !current.active || seen.app != current.app {
                    current = seen;
                    apply(&app, &current);
                }
            } else if current.active {
                calm += 1;
                if calm >= CALM_TICKS || !ENABLED.load(Ordering::Relaxed) {
                    calm = 0;
                    current = GameState::default();
                    apply(&app, &current);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_borderless_window_over_the_whole_monitor_is_fullscreen() {
        let monitor = (0, 0, 1920, 1080);
        assert!(covers((0, 0, 1920, 1080), monitor, false));
        assert!(covers((-8, -8, 1928, 1088), monitor, false));
        assert!(!covers((0, 0, 1920, 1080), monitor, true));
        assert!(!covers((0, 0, 1920, 1040), monitor, false));
    }

    #[test]
    fn the_desktop_and_tako_never_count_as_a_game() {
        assert!(is_game(QUNS_RUNNING_D3D_FULL_SCREEN.0, false, false, false));
        assert!(is_game(QUNS_BUSY.0, false, false, false));
        assert!(is_game(5, true, false, false));
        assert!(!is_game(5, false, false, false));
        assert!(!is_game(QUNS_BUSY.0, true, true, false));
        assert!(!is_game(QUNS_RUNNING_D3D_FULL_SCREEN.0, true, false, true));
    }

    #[test]
    fn terminals_and_editors_never_count_as_a_game() {
        assert!(is_work_app("WindowsTerminal"));
        assert!(is_work_app("Code"));
        assert!(is_work_app("Cursor"));
        assert!(is_work_app("pwsh"));
        assert!(!is_work_app("RainbowSix"));
        assert!(!is_work_app("chrome"));
    }

    #[test]
    fn known_games_get_their_real_name() {
        assert_eq!(pretty("RobloxPlayerBeta"), "Roblox");
        assert_eq!(pretty("FortniteClient-Win64-Shipping"), "Fortnite");
        assert_eq!(pretty("SomeIndieGame"), "SomeIndieGame");
        assert_eq!(pretty("RainbowSix"), "Rainbow Six Siege");
    }

    #[test]
    fn variants_of_a_game_keep_its_name_but_lookalikes_do_not() {
        assert_eq!(pretty("cod"), "Call of Duty");
        assert_eq!(pretty("RainbowSix_BE"), "Rainbow Six Siege");
        assert_eq!(pretty("r5apex_dx12"), "Apex Legends");
        assert_eq!(pretty("FortniteClient-Win64-Shipping_EAC"), "Fortnite");
        assert_eq!(pretty("GTA5_Enhanced"), "GTA V");
        assert_eq!(pretty("codeblocks"), "codeblocks");
        assert_eq!(pretty("VSCodium"), "VSCodium");
        assert_eq!(pretty("codex"), "codex");
        assert_eq!(pretty("chromebook-emulator"), "chromebook-emulator");
        assert_eq!(pretty("vlcplayer"), "vlcplayer");
    }
}
