use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Networking::NetworkListManager::{
    INetwork, INetworkListManager, NetworkListManager, NLM_CONNECTIVITY_IPV4_INTERNET, NLM_CONNECTIVITY_IPV6_INTERNET,
    NLM_ENUM_NETWORK_CONNECTED,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_secs(2);
const LOST_AFTER: u32 = 3;
const SLEPT: Duration = Duration::from_secs(8);
const WAKE_GRACE: u32 = 10;

static ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub online: bool,
    pub name: String,
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

fn read(manager: &INetworkListManager) -> Option<Network> {
    unsafe {
        let flags = manager.GetConnectivity().ok()?.0;
        let online = flags & (NLM_CONNECTIVITY_IPV4_INTERNET.0 | NLM_CONNECTIVITY_IPV6_INTERNET.0) != 0;
        let mut name = String::new();
        if let Ok(list) = manager.GetNetworks(NLM_ENUM_NETWORK_CONNECTED) {
            let mut slot: [Option<INetwork>; 1] = [None];
            let mut fetched = 0u32;
            if list.Next(&mut slot, Some(&mut fetched)).is_ok() && fetched == 1 {
                if let Some(net) = slot[0].take() {
                    name = net.GetName().map(|b| b.to_string()).unwrap_or_default();
                }
            }
        }
        Some(Network { online, name })
    }
}

pub struct Debounce {
    offline_ticks: u32,
    seen_online: bool,
    down: bool,
}

impl Debounce {
    pub fn new(online: bool) -> Self {
        Self { offline_ticks: 0, seen_online: online, down: false }
    }

    pub fn feed(&mut self, online: bool) -> Option<bool> {
        if online {
            self.offline_ticks = 0;
            self.seen_online = true;
            if self.down {
                self.down = false;
                return Some(true);
            }
            return None;
        }
        self.offline_ticks += 1;
        if self.seen_online && self.offline_ticks >= LOST_AFTER && !self.down {
            self.down = true;
            return Some(false);
        }
        None
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let Ok(manager) = (unsafe { CoCreateInstance::<_, INetworkListManager>(&NetworkListManager, None, CLSCTX_ALL) }) else {
            crate::log::line("network: list manager unavailable");
            return;
        };
        let first = read(&manager);
        let mut gate = Debounce::new(first.as_ref().is_some_and(|n| n.online));
        let mut name = first.map(|n| n.name).unwrap_or_default();
        let mut last = std::time::Instant::now();
        let mut grace = 0u32;
        loop {
            std::thread::sleep(EVERY);
            if last.elapsed() > SLEPT {
                grace = WAKE_GRACE;
            }
            last = std::time::Instant::now();
            let Some(now) = read(&manager) else { continue };
            if !now.name.is_empty() {
                name = now.name.clone();
            }
            if grace > 0 {
                grace -= 1;
                if !now.online {
                    continue;
                }
                grace = 0;
            }
            let flipped = gate.feed(now.online);
            if let (Some(online), true) = (flipped, ENABLED.load(Ordering::Relaxed)) {
                let _ = app.emit_to(WINDOW_LABEL, "network", Network { online, name: name.clone() });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_missed_probe_is_not_an_outage() {
        let mut d = Debounce::new(true);
        assert_eq!(d.feed(false), None);
        assert_eq!(d.feed(true), None);
        assert_eq!(d.feed(false), None);
        assert_eq!(d.feed(false), None);
        assert_eq!(d.feed(false), Some(false));
        assert_eq!(d.feed(false), None);
        assert_eq!(d.feed(true), Some(true));
        assert_eq!(d.feed(true), None);
    }

    #[test]
    fn starting_offline_is_not_announced_as_a_reconnection() {
        let mut d = Debounce::new(false);
        for _ in 0..6 {
            assert_eq!(d.feed(false), None);
        }
        assert_eq!(d.feed(true), None);
        assert_eq!(d.feed(false), None);
        assert_eq!(d.feed(false), None);
        assert_eq!(d.feed(false), Some(false));
        assert_eq!(d.feed(true), Some(true));
    }

    #[test]
    fn coming_back_online_is_only_told_after_a_told_outage() {
        let mut d = Debounce::new(true);
        assert_eq!(d.feed(true), None);
        assert_eq!(d.feed(false), None);
        assert_eq!(d.feed(true), None);
    }
}
