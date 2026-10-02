use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::island::WINDOW_LABEL;

const EVERY: Duration = Duration::from_millis(1000);
const MAX_ART: u32 = 1024 * 1024;
const TICKS_PER_MS: i64 = 10_000;

static ENABLED: AtomicBool = AtomicBool::new(true);

#[derive(Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub active: bool,
    pub title: String,
    pub artist: String,
    pub app: String,
    pub playing: bool,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub at_ms: i64,
    pub art: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn app_name(id: &str) -> String {
    let base = id.rsplit(['\\', '/']).next().unwrap_or(id);
    let base = base.split('!').next().unwrap_or(base);
    let base = base.trim_end_matches(".exe").trim_end_matches(".EXE");
    let lower = base.to_lowercase();
    for (key, name) in [
        ("spotify", "Spotify"),
        ("chrome", "Chrome"),
        ("msedge", "Edge"),
        ("firefox", "Firefox"),
        ("opera", "Opera"),
        ("brave", "Brave"),
        ("zunemusic", "Media Player"),
        ("deezer", "Deezer"),
        ("applemusic", "Apple Music"),
        ("vlc", "VLC"),
        ("discord", "Discord"),
    ] {
        if lower.contains(key) {
            return name.to_string();
        }
    }
    base.split('.').next_back().unwrap_or(base).to_string()
}

fn manager() -> windows::core::Result<SessionManager> {
    SessionManager::RequestAsync()?.get()
}

fn art_of(session: &Session) -> Option<String> {
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > MAX_ART {
        return None;
    }
    let kind = stream.ContentType().map(|s| s.to_string()).unwrap_or_default();
    let kind = if kind.starts_with("image/") { kind } else { "image/png".to_string() };
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    Some(format!("data:{kind};base64,{}", crate::claude::base64_for(&bytes)))
}

fn read(manager: &SessionManager, art_key: &mut String, art: &mut Option<String>) -> Track {
    let Ok(session) = manager.GetCurrentSession() else { return Track::default() };
    let Ok(props) = session.TryGetMediaPropertiesAsync().and_then(|op| op.get()) else { return Track::default() };
    let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
    if title.is_empty() {
        return Track::default();
    }
    let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
    let playing = session
        .GetPlaybackInfo()
        .and_then(|i| i.PlaybackStatus())
        .map(|s| s == Status::Playing)
        .unwrap_or(false);
    let (mut position_ms, mut duration_ms, mut at_ms) = (0, 0, now_ms());
    if let Ok(timeline) = session.GetTimelineProperties() {
        position_ms = timeline.Position().map(|t| t.Duration / TICKS_PER_MS).unwrap_or(0);
        duration_ms = timeline.EndTime().map(|t| t.Duration / TICKS_PER_MS).unwrap_or(0);
        if let Ok(updated) = timeline.LastUpdatedTime() {
            let unix = updated.UniversalTime / TICKS_PER_MS - 11_644_473_600_000;
            if unix > 0 && unix <= now_ms() {
                at_ms = unix;
            }
        }
    }
    let app = session.SourceAppUserModelId().map(|s| app_name(&s.to_string())).unwrap_or_default();
    let key = format!("{title}\u{1}{artist}\u{1}{app}");
    if *art_key != key {
        *art_key = key;
        *art = art_of(&session);
    }
    Track { active: true, title, artist, app, playing, position_ms, duration_ms, at_ms, art: art.clone() }
}

fn changed(a: &Track, b: &Track) -> bool {
    if a.active != b.active || a.title != b.title || a.artist != b.artist || a.playing != b.playing
        || a.duration_ms != b.duration_ms || a.art != b.art
    {
        return true;
    }
    let expected = if a.playing { a.position_ms + (b.at_ms - a.at_ms) } else { a.position_ms };
    (b.position_ms - expected).abs() > 2500
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn start(app: AppHandle, gate: Arc<crate::island::PollGate>) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let mut last = Track::default();
        let mut art_key = String::new();
        let mut art = None;
        let mut current = None;
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(EVERY);
            tick = tick.wrapping_add(1);
            if gate.collapsed.load(Ordering::Relaxed) && tick % 2 == 0 {
                continue;
            }
            if !ENABLED.load(Ordering::Relaxed) {
                if last.active {
                    last = Track::default();
                    let _ = app.emit_to(WINDOW_LABEL, "media", &last);
                }
                continue;
            }
            if current.is_none() {
                current = manager().ok();
            }
            let Some(m) = current.as_ref() else { continue };
            let track = read(m, &mut art_key, &mut art);
            if changed(&last, &track) {
                let _ = app.emit_to(WINDOW_LABEL, "media", &track);
            }
            last = track;
        }
    });
}

pub fn control(action: &str) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let manager = manager().map_err(|e| e.to_string())?;
    let session = manager.GetCurrentSession().map_err(|_| "Nothing is playing.".to_string())?;
    let op = match action {
        "toggle" => session.TryTogglePlayPauseAsync(),
        "next" => session.TrySkipNextAsync(),
        "previous" => session.TrySkipPreviousAsync(),
        _ => return Err("Unknown action.".into()),
    };
    op.and_then(|o| o.get()).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_ids_become_short_names() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(app_name("MSEdge"), "Edge");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
    }

    #[test]
    fn small_position_drift_is_not_a_change() {
        let a = Track { active: true, title: "x".into(), playing: true, position_ms: 1000, at_ms: 0, ..Default::default() };
        let mut b = a.clone();
        b.at_ms = 1000;
        b.position_ms = 2000;
        assert!(!changed(&a, &b));
        b.position_ms = 9000;
        assert!(changed(&a, &b));
    }
}
