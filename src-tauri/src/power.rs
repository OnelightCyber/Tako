use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_secs(2);
const NO_BATTERY: u8 = 128;
const UNKNOWN: u8 = 255;

static ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Serialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Power {
    pub has_battery: bool,
    pub percent: u8,
    pub plugged: bool,
    pub saver: bool,
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn from_status(ac: u8, flag: u8, percent: u8, saver: u8) -> Power {
    let has_battery = flag != NO_BATTERY && flag != UNKNOWN && percent != UNKNOWN;
    Power {
        has_battery,
        percent: if has_battery { percent.min(100) } else { 0 },
        plugged: ac == 1,
        saver: saver == 1,
    }
}

pub fn status() -> Power {
    let mut s = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut s) }.is_err() {
        return Power::default();
    }
    from_status(s.ACLineStatus, s.BatteryFlag, s.BatteryLifePercent, s.SystemStatusFlag)
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = status();
        loop {
            std::thread::sleep(EVERY);
            let now = status();
            if now != last && now.has_battery && ENABLED.load(Ordering::Relaxed) {
                let _ = app.emit_to(WINDOW_LABEL, "power", now);
            }
            last = now;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktops_without_a_battery_report_none() {
        assert!(!from_status(1, NO_BATTERY, UNKNOWN, 0).has_battery);
        assert!(!from_status(1, UNKNOWN, 50, 0).has_battery);
        let laptop = from_status(0, 1, 76, 1);
        assert!(laptop.has_battery);
        assert_eq!(laptop.percent, 76);
        assert!(!laptop.plugged);
        assert!(laptop.saver);
        assert!(from_status(1, 8, 40, 0).plugged);
    }
}
