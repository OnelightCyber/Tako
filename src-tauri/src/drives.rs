use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::PCWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Storage::FileSystem::{
    BusTypeUsb, CreateFileW, GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Ioctl::{
    PropertyStandardQuery, StorageDeviceProperty, IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_DEVICE_DESCRIPTOR,
    STORAGE_PROPERTY_QUERY,
};
use windows::Win32::System::IO::DeviceIoControl;

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_millis(1500);
const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_FIXED: u32 = 3;
const DRIVE_CDROM: u32 = 5;

static ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub letter: String,
    pub label: String,
    pub total: u64,
    pub free: u64,
    pub kind: &'static str,
    pub present: bool,
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn letters(mask: u32) -> Vec<char> {
    (0..26u8).filter(|i| mask & (1 << i) != 0).map(|i| (b'A' + i) as char).collect()
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn on_usb_bus(letter: char) -> bool {
    let path = wide(&format!(r"\\.\{letter}:"));
    unsafe {
        let Ok(handle) = CreateFileW(
            PCWSTR(path.as_ptr()),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        ) else {
            return false;
        };
        let query = STORAGE_PROPERTY_QUERY { PropertyId: StorageDeviceProperty, QueryType: PropertyStandardQuery, AdditionalParameters: [0] };
        let mut buf = [0u8; 1024];
        let mut returned = 0u32;
        let ok = DeviceIoControl(
            handle,
            IOCTL_STORAGE_QUERY_PROPERTY,
            Some(&query as *const _ as *const _),
            std::mem::size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            Some(buf.as_mut_ptr() as *mut _),
            buf.len() as u32,
            Some(&mut returned),
            None,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok || (returned as usize) < std::mem::size_of::<STORAGE_DEVICE_DESCRIPTOR>() {
            return false;
        }
        let descriptor = std::ptr::read_unaligned(buf.as_ptr() as *const STORAGE_DEVICE_DESCRIPTOR);
        descriptor.BusType == BusTypeUsb
    }
}

fn kind_of(letter: char) -> Option<&'static str> {
    let root = wide(&format!("{letter}:\\"));
    match unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } {
        DRIVE_REMOVABLE => Some("usb"),
        DRIVE_CDROM => Some("disc"),
        DRIVE_FIXED if on_usb_bus(letter) => Some("usb"),
        _ => None,
    }
}

fn describe(letter: char, kind: &'static str) -> Drive {
    let root = wide(&format!("{letter}:\\"));
    let mut name = [0u16; 261];
    let label = if unsafe { GetVolumeInformationW(PCWSTR(root.as_ptr()), Some(&mut name), None, None, None, None) }.is_ok() {
        let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        String::from_utf16_lossy(&name[..end])
    } else {
        String::new()
    };
    let (mut free, mut total) = (0u64, 0u64);
    let _ = unsafe { GetDiskFreeSpaceExW(PCWSTR(root.as_ptr()), Some(&mut free), Some(&mut total), None) };
    Drive { letter: letter.to_string(), label, total, free, kind, present: true }
}

pub fn open(letter: &str) -> bool {
    let Some(c) = letter.chars().next().filter(|c| c.is_ascii_alphabetic() && letter.len() == 1) else { return false };
    let root = format!("{}:\\", c.to_ascii_uppercase());
    std::path::Path::new(&root).exists() && std::process::Command::new("explorer.exe").arg(root).spawn().is_ok()
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut known: HashMap<char, Option<&'static str>> =
            letters(unsafe { GetLogicalDrives() }).into_iter().map(|l| (l, None)).collect();
        loop {
            std::thread::sleep(EVERY);
            let now = letters(unsafe { GetLogicalDrives() });
            for letter in &now {
                if known.contains_key(letter) {
                    continue;
                }
                let kind = kind_of(*letter);
                known.insert(*letter, kind);
                if let (Some(kind), true) = (kind, ENABLED.load(Ordering::Relaxed)) {
                    let _ = app.emit_to(WINDOW_LABEL, "drive", describe(*letter, kind));
                }
            }
            let gone: Vec<char> = known.keys().copied().filter(|l| !now.contains(l)).collect();
            for letter in gone {
                if let Some(Some(kind)) = known.remove(&letter) {
                    if ENABLED.load(Ordering::Relaxed) {
                        let _ = app.emit_to(
                            WINDOW_LABEL,
                            "drive",
                            Drive { letter: letter.to_string(), label: String::new(), total: 0, free: 0, kind, present: false },
                        );
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_drive_mask_lists_letters() {
        assert_eq!(letters(0b101), vec!['A', 'C']);
        assert_eq!(letters(1 << 4 | 1 << 2), vec!['C', 'E']);
        assert!(letters(0).is_empty());
    }
}
