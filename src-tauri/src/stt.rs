use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::assets::{self, Asset};
use crate::{log, settings};

const MODEL_FILE: Asset = Asset {
    file: "ggml-small-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    size: 190_085_487,
};
const SIZE: u64 = MODEL_FILE.size;
const IDLE: Duration = Duration::from_secs(180);
const PROMPT: &str = "Tako, Claude, minuteur, JavaScript.";
const HALLUCINATIONS: &[&str] = &[
    "amara.org", "sous-titres", "sous-titrage", "merci d'avoir regardé", "abonnez-vous", "n'oubliez pas de vous abonner",
    "thanks for watching", "subtitles by",
];

struct Loaded {
    ctx: WhisperContext,
    used: Instant,
}

static MODEL: Mutex<Option<Loaded>> = Mutex::new(None);
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static RECEIVED: AtomicU64 = AtomicU64::new(0);
static HOOKS: std::sync::Once = std::sync::Once::new();

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub downloading: bool,
    pub received: u64,
    pub total: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub received: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

pub fn path() -> PathBuf {
    settings::local_dir().join("models").join(MODEL_FILE.file)
}

pub fn installed() -> bool {
    std::fs::metadata(path()).map(|m| m.len() == SIZE).unwrap_or(false)
}

pub fn status() -> Status {
    Status { installed: installed(), downloading: DOWNLOADING.load(Ordering::Relaxed), received: RECEIVED.load(Ordering::Relaxed), total: SIZE }
}

pub fn cpu_ok() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") && std::arch::is_x86_feature_detected!("f16c")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        true
    }
}

pub fn ensure_loaded() -> Result<(), String> {
    let mut guard = MODEL.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    if !cpu_ok() {
        return Err("cpu".into());
    }
    if !installed() {
        return Err("model".into());
    }
    HOOKS.call_once(whisper_rs::install_logging_hooks);
    let file = path();
    let ctx = WhisperContext::new_with_params(&file, WhisperContextParameters::default()).map_err(|e| {
        log::line(format!("voice: cannot load the speech model ({e})"));
        "model".to_string()
    })?;
    *guard = Some(Loaded { ctx, used: Instant::now() });
    Ok(())
}

pub fn unload_idle() {
    let mut guard = MODEL.lock().unwrap();
    if guard.as_ref().is_some_and(|m| m.used.elapsed() > IDLE) {
        *guard = None;
    }
}

pub fn whisper_language(tag: &str) -> Option<&'static str> {
    let code = tag.split(['-', '_']).next().unwrap_or("").to_lowercase();
    ["fr", "en", "de", "es", "it", "pt", "nl", "pl", "ru", "uk", "ja", "zh", "ko", "ar", "tr", "sv", "da", "no", "fi", "cs", "ro", "el", "hu"]
        .into_iter()
        .find(|c| *c == code)
}

pub fn audio_context(samples: usize) -> i32 {
    let seconds = samples as f32 / 16_000.0;
    (((seconds + 1.0) * 100.0) as i32).clamp(256, 1500)
}

pub fn clean(text: &str) -> String {
    let t = text.trim().trim_matches(|c: char| c == '"' || c == '«' || c == '»').trim().to_string();
    let lower = t.to_lowercase();
    if HALLUCINATIONS.iter().any(|h| lower.contains(h)) || t.chars().all(|c| !c.is_alphanumeric()) {
        return String::new();
    }
    t
}

pub fn transcribe(samples: &[f32], language: Option<&str>) -> Result<String, String> {
    ensure_loaded()?;
    let mut guard = MODEL.lock().unwrap();
    let loaded = guard.as_mut().ok_or("model")?;
    loaded.used = Instant::now();
    let mut state = loaded.ctx.create_state().map_err(|e| e.to_string())?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8) as i32;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(language.or(Some("auto")));
    params.set_n_threads(threads);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_single_segment(true);
    params.set_suppress_blank(true);
    params.set_initial_prompt(PROMPT);
    params.set_audio_ctx(audio_context(samples.len()));
    let mut padded;
    let audio = if samples.len() < 16_000 {
        padded = samples.to_vec();
        padded.resize(16_000, 0.0);
        &padded[..]
    } else {
        samples
    };
    state.full(params, audio).map_err(|e| e.to_string())?;
    let text: String = state.as_iter().map(|s| s.to_string()).collect();
    Ok(clean(&text))
}

fn emit(app: &AppHandle, progress: Progress) {
    let _ = app.emit("stt-progress", progress);
}

async fn fetch(app: &AppHandle) -> Result<(), String> {
    let dir = path().parent().map(|p| p.to_path_buf()).unwrap_or_else(settings::local_dir);
    RECEIVED.store(0, Ordering::Relaxed);
    let mut told = 0u64;
    assets::fetch(&MODEL_FILE, &dir, |received| {
        RECEIVED.store(received, Ordering::Relaxed);
        if received - told >= SIZE / 100 {
            told = received;
            emit(app, Progress { received, total: SIZE, done: false, error: None });
        }
    })
    .await
}

pub fn start_download(app: AppHandle) {
    if !cpu_ok() || installed() || DOWNLOADING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        log::line("voice: downloading the speech model");
        let result = fetch(&app).await;
        DOWNLOADING.store(false, Ordering::SeqCst);
        match &result {
            Ok(()) => log::line("voice: speech model ready"),
            Err(err) => log::line(format!("voice: speech model download failed ({err})")),
        }
        emit(&app, Progress { received: RECEIVED.load(Ordering::Relaxed), total: SIZE, done: true, error: result.err() });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_map_to_whisper_codes() {
        assert_eq!(whisper_language("fr-FR"), Some("fr"));
        assert_eq!(whisper_language("en-US"), Some("en"));
        assert_eq!(whisper_language("xx-YY"), None);
    }

    #[test]
    fn the_audio_window_follows_the_length() {
        assert_eq!(audio_context(16_000), 256);
        assert_eq!(audio_context(16_000 * 4), 500);
        assert_eq!(audio_context(16_000 * 40), 1500);
    }

    #[test]
    fn whisper_ghost_captions_are_dropped() {
        assert_eq!(clean(" Sous-titres réalisés par la communauté d'Amara.org"), "");
        assert_eq!(clean("Merci d'avoir regardé !"), "");
        assert_eq!(clean(" ... "), "");
        assert_eq!(clean(" Quelle heure est-il ? "), "Quelle heure est-il ?");
    }

    #[test]
    #[ignore]
    fn live_model_transcribes_french() {
        let bytes = std::fs::read(std::env::var("TAKO_WAV").expect("TAKO_WAV")).unwrap();
        let mut i = 12;
        let mut samples = Vec::new();
        while i + 8 <= bytes.len() {
            let size = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
            if &bytes[i..i + 4] == b"data" {
                let data = &bytes[i + 8..(i + 8 + size).min(bytes.len())];
                samples = data.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
                break;
            }
            i += 8 + size + (size & 1);
        }
        let started = Instant::now();
        let text = transcribe(&samples, Some("fr")).expect("transcribe");
        println!("{:?} -> {text}", started.elapsed());
        assert!(!text.is_empty());
    }
}
