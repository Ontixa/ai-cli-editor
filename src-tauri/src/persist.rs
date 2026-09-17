//! Workspace/UI state persistence: a single versioned JSON document in the
//! app's data directory. Writes go through tmp+rename to survive crashes;
//! corrupt files degrade to defaults rather than failing startup.

use crate::error::AppResult;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "workspace-state.json";

fn state_path(app_data: &Path) -> PathBuf {
    app_data.join(FILE_NAME)
}

pub fn load(app_data: PathBuf) -> Option<Value> {
    let path = state_path(&app_data);
    let bytes = fs::read(path).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("version")?;
    Some(v)
}

pub fn save(app_data: PathBuf, state: &Value) -> AppResult<()> {
    fs::create_dir_all(&app_data)?;
    let path = state_path(&app_data);
    let tmp = app_data.join(format!("{FILE_NAME}.tmp"));
    let bytes = serde_json::to_vec_pretty(state)?;
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}
