use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::ApplicationModel::AppInfo;
use windows::Foundation::Size;
use windows::Storage::Streams::DataReader;
use windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds, UserNotification};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::island::WINDOW_LABEL;
use crate::log;

const EVERY: Duration = Duration::from_millis(1200);
const DENIED_RETRY: Duration = Duration::from_secs(30);
const ASK_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_LOGO: u32 = 512 * 1024;
const MAX_TEXT: usize = 300;

static ENABLED: AtomicBool = AtomicBool::new(true);
static PRIVATE: AtomicBool = AtomicBool::new(false);
static MUTED: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: u32,
    pub app: String,
    pub app_id: String,
    pub title: String,
    pub body: String,
    pub logo: Option<String>,
    pub at: i64,
}

pub fn configure(enabled: bool, private: bool, muted: &[String]) {
    ENABLED.store(enabled, Ordering::Relaxed);
    PRIVATE.store(private, Ordering::Relaxed);
    *MUTED.lock().unwrap() = muted.iter().map(|m| m.to_lowercase()).collect();
}

pub fn is_muted(app: &str, app_id: &str, muted: &[String]) -> bool {
    let (a, b) = (app.to_lowercase(), app_id.to_lowercase());
    muted.iter().any(|m| !m.is_empty() && (*m == a || *m == b))
}

pub fn clip(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= MAX_TEXT {
        return t.to_string();
    }
    let mut out: String = t.chars().take(MAX_TEXT).collect();
    out.push('…');
    out
}

pub fn split_texts(texts: &[String], private: bool) -> (String, String) {
    let title = texts.first().map(|t| clip(t)).unwrap_or_default();
    let body = if private { String::new() } else { clip(&texts.iter().skip(1).cloned().collect::<Vec<_>>().join(" · ")) };
    (title, body)
}

pub fn valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 260
        && !id.contains("..")
        && id.chars().all(|c| c.is_ascii_alphanumeric() || " ._!-{}\\#".contains(c))
}

fn texts(n: &UserNotification) -> Vec<String> {
    let read = || -> windows::core::Result<Vec<String>> {
        let binding = n.Notification()?.Visual()?.GetBinding(&KnownNotificationBindings::ToastGeneric()?)?;
        Ok(binding.GetTextElements()?.into_iter().filter_map(|t| t.Text().ok().map(|s| s.to_string())).collect())
    };
    read().unwrap_or_default()
}

fn logo(info: &AppInfo) -> Option<String> {
    let reference = info.DisplayInfo().ok()?.GetLogo(Size { Width: 64.0, Height: 64.0 }).ok()?;
    let stream = reference.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > MAX_LOGO {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    Some(format!("data:image/png;base64,{}", crate::claude::base64_for(&bytes)))
}

fn access(listener: &UserNotificationListener) -> UserNotificationListenerAccessStatus {
    let status = listener.GetAccessStatus().unwrap_or(UserNotificationListenerAccessStatus::Unspecified);
    if status != UserNotificationListenerAccessStatus::Unspecified {
        return status;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let asked = UserNotificationListener::Current()
            .and_then(|l| l.RequestAccessAsync())
            .and_then(|op| op.get())
            .unwrap_or(UserNotificationListenerAccessStatus::Unspecified);
        let _ = tx.send(asked);
    });
    rx.recv_timeout(ASK_TIMEOUT).unwrap_or(UserNotificationListenerAccessStatus::Unspecified)
}

fn notice(n: &UserNotification, id: u32, logos: &mut HashMap<String, Option<String>>) -> Option<Notice> {
    let info = n.AppInfo().ok();
    let app = info
        .as_ref()
        .and_then(|i| i.DisplayInfo().ok())
        .and_then(|d| d.DisplayName().ok())
        .map(|s| s.to_string())
        .unwrap_or_default();
    let app_id = info.as_ref().and_then(|i| i.AppUserModelId().ok()).map(|s| s.to_string()).unwrap_or_default();
    if app.eq_ignore_ascii_case("tako") {
        return None;
    }
    if is_muted(&app, &app_id, &MUTED.lock().unwrap()) {
        return None;
    }
    let (title, body) = split_texts(&texts(n), PRIVATE.load(Ordering::Relaxed));
    if title.is_empty() && body.is_empty() {
        return None;
    }
    let logo = match &info {
        Some(i) => logos.entry(app_id.clone()).or_insert_with(|| logo(i)).clone(),
        None => None,
    };
    let at = n.CreationTime().map(|t| t.UniversalTime / 10_000 - 11_644_473_600_000).unwrap_or(0);
    Some(Notice { id, app, app_id, title, body, logo, at })
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let listener = match UserNotificationListener::Current() {
            Ok(l) => l,
            Err(err) => {
                log::line(format!("notifications: listener unavailable ({err})"));
                return;
            }
        };
        let mut allowed = false;
        let mut asked = false;
        let mut told = false;
        let mut primed = false;
        let mut seen: HashSet<u32> = HashSet::new();
        let mut logos: HashMap<String, Option<String>> = HashMap::new();
        let mut failing = false;
        loop {
            std::thread::sleep(EVERY);
            if !ENABLED.load(Ordering::Relaxed) {
                primed = false;
                continue;
            }
            if !allowed {
                let status = if asked {
                    listener.GetAccessStatus().unwrap_or(UserNotificationListenerAccessStatus::Unspecified)
                } else {
                    asked = true;
                    access(&listener)
                };
                allowed = status != UserNotificationListenerAccessStatus::Denied;
                if !allowed {
                    if !told {
                        told = true;
                        log::line(format!("notifications: Windows does not allow reading notifications ({status:?})"));
                    }
                    std::thread::sleep(DENIED_RETRY);
                    continue;
                }
                log::line("notifications: reading Windows notifications");
            }
            let list = match listener.GetNotificationsAsync(NotificationKinds::Toast).and_then(|op| op.get()) {
                Ok(list) => {
                    if failing {
                        failing = false;
                        log::line("notifications: reading again");
                    }
                    list
                }
                Err(err) => {
                    if !failing {
                        failing = true;
                        log::line(format!("notifications: cannot read the list ({err})"));
                    }
                    continue;
                }
            };
            let mut ids = HashSet::new();
            for n in list {
                let Ok(id) = n.Id() else { continue };
                ids.insert(id);
                if !primed || seen.contains(&id) {
                    continue;
                }
                if let Some(found) = notice(&n, id, &mut logos) {
                    let _ = app.emit_to(WINDOW_LABEL, "notification", found);
                }
            }
            seen = ids;
            primed = true;
        }
    });
}

pub fn open(app_id: &str) -> bool {
    if !valid_app_id(app_id) {
        return false;
    }
    std::process::Command::new("explorer.exe").arg(format!("shell:AppsFolder\\{app_id}")).spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn muted_apps_match_by_name_or_id() {
        let muted = vec!["discord".to_string(), "microsoft.outlook".to_string()];
        assert!(is_muted("Discord", "com.squirrel.Discord.Discord", &muted));
        assert!(is_muted("Outlook", "Microsoft.Outlook", &muted));
        assert!(!is_muted("Spotify", "Spotify", &muted));
        assert!(!is_muted("Spotify", "", &[String::new()]));
    }

    #[test]
    fn the_first_text_is_the_title_and_private_mode_hides_the_rest() {
        let texts = vec!["Léa".to_string(), "salut".to_string(), "ça va ?".to_string()];
        assert_eq!(split_texts(&texts, false), ("Léa".to_string(), "salut · ça va ?".to_string()));
        assert_eq!(split_texts(&texts, true), ("Léa".to_string(), String::new()));
        assert_eq!(split_texts(&[], false), (String::new(), String::new()));
    }

    #[test]
    fn long_texts_are_clipped() {
        let long = "é".repeat(500);
        let out = clip(&long);
        assert_eq!(out.chars().count(), MAX_TEXT + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    #[ignore]
    fn live_listener_reads_the_center() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let listener = UserNotificationListener::Current().unwrap();
        println!("access {:?}", access(&listener));
        match listener.GetNotificationsAsync(NotificationKinds::Toast).and_then(|op| op.get()) {
            Ok(list) => {
                println!("count {}", list.Size().unwrap_or(0));
                let mut logos = HashMap::new();
                for n in list {
                    let id = n.Id().unwrap_or(0);
                    println!("{:?}", notice(&n, id, &mut logos).map(|x| (x.app, x.app_id, x.title.len(), x.body.len(), x.logo.is_some())));
                }
            }
            Err(err) => println!("error {err:?}"),
        }
    }

    #[test]
    #[ignore]
    fn live_listener_events() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let listener = UserNotificationListener::Current().unwrap();
        let started = std::time::Instant::now();
        let handler = windows::Foundation::TypedEventHandler::new(move |_, args: windows::core::Ref<windows::UI::Notifications::UserNotificationChangedEventArgs>| {
            if let Some(a) = args.as_ref() {
                println!("event {:?} id {:?} after {} ms", a.ChangeKind(), a.UserNotificationId(), started.elapsed().as_millis());
            }
            Ok(())
        });
        match listener.NotificationChanged(&handler) {
            Ok(token) => {
                println!("subscribed");
                std::thread::sleep(std::time::Duration::from_secs(12));
                let _ = listener.RemoveNotificationChanged(token);
            }
            Err(err) => println!("subscribe failed {err:?}"),
        }
    }

    #[test]
    fn only_plain_app_ids_can_be_opened() {
        assert!(valid_app_id("com.squirrel.Discord.Discord"));
        assert!(valid_app_id("Microsoft.WindowsStore_8wekyb3d8bbwe!App"));
        assert!(!valid_app_id(""));
        assert!(!valid_app_id("..\\..\\Windows"));
        assert!(!valid_app_id("a\" & calc"));
    }
}
