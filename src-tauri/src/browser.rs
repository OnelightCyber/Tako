use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use crate::log;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const START_TIMEOUT: Duration = Duration::from_secs(90);

struct Running {
    pid: u32,
    port: u16,
    visible: bool,
}

#[derive(Default)]
pub struct Browser {
    running: Mutex<Option<Running>>,
}

impl Browser {
    pub async fn ensure(&self, visible: bool) -> Result<String, String> {
        let existing = {
            let guard = self.running.lock().unwrap();
            guard.as_ref().map(|r| (r.port, r.visible))
        };
        if let Some((port, was_visible)) = existing {
            if was_visible == visible && port_open(port).await {
                return Ok(endpoint(port));
            }
            self.stop();
        }

        let port = free_port().ok_or("No free port for the browser.")?;
        let config = write_config(visible)?;
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npx", "-y", "@playwright/mcp@latest", "--port"])
            .arg(port.to_string())
            .args(["--host", "127.0.0.1", "--shared-browser-context", "--config"])
            .arg(&config)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        if !visible {
            cmd.arg("--headless");
        }
        let child = cmd.spawn().map_err(|e| format!("Couldn't start the browser: {e}"))?;
        let pid = child.id();
        *self.running.lock().unwrap() = Some(Running { pid, port, visible });
        log::line(format!("browser server starting on port {port} (pid {pid})"));

        let deadline = tokio::time::Instant::now() + START_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if port_open(port).await {
                log::line(format!("browser server ready on port {port}"));
                return Ok(endpoint(port));
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        self.stop();
        Err("The browser took too long to start. Is Node.js installed?".into())
    }

    pub async fn is_ready(&self, visible: bool) -> bool {
        let existing = {
            let guard = self.running.lock().unwrap();
            guard.as_ref().map(|r| (r.port, r.visible))
        };
        match existing {
            Some((port, was_visible)) if was_visible == visible => port_open(port).await,
            _ => false,
        }
    }

    pub fn stop(&self) {
        let Some(run) = self.running.lock().unwrap().take() else { return };
        let _ = Command::new("taskkill")
            .args(["/PID", &run.pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        log::line(format!("browser server on port {} stopped", run.port));
    }
}

fn endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

async fn port_open(port: u16) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_millis(300), tokio::net::TcpStream::connect(("127.0.0.1", port))).await,
        Ok(Ok(_))
    )
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?.local_addr().ok().map(|a| a.port())
}

fn write_config(visible: bool) -> Result<std::path::PathBuf, String> {
    let dir = crate::settings::local_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("playwright.json");
    let config = serde_json::json!({
        "browser": {
            "userDataDir": dir.join("browser-profile").to_string_lossy(),
            "launchOptions": { "headless": !visible },
            "contextOptions": { "viewport": null }
        }
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&config).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(path)
}
