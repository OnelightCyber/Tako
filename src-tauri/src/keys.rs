use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetKeyState, VK_CAPITAL};

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_millis(50);
const IDLE: Duration = Duration::from_millis(500);
const SETTLE: Duration = Duration::from_millis(40);
const CHECK_EVERY: u32 = 100;

static ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LockKey {
    pub key: &'static str,
    pub on: bool,
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

fn caps_toggled() -> Option<bool> {
    std::thread::spawn(|| unsafe { GetKeyState(VK_CAPITAL.0 as i32) } & 1 == 1).join().ok()
}

fn caps_keys() -> (bool, bool) {
    let raw = unsafe { GetAsyncKeyState(VK_CAPITAL.0 as i32) } as u16;
    (raw & 0x8000 != 0, raw & 0x0001 != 0)
}

pub fn released(was_down: bool, down: bool, tapped: bool) -> bool {
    !down && (was_down || tapped)
}

pub fn changed(previous: bool, read: Option<bool>) -> Option<bool> {
    read.filter(|now| *now != previous)
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut state = false;
        let mut synced = false;
        let mut was_down = false;
        let mut tick: u32 = 0;
        loop {
            if !ENABLED.load(Ordering::Relaxed) {
                synced = false;
                was_down = false;
                std::thread::sleep(IDLE);
                continue;
            }
            if !synced {
                if let Some(now) = caps_toggled() {
                    state = now;
                }
                synced = true;
                tick = 0;
            }
            std::thread::sleep(EVERY);
            tick = tick.wrapping_add(1);
            let (down, tapped) = caps_keys();
            let release = released(was_down, down, tapped);
            was_down = down;
            if !release && !tick.is_multiple_of(CHECK_EVERY) {
                continue;
            }
            if release {
                std::thread::sleep(SETTLE);
            }
            if let Some(now) = changed(state, caps_toggled()) {
                state = now;
                if ENABLED.load(Ordering::Relaxed) {
                    let _ = app.emit_to(WINDOW_LABEL, "lock-key", LockKey { key: "caps", on: state });
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_change_is_reported() {
        assert_eq!(changed(false, Some(true)), Some(true));
        assert_eq!(changed(true, Some(false)), Some(false));
        assert_eq!(changed(false, Some(false)), None);
        assert_eq!(changed(true, None), None);
    }

    #[test]
    fn a_press_is_seen_when_the_key_comes_back_up() {
        assert!(released(true, false, false));
        assert!(released(false, false, true));
        assert!(!released(true, true, false));
        assert!(!released(false, false, false));
    }
}
