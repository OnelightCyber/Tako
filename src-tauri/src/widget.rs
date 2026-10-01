use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::settings::Settings;
use crate::{island, log, Shared};

pub const LABEL: &str = "usage";
const PRESETS: [&str; 4] = ["island-right", "island-left", "corner-right", "corner-left"];
const GAP: f64 = 440.0;
const EDGE: f64 = 12.0;
const SNAP: f64 = 28.0;

static DRAGGING: AtomicBool = AtomicBool::new(false);

struct Frame {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/usage.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("usage.html".into())
}

pub fn create(app: &AppHandle) {
    match WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Tako usage")
        .inner_size(190.0, 36.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
    {
        Ok(win) => island::make_non_activating(&win),
        Err(err) => log::line(format!("usage window failed: {err}")),
    }
}

fn frame(app: &AppHandle, screen: &str) -> Option<Frame> {
    let m = island::target_monitor(app, screen)?;
    let (p, s) = (*m.position(), *m.size());
    Some(Frame { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64, scale: m.scale_factor() })
}

fn preset(name: &str, f: &Frame, w: f64) -> (f64, f64) {
    let centre = f.x + f.w / 2.0;
    let (gap, edge) = (GAP * f.scale, EDGE * f.scale);
    match name {
        "island-left" => (centre - gap - w, f.y),
        "corner-right" => (f.x + f.w - w - edge, f.y + edge),
        "corner-left" => (f.x + edge, f.y + edge),
        _ => (centre + gap, f.y),
    }
}

fn clamp(f: &Frame, x: f64, y: f64, w: f64, h: f64) -> (f64, f64) {
    (x.min(f.x + f.w - w).max(f.x), y.min(f.y + f.h - h).max(f.y))
}

fn spot(s: &Settings, f: &Frame, w: f64, h: f64) -> (f64, f64) {
    let (x, y) = if s.usage_position == "custom" {
        (f.x + s.usage_x * f.w, f.y + s.usage_y * f.h)
    } else {
        preset(&s.usage_position, f, w)
    };
    clamp(f, x, y, w, h)
}

fn current(app: &AppHandle) -> Settings {
    app.state::<Shared>().settings.lock().unwrap().clone()
}

fn move_to(win: &WebviewWindow, x: f64, y: f64) {
    let _ = win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

pub fn place(app: &AppHandle, width: f64, height: f64) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let s = current(app);
    let Some(f) = frame(app, &s.screen) else { return };
    let w = (width * f.scale).round().max(1.0);
    let h = (height * f.scale).round().max(1.0);
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    if !DRAGGING.load(Ordering::SeqCst) {
        let (x, y) = spot(&s, &f, w, h);
        move_to(&win, x, y);
    }
    let _ = win.set_always_on_top(true);
}

pub fn sync(app: &AppHandle, s: &Settings) {
    if let Some(items) = app.try_state::<crate::tray::Items>() {
        let _ = items.usage.set_checked(s.usage_widget);
    }
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let _ = if s.usage_widget { win.show() } else { win.hide() };
}

fn store(app: &AppHandle, change: impl FnOnce(&mut Settings)) -> Settings {
    let updated = {
        let shared = app.state::<Shared>();
        let mut s = shared.settings.lock().unwrap();
        change(&mut s);
        s.clone()
    };
    if let Err(err) = crate::settings::save(&updated) {
        log::line(format!("settings not saved: {err}"));
    }
    let _ = app.emit("settings-changed", &updated);
    updated
}

pub fn set_visible(app: &AppHandle, visible: bool) {
    let updated = store(app, |s| s.usage_widget = visible);
    sync(app, &updated);
}

fn settle(app: &AppHandle, win: &WebviewWindow, start: PhysicalPosition<i32>) {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
    if (pos.x - start.x).abs() < 4 && (pos.y - start.y).abs() < 4 {
        return;
    }
    let Some(f) = frame(app, &current(app).screen) else { return };
    let (w, h) = (size.width as f64, size.height as f64);
    let (x, y) = clamp(&f, pos.x as f64, pos.y as f64, w, h);
    let snap = SNAP * f.scale;
    let near = PRESETS.into_iter().find(|p| {
        let (px, py) = preset(p, &f, w);
        (px - x).abs() < snap && (py - y).abs() < snap
    });
    let y = if y - f.y < snap { f.y } else { y };
    let updated = store(app, |s| match near {
        Some(p) => s.usage_position = p.to_string(),
        None => {
            s.usage_position = "custom".into();
            s.usage_x = (x - f.x) / f.w;
            s.usage_y = (y - f.y) / f.h;
        }
    });
    let (x, y) = spot(&updated, &f, w, h);
    move_to(win, x, y);
}

#[tauri::command]
pub fn usage_resize(app: AppHandle, width: f64, height: f64) {
    place(&app, width, height);
}

#[tauri::command]
pub fn usage_close(app: AppHandle) {
    set_visible(&app, false);
}

#[tauri::command]
pub fn usage_drag(app: AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let Ok(start) = win.outer_position() else { return };
    if !island::primary_button_down() {
        let _ = app.emit_to(LABEL, "usage-drag-end", ());
        return;
    }
    if DRAGGING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(err) = win.start_dragging() {
        log::line(format!("usage drag failed: {err}"));
        DRAGGING.store(false, Ordering::SeqCst);
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(60)).await;
        for _ in 0..4000 {
            if !island::primary_button_down() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        DRAGGING.store(false, Ordering::SeqCst);
        settle(&app, &win, start);
        let _ = app.emit_to(LABEL, "usage-drag-end", ());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> Frame {
        Frame { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0, scale: 1.0 }
    }

    #[test]
    fn presets_sit_beside_the_island_or_in_a_corner() {
        let f = screen();
        assert_eq!(preset("island-right", &f, 200.0), (1400.0, 0.0));
        assert_eq!(preset("island-left", &f, 200.0), (320.0, 0.0));
        assert_eq!(preset("corner-right", &f, 200.0), (1708.0, 12.0));
        assert_eq!(preset("corner-left", &f, 200.0), (12.0, 12.0));
    }

    #[test]
    fn a_custom_spot_never_leaves_the_screen() {
        let f = screen();
        let mut s = Settings::default();
        s.usage_position = "custom".into();
        s.usage_x = 0.99;
        s.usage_y = 0.99;
        assert_eq!(spot(&s, &f, 200.0, 36.0), (1720.0, 1044.0));
        s.usage_x = 0.25;
        s.usage_y = 0.0;
        assert_eq!(spot(&s, &f, 200.0, 36.0), (480.0, 0.0));
    }
}
