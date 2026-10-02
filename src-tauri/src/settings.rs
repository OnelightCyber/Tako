use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,

    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,

    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub chat_agent: bool,
    #[serde(default = "default_true")]
    pub agent_browser_visible: bool,
    #[serde(default = "default_true")]
    pub open_on_finish: bool,
    #[serde(default = "default_true")]
    pub chat_screen: bool,
    #[serde(default)]
    pub agent_auto: bool,
    #[serde(default = "default_true")]
    pub usage_widget: bool,
    #[serde(default = "default_usage_position")]
    pub usage_position: String,
    #[serde(default)]
    pub usage_x: f64,
    #[serde(default)]
    pub usage_y: f64,
    #[serde(default = "default_true")]
    pub usage_alerts: bool,
    #[serde(default = "default_true")]
    pub usage_recharge: bool,
    #[serde(default)]
    pub review_mode: bool,
    #[serde(default = "default_hotkey")]
    pub mission_hotkey: String,
    #[serde(default)]
    pub recent_projects: Vec<String>,
    #[serde(default = "default_true")]
    pub media_enabled: bool,
    #[serde(default = "default_true")]
    pub stats_enabled: bool,
    #[serde(default = "default_true")]
    pub game_mode: bool,
    #[serde(default = "default_true")]
    pub game_mute: bool,
    #[serde(default = "default_true")]
    pub bt_animation: bool,
    #[serde(default = "default_true")]
    pub vpn_alerts: bool,
    #[serde(default = "default_true")]
    pub chat_apps: bool,
    #[serde(default = "default_focus")]
    pub pomodoro_focus: u32,
    #[serde(default = "default_break")]
    pub pomodoro_break: u32,
    #[serde(default = "default_long")]
    pub pomodoro_long: u32,
    #[serde(default = "default_rounds")]
    pub pomodoro_rounds: u32,
    #[serde(default = "default_scale")]
    pub island_scale: f64,
    #[serde(default = "default_true")]
    pub keep_live_visible: bool,
    #[serde(default = "default_true")]
    pub volume_hud: bool,
    #[serde(default = "default_true")]
    pub lock_keys_hud: bool,
    #[serde(default = "default_true")]
    pub battery_alerts: bool,
    #[serde(default = "default_true")]
    pub privacy_dots: bool,
    #[serde(default = "default_true")]
    pub call_activity: bool,
    #[serde(default = "default_true")]
    pub downloads_enabled: bool,
    #[serde(default = "default_true")]
    pub drives_enabled: bool,
    #[serde(default = "default_true")]
    pub network_alerts: bool,
    #[serde(default = "default_true")]
    pub notifications_enabled: bool,
    #[serde(default)]
    pub notifications_private: bool,
    #[serde(default)]
    pub notifications_muted: Vec<String>,
    #[serde(default = "default_true")]
    pub weather_enabled: bool,
    #[serde(default)]
    pub weather_city: String,
    #[serde(default = "default_true")]
    pub visualizer: bool,
    #[serde(default)]
    pub voice_enabled: bool,
    #[serde(default = "default_true")]
    pub voice_replies: bool,
    #[serde(default)]
    pub voice_approvals: bool,
    #[serde(default = "default_true")]
    pub lens_enabled: bool,
    #[serde(default = "default_true")]
    pub mascot_alive: bool,
    #[serde(default)]
    pub calm_motion: bool,
}

fn default_scale() -> f64 {
    1.2
}

fn default_focus() -> u32 {
    25
}

fn default_break() -> u32 {
    5
}

fn default_long() -> u32 {
    15
}

fn default_rounds() -> u32 {
    4
}

fn default_usage_position() -> String {
    "island-right".into()
}

pub fn default_hotkey() -> String {
    "Alt+Shift+Space".into()
}

fn default_true() -> bool {
    true
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            chat_agent: false,
            agent_browser_visible: true,
            open_on_finish: true,
            chat_screen: true,
            agent_auto: false,
            usage_widget: true,
            usage_position: default_usage_position(),
            usage_x: 0.0,
            usage_y: 0.0,
            usage_alerts: true,
            usage_recharge: true,
            review_mode: false,
            mission_hotkey: default_hotkey(),
            recent_projects: Vec::new(),
            media_enabled: true,
            stats_enabled: true,
            game_mode: true,
            game_mute: true,
            bt_animation: true,
            vpn_alerts: true,
            chat_apps: true,
            pomodoro_focus: default_focus(),
            pomodoro_break: default_break(),
            pomodoro_long: default_long(),
            pomodoro_rounds: default_rounds(),
            island_scale: default_scale(),
            keep_live_visible: true,
            volume_hud: true,
            lock_keys_hud: true,
            battery_alerts: true,
            privacy_dots: true,
            call_activity: true,
            downloads_enabled: true,
            drives_enabled: true,
            network_alerts: true,
            notifications_enabled: true,
            notifications_private: false,
            notifications_muted: Vec::new(),
            weather_enabled: true,
            weather_city: String::new(),
            visualizer: true,
            voice_enabled: false,
            voice_replies: true,
            voice_approvals: false,
            lens_enabled: true,
            mascot_alive: true,
            calm_motion: false,
        }
    }
}

pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Tako")
}

pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Tako")
}

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join("tako-hook.exe")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
