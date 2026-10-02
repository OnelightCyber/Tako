mod assets;
mod audio;
mod bluetooth;
mod browser;
mod claude;
mod claude_cli;
mod clipboard;
mod downloads;
mod drives;
mod files;
mod game;
mod hooks;
mod integrations;
mod island;
mod keys;
mod log;
mod media;
mod mic;
mod network;
mod notify;
mod pipe;
mod power;
mod privacy;
mod secrets;
mod sessions;
mod settings;
mod stt;
mod sysstats;
mod tray;
mod tts;
mod updater;
mod usage;
mod voice;
mod vpn;
mod weather;
mod widget;
mod win_user;

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use claude::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();

    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let mut settings = settings;
    settings.island_scale = island::clamp_zoom(settings.island_scale);
    let (screen_changed, autostart_changed, zoom_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        let zoom_changed = (current.island_scale - settings.island_scale).abs() > f64::EPSILON;
        *current = settings.clone();
        (screen_changed, autostart_changed, zoom_changed)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[tako] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[tako] autostart: {err}");
        }
    }
    if zoom_changed {
        island::set_zoom(&app, settings.island_scale);
    }
    if screen_changed || zoom_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    warm_browser(&app, &settings);
    widget::sync(&app, &settings);
    apply_features(&app, &settings);

    let _ = app.emit("settings-changed", settings);
}

fn apply_features(app: &AppHandle, settings: &Settings) {
    sessions::set_review_flag(settings.review_mode);
    media::set_enabled(settings.media_enabled);
    sysstats::set_enabled(settings.stats_enabled);
    game::set_enabled(settings.game_mode);
    bluetooth::set_enabled(settings.bt_animation);
    vpn::set_enabled(settings.vpn_alerts);
    audio::set_hud(settings.volume_hud);
    keys::set_enabled(settings.lock_keys_hud);
    power::set_enabled(settings.battery_alerts);
    privacy::set_enabled(settings.privacy_dots || settings.call_activity);
    downloads::set_enabled(settings.downloads_enabled);
    drives::set_enabled(settings.drives_enabled);
    network::set_enabled(settings.network_alerts);
    notify::configure(settings.notifications_enabled, settings.notifications_private, &settings.notifications_muted);
    weather::configure(settings.weather_enabled, &settings.weather_city);
    voice::set_enabled(settings.voice_enabled);
    if settings.voice_enabled {
        stt::start_download(app.clone());
        if settings.voice_replies && settings.voice_name != "windows" {
            tts::start_download(app.clone(), &settings.voice_name);
        }
    }
    clipboard::set_enabled(settings.lens_enabled);
    register_hotkey(app, &settings.mission_hotkey);
}

#[tauri::command]
fn audio_meter(on: bool) {
    audio::set_meter(on);
}

#[tauri::command]
fn power_status() -> power::Power {
    power::status()
}

#[tauri::command]
fn privacy_status() -> privacy::Privacy {
    privacy::status()
}

#[tauri::command]
fn weather_now() -> Option<weather::Weather> {
    weather::current()
}

#[tauri::command]
fn weather_refresh() {
    weather::refresh();
}

#[tauri::command]
fn weather_failure() -> Option<String> {
    weather::failure()
}

#[tauri::command]
fn voice_listen() {
    voice::listen();
}

#[tauri::command]
fn voice_cancel() {
    voice::cancel();
}

#[tauri::command]
fn stt_status() -> stt::Status {
    stt::status()
}

#[tauri::command]
fn stt_download(app: AppHandle) {
    stt::start_download(app);
}

#[tauri::command]
async fn voice_say(shared: State<'_, Shared>, text: String) -> Result<String, String> {
    let name = shared.settings.lock().unwrap().voice_name.clone();
    tauri::async_runtime::spawn_blocking(move || voice::say(&text, &name)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn tts_status(voice: String) -> tts::Status {
    tts::status(&voice)
}

#[tauri::command]
fn tts_download(app: AppHandle, voice: String) {
    tts::start_download(app, &voice);
}

#[tauri::command]
fn drive_open(letter: String) -> bool {
    drives::open(&letter)
}

#[tauri::command]
fn download_open(path: String) -> bool {
    downloads::open(&path)
}

#[tauri::command]
fn download_reveal(path: String) -> bool {
    downloads::reveal(&path)
}

#[tauri::command]
fn notification_open(app_id: String) -> bool {
    notify::open(&app_id)
}

#[tauri::command]
fn hud_test(app: AppHandle, kind: String) {
    const KINDS: &[&str] = &[
        "volume", "caps", "charging", "battery", "drive", "network", "download", "notification", "call",
        "lens-error", "lens-english", "lens-tracking", "lens-address", "voice", "celebrate",
    ];
    if KINDS.contains(&kind.as_str()) {
        let _ = app.emit_to(island::WINDOW_LABEL, "hud-test", kind);
    }
}

#[tauri::command]
fn game_status() -> game::GameState {
    game::state()
}

#[tauri::command]
fn vpn_status() -> vpn::VpnStatus {
    vpn::status()
}

#[tauri::command]
fn vpn_test(app: AppHandle) {
    vpn::test(&app);
}

#[tauri::command]
fn vpn_open_app() -> bool {
    match vpn::mullvad_app() {
        Some(path) => Command::new(path).spawn().is_ok(),
        None => false,
    }
}

#[tauri::command]
fn bluetooth_test(app: AppHandle) {
    bluetooth::test(&app);
}

static HOTKEY_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn register_hotkey(app: &AppHandle, hotkey: &str) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let mut error = None;
    if !hotkey.is_empty() && hotkey != "off" {
        match hotkey.parse::<Shortcut>() {
            Ok(shortcut) => {
                if let Err(err) = shortcuts.register(shortcut) {
                    log::line(format!("hotkey {hotkey} unavailable: {err}"));
                    error = Some(err.to_string());
                }
            }
            Err(err) => {
                log::line(format!("hotkey {hotkey} invalid: {err}"));
                error = Some(err.to_string());
            }
        }
    }
    *HOTKEY_ERROR.lock().unwrap() = error;
}

#[tauri::command]
fn hotkey_status() -> Option<String> {
    HOTKEY_ERROR.lock().unwrap().clone()
}

fn warm_browser(app: &AppHandle, settings: &Settings) {
    let app = app.clone();
    let agent = settings.chat_agent;
    tauri::async_runtime::spawn(async move {
        let browser = app.state::<browser::Browser>();
        if agent {
            browser.warm().await;
        } else {
            browser.stop();
            browser.close_chrome();
        }
    });
}

#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);

    island::set_ignore_cursor(&app, collapsed && game::active());
    shared.gate.forget_ignore_state();
    shared.gate.set_active(!collapsed);
}

#[tauri::command]
fn set_island_rect(shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    island::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    let _ = Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    launch_vscode(path)
}

pub(crate) fn launch_vscode(path: Option<String>) -> bool {
    if let Some(code) = find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
            cmd.arg(p);
        }
        if cmd.creation_flags(CREATE_NO_WINDOW).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
        let _ = Command::new("explorer").arg(p).spawn();
    }
    false
}

pub(crate) fn find_on_path(stem: &str) -> Option<std::path::PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{stem}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    browser: State<'_, browser::Browser>,
    chat: State<'_, Chat>,
    cli_chat: State<'_, claude_cli::CliChat>,
    query: String,
    context: Option<ChatContext>,
    cwd: Option<String>,
) -> Result<ChatReply, String> {
    if let Some(exe) = claude_cli::find() {
        let (screen, agent, auto, apps) = {
            let s = shared.settings.lock().unwrap();
            (s.chat_screen, s.chat_agent, s.agent_auto, s.chat_apps)
        };
        let browser = if agent {
            if !browser.server_running() {
                let _ = app.emit_to(island::WINDOW_LABEL, "chat-status", "Préparation du navigateur…");
            }
            match browser.link().await {
                Ok(url) => Some(url),
                Err(err) => {
                    log::line(format!("browser: {err}"));
                    let _ = app.emit_to(island::WINDOW_LABEL, "chat-status", "Navigateur indisponible, réponse sans lui…");
                    None
                }
            }
        } else {
            browser.stop();
            None
        };
        let powers = claude_cli::Powers { hook: settings::hook_exe_path(), screen, apps, browser, auto };
        return claude_cli::send(&app, &cli_chat, &exe, query, context, cwd, powers).await;
    }
    let model = shared.settings.lock().unwrap().model.clone();
    claude::send(&chat, &model, query, context).await
}

#[tauri::command]
fn chat_reset(chat: State<Chat>, cli_chat: State<claude_cli::CliChat>) {
    chat.reset();
    cli_chat.reset();
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeCodeInfo {
    found: bool,
    path: String,
    version: String,
}

#[tauri::command]
async fn claude_code_info() -> ClaudeCodeInfo {
    let Some(exe) = claude_cli::find() else {
        return ClaudeCodeInfo { found: false, path: String::new(), version: String::new() };
    };
    let version = tokio::process::Command::new(&exe)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    ClaudeCodeInfo { found: true, path: exe.to_string_lossy().to_string(), version }
}

#[tauri::command]
fn open_tako_folder() {
    let dir = settings::local_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = Command::new("explorer.exe").arg(&dir).spawn();
}

#[tauri::command]
fn show_island(app: AppHandle) {
    let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
}

#[tauri::command]
async fn chat_commands(cli_chat: State<'_, claude_cli::CliChat>) -> Result<serde_json::Value, String> {
    match claude_cli::find() {
        Some(exe) => Ok(claude_cli::commands(&cli_chat, &exe).await),
        None => Ok(serde_json::json!({ "commands": [], "skills": [] })),
    }
}

#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Option<updater::UpdateInfo>, String> {
    updater::check(&app).await
}

#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    updater::install(&app).await
}

#[tauri::command]
fn chat_backend() -> &'static str {
    if claude_cli::find().is_some() { "claude-code" } else { "api" }
}

#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

#[tauri::command]
fn ingest_bytes(request: tauri::ipc::Request<'_>) -> Result<DroppedFile, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("No file data.".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| "file".into());
    let saved = files::ingest_bytes(&name, bytes)?;
    log::line(format!("drop saved {} ({} bytes)", saved.name, saved.size));
    Ok(saved)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

#[tauri::command]
async fn usage_get(app: AppHandle, force: bool) -> usage::UsageReport {
    usage::get(&app, force).await
}

#[tauri::command]
fn usage_history(app: AppHandle) -> Vec<usage::Sample> {
    usage::history(&app)
}

#[tauri::command]
fn session_summary(session_id: String, cwd: String) -> Option<sessions::TurnSummary> {
    let safe = sessions::safe_id(&session_id)?;
    let mut summary = sessions::summary(&safe, &cwd, None)?;
    summary.session_id = session_id;
    Some(summary)
}

#[tauri::command]
async fn session_undo(session_id: String) -> Result<sessions::UndoReport, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::undo(&session_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn session_diff(session_id: String, project: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sessions::open_diff(&session_id, &project))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn session_commit_message(session_id: String, cwd: String) -> Result<String, String> {
    sessions::commit_message(session_id, cwd).await
}

#[tauri::command]
async fn session_commit(session_id: String, cwd: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::commit(&session_id, &cwd, &message))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn mission_start(app: AppHandle, task: String, cwd: String) -> Result<(), String> {
    sessions::start_mission(&task, &cwd)?;
    let shared = app.state::<Shared>();
    let updated = {
        let mut s = shared.settings.lock().unwrap();
        s.recent_projects.retain(|p| !p.eq_ignore_ascii_case(&cwd));
        s.recent_projects.insert(0, cwd.clone());
        s.recent_projects.truncate(8);
        s.clone()
    };
    let _ = settings::save(&updated);
    let _ = app.emit("settings-changed", updated);
    Ok(())
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Dossier du projet").pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let folder = rx.await.ok()??;
    folder.into_path().ok().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn media_control(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || media::control(&action))
        .await
        .map_err(|e| e.to_string())?
}

fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Réglages — Tako")
        .inner_size(980.0, 740.0)
        .min_inner_size(800.0, 560.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app.emit_to(island::WINDOW_LABEL, "mission-open", ());
                    }
                })
                .build(),
        )
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(claude_cli::CliChat::default())
        .manage(browser::Browser::default())
        .manage(usage::Usage::default())
        .manage(sessions::Sessions::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_reset,
            chat_backend,
            update_check,
            update_install,
            chat_commands,
            usage_get,
            usage_history,
            session_summary,
            session_undo,
            session_diff,
            session_commit_message,
            session_commit,
            mission_start,
            pick_folder,
            hotkey_status,
            game_status,
            vpn_status,
            vpn_test,
            vpn_open_app,
            bluetooth_test,
            media_control,
            audio_meter,
            power_status,
            privacy_status,
            weather_now,
            weather_refresh,
            weather_failure,
            voice_listen,
            voice_cancel,
            stt_status,
            stt_download,
            tts_status,
            tts_download,
            voice_say,
            drive_open,
            download_open,
            download_reveal,
            notification_open,
            hud_test,
            widget::usage_resize,
            widget::usage_drag,
            widget::usage_close,
            claude_code_info,
            open_tako_folder,
            show_island,
            ingest_file,
            ingest_bytes,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;

            create_settings_window(&handle);
            widget::create(&handle);

            island::set_zoom(&handle, loaded.island_scale);
            if let Some(win) = island::window(&handle) {
                island::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();

                win.on_window_event(|event| {
                    if let tauri::WindowEvent::DragDrop(drag) = event {
                        match drag {
                            tauri::DragDropEvent::Enter { paths, .. } => {
                                log::line(format!("drag enter (window) {} file(s)", paths.len()))
                            }
                            tauri::DragDropEvent::Drop { paths, .. } => {
                                log::line(format!("drag drop (window) {} file(s)", paths.len()))
                            }
                            tauri::DragDropEvent::Leave => log::line("drag leave (window)".to_string()),
                            _ => {}
                        }
                    }
                });
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());
            island::spawn_drag_watch(handle.clone(), gate.clone());


            log::line(format!("--- Tako {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            if loaded.chat_agent {
                warm_browser(&handle, &loaded);
            }
            integrations::start(handle.clone());
            updater::start(handle.clone());
            usage::start(handle.clone());
            widget::sync(&handle, &loaded);
            sessions::start_cleanup();
            media::start(handle.clone(), gate.clone());
            sysstats::start(handle.clone(), gate.clone());
            game::start(handle.clone());
            vpn::start(handle.clone());
            bluetooth::start(handle.clone());
            audio::start(handle.clone());
            keys::start(handle.clone());
            power::start(handle.clone());
            privacy::start(handle.clone());
            downloads::start(handle.clone());
            drives::start(handle.clone());
            network::start(handle.clone());
            notify::start(handle.clone());
            weather::start(handle.clone());
            voice::start(handle.clone());
            clipboard::start(handle.clone());
            apply_features(&handle, &loaded);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Tako")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<browser::Browser>().stop();
            }
        });
}
