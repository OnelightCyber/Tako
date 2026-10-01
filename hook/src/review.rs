use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use similar::{ChangeTag, TextDiff};

const MAX_LINES: usize = 300;
const MAX_TEXT: usize = 400;
const MAX_READ: u64 = 2 * 1024 * 1024;
const MAX_PROPOSED: usize = 2 * 1024 * 1024;
const DIFF_TIMEOUT: Duration = Duration::from_millis(1500);

fn apply(text: &str, edit: &Value) -> Option<String> {
    let old = edit.get("old_string")?.as_str()?;
    let new = edit.get("new_string")?.as_str()?;
    let all = edit.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
    if old.is_empty() {
        return text.is_empty().then(|| new.to_string());
    }
    let (old, new) = if !text.contains(old) && text.contains("\r\n") {
        (old.replace("\r\n", "\n").replace('\n', "\r\n"), new.replace("\r\n", "\n").replace('\n', "\r\n"))
    } else {
        (old.to_string(), new.to_string())
    };
    if !text.contains(&old) {
        return None;
    }
    Some(if all { text.replace(&old, &new) } else { text.replacen(&old, &new, 1) })
}

pub fn proposed(tool: &str, input: &Value, before: &str) -> Option<String> {
    match tool {
        "Write" => input.get("content").and_then(Value::as_str).map(str::to_string),
        "Edit" => apply(before, input),
        "MultiEdit" => {
            let mut text = before.to_string();
            for edit in input.get("edits")?.as_array()? {
                text = apply(&text, edit)?;
            }
            Some(text)
        }
        _ => None,
    }
}

fn clip(s: &str) -> String {
    if s.len() <= MAX_TEXT {
        return s.to_string();
    }
    let mut end = MAX_TEXT;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_READ {
        return None;
    }
    String::from_utf8(std::fs::read(path).ok()?).ok()
}

pub fn diff_lines(before: &str, after: &str) -> Value {
    let diff = TextDiff::configure().timeout(DIFF_TIMEOUT).diff_lines(before, after);
    let mut lines: Vec<Value> = Vec::new();
    let (mut added, mut removed) = (0usize, 0usize);
    let mut truncated = false;
    for (i, group) in diff.grouped_ops(3).iter().enumerate() {
        if i > 0 && lines.len() < MAX_LINES {
            lines.push(json!({ "kind": "sep", "text": "", "no": null }));
        }
        for op in group {
            for change in diff.iter_changes(op) {
                let (kind, no) = match change.tag() {
                    ChangeTag::Equal => ("ctx", change.new_index()),
                    ChangeTag::Insert => {
                        added += 1;
                        ("add", change.new_index())
                    }
                    ChangeTag::Delete => {
                        removed += 1;
                        ("del", change.old_index())
                    }
                };
                if lines.len() < MAX_LINES {
                    let text = clip(change.value().trim_end_matches(['\n', '\r']));
                    lines.push(json!({ "kind": kind, "text": text, "no": no.map(|n| n + 1) }));
                } else {
                    truncated = true;
                }
            }
        }
    }
    json!({ "lines": lines, "added": added, "removed": removed, "truncated": truncated })
}

pub fn preview(tool: &str, input: &Value, path: &Path) -> Value {
    let existed = path.is_file();
    let before = if existed { read_text(path) } else { Some(String::new()) };
    let Some(before) = before else {
        return json!({ "path": path, "created": false, "unreadable": true });
    };
    let Some(after) = proposed(tool, input, &before) else {
        return json!({ "path": path, "created": !existed, "unknown": true });
    };
    if after.len() > MAX_PROPOSED {
        return json!({ "path": path, "created": !existed, "unreadable": true });
    }
    let mut out = diff_lines(&before, &after);
    out["path"] = json!(path);
    out["created"] = json!(!existed);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_replaces_the_first_match_only() {
        let edit = json!({ "old_string": "a", "new_string": "b" });
        assert_eq!(proposed("Edit", &edit, "a a").as_deref(), Some("b a"));
        let all = json!({ "old_string": "a", "new_string": "b", "replace_all": true });
        assert_eq!(proposed("Edit", &all, "a a").as_deref(), Some("b b"));
    }

    #[test]
    fn crlf_files_still_match_lf_edits() {
        let edit = json!({ "old_string": "x\ny", "new_string": "x\nz" });
        assert_eq!(proposed("Edit", &edit, "x\r\ny\r\n").as_deref(), Some("x\r\nz\r\n"));
    }

    #[test]
    fn multi_edits_apply_in_order_and_fail_as_a_whole() {
        let ok = json!({ "edits": [
            { "old_string": "one", "new_string": "two" },
            { "old_string": "two", "new_string": "three" },
        ] });
        assert_eq!(proposed("MultiEdit", &ok, "one").as_deref(), Some("three"));
        let bad = json!({ "edits": [{ "old_string": "missing", "new_string": "x" }] });
        assert_eq!(proposed("MultiEdit", &bad, "one"), None);
    }

    #[test]
    fn the_diff_counts_and_numbers_lines() {
        let v = diff_lines("a\nb\nc\n", "a\nB\nc\nd\n");
        assert_eq!(v["added"], 2);
        assert_eq!(v["removed"], 1);
        let kinds: Vec<&str> = v["lines"].as_array().unwrap().iter().map(|l| l["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["ctx", "del", "add", "ctx", "add"]);
        assert_eq!(v["lines"][2]["no"], 2);
        assert_eq!(v["lines"][4]["no"], 4);
    }
}
