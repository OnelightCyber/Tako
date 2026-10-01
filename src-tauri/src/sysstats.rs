use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::w;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_secs(2);
const PDH_MORE_DATA: u32 = 0x8000_07D2;

static ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub cpu: f64,
    pub ram: f64,
    pub ram_used_gb: f64,
    pub ram_total_gb: f64,
    pub gpu: Option<f64>,
}

fn ticks(t: FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}

fn cpu_times() -> Option<(u64, u64)> {
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).ok()? };
    Some((ticks(idle), ticks(kernel) + ticks(user)))
}

pub fn cpu_percent(before: (u64, u64), after: (u64, u64)) -> f64 {
    let idle = after.0.saturating_sub(before.0) as f64;
    let total = after.1.saturating_sub(before.1) as f64;
    if total <= 0.0 {
        return 0.0;
    }
    ((1.0 - idle / total) * 100.0).clamp(0.0, 100.0)
}

fn memory() -> Option<(f64, f64, f64)> {
    let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut status).ok()? };
    let gb = 1024.0 * 1024.0 * 1024.0;
    let total = status.ullTotalPhys as f64 / gb;
    let used = (status.ullTotalPhys - status.ullAvailPhys) as f64 / gb;
    Some((status.dwMemoryLoad as f64, used, total))
}

struct Gpu {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
}

unsafe impl Send for Gpu {}

impl Gpu {
    fn open() -> Option<Gpu> {
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(None, 0, &mut query) != 0 {
                return None;
            }
            let mut counter = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(query, w!("\\GPU Engine(*engtype_3D)\\Utilization Percentage"), 0, &mut counter) != 0 {
                return None;
            }
            let _ = PdhCollectQueryData(query);
            Some(Gpu { query, counter })
        }
    }

    fn read(&self) -> Option<f64> {
        unsafe {
            if PdhCollectQueryData(self.query) != 0 {
                return None;
            }
            let (mut size, mut count) = (0u32, 0u32);
            let first = PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
            if first != PDH_MORE_DATA || size == 0 {
                return if first == 0 { Some(0.0) } else { None };
            }
            let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
            let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
                return None;
            }
            let mut total = 0.0;
            for i in 0..count as usize {
                let item = &*items.add(i);
                if item.FmtValue.CStatus == 0 {
                    total += item.FmtValue.Anonymous.doubleValue;
                }
            }
            Some(total.clamp(0.0, 100.0))
        }
    }
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn start(app: AppHandle, gate: Arc<crate::island::PollGate>) {
    std::thread::spawn(move || {
        let gpu = Gpu::open();
        let mut before = cpu_times();
        loop {
            std::thread::sleep(EVERY);
            if !ENABLED.load(Ordering::Relaxed) || gate.collapsed.load(Ordering::Relaxed) {
                before = cpu_times();
                continue;
            }
            let now = cpu_times();
            let cpu = match (before, now) {
                (Some(a), Some(b)) => cpu_percent(a, b),
                _ => 0.0,
            };
            before = now;
            let (ram, ram_used_gb, ram_total_gb) = memory().unwrap_or((0.0, 0.0, 0.0));
            let stats = Stats { cpu, ram, ram_used_gb, ram_total_gb, gpu: gpu.as_ref().and_then(Gpu::read) };
            let _ = app.emit_to(WINDOW_LABEL, "system-stats", stats);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_is_the_busy_share_of_elapsed_time() {
        assert_eq!(cpu_percent((100, 1000), (150, 1100)), 50.0);
        assert_eq!(cpu_percent((100, 1000), (100, 1000)), 0.0);
        assert_eq!(cpu_percent((0, 0), (0, 100)), 100.0);
    }

    #[test]
    fn memory_and_cpu_can_be_read() {
        let (load, used, total) = memory().expect("memory status");
        assert!(load > 0.0 && load <= 100.0);
        assert!(used > 0.0 && used <= total);
        assert!(cpu_times().is_some());
    }
}
