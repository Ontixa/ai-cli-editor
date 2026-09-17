use serde::Serialize;
use thiserror::Error;

/// Application error type. Serialized to a plain string for the frontend so
/// `invoke()` rejections stay simple to display.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("path not found: {0}")]
    NotFound(String),

    #[error("path escapes the workspace root: {0}")]
    OutsideWorkspace(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("no workspace is open")]
    NoWorkspace,

    #[error("{0}")]
    Internal(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
