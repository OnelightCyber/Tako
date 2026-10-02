use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::island::WINDOW_LABEL;
use crate::log;

const EVERY: Duration = Duration::from_secs(20 * 60);
const TIMEOUT: Duration = Duration::from_secs(10);

static ENABLED: AtomicBool = AtomicBool::new(true);
static CITY: Mutex<String> = Mutex::new(String::new());
static CURRENT: Mutex<Option<Weather>> = Mutex::new(None);
static FAILED: Mutex<Option<String>> = Mutex::new(None);
static WAKE: OnceLock<Notify> = OnceLock::new();

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub date: String,
    pub code: i64,
    pub max: f64,
    pub min: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    pub city: String,
    pub temp: f64,
    pub code: i64,
    pub is_day: bool,
    pub max: f64,
    pub min: f64,
    pub wind: f64,
    pub humidity: f64,
    pub days: Vec<Day>,
}

#[derive(Deserialize)]
struct Place {
    name: String,
    latitude: f64,
    longitude: f64,
}

#[derive(Deserialize)]
struct Places {
    #[serde(default)]
    results: Vec<Place>,
}

#[derive(Deserialize)]
struct Current {
    temperature_2m: f64,
    weather_code: i64,
    is_day: i64,
    #[serde(default)]
    wind_speed_10m: f64,
    #[serde(default)]
    relative_humidity_2m: f64,
}

#[derive(Deserialize)]
struct Daily {
    #[serde(default)]
    time: Vec<String>,
    #[serde(default)]
    weather_code: Vec<i64>,
    #[serde(default)]
    temperature_2m_max: Vec<f64>,
    #[serde(default)]
    temperature_2m_min: Vec<f64>,
}

#[derive(Deserialize)]
struct Forecast {
    current: Current,
    daily: Daily,
}

fn wake() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

pub fn configure(enabled: bool, city: &str) {
    let city = city.trim().to_string();
    let was = ENABLED.swap(enabled, Ordering::Relaxed);
    let changed = {
        let mut current = CITY.lock().unwrap();
        let changed = *current != city;
        *current = city;
        changed
    };
    if changed {
        *FAILED.lock().unwrap() = None;
    }
    if changed || (enabled && !was) {
        wake().notify_one();
    }
}

pub fn current() -> Option<Weather> {
    CURRENT.lock().unwrap().clone()
}

pub fn failure() -> Option<String> {
    FAILED.lock().unwrap().clone()
}

pub fn refresh() {
    wake().notify_one();
}

async fn fetch(client: &reqwest::Client, city: &str) -> Result<Weather, String> {
    let places: Places = client
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[("name", city), ("count", "1"), ("language", "fr"), ("format", "json")])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let place = places.results.into_iter().next().ok_or_else(|| format!("ville introuvable : {city}"))?;
    let lat = place.latitude.to_string();
    let lon = place.longitude.to_string();
    let forecast: Forecast = client
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", lat.as_str()),
            ("longitude", lon.as_str()),
            ("current", "temperature_2m,weather_code,is_day,wind_speed_10m,relative_humidity_2m"),
            ("daily", "weather_code,temperature_2m_max,temperature_2m_min"),
            ("timezone", "auto"),
            ("forecast_days", "6"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let daily = &forecast.daily;
    let days = daily
        .time
        .iter()
        .enumerate()
        .map(|(i, date)| Day {
            date: date.clone(),
            code: daily.weather_code.get(i).copied().unwrap_or(0),
            max: daily.temperature_2m_max.get(i).copied().unwrap_or(0.0),
            min: daily.temperature_2m_min.get(i).copied().unwrap_or(0.0),
        })
        .collect();
    Ok(Weather {
        city: place.name,
        temp: forecast.current.temperature_2m,
        code: forecast.current.weather_code,
        is_day: forecast.current.is_day == 1,
        max: daily.temperature_2m_max.first().copied().unwrap_or(forecast.current.temperature_2m),
        min: daily.temperature_2m_min.first().copied().unwrap_or(forecast.current.temperature_2m),
        wind: forecast.current.wind_speed_10m,
        humidity: forecast.current.relative_humidity_2m,
        days,
    })
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().timeout(TIMEOUT).build() {
            Ok(c) => c,
            Err(err) => {
                log::line(format!("weather: {err}"));
                return;
            }
        };
        loop {
            let city = CITY.lock().unwrap().clone();
            if ENABLED.load(Ordering::Relaxed) && !city.is_empty() {
                match fetch(&client, &city).await {
                    Ok(w) => {
                        if CITY.lock().unwrap().as_str() == city {
                            *CURRENT.lock().unwrap() = Some(w.clone());
                            *FAILED.lock().unwrap() = None;
                            let _ = app.emit_to(WINDOW_LABEL, "weather", Some(w));
                        }
                    }
                    Err(err) => {
                        log::line(format!("weather: {err}"));
                        let missing = err.starts_with("ville introuvable");
                        *FAILED.lock().unwrap() = Some(if missing { "missing".into() } else { "offline".into() });
                        if missing {
                            *CURRENT.lock().unwrap() = None;
                            let _ = app.emit_to(WINDOW_LABEL, "weather", None::<Weather>);
                        }
                    }
                }
            } else if CURRENT.lock().unwrap().take().is_some() {
                let _ = app.emit_to(WINDOW_LABEL, "weather", None::<Weather>);
            }
            tokio::select! {
                _ = tokio::time::sleep(EVERY) => {}
                _ = wake().notified() => {}
            }
        }
    });
}
