use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetKeyState, VK_CAPITAL};

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_millis(50);
const SETTLE: Duration = Duration::from_millis(40);
const CHECK_EVERY: u32 = 8;

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

fn caps_down() -> bool {
    (unsafe { GetAsyncKeyState(VK_CAPITAL.0 as i32) } as u16 & 0x8000) != 0
}

pub fn changed(previous: bool, read: Option<bool>) -> Option<bool> {
    read.filter(|now| *now != previous)
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut state = caps_toggled().unwrap_or(false);
        let mut was_down = false;
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(EVERY);
            tick = tick.wrapping_add(1);
            let down = caps_down();
            let released = was_down && !down;
            was_down = down;
            if !released && tick % CHECK_EVERY != 0 {
                continue;
            }
            if released {
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
}
