use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::island::WINDOW_LABEL;
use crate::Shared;

pub struct Items {
    pub usage: CheckMenuItem<Wry>,
}

fn usage_shown(app: &AppHandle) -> bool {
    app.state::<Shared>().settings.lock().unwrap().usage_widget
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Tako", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let usage = CheckMenuItem::with_id(app, "usage", "Usage widget", true, usage_shown(app), None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &sep1, &settings, &usage, &pause, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("tako")
        .tooltip("Tako")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "usage" => crate::widget::set_visible(app, !usage_shown(app)),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    app.manage(Items { usage });
    Ok(())
}
