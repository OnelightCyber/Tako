use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::log;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const EVERY: Duration = Duration::from_secs(4 * 60);
const FRESH_FOR: u64 = 60;

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
}

#[derive(Default)]
pub struct Usage {
    last: Mutex<Option<UsageReport>>,
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
    }
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
    let report = match crate::claude_cli::find() {
        Some(exe) => fetch(&exe).await,
        None => UsageReport { fetched_at: now(), error: Some("Claude Code is not installed.".into()), ..Default::default() },
    };
    if let Some(err) = &report.error {
        log::line(format!("usage: {err}"));
    }
    *usage.last.lock().unwrap() = Some(report.clone());
    let _ = app.emit("usage-updated", &report);
    report
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            let enabled = app
                .try_state::<crate::Shared>()
                .map(|s| s.settings.lock().unwrap().usage_widget)
                .unwrap_or(false);
            if enabled {
                let _ = get(&app, true).await;
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
