use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use crate::log;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const START_TIMEOUT: Duration = Duration::from_secs(90);
const CHROME_TIMEOUT: Duration = Duration::from_secs(20);

struct Server {
    pid: u32,
    port: u16,
    cdp: u16,
}

struct Chrome {
    pid: Option<u32>,
    port: u16,
    visible: bool,
}

#[derive(Default)]
pub struct Browser {
    server: Mutex<Option<Server>>,
    chrome: Mutex<Option<Chrome>>,
}

fn profile_dir() -> PathBuf {
    crate::settings::local_dir().join("browser-profile")
}

fn port_file() -> PathBuf {
    crate::settings::local_dir().join("browser-port")
}

pub fn find_chromium() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            candidates.push(PathBuf::from(base).join(r"Google\Chrome\Application\chrome.exe"));
        }
    }
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(base) = std::env::var_os(var) {
            candidates.push(PathBuf::from(base).join(r"Microsoft\Edge\Application\msedge.exe"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

pub fn parse_active_port(text: &str) -> Option<u16> {
    text.lines().next()?.trim().parse().ok().filter(|p| *p > 0)
}

fn active_port(profile: &Path) -> Option<u16> {
    parse_active_port(&std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?)
}

fn saved_port() -> u16 {
    if let Some(port) = std::fs::read_to_string(port_file()).ok().and_then(|t| t.trim().parse::<u16>().ok()) {
        return port;
    }
    let port = free_port().unwrap_or(9333);
    save_port(port);
    port
}

fn save_port(port: u16) {
    let _ = std::fs::create_dir_all(crate::settings::local_dir());
    let _ = std::fs::write(port_file(), port.to_string());
}

fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

impl Browser {
    pub async fn link(&self) -> Result<String, String> {
        let cdp = self.cdp_port().await?;
        self.ensure_server(cdp).await
    }

    pub async fn warm(&self) {
        if let Err(err) = self.link().await {
            log::line(format!("browser: {err}"));
        }
    }

    pub fn server_running(&self) -> bool {
        self.server.lock().unwrap().is_some()
    }

    pub async fn chrome_running(&self) -> bool {
        let cdp = self.server.lock().unwrap().as_ref().map(|s| s.cdp);
        match cdp {
            Some(port) => port_open(port).await,
            None => false,
        }
    }

    pub async fn open(&self, visible: bool, launch: bool) -> Result<bool, String> {
        let cdp = match self.server.lock().unwrap().as_ref().map(|s| s.cdp) {
            Some(port) => port,
            None => saved_port(),
        };
        let known = self.chrome.lock().unwrap().as_ref().map(|c| (c.port, c.visible, c.pid));
        if port_open(cdp).await {
            let mismatch = matches!(known, Some((port, was_visible, Some(_))) if port == cdp && was_visible != visible);
            if !mismatch || !launch {
                if known.map(|k| k.0) != Some(cdp) {
                    *self.chrome.lock().unwrap() = Some(Chrome { pid: None, port: cdp, visible });
                }
                return Ok(true);
            }
            self.close_chrome();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while port_open(cdp).await && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
        if !launch {
            return Ok(false);
        }
        self.launch_chrome(cdp, visible).await?;
        Ok(true)
    }

    async fn cdp_port(&self) -> Result<u16, String> {
        let known = self.chrome.lock().unwrap().as_ref().map(|c| c.port);
        if let Some(port) = known {
            if port_open(port).await {
                return Ok(port);
            }
            *self.chrome.lock().unwrap() = None;
        }
        if let Some(port) = active_port(&profile_dir()) {
            if port_open(port).await {
                save_port(port);
                *self.chrome.lock().unwrap() = Some(Chrome { pid: None, port, visible: true });
                log::line(format!("browser: reusing the open window (debug port {port})"));
                return Ok(port);
            }
        }
        let server = self.server.lock().unwrap().as_ref().map(|s| s.cdp);
        let mut port = saved_port();
        if server != Some(port) && port_open(port).await {
            port = free_port().ok_or("Aucun port libre pour le navigateur.")?;
            save_port(port);
        }
        Ok(port)
    }

    async fn launch_chrome(&self, port: u16, visible: bool) -> Result<(), String> {
        let exe = find_chromium().ok_or("Chrome ou Edge introuvable sur ce PC.")?;
        let profile = profile_dir();
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));
        let mut cmd = Command::new(&exe);
        cmd.arg(format!("--user-data-dir={}", profile.display()))
            .arg(format!("--remote-debugging-port={port}"))
            .args(["--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check"]);
        if !visible {
            cmd.arg("--headless=new");
        }
        cmd.arg("about:blank").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("Impossible de lancer le navigateur : {e}"))?;
        let pid = child.id();
        log::line(format!("browser: launched {} (pid {pid}, debug port {port})", exe.display()));
        let deadline = tokio::time::Instant::now() + CHROME_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if port_open(port).await {
                *self.chrome.lock().unwrap() = Some(Chrome { pid: Some(pid), port, visible });
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err("Le navigateur ne répond pas. Ferme la fenêtre du navigateur de Tako si elle est ouverte, puis réessaie.".into())
    }

    async fn ensure_server(&self, cdp: u16) -> Result<String, String> {
        let existing = self.server.lock().unwrap().as_ref().map(|s| (s.port, s.cdp));
        if let Some((port, server_cdp)) = existing {
            if server_cdp == cdp && port_open(port).await {
                return Ok(endpoint(port));
            }
            self.stop();
        }

        let port = free_port().ok_or("Aucun port libre pour le navigateur.")?;
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npx", "-y", "@playwright/mcp@latest", "--port"])
            .arg(port.to_string())
            .args(["--host", "127.0.0.1", "--allowed-hosts"])
            .arg(format!("127.0.0.1:{port}"))
            .args(["--shared-browser-context", "--cdp-endpoint"])
            .arg(format!("http://127.0.0.1:{cdp}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let child = cmd.spawn().map_err(|e| format!("Impossible de démarrer le navigateur : {e}"))?;
        let pid = child.id();
        *self.server.lock().unwrap() = Some(Server { pid, port, cdp });
        log::line(format!("browser server starting on port {port} (pid {pid}, chrome {cdp})"));

        let deadline = tokio::time::Instant::now() + START_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if port_open(port).await {
                log::line(format!("browser server ready on port {port}"));
                return Ok(endpoint(port));
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        self.stop();
        Err("Le navigateur met trop de temps à démarrer. Node.js est-il installé ?".into())
    }

    pub fn stop(&self) {
        let Some(run) = self.server.lock().unwrap().take() else { return };
        kill_tree(run.pid);
        log::line(format!("browser server on port {} stopped", run.port));
    }

    pub fn close_chrome(&self) {
        let Some(chrome) = self.chrome.lock().unwrap().take() else { return };
        if let Some(pid) = chrome.pid {
            kill_tree(pid);
            log::line(format!("browser window closed (pid {pid})"));
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_debug_port_is_read_from_chromes_own_file() {
        assert_eq!(parse_active_port("9333\n/devtools/browser/abc\n"), Some(9333));
        assert_eq!(parse_active_port("0\n"), None);
        assert_eq!(parse_active_port(""), None);
        assert_eq!(parse_active_port("nope"), None);
    }
}
