use std::time::{Duration, Instant};

use windows::Win32::Media::Audio::{
    eCapture, eConsole, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};

pub const RATE: usize = 16_000;
pub const FRAME: usize = RATE / 50;
const PRE_ROLL: usize = RATE * 3 / 10;
const WAIT_FRAMES: u32 = 7 * 50;
const END_FRAMES: u32 = 45;
const MIN_SPEECH_FRAMES: u32 = 12;
const MAX_SPEECH_FRAMES: u32 = 14 * 50;
const START_FRAMES: u32 = 3;
const WAVE_FORMAT_PCM: u16 = 1;
const MAX_RECORDING: Duration = Duration::from_secs(25);
const NO_PACKETS: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Step {
    Waiting,
    Speaking,
    Done,
    Silent,
}

pub struct Detector {
    floor: f32,
    voiced_run: u32,
    quiet_run: u32,
    speech: u32,
    waited: u32,
    started: bool,
}

impl Default for Detector {
    fn default() -> Self {
        Detector { floor: 0.003, voiced_run: 0, quiet_run: 0, speech: 0, waited: 0, started: false }
    }
}

pub fn rms(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt()
}

impl Detector {
    pub fn started(&self) -> bool {
        self.started
    }

    pub fn push(&mut self, frame: &[f32]) -> Step {
        let level = rms(frame);
        let loud = level > (self.floor * 3.0).max(0.010);
        let quiet = level < (self.floor * 2.0).max(0.007);
        if !self.started {
            self.waited += 1;
            if loud {
                self.voiced_run += 1;
            } else {
                self.voiced_run = 0;
                self.floor = (self.floor * 0.95 + level * 0.05).clamp(0.0015, 0.05);
            }
            if self.voiced_run >= START_FRAMES {
                self.started = true;
                self.speech = self.voiced_run;
                self.quiet_run = 0;
                return Step::Speaking;
            }
            return if self.waited >= WAIT_FRAMES { Step::Silent } else { Step::Waiting };
        }
        self.speech += 1;
        if quiet {
            self.quiet_run += 1;
        } else {
            self.quiet_run = 0;
        }
        if self.quiet_run >= END_FRAMES {
            if self.speech - self.quiet_run < MIN_SPEECH_FRAMES {
                self.started = false;
                self.voiced_run = 0;
                self.quiet_run = 0;
                self.speech = 0;
                return if self.waited >= WAIT_FRAMES { Step::Silent } else { Step::Waiting };
            }
            return Step::Done;
        }
        if self.speech >= MAX_SPEECH_FRAMES {
            return Step::Done;
        }
        Step::Speaking
    }
}

pub fn to_mono_16k(data: &[f32], channels: usize, rate: usize) -> Vec<f32> {
    let channels = channels.max(1);
    let mono: Vec<f32> = data.chunks(channels).map(|c| c.iter().sum::<f32>() / c.len() as f32).collect();
    if rate == RATE || rate == 0 {
        return mono;
    }
    let ratio = rate as f64 / RATE as f64;
    let out_len = (mono.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = (i as f64 * ratio) as usize;
        let end = (((i + 1) as f64 * ratio) as usize).min(mono.len()).max(start + 1);
        let slice = &mono[start.min(mono.len() - 1)..end];
        out.push(slice.iter().sum::<f32>() / slice.len() as f32);
    }
    out
}

pub struct Recording {
    pub samples: Vec<f32>,
    pub heard: bool,
}

struct Source {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    channels: usize,
    rate: usize,
    float: bool,
    bits: u16,
}

fn pcm16(rate: u32) -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM,
        nChannels: 1,
        nSamplesPerSec: rate,
        nAvgBytesPerSec: rate * 2,
        nBlockAlign: 2,
        wBitsPerSample: 16,
        cbSize: 0,
    }
}

fn open() -> Result<Source, String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(|_| "microphone".to_string())?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
        let wanted = pcm16(RATE as u32);
        let flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        let source = if client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &wanted, None).is_ok() {
            Source { capture: client.GetService().map_err(|e| e.message())?, client, channels: 1, rate: RATE, float: false, bits: 16 }
        } else {
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
            let mix = client.GetMixFormat().map_err(|e| e.message())?;
            let format = std::ptr::read_unaligned(mix);
            let result = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 2_000_000, 0, mix, None);
            CoTaskMemFree(Some(mix as *const _));
            result.map_err(|e| e.message())?;
            let bits = format.wBitsPerSample;
            Source {
                capture: client.GetService().map_err(|e| e.message())?,
                client,
                channels: format.nChannels as usize,
                rate: format.nSamplesPerSec as usize,
                float: bits == 32,
                bits,
            }
        };
        Ok(source)
    }
}

impl Source {
    fn read(&self, out: &mut Vec<f32>) -> Result<(), String> {
        unsafe {
            loop {
                let packet = self.capture.GetNextPacketSize().map_err(|e| e.message())?;
                if packet == 0 {
                    return Ok(());
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None).map_err(|e| e.message())?;
                let count = frames as usize * self.channels;
                if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    out.extend(std::iter::repeat_n(0.0, count));
                } else if self.float {
                    out.extend_from_slice(std::slice::from_raw_parts(data as *const f32, count));
                } else if self.bits == 16 {
                    out.extend(std::slice::from_raw_parts(data as *const i16, count).iter().map(|s| *s as f32 / 32768.0));
                } else {
                    out.extend(std::iter::repeat_n(0.0, count));
                }
                self.capture.ReleaseBuffer(frames).map_err(|e| e.message())?;
            }
        }
    }
}

pub fn record(
    stop: impl Fn() -> bool,
    mut on_ready: impl FnMut(),
    mut on_level: impl FnMut(f32),
    mut on_speech: impl FnMut(&[f32]),
) -> Result<Recording, String> {
    let source = open()?;
    unsafe { source.client.Start().map_err(|e| e.message())? };
    on_ready();
    let mut raw = Vec::new();
    let mut audio: Vec<f32> = Vec::with_capacity(RATE * 16);
    let mut detector = Detector::default();
    let mut cursor = 0usize;
    let mut start_at = 0usize;
    let mut peak = 0.0f32;
    let mut meter = 0u32;
    let mut since_partial = 0u32;
    let started = Instant::now();
    let mut last_packet = Instant::now();
    let result = loop {
        if stop() {
            break Ok(Recording { samples: Vec::new(), heard: false });
        }
        if started.elapsed() > MAX_RECORDING {
            let heard = detector.started() && cursor > start_at;
            let samples = if heard { audio[start_at..cursor.min(audio.len())].to_vec() } else { Vec::new() };
            break Ok(Recording { samples, heard });
        }
        std::thread::sleep(Duration::from_millis(15));
        raw.clear();
        if let Err(err) = source.read(&mut raw) {
            break Err(err);
        }
        if raw.is_empty() {
            if last_packet.elapsed() > NO_PACKETS {
                break Err("no audio".to_string());
            }
            continue;
        }
        last_packet = Instant::now();
        let converted = if source.channels == 1 && source.rate == RATE { std::mem::take(&mut raw) } else { to_mono_16k(&raw, source.channels, source.rate) };
        audio.extend_from_slice(&converted);
        let mut finished = None;
        while cursor + FRAME <= audio.len() {
            let frame = &audio[cursor..cursor + FRAME];
            peak = peak.max(frame.iter().fold(0.0f32, |m, s| m.max(s.abs())));
            meter += 1;
            if meter >= 2 {
                on_level(peak);
                peak = 0.0;
                meter = 0;
            }
            let was = detector.started();
            let step = detector.push(frame);
            if !was && detector.started() {
                start_at = cursor.saturating_sub(PRE_ROLL + FRAME * START_FRAMES as usize);
                since_partial = 0;
            }
            cursor += FRAME;
            if detector.started() {
                since_partial += 1;
                if since_partial >= 60 {
                    since_partial = 0;
                    on_speech(&audio[start_at..cursor]);
                }
            }
            match step {
                Step::Done => {
                    finished = Some(true);
                    break;
                }
                Step::Silent => {
                    finished = Some(false);
                    break;
                }
                _ => {}
            }
        }
        if let Some(heard) = finished {
            let samples = if heard { audio[start_at..cursor.min(audio.len())].to_vec() } else { Vec::new() };
            break Ok(Recording { samples, heard });
        }
    };
    unsafe {
        let _ = source.client.Stop();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize, amp: f32) -> Vec<f32> {
        (0..frames * FRAME).map(|i| (i as f32 * 0.07).sin() * amp).collect()
    }

    fn run(detector: &mut Detector, audio: &[f32]) -> Vec<Step> {
        audio.chunks(FRAME).map(|f| detector.push(f)).collect()
    }

    #[test]
    fn speech_followed_by_silence_ends_the_recording() {
        let mut d = Detector::default();
        let mut audio = tone(20, 0.0005);
        audio.extend(tone(60, 0.2));
        audio.extend(tone(60, 0.0005));
        let steps = run(&mut d, &audio);
        assert!(steps.contains(&Step::Speaking));
        assert_eq!(steps.iter().position(|s| *s == Step::Done).map(|i| i >= 80 + END_FRAMES as usize - 1), Some(true));
    }

    #[test]
    fn nothing_said_gives_up_after_the_wait() {
        let mut d = Detector::default();
        let steps = run(&mut d, &tone(WAIT_FRAMES as usize + 5, 0.001));
        assert_eq!(steps.iter().position(|s| *s == Step::Silent), Some(WAIT_FRAMES as usize - 1));
    }

    #[test]
    fn a_click_is_not_speech() {
        let mut d = Detector::default();
        let mut audio = tone(10, 0.0005);
        audio.extend(tone(4, 0.3));
        audio.extend(tone(80, 0.0005));
        let steps = run(&mut d, &audio);
        assert!(!steps.contains(&Step::Done));
        assert!(!d.started());
    }

    #[test]
    fn long_speech_is_cut_at_the_limit() {
        let mut d = Detector::default();
        let steps = run(&mut d, &tone(MAX_SPEECH_FRAMES as usize + 20, 0.2));
        assert!(steps.contains(&Step::Done));
    }

    #[test]
    fn stereo_48k_becomes_mono_16k() {
        let stereo: Vec<f32> = (0..4800).flat_map(|i| [i as f32 / 4800.0, i as f32 / 4800.0]).collect();
        let out = to_mono_16k(&stereo, 2, 48_000);
        assert_eq!(out.len(), 1600);
        assert!((out[800] - 0.5).abs() < 0.01);
    }
}
