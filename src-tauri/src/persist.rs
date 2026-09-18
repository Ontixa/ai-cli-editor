//! Workspace/UI state persistence: versioned JSON documents in the app's
//! data directory. Writes go through tmp+rename to survive crashes;
//! corrupt files degrade to defaults rather than failing startup.
//!
//! Two documents exist: `workspace-state.json` (frontend-owned UI state)
//! and `sessions.json` (backend-owned agent-session history). Both use the
//! same atomic write path.

use crate::error::AppResult;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const STATE_FILE: &str = "workspace-state.json";
const SESSIONS_FILE: &str = "sessions.json";

fn path_for(app_data: &Path, name: &str) -> PathBuf {
    app_data.join(name)
}

fn load_doc(app_data: &Path, name: &str) -> Option<Value> {
    let bytes = fs::read(path_for(app_data, name)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn save_doc(app_data: &Path, name: &str, state: &Value) -> AppResult<()> {
    fs::create_dir_all(app_data)?;
    let path = path_for(app_data, name);
    let tmp = app_data.join(format!("{name}.tmp"));
    let bytes = serde_json::to_vec_pretty(state)?;
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn load(app_data: PathBuf) -> Option<Value> {
    let v = load_doc(&app_data, STATE_FILE)?;
    v.get("version")?;
    Some(v)
}

pub fn save(app_data: PathBuf, state: &Value) -> AppResult<()> {
    save_doc(&app_data, STATE_FILE, state)
}

/// Backend-owned session history. Versioned envelope so future migrations
/// can detect shape changes; corrupt data degrades to empty history.
pub fn load_sessions(app_data: &Path) -> Vec<crate::session::PersistedSession> {
    let Some(v) = load_doc(app_data, SESSIONS_FILE) else {
        return Vec::new();
    };
    if v.get("version").and_then(|x| x.as_u64()) != Some(2) {
        return Vec::new();
    }
    v.get("sessions")
        .cloned()
        .and_then(|s| serde_json::from_value(s).ok())
        .unwrap_or_default()
}

pub fn save_sessions(
    app_data: &Path,
    sessions: &[crate::session::PersistedSession],
) -> AppResult<()> {
    let doc = serde_json::json!({ "version": 2, "sessions": sessions });
    save_doc(app_data, SESSIONS_FILE, &doc)
}
