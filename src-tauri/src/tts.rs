use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::assets::{self, Asset};
use crate::{log, settings};

const NO_WINDOW: u32 = 0x0800_0000;
const TIMEOUT: Duration = Duration::from_secs(25);

const RUNTIME: Asset = Asset {
    file: "piper_windows_amd64.zip",
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
    size: 22_477_236,
};

const SIWIS: [Asset; 2] = [
    Asset {
        file: "fr_FR-siwis-medium.onnx",
        url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx",
        sha256: "641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99",
        size: 63_201_294,
    },
    Asset {
        file: "fr_FR-siwis-medium.onnx.json",
        url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json",
        sha256: "39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959",
        size: 4_875,
    },
];

const UPMC: [Asset; 2] = [
    Asset {
        file: "fr_FR-upmc-medium.onnx",
        url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx",
        sha256: "9abb3800c199148897a9ed64e100d224f3de83579f100044174ad19418f1786f",
        size: 76_733_615,
    },
    Asset {
        file: "fr_FR-upmc-medium.onnx.json",
        url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx.json",
        sha256: "e8636ec15dfd5d72db37a02cb5320a20f2b8d339f2a0e4337da64c58a33a5868",
        size: 4_996,
    },
];

struct Voice {
    id: &'static str,
    files: &'static [Asset; 2],
    speaker: u32,
}

const VOICES: &[Voice] = &[
    Voice { id: "siwis", files: &SIWIS, speaker: 0 },
    Voice { id: "pierre", files: &UPMC, speaker: 1 },
    Voice { id: "jessica", files: &UPMC, speaker: 0 },
];

static DOWNLOADING: Mutex<Option<String>> = Mutex::new(None);
static BUSY: AtomicBool = AtomicBool::new(false);
static RECEIVED: AtomicU64 = AtomicU64::new(0);
static TOTAL: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub ready: bool,
    pub downloading: bool,
    pub received: u64,
    pub total: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub voice: String,
    pub received: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

fn voice(id: &str) -> Option<&'static Voice> {
    VOICES.iter().find(|v| v.id == id)
}

fn root() -> PathBuf {
    settings::local_dir().join("piper")
}

fn exe() -> PathBuf {
    root().join("piper").join("piper.exe")
}

fn voices_dir() -> PathBuf {
    root().join("voices")
}

pub fn ready(id: &str) -> bool {
    let Some(v) = voice(id) else { return false };
    exe().is_file() && v.files.iter().all(|a| a.present(&voices_dir()))
}

fn missing_bytes(v: &Voice) -> u64 {
    let runtime = if exe().is_file() { 0 } else { RUNTIME.size };
    runtime + v.files.iter().filter(|a| !a.present(&voices_dir())).map(|a| a.size).sum::<u64>()
}

pub fn status(id: &str) -> Status {
    let downloading = DOWNLOADING.lock().unwrap().as_deref() == Some(id);
    let total = voice(id).map(missing_bytes).unwrap_or(0);
    Status {
        ready: ready(id),
        downloading,
        received: if downloading { RECEIVED.load(Ordering::Relaxed) } else { 0 },
        total: if downloading { TOTAL.load(Ordering::Relaxed) } else { total },
    }
}

fn extract(zip: &PathBuf) -> Result<(), String> {
    let tar = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32").join("tar.exe");
    let status = Command::new(tar)
        .arg("-xf")
        .arg(zip)
        .arg("-C")
        .arg(root())
        .creation_flags(NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(zip);
    if status.success() && exe().is_file() {
        Ok(())
    } else {
        Err("extract".into())
    }
}

async fn fetch_voice(app: &AppHandle, v: &'static Voice) -> Result<(), String> {
    let total = missing_bytes(v);
    TOTAL.store(total, Ordering::Relaxed);
    RECEIVED.store(0, Ordering::Relaxed);
    let told = AtomicU64::new(0);
    let report = |received: u64| {
        RECEIVED.store(received, Ordering::Relaxed);
        if received.saturating_sub(told.load(Ordering::Relaxed)) >= (total / 100).max(1) {
            told.store(received, Ordering::Relaxed);
            let _ = app.emit("tts-progress", Progress { voice: v.id.into(), received, total, done: false, error: None });
        }
    };
    let mut base = 0u64;
    if !exe().is_file() {
        assets::fetch(&RUNTIME, &root(), |done| report(base + done)).await?;
        extract(&root().join(RUNTIME.file))?;
        base += RUNTIME.size;
    }
    for asset in v.files.iter() {
        if asset.present(&voices_dir()) {
            continue;
        }
        assets::fetch(asset, &voices_dir(), |done| report(base + done)).await?;
        base += asset.size;
    }
    if ready(v.id) {
        Ok(())
    } else {
        Err("corrupt".into())
    }
}

pub fn start_download(app: AppHandle, id: &str) {
    let Some(v) = voice(id) else { return };
    if ready(id) {
        return;
    }
    {
        let mut current = DOWNLOADING.lock().unwrap();
        if current.is_some() {
            return;
        }
        *current = Some(id.to_string());
    }
    tauri::async_runtime::spawn(async move {
        log::line(format!("voice: downloading the {} voice", v.id));
        let result = fetch_voice(&app, v).await;
        *DOWNLOADING.lock().unwrap() = None;
        match &result {
            Ok(()) => log::line(format!("voice: {} voice ready", v.id)),
            Err(err) => log::line(format!("voice: {} voice download failed ({err})", v.id)),
        }
        let _ = app.emit("tts-progress", Progress { voice: v.id.into(), received: RECEIVED.load(Ordering::Relaxed), total: TOTAL.load(Ordering::Relaxed), done: true, error: result.err() });
    });
}

pub fn synthesize(id: &str, text: &str) -> Result<Vec<u8>, String> {
    let v = voice(id).ok_or("voice")?;
    if !ready(id) {
        return Err("voice".into());
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let result = run(v, text);
    BUSY.store(false, Ordering::SeqCst);
    result
}

fn run(v: &Voice, text: &str) -> Result<Vec<u8>, String> {
    let line = text.replace(['\r', '\n'], " ");
    let out = root().join(format!("speech-{}.wav", std::process::id()));
    let _ = std::fs::remove_file(&out);
    let mut child = Command::new(exe())
        .arg("--model")
        .arg(voices_dir().join(v.files[0].file))
        .arg("--speaker")
        .arg(v.speaker.to_string())
        .arg("--output_file")
        .arg(&out)
        .arg("--quiet")
        .current_dir(exe().parent().unwrap_or(&root()))
        .creation_flags(NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    }
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = std::fs::remove_file(&out);
            return Err("timeout".into());
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    let bytes = std::fs::read(&out).unwrap_or_default();
    let _ = std::fs::remove_file(&out);
    if !status.success() || !valid_wav(&bytes) {
        return Err("piper".into());
    }
    Ok(bytes)
}

pub fn valid_wav(bytes: &[u8]) -> bool {
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return false;
    }
    let declared = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    declared + 8 == bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_voice_has_its_model_and_config() {
        for v in VOICES {
            assert!(v.files[0].file.ends_with(".onnx"));
            assert_eq!(v.files[1].file, format!("{}.json", v.files[0].file));
            assert_eq!(v.files[0].sha256.len(), 64);
        }
        assert!(voice("windows").is_none());
    }

    #[test]
    fn wav_files_must_match_their_header() {
        let mut wav = b"RIFF".to_vec();
        wav.extend(40u32.to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.resize(48, 0);
        assert!(valid_wav(&wav));
        let mut stretched = wav.clone();
        stretched.insert(30, b'\r');
        assert!(!valid_wav(&stretched));
        assert!(!valid_wav(b"RIFF"));
    }

    #[test]
    #[ignore]
    fn live_piper_round_trips_through_whisper() {
        let wav = synthesize("siwis", "Bonjour, je suis Tako, ton assistant. Il est onze heures.").expect("piper");
        let mut i = 12;
        let mut samples = Vec::new();
        while i + 8 <= wav.len() {
            let size = u32::from_le_bytes([wav[i + 4], wav[i + 5], wav[i + 6], wav[i + 7]]) as usize;
            if &wav[i..i + 4] == b"data" {
                samples = wav[i + 8..(i + 8 + size).min(wav.len())].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
                break;
            }
            i += 8 + size + (size & 1);
        }
        let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        let audio = crate::mic::to_mono_16k(&samples, 1, 22_050);
        let text = crate::stt::transcribe(&audio, Some("fr")).expect("whisper");
        println!("peak {peak:.2} -> {text}");
        assert!(text.to_lowercase().contains("tako") || text.to_lowercase().contains("bonjour"));
    }
}
