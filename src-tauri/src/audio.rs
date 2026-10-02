use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

use crate::island::WINDOW_LABEL;

const VOLUME_EVERY: Duration = Duration::from_millis(120);
const METER_EVERY: Duration = Duration::from_millis(40);
const REFRESH: Duration = Duration::from_secs(3);

static HUD: AtomicBool = AtomicBool::new(true);
static METER: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub level: u8,
    pub muted: bool,
}

struct Endpoint {
    id: String,
    volume: IAudioEndpointVolume,
    meter: Option<IAudioMeterInformation>,
}

pub fn set_hud(on: bool) {
    HUD.store(on, Ordering::Relaxed);
}

pub fn set_meter(on: bool) {
    METER.store(on, Ordering::Relaxed);
}

pub fn percent(scalar: f32) -> u8 {
    (scalar * 100.0).round().clamp(0.0, 100.0) as u8
}

fn endpoint() -> Option<Endpoint> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let id = device
            .GetId()
            .ok()
            .map(|raw| {
                let text = raw.to_string().unwrap_or_default();
                windows::Win32::System::Com::CoTaskMemFree(Some(raw.0 as *const _));
                text
            })
            .unwrap_or_default();
        let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).ok()?;
        let meter = device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok();
        Some(Endpoint { id, volume, meter })
    }
}

fn read(e: &Endpoint) -> Option<Volume> {
    unsafe {
        let level = e.volume.GetMasterVolumeLevelScalar().ok()?;
        let muted = e.volume.GetMute().ok()?.as_bool();
        Some(Volume { level: percent(level), muted })
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let mut current: Option<Endpoint> = None;
        let mut refreshed: Option<Instant> = None;
        let mut last: Option<Volume> = None;
        loop {
            let metering = METER.load(Ordering::Relaxed);
            std::thread::sleep(if metering { METER_EVERY } else { VOLUME_EVERY });
            let hud = HUD.load(Ordering::Relaxed);
            if !hud && !metering {
                last = None;
                continue;
            }
            if current.is_none() || refreshed.map(|t| t.elapsed() >= REFRESH).unwrap_or(true) {
                let before = current.as_ref().map(|e| e.id.clone());
                current = endpoint();
                refreshed = Some(Instant::now());
                if current.as_ref().map(|e| e.id.clone()) != before {
                    last = None;
                }
            }
            let Some(e) = current.as_ref() else { continue };
            let mut lost = false;
            if hud {
                match read(e) {
                    Some(v) => {
                        if last.is_some() && last != Some(v) {
                            let _ = app.emit_to(WINDOW_LABEL, "volume", v);
                        }
                        last = Some(v);
                    }
                    None => lost = true,
                }
            }
            if metering {
                if let Some(meter) = &e.meter {
                    if let Ok(peak) = unsafe { meter.GetPeakValue() } {
                        let _ = app.emit_to(WINDOW_LABEL, "audio-level", peak);
                    }
                }
            }
            if lost {
                current = None;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_volume_is_a_whole_percent() {
        assert_eq!(percent(0.0), 0);
        assert_eq!(percent(0.624), 62);
        assert_eq!(percent(1.0), 100);
        assert_eq!(percent(1.7), 100);
        assert_eq!(percent(-0.2), 0);
    }
}
