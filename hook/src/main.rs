use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);

const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);

const DECISION_BUDGET: Duration = Duration::from_secs(100);

const ERROR_PIPE_BUSY: i32 = 231;

const DROPPED_RESPONSE_FIELDS: &[&str] = &["originalFile", "base64"];

const MAX_FIELD_LEN: usize = 2_000;

const MAX_OUTPUT_TAIL: usize = 1_500;

const MAX_LIST_LEN: usize = 60;

const MAX_LINE_LEN: usize = 256 * 1024;

const GATED_AGENT_TOOLS: &[&str] = &[
    "browser_navigate", "browser_navigate_back", "browser_click", "browser_type",
    "browser_fill_form", "browser_press_key", "browser_select_option", "browser_evaluate",
    "browser_run_code_unsafe", "browser_file_upload", "browser_drag", "browser_drop",
    "browser_handle_dialog", "browser_tabs",
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Wait {
    None,
    Permission,
    AgentAction,
    Review,
}

fn wait_for(event: &str, origin: &str, tool: &str, review: bool) -> Wait {
    if event == "PermissionRequest" {
        return Wait::Permission;
    }
    let browser_tool = tool.strip_prefix("mcp__playwright__").unwrap_or("");
    if event == "PreToolUse" && origin == "chat" && GATED_AGENT_TOOLS.contains(&browser_tool) {
        return Wait::AgentAction;
    }
    if event == "PreToolUse" && origin != "chat" && review && snapshot::EDIT_TOOLS.contains(&tool) {
        return Wait::Review;
    }
    Wait::None
}

enum Talk {
    Unreachable,
    Answer(Option<String>),
}

mod mcp;
mod review;
mod screen;
mod snapshot;
mod win;

fn pipe_path() -> String {
    let key = win::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\tako-{key}")
}

fn connect() -> Option<std::fs::File> {
    use std::os::windows::io::AsRawHandle;
    let path = pipe_path();
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => {
                let handle = windows::Win32::Foundation::HANDLE(file.as_raw_handle());
                return win::pipe_server_is_same_user(handle).then_some(file);
            }
            Err(err) => {
                if err.raw_os_error() != Some(ERROR_PIPE_BUSY) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        mcp::serve();
        return;
    }
    let started = Instant::now();
    let Some((payload, wait)) = read_event() else { std::process::exit(0) };

    let waits_for_answer = wait != Wait::None;
    let budget = if waits_for_answer { DECISION_BUDGET.saturating_sub(started.elapsed()) } else { FIRE_AND_FORGET_BUDGET };

    let (tx, rx) = mpsc::channel::<Talk>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    let (reachable, decision) = match rx.recv_timeout(budget) {
        Ok(Talk::Unreachable) => (false, None),
        Ok(Talk::Answer(answer)) => (true, answer),
        Err(_) => (true, None),
    };
    let json = match wait {
        Wait::Permission => decision.as_deref().and_then(decision_json),
        Wait::AgentAction => Some(agent_decision_json(decision.as_deref().unwrap_or("deny"))),
        Wait::Review => review_decision_json(reachable, decision.as_deref()),
        Wait::None => None,
    };
    if let Some(json) = json {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{json}");
        let _ = out.flush();
    }

    std::process::exit(0);
}

fn agent_decision_json(decision: &str) -> String {
    match decision.trim() {
        "allow" | "always" => {
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#.to_string()
        }
        _ => r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The user did not allow this browser action in Tako."}}"#.to_string(),
    }
}

fn pre_tool_deny(reason: &str) -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
    .to_string()
}

fn review_decision_json(reachable: bool, decision: Option<&str>) -> Option<String> {
    if !reachable {
        return None;
    }
    match decision.map(str::trim) {
        Some("allow") | Some("always") => {
            Some(r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#.to_string())
        }
        Some("pass") => None,
        Some("deny") => Some(pre_tool_deny(
            "The user rejected this edit in Tako's review. Ask them what they want changed instead.",
        )),
        _ => Some(pre_tool_deny("This edit was not approved in Tako in time, so it was not applied.")),
    }
}

fn decision_json(decision: &str) -> Option<String> {
    let behavior = match decision.trim() {
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Tako"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

fn read_event() -> Option<(String, Wait)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }

    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    let arg_event = std::env::args().nth(1).unwrap_or_default();
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    let origin = std::env::var("TAKO_ORIGIN").unwrap_or_default();
    let tool = map.get("tool_name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let data = snapshot::data_dir();
    let review_on = data.as_ref().map(|d| d.join("review-mode").exists()).unwrap_or(false);
    let wait = wait_for(&event, &origin, &tool, review_on);
    if wait == Wait::AgentAction || wait == Wait::Review {
        map.insert("await_decision".into(), serde_json::Value::Bool(true));
    }

    let mut review_preview = None;
    if origin != "chat" {
        let session = map.get("session_id").and_then(|v| v.as_str()).and_then(snapshot::safe_id);
        let cwd = map.get("cwd").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let input = map.get("tool_input").cloned().unwrap_or(serde_json::Value::Null);
        if let (Some(dir), Some(session)) = (data.as_ref(), session) {
            match event.as_str() {
                "UserPromptSubmit" => snapshot::start_turn(dir, &session),
                "PreToolUse" => {
                    if let Some(path) = snapshot::target_path(&tool, &input, &cwd) {
                        if wait == Wait::Review {
                            review_preview = Some(review::preview(&tool, &input, &path));
                        }
                        snapshot::before(dir, &session, &path);
                    }
                }
                "PostToolUse" => {
                    if let Some(path) = snapshot::target_path(&tool, &input, &cwd) {
                        snapshot::after(dir, &session, &path);
                    }
                }
                _ => {}
            }
        }
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
        ("tako_origin", "TAKO_ORIGIN"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    if let Some(response) = map.get_mut("tool_response") {
        slim_response(response);
    }

    truncate_strings(&mut payload);
    cap_lists(&mut payload);
    if let (Some(preview), Some(map)) = (review_preview, payload.as_object_mut()) {
        map.insert("tako_review".into(), preview);
    }

    let mut line = payload.to_string();
    if line.len() > MAX_LINE_LEN {
        if let Some(map) = payload.as_object_mut() {
            map.remove("tool_response");
        }
        line = payload.to_string();
    }
    line.push('\n');
    Some((line, wait))
}

fn slim_response(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for field in DROPPED_RESPONSE_FIELDS {
                map.remove(*field);
            }
            for key in ["stdout", "stderr"] {
                if let Some(serde_json::Value::String(s)) = map.get_mut(key) {
                    keep_tail(s, MAX_OUTPUT_TAIL);
                }
            }
            map.values_mut().for_each(slim_response);
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(slim_response),
        _ => {}
    }
}

fn keep_tail(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    *s = format!("…{}", &s[start..]);
}

fn cap_lists(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            items.truncate(MAX_LIST_LEN);
            items.iter_mut().for_each(cap_lists);
        }
        serde_json::Value::Object(map) => map.values_mut().for_each(cap_lists),
        _ => {}
    }
}

fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

fn talk(payload: &str, waits_for_answer: bool) -> Talk {
    let Some(mut pipe) = connect() else { return Talk::Unreachable };

    if pipe.write_all(payload.as_bytes()).is_err() {
        return Talk::Unreachable;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return Talk::Answer(None);
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    Talk::Answer((!answer.is_empty()).then_some(answer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Tako"}}}"#
        );
        assert!(decision_json("always").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("").is_none());
        assert!(decision_json("maybe").is_none());
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#).is_none());
    }

    #[test]
    fn only_the_chat_agents_acting_browser_tools_wait() {
        assert_eq!(wait_for("PermissionRequest", "", "Bash", false), Wait::Permission);
        assert_eq!(wait_for("PreToolUse", "chat", "mcp__playwright__browser_navigate", false), Wait::AgentAction);
        assert_eq!(wait_for("PreToolUse", "chat", "mcp__playwright__browser_click", false), Wait::AgentAction);
        assert_eq!(wait_for("PreToolUse", "chat", "mcp__playwright__browser_snapshot", false), Wait::None);
        assert_eq!(wait_for("PreToolUse", "", "mcp__playwright__browser_navigate", false), Wait::None);
        assert_eq!(wait_for("PreToolUse", "chat", "Read", false), Wait::None);
    }

    #[test]
    fn review_mode_holds_edits_from_terminal_sessions_only() {
        assert_eq!(wait_for("PreToolUse", "", "Edit", true), Wait::Review);
        assert_eq!(wait_for("PreToolUse", "mission", "Write", true), Wait::Review);
        assert_eq!(wait_for("PreToolUse", "", "Edit", false), Wait::None);
        assert_eq!(wait_for("PreToolUse", "chat", "Edit", true), Wait::None);
        assert_eq!(wait_for("PreToolUse", "", "Bash", true), Wait::None);
        assert_eq!(wait_for("PostToolUse", "", "Edit", true), Wait::None);
    }

    #[test]
    fn review_answers_map_to_pre_tool_decisions() {
        assert_eq!(review_decision_json(false, None), None);
        assert_eq!(review_decision_json(false, Some("deny")), None);
        assert_eq!(review_decision_json(true, Some("pass")), None);
        assert!(review_decision_json(true, Some("allow")).unwrap().contains(r#""permissionDecision":"allow""#));
        assert!(review_decision_json(true, Some("deny")).unwrap().contains(r#""permissionDecision":"deny""#));
        assert!(review_decision_json(true, None).unwrap().contains("in time"));
        assert!(review_decision_json(true, Some("maybe")).unwrap().contains(r#""permissionDecision":"deny""#));
    }

    #[test]
    fn an_unanswered_agent_action_is_denied() {
        assert!(agent_decision_json("allow").contains(r#""permissionDecision":"allow""#));
        assert!(agent_decision_json("deny").contains(r#""permissionDecision":"deny""#));
        assert!(agent_decision_json("").contains(r#""permissionDecision":"deny""#));
        assert!(agent_decision_json("maybe").contains(r#""permissionDecision":"deny""#));
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn tool_response_keeps_the_diff_and_the_end_of_the_output() {
        let mut v = serde_json::json!({
            "originalFile": "x".repeat(10_000),
            "structuredPatch": [{ "oldStart": 12, "lines": ["-a", "+b"] }],
            "stdout": format!("{}Tests: 48 passed", "é".repeat(2_000)),
        });
        slim_response(&mut v);
        assert!(v.get("originalFile").is_none());
        assert_eq!(v["structuredPatch"][0]["oldStart"], 12);
        let out = v["stdout"].as_str().unwrap();
        assert!(out.starts_with('…'));
        assert!(out.ends_with("Tests: 48 passed"));
        assert!(out.len() <= MAX_OUTPUT_TAIL + 4);
    }

    #[test]
    fn long_lists_are_capped() {
        let lines: Vec<String> = (0..5_000).map(|i| format!("+line {i}")).collect();
        let mut v = serde_json::json!({ "structuredPatch": [{ "lines": lines }] });
        cap_lists(&mut v);
        assert_eq!(v["structuredPatch"][0]["lines"].as_array().unwrap().len(), MAX_LIST_LEN);
    }
}
