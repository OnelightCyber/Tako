use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, HANDLE, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, NotifyIpInterfaceChange, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
    GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH, MIB_IPINTERFACE_ROW, MIB_NOTIFICATION_TYPE,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::Networking::WinSock::AF_UNSPEC;

use crate::island::WINDOW_LABEL;
use crate::log;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SETTLE: Duration = Duration::from_millis(900);
const GRACE: Duration = Duration::from_secs(4);
const FALLBACK: Duration = Duration::from_secs(60);
const CLI_TIMEOUT: Duration = Duration::from_secs(3);

const VPN_WORDS: &[&str] = &[
    "mullvad", "wireguard", "wintun", "openvpn", "tap-windows", "nordlynx", "nordvpn", "protonvpn",
    "proton vpn", "surfshark", "expressvpn", "windscribe", "cyberghost", "private internet access",
];
const NOT_VPN_WORDS: &[&str] = &[
    "teredo", "isatap", "6to4", "ip-https", "loopback", "bluetooth", "hyper-v", "vethernet", "virtualbox",
    "vmware", "wsl", "tailscale", "zerotier",
];

static ENABLED: AtomicBool = AtomicBool::new(true);
static WAKE: OnceLock<Mutex<Sender<()>>> = OnceLock::new();
static STATUS: Mutex<VpnStatus> = Mutex::new(VpnStatus { present: false, up: false, name: String::new(), location: String::new() });

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VpnStatus {
    pub present: bool,
    pub up: bool,
    pub name: String,
    pub location: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VpnEvent {
    pub kind: String,
    pub name: String,
    pub location: String,
    pub test: bool,
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn status() -> VpnStatus {
    STATUS.lock().unwrap().clone()
}

pub fn is_vpn(name: &str, description: &str) -> bool {
    let text = format!("{name} {description}").to_lowercase();
    !NOT_VPN_WORDS.iter().any(|w| text.contains(w)) && VPN_WORDS.iter().any(|w| text.contains(w))
}

pub fn mullvad_state(text: &str) -> (String, String) {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default().to_lowercase();
    let state = if first.starts_with("connected") {
        "connected"
    } else if first.starts_with("connecting") || first.starts_with("reconnecting") {
        "connecting"
    } else if first.starts_with("disconnecting") {
        "disconnecting"
    } else if first.starts_with("disconnected") {
        "disconnected"
    } else if first.contains("block") || first.contains("error") {
        "blocked"
    } else {
        ""
    };
    let mut location = String::new();
    for line in text.lines() {
        if let Some((_, rest)) = line.split_once("Visible location:") {
            let cut = rest.split(". IPv").next().unwrap_or(rest);
            location = cut.trim().trim_end_matches('.').to_string();
        }
    }
    if location.is_empty() {
        if let Some((_, rest)) = text.lines().next().unwrap_or_default().split_once(" in ") {
            location = rest.trim().trim_end_matches('.').to_string();
        }
    }
    let location = location.split_whitespace().filter(|w| !w.contains(['.', ':']) || w.ends_with(',')).collect::<Vec<_>>().join(" ");
    (state.to_string(), location)
}

fn mullvad_cli() -> Option<PathBuf> {
    let base = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let path = base.join("Mullvad VPN").join("resources").join("mullvad.exe");
    if path.is_file() {
        return Some(path);
    }
    crate::find_on_path("mullvad")
}

fn ask_mullvad() -> Option<(String, String)> {
    let exe = mullvad_cli()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let output = Command::new(exe)
            .arg("status")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = tx.send(output);
    });
    let output = rx.recv_timeout(CLI_TIMEOUT).ok()?.ok()?;
    Some(mullvad_state(&String::from_utf8_lossy(&output.stdout)))
}

pub fn mullvad_app() -> Option<PathBuf> {
    let base = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let path = base.join("Mullvad VPN").join("Mullvad VPN.exe");
    path.is_file().then_some(path)
}

fn adapters() -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 32 * 1024;
    for _ in 0..4 {
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        let first = buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        let ret = unsafe { GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(first), &mut size) };
        if ret == ERROR_BUFFER_OVERFLOW.0 {
            continue;
        }
        if ret != NO_ERROR.0 {
            return out;
        }
        let mut p = first as *const IP_ADAPTER_ADDRESSES_LH;
        while !p.is_null() {
            let a = unsafe { &*p };
            let name = unsafe { a.FriendlyName.to_string() }.unwrap_or_default();
            let description = unsafe { a.Description.to_string() }.unwrap_or_default();
            out.push((name, description, a.OperStatus == IfOperStatusUp));
            p = a.Next;
        }
        return out;
    }
    out
}

fn snapshot() -> VpnStatus {
    let vpns: Vec<_> = adapters().into_iter().filter(|(n, d, _)| is_vpn(n, d)).collect();
    let up = vpns.iter().find(|(_, _, up)| *up);
    let name = up.or(vpns.first()).map(|(n, _, _)| n.clone()).unwrap_or_default();
    VpnStatus { present: !vpns.is_empty(), up: up.is_some(), name, location: String::new() }
}

unsafe extern "system" fn on_change(_ctx: *const core::ffi::c_void, _row: *const MIB_IPINTERFACE_ROW, _kind: MIB_NOTIFICATION_TYPE) {
    if let Some(tx) = WAKE.get() {
        let _ = tx.lock().unwrap().send(());
    }
}

fn emit(app: &AppHandle, kind: &str, status: &VpnStatus, test: bool) {
    let event = VpnEvent { kind: kind.to_string(), name: status.name.clone(), location: status.location.clone(), test };
    log::line(format!("vpn {kind} ({})", status.name));
    let _ = app.emit_to(WINDOW_LABEL, "vpn", event);
}

pub fn test(app: &AppHandle) {
    let mut status = status();
    if status.name.is_empty() {
        status.name = "Mullvad".into();
    }
    emit(app, "down", &status, true);
}

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    let _ = WAKE.set(Mutex::new(tx));
    std::thread::spawn(move || {
        let mut handle = HANDLE::default();
        let err = unsafe { NotifyIpInterfaceChange(AF_UNSPEC, Some(on_change), None, false, &mut handle) };
        if err != NO_ERROR {
            log::line(format!("vpn: no interface notifications ({})", err.0));
        }
        let mut current = snapshot();
        if current.up {
            if let Some((_, location)) = ask_mullvad() {
                current.location = location;
            }
        }
        *STATUS.lock().unwrap() = current.clone();
        loop {
            let _ = rx.recv_timeout(FALLBACK);
            std::thread::sleep(SETTLE);
            while rx.try_recv().is_ok() {}
            let mut seen = snapshot();
            if seen.up == current.up {
                seen.location = if seen.up { current.location.clone() } else { String::new() };
                if seen.present != current.present || seen.name != current.name {
                    current = seen;
                    *STATUS.lock().unwrap() = current.clone();
                }
                continue;
            }
            if current.up && !seen.up {
                std::thread::sleep(GRACE);
                while rx.try_recv().is_ok() {}
                let again = snapshot();
                if again.up {
                    continue;
                }
                let kind = match ask_mullvad().map(|(s, _)| s) {
                    Some(s) if s == "disconnected" || s == "disconnecting" => "off",
                    _ => "down",
                };
                let name = current.name.clone();
                current = again;
                if current.name.is_empty() {
                    current.name = name;
                }
                *STATUS.lock().unwrap() = current.clone();
                if ENABLED.load(Ordering::Relaxed) {
                    emit(&app, kind, &current, false);
                }
            } else {
                current = seen;
                if let Some((_, location)) = ask_mullvad() {
                    current.location = location;
                }
                *STATUS.lock().unwrap() = current.clone();
                if ENABLED.load(Ordering::Relaxed) {
                    emit(&app, "up", &current, false);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vpn_adapters_are_recognised_and_lookalikes_ignored() {
        assert!(is_vpn("Mullvad", "Mullvad Tunnel"));
        assert!(is_vpn("Ethernet 3", "WireGuard Tunnel"));
        assert!(is_vpn("NordLynx", ""));
        assert!(!is_vpn("Teredo Tunneling Pseudo-Interface", ""));
        assert!(!is_vpn("Tailscale", "Tailscale Tunnel"));
        assert!(!is_vpn("Wi-Fi", "Intel(R) Wi-Fi 6 AX201"));
    }

    #[test]
    fn mullvad_status_is_read_without_keeping_the_ip() {
        let text = "Connected\n    Relay:                  ch-zrh-wg-002\n    Features:               Quantum Resistance\n    Visible location:       Switzerland, Zurich. IPv4: 1.2.3.4\n";
        assert_eq!(mullvad_state(text), ("connected".to_string(), "Switzerland, Zurich".to_string()));
        assert_eq!(mullvad_state("Disconnected\n").0, "disconnected");
        assert_eq!(mullvad_state("Connecting to se-got-wg-001\n").0, "connecting");
        assert_eq!(mullvad_state("Blocked: the tunnel failed\n").0, "blocked");
        let old = mullvad_state("Connected to se-got-wg-001 in Gothenburg, Sweden\n");
        assert_eq!(old, ("connected".to_string(), "Gothenburg, Sweden".to_string()));
    }

    #[test]
    fn adapters_can_be_listed() {
        let list = adapters();
        assert!(!list.is_empty());
    }
}
