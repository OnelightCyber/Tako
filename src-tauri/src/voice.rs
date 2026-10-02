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
    SpeechContinuousRecognitionSession, SpeechRecognitionConfidence, SpeechRecognitionHypothesisGeneratedEventArgs,
    SpeechRecognitionListConstraint, SpeechRecognitionResultStatus, SpeechRecognizer,
};
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
use windows::Storage::Streams::DataReader;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{eCapture, eCommunications, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows_collections::IIterable;

use crate::island::WINDOW_LABEL;
use crate::log;

const WAKE: &[&str] = &["hé tako", "hey tako", "ok tako", "salut tako", "dis tako"];
const YES: &[&str] = &["tako oui", "oui tako", "tako autorise", "tako valide"];
const NO: &[&str] = &["tako non", "non tako", "tako refuse"];
const STOP: &[&str] = &["tako stop", "stop tako", "tako tais-toi", "tako silence"];
const TICKS_PER_SECOND: i64 = 10_000_000;
const MAX_SPEECH: usize = 600;

static ENABLED: AtomicBool = AtomicBool::new(false);
static LISTENING: AtomicBool = AtomicBool::new(false);
static STOPPING: AtomicBool = AtomicBool::new(false);
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
    send(Command::Listen);
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

fn dictate(app: &AppHandle) -> Final {
    let emitter = app.clone();
    let ready = app.clone();
    dictate_with(
        move |text| {
            let _ = emitter.emit_to(WINDOW_LABEL, "voice-partial", text);
        },
        move || {
            let _ = ready.emit_to(WINDOW_LABEL, "voice-ready", ());
        },
    )
}

fn dictate_with(on_partial: impl Fn(String) + Send + Sync + Clone + 'static, on_ready: impl FnOnce()) -> Final {
    let run = || -> windows::core::Result<Final> {
        let recognizer = SpeechRecognizer::Create(&language()?)?;
        let timeouts = recognizer.Timeouts()?;
        timeouts.SetInitialSilenceTimeout(ticks(6.0))?;
        timeouts.SetEndSilenceTimeout(ticks(1.1))?;
        timeouts.SetBabbleTimeout(ticks(20.0))?;
        let compiled = recognizer.CompileConstraintsAsync()?.get()?;
        if compiled.Status()? != SpeechRecognitionResultStatus::Success {
            return Ok(Final { text: String::new(), error: Some("dictation".into()) });
        }
        let partial = on_partial.clone();
        recognizer.HypothesisGenerated(&TypedEventHandler::new(
            move |_: Ref<SpeechRecognizer>, args: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    partial(args.Hypothesis()?.Text()?.to_string());
                }
                Ok(())
            },
        ))?;
        let pending = recognizer.RecognizeAsync()?;
        on_ready();
        let result = pending.get()?;
        let status = result.Status()?;
        let text = result.Text().map(|t| t.to_string()).unwrap_or_default();
        let error = match status {
            SpeechRecognitionResultStatus::Success => None,
            SpeechRecognitionResultStatus::UserCanceled => Some("canceled".to_string()),
            SpeechRecognitionResultStatus::TimeoutExceeded => Some("silence".to_string()),
            SpeechRecognitionResultStatus::AudioQualityFailure | SpeechRecognitionResultStatus::MicrophoneUnavailable => Some("microphone".to_string()),
            SpeechRecognitionResultStatus::NetworkFailure => Some("network".to_string()),
            other => Some(format!("{:?}", other)),
        };
        Ok(Final { text, error })
    };
    run().unwrap_or_else(|err| {
        let code = err.code().0 as u32;
        let error = if code == 0x8004_5509 { "privacy".to_string() } else { format!("{code:#010x} {}", err.message()) };
        Final { text: String::new(), error: Some(error) }
    })
}

fn meter() -> Option<IAudioMeterInformation> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications).ok()?;
        device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok()
    }
}

fn spawn_meter(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let Some(m) = meter() else { return };
        while LISTENING.load(Ordering::Relaxed) {
            if let Ok(peak) = unsafe { m.GetPeakValue() } {
                let _ = app.emit_to(WINDOW_LABEL, "voice-level", peak);
            }
            std::thread::sleep(Duration::from_millis(45));
        }
    });
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
        let cmd = match rx.recv_timeout(if current.is_none() && ENABLED.load(Ordering::Relaxed) { wait } else { Duration::from_secs(3600) }) {
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
                spawn_meter(app.clone());
                let heard = dictate(&app);
                LISTENING.store(false, Ordering::Relaxed);
                if let Some(error) = &heard.error {
                    log::line(format!("voice: dictation ended ({error})"));
                }
                let _ = app.emit_to(WINDOW_LABEL, "voice-final", heard);
            }
            None => {}
        }
    }
}

pub fn start(app: AppHandle) {
    let (tx, rx) = channel();
    let _ = TX.set(Mutex::new(tx.clone()));
    std::thread::spawn(move || run(app, rx, tx));
}

pub fn say(text: &str) -> Result<String, String> {
    let text: String = text.chars().take(MAX_SPEECH).collect();
    let synth = SpeechSynthesizer::new().map_err(|e| e.to_string())?;
    if let Ok(voices) = SpeechSynthesizer::AllVoices() {
        let wanted = language().ok().and_then(|l| l.LanguageTag().ok()).map(|t| t.to_string().to_lowercase()).unwrap_or_else(|| "fr-fr".into());
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
    Ok(format!("data:audio/wav;base64,{}", crate::claude::base64_for(&bytes)))
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
    fn live_dictation_reports_its_status() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let started = std::time::Instant::now();
        let heard = dictate_with(|text| println!("partial: {text}"), || println!("ready"));
        println!("after {:?}: text={:?} error={:?}", started.elapsed(), heard.text, heard.error);
    }

    #[test]
    #[ignore]
    fn live_speech_synthesis_returns_a_wav() {
        let started = std::time::Instant::now();
        let url = say("Bonjour, je suis Tako.").expect("synthesis");
        let first = started.elapsed();
        let again = std::time::Instant::now();
        let second = say("Il est vingt et une heures.").expect("synthesis");
        println!("first {:?}, second {:?}", first, again.elapsed());
        assert!(url.starts_with("data:audio/wav;base64,UklGR"));
        assert!(url.len() > 20_000 && second.len() > 20_000);
    }
}
