use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::log;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const EVERY: Duration = Duration::from_secs(4 * 60);
const FRESH_FOR: u64 = 60;
const KEEP_DAYS: u64 = 60;
const ALERTS: [u32; 2] = [80, 90];
const FORECAST_WINDOW: u64 = 90 * 60;
const FORECAST_MIN_SPAN: u64 = 8 * 60;

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageLine {
    pub label: String,
    pub percent: u32,
    pub resets: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub lines: Vec<UsageLine>,
    pub subscription: bool,
    pub fetched_at: u64,
    pub error: Option<String>,
    pub forecast_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub t: u64,
    pub session: Option<u32>,
    pub week: Option<u32>,
    #[serde(default)]
    pub session_resets: String,
    #[serde(default)]
    pub week_resets: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageAlert {
    pub kind: String,
    pub percent: u32,
    pub threshold: u32,
    pub resets: String,
    pub forecast_at: Option<u64>,
}

#[derive(Default)]
pub struct Usage {
    last: Mutex<Option<UsageReport>>,
    history: Mutex<Option<Vec<Sample>>>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn parse(text: &str) -> Vec<UsageLine> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        let Some((label, rest)) = line.split_once(':') else { continue };
        let Some(end) = rest.find("% used") else { continue };
        let Ok(percent) = rest[..end].trim().parse::<u32>() else { continue };
        let resets = rest
            .split_once("resets")
            .map(|(_, r)| r.trim().to_string())
            .unwrap_or_default();
        lines.push(UsageLine { label: label.trim().to_string(), percent: percent.min(100), resets });
    }
    lines
}

fn find_line<'a>(lines: &'a [UsageLine], key: &str) -> Option<&'a UsageLine> {
    lines.iter().find(|l| l.label.to_lowercase().contains(key))
}

pub fn sample_of(report: &UsageReport) -> Option<Sample> {
    let session = find_line(&report.lines, "session");
    let week = find_line(&report.lines, "all models");
    if session.is_none() && week.is_none() {
        return None;
    }
    Some(Sample {
        t: report.fetched_at,
        session: session.map(|l| l.percent),
        week: week.map(|l| l.percent),
        session_resets: session.map(|l| l.resets.clone()).unwrap_or_default(),
        week_resets: week.map(|l| l.resets.clone()).unwrap_or_default(),
    })
}

pub fn forecast(history: &[Sample], latest: &Sample) -> Option<u64> {
    let p = latest.session?;
    if p >= 100 {
        return None;
    }
    let first = history.iter().find(|s| {
        s.session.is_some()
            && s.session_resets == latest.session_resets
            && latest.t.saturating_sub(s.t) <= FORECAST_WINDOW
            && s.t < latest.t
    })?;
    let span = latest.t - first.t;
    let gained = p as f64 - first.session? as f64;
    if span < FORECAST_MIN_SPAN || gained <= 0.0 {
        return None;
    }
    let rate = gained / span as f64;
    Some(latest.t + ((100.0 - p as f64) / rate) as u64)
}

pub fn alerts(previous: Option<&Sample>, latest: &Sample) -> Vec<(String, u32, u32, String)> {
    let mut out = Vec::new();
    let Some(prev) = previous else { return out };
    for (kind, before, now, resets) in [
        ("session", prev.session, latest.session, &latest.session_resets),
        ("week", prev.week, latest.week, &latest.week_resets),
    ] {
        let (Some(before), Some(now)) = (before, now) else { continue };
        if let Some(threshold) = ALERTS.iter().rev().find(|t| before < **t && now >= **t) {
            out.push((kind.to_string(), now, *threshold, resets.clone()));
        }
    }
    out
}

pub fn recharged(previous: Option<&Sample>, latest: &Sample) -> bool {
    match (previous.and_then(|p| p.session), latest.session) {
        (Some(before), Some(now)) => before >= 15 && now + 10 <= before,
        _ => false,
    }
}

fn history_path() -> PathBuf {
    crate::settings::local_dir().join("usage-history.json")
}

fn load_history() -> Vec<Sample> {
    std::fs::read(history_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Vec<Sample>>(&b).ok())
        .unwrap_or_default()
}

pub fn record(history: &mut Vec<Sample>, sample: Sample) {
    let cutoff = sample.t.saturating_sub(KEEP_DAYS * 86_400);
    history.retain(|s| s.t >= cutoff);
    if let Some(last) = history.last_mut() {
        if sample.t.saturating_sub(last.t) < 120 {
            *last = sample;
            return;
        }
    }
    history.push(sample);
}

async fn fetch(exe: &Path) -> UsageReport {
    let dir = crate::settings::local_dir().join("chat");
    let _ = std::fs::create_dir_all(&dir);
    let mut cmd = Command::new(exe);
    cmd.current_dir(&dir)
        .args(["-p", "--output-format", "json", "--setting-sources", "project,local", "--strict-mcp-config", "--tools", ""])
        .env("TAKO_ORIGIN", "chat")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    for key in crate::sessions::session_vars() {
        cmd.env_remove(key);
    }
    let failed = |e: String| UsageReport { fetched_at: now(), error: Some(e), ..Default::default() };
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return failed(e.to_string()),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"/usage").await;
    }
    let output = match tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return failed(e.to_string()),
        Err(_) => return failed("Claude Code took too long.".into()),
    };
    let text = serde_json::from_slice::<Value>(&output.stdout)
        .ok()
        .and_then(|v| v.get("result").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let lines = parse(&text);
    UsageReport {
        subscription: text.to_lowercase().contains("subscription"),
        error: lines.is_empty().then(|| "No usage limits reported.".to_string()),
        lines,
        fetched_at: now(),
        forecast_at: None,
    }
}

fn wants(app: &AppHandle) -> (bool, bool, bool) {
    app.try_state::<crate::Shared>()
        .map(|s| {
            let s = s.settings.lock().unwrap();
            (s.usage_widget || s.usage_alerts, s.usage_alerts, s.usage_recharge)
        })
        .unwrap_or((false, false, false))
}

pub async fn get(app: &AppHandle, force: bool) -> UsageReport {
    let usage = app.state::<Usage>();
    if !force {
        if let Some(last) = usage.last.lock().unwrap().clone() {
            if now().saturating_sub(last.fetched_at) < FRESH_FOR {
                return last;
            }
        }
    }
    let mut report = match crate::claude_cli::find() {
        Some(exe) => fetch(&exe).await,
        None => UsageReport { fetched_at: now(), error: Some("Claude Code is not installed.".into()), ..Default::default() },
    };
    if let Some(err) = &report.error {
        log::line(format!("usage: {err}"));
    }
    if let Some(sample) = sample_of(&report) {
        let (_, alerts_on, recharge_on) = wants(app);
        let (previous, snapshot) = {
            let mut guard = usage.history.lock().unwrap();
            let history = guard.get_or_insert_with(load_history);
            let previous = history.last().cloned();
            record(history, sample.clone());
            (previous, history.clone())
        };
        report.forecast_at = forecast(&snapshot, &sample);
        let _ = std::fs::write(history_path(), serde_json::to_vec(&snapshot).unwrap_or_default());
        if alerts_on {
            for (kind, percent, threshold, resets) in alerts(previous.as_ref(), &sample) {
                let forecast_at = if kind == "session" { report.forecast_at } else { None };
                let alert = UsageAlert { kind, percent, threshold, resets, forecast_at };
                let _ = app.emit("usage-alert", alert);
            }
        }
        if recharge_on && recharged(previous.as_ref(), &sample) {
            let _ = app.emit("usage-recharged", sample.session.unwrap_or(0));
        }
    }
    *usage.last.lock().unwrap() = Some(report.clone());
    let _ = app.emit("usage-updated", &report);
    report
}

pub fn history(app: &AppHandle) -> Vec<Sample> {
    let usage = app.state::<Usage>();
    let mut guard = usage.history.lock().unwrap();
    guard.get_or_insert_with(load_history).clone()
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            if wants(&app).0 {
                let _ = get(&app, true).await;
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(t: u64, session: u32, resets: &str) -> Sample {
        Sample { t, session: Some(session), week: Some(40), session_resets: resets.into(), week_resets: "Oct 7".into() }
    }

    #[test]
    fn reads_the_limits_out_of_usage() {
        let text = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 9% used · resets Oct 1, 7:10pm (Europe/Paris)\nCurrent week (all models): 47% used · resets Oct 7, 7am (Europe/Paris)\nCurrent week (Fable): 0% used · resets Oct 7, 7am (Europe/Paris)\n\nWhat's contributing to your limits usage?";
        let lines = parse(text);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], UsageLine { label: "Current session".into(), percent: 9, resets: "Oct 1, 7:10pm (Europe/Paris)".into() });
        assert_eq!(lines[1].label, "Current week (all models)");
        assert_eq!(lines[1].percent, 47);
        assert_eq!(lines[2].percent, 0);
    }

    #[test]
    fn ignores_lines_without_a_percentage() {
        assert!(parse("Nothing here\nTokens: 3.1k / 1m (0%)").is_empty());
    }

    #[test]
    fn a_steady_pace_predicts_when_the_limit_is_hit() {
        let history = vec![s(0, 40, "7pm"), s(600, 45, "7pm"), s(1200, 50, "7pm")];
        assert_eq!(forecast(&history, &history[2]), Some(1200 + 50 * 120));
    }

    #[test]
    fn no_forecast_without_progress_or_across_windows() {
        let flat = vec![s(0, 50, "7pm"), s(1200, 50, "7pm")];
        assert_eq!(forecast(&flat, &flat[1]), None);
        let other = vec![s(0, 10, "2pm"), s(1200, 50, "7pm")];
        assert_eq!(forecast(&other, &other[1]), None);
    }

    #[test]
    fn crossing_a_threshold_alerts_once() {
        assert_eq!(alerts(Some(&s(0, 79, "x")), &s(1, 81, "x")).len(), 1);
        assert_eq!(alerts(Some(&s(0, 79, "x")), &s(1, 95, "x"))[0].2, 90);
        assert!(alerts(Some(&s(0, 81, "x")), &s(1, 85, "x")).is_empty());
        assert!(alerts(None, &s(1, 95, "x")).is_empty());
    }

    #[test]
    fn a_big_drop_means_the_session_was_recharged() {
        assert!(recharged(Some(&s(0, 72, "x")), &s(1, 0, "y")));
        assert!(!recharged(Some(&s(0, 12, "x")), &s(1, 0, "y")));
        assert!(!recharged(Some(&s(0, 50, "x")), &s(1, 45, "x")));
    }

    #[test]
    fn samples_close_together_are_merged() {
        let mut history = vec![s(0, 10, "x")];
        record(&mut history, s(60, 11, "x"));
        assert_eq!(history.len(), 1);
        record(&mut history, s(300, 12, "x"));
        assert_eq!(history.len(), 2);
    }
}
