use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::{apps, screen};

const MAX_SIDE: u32 = 1568;

pub fn serve() {
    let enabled = std::env::var("TAKO_MCP_TOOLS").unwrap_or_else(|_| "screen".into());
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue };
        let reply = match handle(&msg, &enabled) {
            Some(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            None => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } }),
        };
        if writeln!(out, "{reply}").is_err() || out.flush().is_err() {
            break;
        }
    }
}

fn wants(enabled: &str, part: &str) -> bool {
    enabled.split(',').any(|p| p.trim() == part)
}

fn tools(enabled: &str) -> Vec<Value> {
    let mut list = Vec::new();
    if wants(enabled, "screen") {
        list.push(screenshot_tool());
    }
    if wants(enabled, "apps") {
        list.push(open_app_tool());
    }
    list
}

fn handle(msg: &Value, enabled: &str) -> Option<Value> {
    match msg.get("method").and_then(Value::as_str)? {
        "initialize" => Some(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "tako", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Some(json!({})),
        "tools/list" => Some(json!({ "tools": tools(enabled) })),
        "tools/call" => Some(call(&msg["params"], enabled)),
        _ => None,
    }
}

fn screenshot_tool() -> Value {
    json!({
        "name": "screenshot",
        "description": "Capture the user's main display and return it as an image. Use it whenever the question is about something the user is looking at right now: an error on screen, a page, a design, a window, 'this', 'here', 'what do you see'. Do not use it otherwise.",
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    })
}

fn open_app_tool() -> Value {
    json!({
        "name": "open_app",
        "description": "Open an application installed on the user's PC, found by its Start menu name (for example Spotify, Discord, Paint, Bloc-notes). Use it only when the user asks to open or launch an app. The app keeps running after you answer.",
        "inputSchema": {
            "type": "object",
            "properties": { "name": { "type": "string", "description": "The app's name as the user said it." } },
            "required": ["name"],
            "additionalProperties": false
        }
    })
}

fn text(ok: bool, message: String) -> Value {
    if ok {
        json!({ "content": [{ "type": "text", "text": message }] })
    } else {
        json!({ "content": [{ "type": "text", "text": message }], "isError": true })
    }
}

fn call(params: &Value, enabled: &str) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let arg = params["arguments"].get("name").and_then(Value::as_str).unwrap_or_default().trim().chars().take(80).collect::<String>();
    match name {
        "screenshot" if wants(enabled, "screen") => match screen::capture(MAX_SIDE) {
            Ok(shot) => json!({
                "content": [
                    { "type": "image", "data": screen::base64(&shot.png), "mimeType": "image/png" },
                    { "type": "text", "text": format!("Screenshot of the user's main display, {}x{} px.", shot.width, shot.height) }
                ]
            }),
            Err(err) => text(false, err),
        },
        "open_app" if wants(enabled, "apps") => {
            if arg.is_empty() {
                return text(false, "Say which app to open.".into());
            }
            let (ok, message) = apps::open(&arg);
            text(ok, message)
        }
        _ => text(false, "Unknown tool.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_lists_one_screenshot_tool_and_ignores_unknown_methods() {
        let list = handle(&json!({ "method": "tools/list" }), "screen").unwrap();
        assert_eq!(list["tools"][0]["name"], "screenshot");
        assert_eq!(list["tools"].as_array().unwrap().len(), 1);
        assert!(handle(&json!({ "method": "resources/list" }), "screen").is_none());
        let init = handle(&json!({ "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }), "screen").unwrap();
        assert_eq!(init["protocolVersion"], "2025-06-18");
    }

    #[test]
    fn app_tools_only_exist_when_enabled() {
        let both = handle(&json!({ "method": "tools/list" }), "screen,apps").unwrap();
        let names: Vec<&str> = both["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["screenshot", "open_app"]);
        let apps_only = handle(&json!({ "method": "tools/list" }), "apps").unwrap();
        assert_eq!(apps_only["tools"].as_array().unwrap().len(), 1);
        let refused = call(&json!({ "name": "open_app", "arguments": { "name": "Paint" } }), "screen");
        assert_eq!(refused["isError"], true);
        let shot = call(&json!({ "name": "screenshot" }), "apps");
        assert_eq!(shot["isError"], true);
    }
}
