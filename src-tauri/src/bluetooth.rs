use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{Ref, GUID, HSTRING, PCWSTR};
use windows::Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothDevice};
use windows::Devices::Enumeration::{DeviceInformation, DeviceWatcher};
use windows::Foundation::TypedEventHandler;
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW,
    SetupDiGetDevicePropertyW, DIGCF_ALLCLASSES, DIGCF_PRESENT, SP_DEVINFO_DATA,
};
use windows::Win32::Devices::Properties::DEVPROPTYPE;
use windows::Win32::Foundation::DEVPROPKEY;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::island::WINDOW_LABEL;
use crate::log;

const BATTERY_KEY: DEVPROPKEY = DEVPROPKEY { fmtid: GUID::from_u128(0x104ea319_6ee2_4701_bd47_8ddbf425bbe5), pid: 2 };
const REPEAT_WINDOW: Duration = Duration::from_secs(6);
const BATTERY_RETRIES: [u64; 3] = [3, 8, 20];

static ENABLED: AtomicBool = AtomicBool::new(true);
static SEEN: Mutex<Option<HashMap<String, (bool, Instant)>>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BtEvent {
    pub name: String,
    pub kind: String,
    pub connected: bool,
    pub battery: Option<u8>,
    pub address: String,
    pub test: bool,
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn kind_of(major: i32, minor: i32) -> &'static str {
    match major {
        4 => match minor {
            5 | 7 | 10 => "speaker",
            _ => "headphones",
        },
        2 => "phone",
        5 => match minor & 0x0f {
            1 | 2 => "gamepad",
            _ => "peripheral",
        },
        _ => "device",
    }
}

pub fn address_hex(address: u64) -> String {
    format!("{address:012X}")
}

pub fn matches_device(instance_id: &str, address: &str) -> bool {
    let id = instance_id.to_uppercase();
    !address.is_empty() && id.starts_with("BTHENUM\\") && id.contains(address)
}

pub fn battery_for(address: &str) -> Option<u8> {
    let enumerator = HSTRING::from("BTHENUM");
    unsafe {
        let set = SetupDiGetClassDevsW(None, PCWSTR(enumerator.as_ptr()), None, DIGCF_PRESENT | DIGCF_ALLCLASSES).ok()?;
        let mut found = None;
        let mut index = 0u32;
        loop {
            let mut data = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
            if SetupDiEnumDeviceInfo(set, index, &mut data).is_err() {
                break;
            }
            index += 1;
            let mut id = [0u16; 512];
            if SetupDiGetDeviceInstanceIdW(set, &data, Some(&mut id), None).is_err() {
                continue;
            }
            let end = id.iter().position(|c| *c == 0).unwrap_or(id.len());
            if !matches_device(&String::from_utf16_lossy(&id[..end]), address) {
                continue;
            }
            let mut kind = DEVPROPTYPE::default();
            let mut value = [0u8; 4];
            let mut size = 0u32;
            if SetupDiGetDevicePropertyW(set, &data, &BATTERY_KEY, &mut kind, Some(&mut value), Some(&mut size), 0).is_ok() && size >= 1 {
                found = Some(value[0].min(100));
                break;
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
        found
    }
}

fn describe(device: &BluetoothDevice) -> BtEvent {
    let connected = device.ConnectionStatus().map(|s| s == BluetoothConnectionStatus::Connected).unwrap_or(false);
    let name = device.Name().map(|n| n.to_string()).unwrap_or_default();
    let (major, minor) = device
        .ClassOfDevice()
        .and_then(|c| Ok((c.MajorClass()?.0, c.MinorClass()?.0)))
        .unwrap_or((0, 0));
    let address = device.BluetoothAddress().map(address_hex).unwrap_or_default();
    BtEvent { name, kind: kind_of(major, minor).to_string(), connected, battery: None, address, test: false }
}

fn fresh(event: &BtEvent) -> bool {
    let mut guard = SEEN.lock().unwrap();
    let seen = guard.get_or_insert_with(HashMap::new);
    let repeat = seen
        .get(&event.address)
        .map(|(connected, at)| *connected == event.connected && at.elapsed() < REPEAT_WINDOW)
        .unwrap_or(false);
    seen.insert(event.address.clone(), (event.connected, Instant::now()));
    !repeat
}

fn on_change(app: &AppHandle, device: &BluetoothDevice) {
    let mut event = describe(device);
    if !fresh(&event) || !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    if event.connected {
        event.battery = battery_for(&event.address);
    }
    log::line(format!("bluetooth {} {}", event.name, if event.connected { "connected" } else { "disconnected" }));
    let _ = app.emit_to(WINDOW_LABEL, "bluetooth", event.clone());
    if event.connected && event.battery.is_none() {
        let app = app.clone();
        std::thread::spawn(move || {
            for wait in BATTERY_RETRIES {
                std::thread::sleep(Duration::from_secs(wait));
                if let Some(level) = battery_for(&event.address) {
                    event.battery = Some(level);
                    let _ = app.emit_to(WINDOW_LABEL, "bluetooth-battery", event);
                    return;
                }
            }
        });
    }
}

pub fn test(app: &AppHandle) {
    let event = BtEvent {
        name: "Casque Bluetooth".into(),
        kind: "headphones".into(),
        connected: true,
        battery: Some(76),
        address: "TEST".into(),
        test: true,
    };
    let _ = app.emit_to(WINDOW_LABEL, "bluetooth", event);
}

fn track(app: &AppHandle, known: &mut HashMap<String, (BluetoothDevice, i64)>, id: &HSTRING) {
    let key = id.to_string();
    if known.contains_key(&key) {
        return;
    }
    let Ok(device) = BluetoothDevice::FromIdAsync(id).and_then(|op| op.get()) else { return };
    let initial = describe(&device);
    SEEN.lock().unwrap().get_or_insert_with(HashMap::new).insert(initial.address.clone(), (initial.connected, Instant::now() - REPEAT_WINDOW));
    let handler_app = app.clone();
    let token = device.ConnectionStatusChanged(&TypedEventHandler::new(
        move |sender: Ref<'_, BluetoothDevice>, _args: Ref<'_, windows::core::IInspectable>| {
            if let Ok(device) = sender.ok() {
                on_change(&handler_app, device);
            }
            Ok(())
        },
    ));
    if let Ok(token) = token {
        known.insert(key, (device, token));
    }
}

fn run(app: AppHandle) -> windows::core::Result<()> {
    let selector = BluetoothDevice::GetDeviceSelectorFromPairingState(true)?;
    let (tx, rx) = mpsc::channel::<HSTRING>();
    let watcher: DeviceWatcher = DeviceInformation::CreateWatcherAqsFilter(&selector)?;
    let added = tx.clone();
    watcher.Added(&TypedEventHandler::new(
        move |_sender: Ref<'_, DeviceWatcher>, info: Ref<'_, DeviceInformation>| {
            if let Ok(info) = info.ok() {
                if let Ok(id) = info.Id() {
                    let _ = added.send(id);
                }
            }
            Ok(())
        },
    ))?;
    watcher.Start()?;
    let mut known: HashMap<String, (BluetoothDevice, i64)> = HashMap::new();
    for id in rx {
        track(&app, &mut known, &id);
    }
    drop(watcher);
    Ok(())
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        if let Err(err) = run(app) {
            log::line(format!("bluetooth watch stopped: {err}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_classes_become_kinds() {
        assert_eq!(kind_of(4, 6), "headphones");
        assert_eq!(kind_of(4, 1), "headphones");
        assert_eq!(kind_of(4, 5), "speaker");
        assert_eq!(kind_of(2, 3), "phone");
        assert_eq!(kind_of(5, 2), "gamepad");
        assert_eq!(kind_of(5, 0x10), "peripheral");
        assert_eq!(kind_of(1, 0), "device");
    }

    #[test]
    fn the_battery_lives_on_the_device_with_the_same_address() {
        let address = address_hex(0xa0b1_c2d3_e4f5);
        assert_eq!(address, "A0B1C2D3E4F5");
        assert!(matches_device(r"BTHENUM\{0000111e-0000-1000-8000-00805f9b34fb}_LOCALMFG&0002\7&2b5c&0&a0b1c2d3e4f5_C00000000", &address));
        assert!(!matches_device(r"BTHLE\DEV_A0B1C2D3E4F5\7&1", &address));
        assert!(!matches_device(r"BTHENUM\{x}\7&0&FFFFFFFFFFFF_C0", &address));
        assert!(!matches_device(r"BTHENUM\{x}\7&0&A0B1C2D3E4F5_C0", ""));
    }

    #[test]
    #[ignore]
    fn list_paired_devices() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let selector = BluetoothDevice::GetDeviceSelectorFromPairingState(true).unwrap();
        let found = DeviceInformation::FindAllAsyncAqsFilter(&selector).unwrap().get().unwrap();
        for i in 0..found.Size().unwrap() {
            let info = found.GetAt(i).unwrap();
            let device = BluetoothDevice::FromIdAsync(&info.Id().unwrap()).unwrap().get().unwrap();
            let e = describe(&device);
            println!("{} kind={} connected={} battery={:?}", e.name, e.kind, e.connected, battery_for(&e.address));
        }
    }
}
