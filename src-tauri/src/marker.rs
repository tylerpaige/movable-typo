//! Runs Marker on a project's PDF and streams its log to the window.

use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

#[derive(Serialize, Clone)]
struct LogLine {
    slug: String,
    line: String,
}

/// Marker's own flags for each mode offered in settings.
fn mode_args(mode: &str) -> Vec<&'static str> {
    match mode {
        // Re-OCRs every page instead of trusting the PDF's text layer. Slower,
        // but scanned readings often have a text layer in the wrong word order.
        "accurate" => vec!["--force_ocr"],
        "balanced" => vec!["--mode", "balanced"],
        _ => vec!["--mode", "fast"],
    }
}

/// Forwards output line by line. Progress bars redraw with `\r`, so that ends a line too.
async fn pump(app: AppHandle, slug: String, mut src: impl AsyncRead + Unpin) {
    let mut buf = [0u8; 4096];
    let mut line = Vec::new();
    while let Ok(n) = src.read(&mut buf).await {
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !line.is_empty() {
                    let text = String::from_utf8_lossy(&line).to_string();
                    let _ = app.emit("marker-log", LogLine { slug: slug.clone(), line: text });
                    line.clear();
                }
            } else {
                line.push(b);
            }
        }
    }
}

pub async fn run(app: AppHandle, marker_path: &str, mode: &str, project_dir: &Path, slug: &str) -> Result<(), String> {
    if !Path::new(marker_path).exists() {
        return Err(format!("Marker not found at {marker_path}. Set its path in Settings."));
    }
    let out_dir = project_dir.join("marker");
    let mut child = Command::new(marker_path)
        .arg(project_dir.join("source.pdf"))
        .args(["--output_format", "json", "--output_dir"])
        .arg(&out_dir)
        .args(mode_args(mode))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start Marker: {e}"))?;
    let out = tokio::spawn(pump(app.clone(), slug.to_string(), child.stdout.take().unwrap()));
    let err = tokio::spawn(pump(app.clone(), slug.to_string(), child.stderr.take().unwrap()));
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = tokio::join!(out, err);
    if !status.success() {
        return Err(format!("Marker exited with {status}"));
    }
    if !out_dir.join("source/source.json").exists() {
        return Err("Marker finished but wrote no JSON output".into());
    }
    crate::files::record_marker_run(project_dir, mode)?;
    Ok(())
}
