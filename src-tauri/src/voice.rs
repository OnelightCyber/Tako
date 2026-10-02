use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{Ref, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Globalization::Language;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
    SpeechContinuousRecognitionSession, SpeechRecognitionConfidence, SpeechRecognitionListConstraint,
    SpeechRecognitionResultStatus, SpeechRecognizer,
};
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
use windows::Storage::Streams::DataReader;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows_collections::IIterable;

use crate::island::WINDOW_LABEL;
use crate::{log, mic, stt, tts};

const WAKE: &[&str] = &["hé tako", "hey tako", "ok tako", "salut tako", "dis tako"];
const YES: &[&str] = &["tako oui", "oui tako", "tako autorise", "tako valide"];
const NO: &[&str] = &["tako non", "non tako", "tako refuse"];
const STOP: &[&str] = &["tako stop", "stop tako", "tako tais-toi", "tako silence"];
const TICKS_PER_SECOND: i64 = 10_000_000;
const MAX_SPEECH: usize = 600;

static ENABLED: AtomicBool = AtomicBool::new(false);
static LISTENING: AtomicBool = AtomicBool::new(false);
static STOPPING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static TX: OnceLock<Mutex<Sender<Command>>> = OnceLock::new();

enum Command {
    Enable(bool),
    Listen,
    Restart,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Heard {
    pub kind: &'static str,
    pub text: String,
    pub sure: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Final {
    pub text: String,
    pub error: Option<String>,
}

impl Final {
    fn failed(error: &str) -> Final {
        Final { text: String::new(), error: Some(error.to_string()) }
    }
}

fn send(cmd: Command) {
    if let Some(tx) = TX.get() {
        let _ = tx.lock().unwrap().send(cmd);
    }
}

pub fn set_enabled(on: bool) {
    if ENABLED.swap(on, Ordering::Relaxed) != on {
        send(Command::Enable(on));
    }
}

pub fn listen() {
    CANCEL.store(false, Ordering::Relaxed);
    send(Command::Listen);
}

pub fn cancel() {
    if LISTENING.load(Ordering::Relaxed) {
        CANCEL.store(true, Ordering::Relaxed);
    }
}

pub fn kind_of(tag: &str) -> &'static str {
    match tag {
        "yes" => "yes",
        "no" => "no",
        "stop" => "stop",
        _ => "wake",
    }
}

fn language() -> windows::core::Result<Language> {
    match SpeechRecognizer::SystemSpeechLanguage() {
        Ok(lang) => Ok(lang),
        Err(_) => Language::CreateLanguage(&HSTRING::from("fr-FR")),
    }
}

fn language_tag() -> String {
    language().and_then(|l| l.LanguageTag()).map(|t| t.to_string()).unwrap_or_else(|_| "fr-FR".into())
}

fn phrases(words: &[&str]) -> IIterable<HSTRING> {
    words.iter().map(|w| HSTRING::from(*w)).collect::<Vec<_>>().into()
}

fn ticks(seconds: f64) -> TimeSpan {
    TimeSpan { Duration: (seconds * TICKS_PER_SECOND as f64) as i64 }
}

struct Wake {
    recognizer: SpeechRecognizer,
    session: SpeechContinuousRecognitionSession,
}

fn wake(app: &AppHandle, tx: Sender<Command>) -> windows::core::Result<Wake> {
    let recognizer = SpeechRecognizer::Create(&language()?)?;
    let constraints = recognizer.Constraints()?;
    for (tag, words) in [("wake", WAKE), ("yes", YES), ("no", NO), ("stop", STOP)] {
        constraints.Append(&SpeechRecognitionListConstraint::CreateWithTag(&phrases(words), &HSTRING::from(tag))?)?;
    }
    let compiled = recognizer.CompileConstraintsAsync()?.get()?;
    if compiled.Status()? != SpeechRecognitionResultStatus::Success {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005u32 as i32)));
    }
    let session = recognizer.ContinuousRecognitionSession()?;
    session.SetAutoStopSilenceTimeout(ticks(24.0 * 3600.0))?;
    let emitter = app.clone();
    session.ResultGenerated(&TypedEventHandler::new(
        move |_: Ref<SpeechContinuousRecognitionSession>, args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
            if let Some(args) = args.as_ref() {
                let result = args.Result()?;
                let confidence = result.Confidence()?;
                if confidence == SpeechRecognitionConfidence::High || confidence == SpeechRecognitionConfidence::Medium {
                    let tag = result.Constraint().and_then(|c| c.Tag()).map(|t| t.to_string()).unwrap_or_default();
                    let text = result.Text().map(|t| t.to_string()).unwrap_or_default();
                    let sure = confidence == SpeechRecognitionConfidence::High;
                    let _ = emitter.emit_to(WINDOW_LABEL, "voice", Heard { kind: kind_of(&tag), text, sure });
                }
            }
            Ok(())
        },
    ))?;
    session.Completed(&TypedEventHandler::new(
        move |_: Ref<SpeechContinuousRecognitionSession>, _: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
            if ENABLED.load(Ordering::Relaxed) && !LISTENING.load(Ordering::Relaxed) && !STOPPING.load(Ordering::Relaxed) {
                let _ = tx.send(Command::Restart);
            }
            Ok(())
        },
    ))?;
    session.StartAsync()?.get()?;
    Ok(Wake { recognizer, session })
}

fn listen_once(app: &AppHandle) -> Final {
    if !stt::cpu_ok() {
        return Final::failed("cpu");
    }
    if !stt::installed() {
        stt::start_download(app.clone());
        return Final::failed("model");
    }
    std::thread::spawn(|| {
        let _ = stt::ensure_loaded();
    });
    let code = stt::whisper_language(&language_tag());
    let (tx, rx) = channel::<Vec<f32>>();
    let partial = app.clone();
    let worker = std::thread::spawn(move || {
        while let Ok(mut audio) = rx.recv() {
            while let Ok(newer) = rx.try_recv() {
                audio = newer;
            }
            if CANCEL.load(Ordering::Relaxed) {
                continue;
            }
            if let Ok(text) = stt::transcribe(&audio, code) {
                if !text.is_empty() {
                    let _ = partial.emit_to(WINDOW_LABEL, "voice-partial", text);
                }
            }
        }
    });
    let ready = app.clone();
    let level = app.clone();
    let recording = mic::record(
        &CANCEL,
        || {
            let _ = ready.emit_to(WINDOW_LABEL, "voice-ready", ());
        },
        |peak| {
            let _ = level.emit_to(WINDOW_LABEL, "voice-level", peak);
        },
        |audio| {
            let _ = tx.send(audio.to_vec());
        },
    );
    drop(tx);
    let _ = worker.join();
    if CANCEL.load(Ordering::Relaxed) {
        return Final::failed("canceled");
    }
    match recording {
        Err(err) => {
            log::line(format!("voice: microphone ({err})"));
            Final::failed("microphone")
        }
        Ok(r) if !r.heard => Final::failed("silence"),
        Ok(r) => {
            let _ = app.emit_to(WINDOW_LABEL, "voice-busy", ());
            match stt::transcribe(&r.samples, code) {
                Ok(text) if text.is_empty() => Final::failed("unclear"),
                Ok(text) => Final { text, error: None },
                Err(err) => Final::failed(&err),
            }
        }
    }
}

fn stop(current: &mut Option<Wake>) {
    if let Some(w) = current.take() {
        STOPPING.store(true, Ordering::Relaxed);
        let _ = w.session.StopAsync().and_then(|op| op.get());
        drop(w.recognizer);
        STOPPING.store(false, Ordering::Relaxed);
    }
}

fn run(app: AppHandle, rx: Receiver<Command>, tx: Sender<Command>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut current: Option<Wake> = None;
    let mut told = false;
    let mut last_error = String::new();
    let mut wait = Duration::from_secs(20);
    loop {
        if ENABLED.load(Ordering::Relaxed) && current.is_none() && !LISTENING.load(Ordering::Relaxed) {
            match wake(&app, tx.clone()) {
                Ok(w) => {
                    if !told {
                        told = true;
                        log::line("voice: listening for the wake word");
                    }
                    last_error.clear();
                    wait = Duration::from_secs(20);
                    current = Some(w);
                }
                Err(err) => {
                    let text = err.to_string();
                    if text != last_error {
                        log::line(format!("voice: cannot listen ({text})"));
                        last_error = text;
                    }
                    wait = (wait * 2).min(Duration::from_secs(300));
                }
            }
        }
        let timeout = if current.is_none() && ENABLED.load(Ordering::Relaxed) { wait } else { Duration::from_secs(60) };
        let cmd = match rx.recv_timeout(timeout) {
            Ok(cmd) => Some(cmd),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        match cmd {
            Some(Command::Enable(false)) => stop(&mut current),
            Some(Command::Enable(true)) => wait = Duration::from_secs(20),
            Some(Command::Restart) => stop(&mut current),
            Some(Command::Listen) => {
                stop(&mut current);
                LISTENING.store(true, Ordering::Relaxed);
                let heard = listen_once(&app);
                LISTENING.store(false, Ordering::Relaxed);
                CANCEL.store(false, Ordering::Relaxed);
                if let Some(error) = &heard.error {
                    if error != "silence" && error != "canceled" {
                        log::line(format!("voice: listening ended ({error})"));
                    }
                }
                let _ = app.emit_to(WINDOW_LABEL, "voice-final", heard);
            }
            None => stt::unload_idle(),
        }
    }
}

pub fn start(app: AppHandle) {
    let (tx, rx) = channel();
    let _ = TX.set(Mutex::new(tx.clone()));
    std::thread::spawn(move || run(app, rx, tx));
}

fn data_url(wav: &[u8]) -> String {
    format!("data:audio/wav;base64,{}", crate::claude::base64_for(wav))
}

pub fn say(text: &str, voice: &str) -> Result<String, String> {
    let text: String = text.chars().take(MAX_SPEECH).collect();
    if voice != "windows" {
        match tts::synthesize(voice, &text) {
            Ok(wav) => return Ok(data_url(&wav)),
            Err(err) if err != "voice" => log::line(format!("voice: natural voice failed ({err})")),
            Err(_) => {}
        }
    }
    windows_say(&text)
}

fn windows_say(text: &str) -> Result<String, String> {
    let synth = SpeechSynthesizer::new().map_err(|e| e.to_string())?;
    if let Ok(voices) = SpeechSynthesizer::AllVoices() {
        let wanted = language_tag().to_lowercase();
        let prefix = wanted.split('-').next().unwrap_or("fr").to_string();
        let mut chosen = None;
        for voice in voices {
            let lang = voice.Language().map(|l| l.to_string().to_lowercase()).unwrap_or_default();
            if lang == wanted {
                chosen = Some(voice);
                break;
            }
            if chosen.is_none() && lang.starts_with(&prefix) {
                chosen = Some(voice);
            }
        }
        if let Some(voice) = chosen {
            let _ = synth.SetVoice(&voice);
        }
    }
    let stream = synth.SynthesizeTextToStreamAsync(&HSTRING::from(text)).map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    let size = stream.Size().map_err(|e| e.to_string())? as u32;
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    reader.LoadAsync(size).map_err(|e| e.to_string())?.get().map_err(|e| e.to_string())?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).map_err(|e| e.to_string())?;
    Ok(data_url(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constraint_tags_map_to_kinds() {
        assert_eq!(kind_of("wake"), "wake");
        assert_eq!(kind_of("yes"), "yes");
        assert_eq!(kind_of("no"), "no");
        assert_eq!(kind_of("stop"), "stop");
        assert_eq!(kind_of(""), "wake");
    }

    #[test]
    #[ignore]
    fn live_speech_synthesis_returns_a_wav() {
        let started = std::time::Instant::now();
        let url = say("Bonjour, je suis Tako.", "windows").expect("synthesis");
        let first = started.elapsed();
        let again = std::time::Instant::now();
        let second = say("Il est vingt et une heures.", "windows").expect("synthesis");
        println!("first {:?}, second {:?}", first, again.elapsed());
        assert!(url.starts_with("data:audio/wav;base64,UklGR"));
        assert!(url.len() > 20_000 && second.len() > 20_000);
    }
}
