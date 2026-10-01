use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::screen;

const MAX_SIDE: u32 = 1568;

pub fn serve() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue };
        let reply = match handle(&msg) {
            Some(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            None => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } }),
        };
        if writeln!(out, "{reply}").is_err() || out.flush().is_err() {
            break;
        }
    }
}

fn handle(msg: &Value) -> Option<Value> {
    match msg.get("method").and_then(Value::as_str)? {
        "initialize" => Some(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "tako", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Some(json!({})),
        "tools/list" => Some(json!({ "tools": [screenshot_tool()] })),
        "tools/call" => Some(call(&msg["params"])),
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

fn call(params: &Value) -> Value {
    if params.get("name").and_then(Value::as_str) != Some("screenshot") {
        return json!({ "content": [{ "type": "text", "text": "Unknown tool." }], "isError": true });
    }
    match screen::capture(MAX_SIDE) {
        Ok(shot) => json!({
            "content": [
                { "type": "image", "data": screen::base64(&shot.png), "mimeType": "image/png" },
                { "type": "text", "text": format!("Screenshot of the user's main display, {}x{} px.", shot.width, shot.height) }
            ]
        }),
        Err(err) => json!({ "content": [{ "type": "text", "text": err }], "isError": true }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_lists_one_screenshot_tool_and_ignores_unknown_methods() {
        let list = handle(&json!({ "method": "tools/list" })).unwrap();
        assert_eq!(list["tools"][0]["name"], "screenshot");
        assert!(handle(&json!({ "method": "resources/list" })).is_none());
        let init = handle(&json!({ "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })).unwrap();
        assert_eq!(init["protocolVersion"], "2025-06-18");
    }
}
