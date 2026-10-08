//! Project and export file handling. Everything here takes explicit
//! directories so it can be tested without a running app.

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Settings {
    pub marker_path: String,
    pub marker_mode: String,
    pub projects_dir: String,
    pub export_dir: String,
}

impl Settings {
    pub fn defaults(home: &Path) -> Self {
        // Readings made while the app was called PDF Transcriber stay where they are.
        let legacy = home.join("Documents/PDF Transcriber");
        let projects = if legacy.exists() && !home.join("Documents/Movable Typo").exists() {
            legacy
        } else {
            home.join("Documents/Movable Typo")
        };
        Settings {
            marker_path: home.join(".local/bin/marker_single").to_string_lossy().into(),
            marker_mode: "accurate".into(),
            projects_dir: projects.to_string_lossy().into(),
            export_dir: home.join("projects/readings").to_string_lossy().into(),
        }
    }
}

/// Reads settings, falling back to the file from before the rename, then to defaults.
pub fn load_settings(file: &Path, legacy: Option<&Path>, home: &Path) -> Settings {
    let read = |p: &Path| fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok());
    read(file)
        .or_else(|| legacy.and_then(read))
        .unwrap_or_else(|| Settings::defaults(home))
}

pub fn save_settings(file: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(err)?;
    fs::write(file, json).map_err(err)
}

#[derive(Serialize, Debug)]
pub struct ProjectSummary {
    pub slug: String,
    pub title: String,
    pub modified: u64,
    pub has_marker: bool,
    /// Mode of the last successful Marker run, if recorded.
    pub marker_mode: Option<String>,
}

/// What produced the current Marker output: written after each successful run.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MarkerRun {
    pub mode: String,
    /// Unix seconds.
    pub finished_at: u64,
}

pub const MARKER_MODES: [&str; 3] = ["accurate", "balanced", "fast"];

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn record_marker_run(project_dir: &Path, mode: &str) -> Result<MarkerRun, String> {
    let run = MarkerRun { mode: mode.to_string(), finished_at: now() };
    let json = serde_json::to_string_pretty(&run).map_err(err)?;
    fs::write(project_dir.join("marker/run.json"), json).map_err(err)?;
    Ok(run)
}

pub fn marker_run(projects: &Path, slug: &str) -> Result<Option<MarkerRun>, String> {
    let p = project_dir(projects, slug)?.join("marker/run.json");
    Ok(fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()))
}

/// Keeps a copy of the project before it is replaced by a fresh import.
pub fn backup_project(projects: &Path, slug: &str) -> Result<bool, String> {
    let dir = project_dir(projects, slug)?;
    let src = dir.join("project.json");
    if !src.exists() {
        return Ok(false);
    }
    fs::copy(src, dir.join("project.backup.json")).map_err(err)?;
    Ok(true)
}

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    let out = out.trim_end_matches('_').to_string();
    if out.is_empty() { "untitled".into() } else { out }
}

/// Rejects slugs that could escape the projects directory.
fn checked(slug: &str) -> Result<&str, String> {
    if slug.is_empty() || slug.contains('/') || slug.contains("..") || slug.contains('\\') {
        return Err(format!("invalid name: {slug}"));
    }
    Ok(slug)
}

/// Resolves `rel` inside `dir`, refusing paths that climb out of it.
fn inside(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("invalid path: {rel}"));
    }
    Ok(dir.join(p))
}

pub fn project_dir(projects: &Path, slug: &str) -> Result<PathBuf, String> {
    Ok(projects.join(checked(slug)?))
}

pub fn marker_json_path(projects: &Path, slug: &str) -> Result<PathBuf, String> {
    Ok(project_dir(projects, slug)?.join("marker/source/source.json"))
}

pub fn create_project(projects: &Path, pdf: &Path) -> Result<String, String> {
    let stem = pdf.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let base = slugify(&stem);
    let mut slug = base.clone();
    let mut n = 2;
    while projects.join(&slug).exists() {
        slug = format!("{base}_{n}");
        n += 1;
    }
    let dir = projects.join(&slug);
    fs::create_dir_all(&dir).map_err(err)?;
    fs::copy(pdf, dir.join("source.pdf")).map_err(err)?;
    Ok(slug)
}

pub fn list_projects(projects: &Path) -> Vec<ProjectSummary> {
    let mut out = vec![];
    let Ok(entries) = fs::read_dir(projects) else { return out };
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.join("source.pdf").exists() {
            continue;
        }
        let slug = e.file_name().to_string_lossy().to_string();
        let pj = dir.join("project.json");
        let title = fs::read_to_string(&pj)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v["meta"]["title"].as_str().map(String::from))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| slug.clone());
        let modified = fs::metadata(if pj.exists() { &pj } else { &dir })
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let has_marker = dir.join("marker/source/source.json").exists();
        let marker_mode = marker_run(projects, &slug).ok().flatten().map(|r| r.mode);
        out.push(ProjectSummary { slug, title, modified, has_marker, marker_mode });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

pub fn read_project_file(projects: &Path, slug: &str, rel: &str) -> Result<Vec<u8>, String> {
    fs::read(inside(&project_dir(projects, slug)?, rel)?).map_err(err)
}

pub fn load_project(projects: &Path, slug: &str) -> Result<Option<String>, String> {
    let p = project_dir(projects, slug)?.join("project.json");
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(p).map(Some).map_err(err)
}

/// Writes atomically so a crash mid-save never leaves a half-written project.
pub fn save_project(projects: &Path, slug: &str, json: &str) -> Result<(), String> {
    let dir = project_dir(projects, slug)?;
    let tmp = dir.join("project.json.tmp");
    fs::write(&tmp, json).map_err(err)?;
    fs::rename(&tmp, dir.join("project.json")).map_err(err)
}

#[derive(Deserialize, Debug)]
pub struct ExportImage {
    /// File name to write under images/.
    pub name: String,
    /// Base64 image data, as Marker embeds it in its JSON.
    pub data: String,
}

#[derive(Deserialize, Debug)]
pub struct Export {
    pub slug: String,
    pub html: String,
    pub markdown: String,
    pub images: Vec<ExportImage>,
}

/// Files an export would overwrite, so the UI can ask first.
pub fn export_conflicts(export_dir: &Path, slug: &str) -> Result<Vec<String>, String> {
    let dir = export_dir.join(checked(slug)?);
    Ok([format!("{slug}.html"), format!("{slug}.md")]
        .into_iter()
        .filter(|f| dir.join(f).exists())
        .map(|f| dir.join(f).to_string_lossy().to_string())
        .collect())
}

pub fn write_export(export_dir: &Path, ex: &Export) -> Result<String, String> {
    let dir = export_dir.join(checked(&ex.slug)?);
    fs::create_dir_all(&dir).map_err(err)?;
    fs::write(dir.join(format!("{}.html", ex.slug)), &ex.html).map_err(err)?;
    fs::write(dir.join(format!("{}.md", ex.slug)), &ex.markdown).map_err(err)?;
    if !ex.images.is_empty() {
        let img_dir = dir.join("images");
        fs::create_dir_all(&img_dir).map_err(err)?;
        for img in &ex.images {
            let bytes = BASE64.decode(img.data.trim()).map_err(err)?;
            fs::write(inside(&img_dir, &img.name)?, bytes).map_err(err)?;
        }
    }
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slugify("wjt-mitchell beyond Comparison!"), "wjt_mitchell_beyond_comparison");
        assert_eq!(slugify("***"), "untitled");
    }

    #[test]
    fn project_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("My Reading.pdf");
        fs::write(&pdf, b"%PDF-1.4").unwrap();
        let projects = tmp.path().join("projects");
        let a = create_project(&projects, &pdf).unwrap();
        let b = create_project(&projects, &pdf).unwrap();
        assert_eq!(a, "my_reading");
        assert_eq!(b, "my_reading_2");
        assert_eq!(load_project(&projects, &a).unwrap(), None);
        save_project(&projects, &a, r#"{"meta":{"title":"T"}}"#).unwrap();
        assert!(load_project(&projects, &a).unwrap().unwrap().contains("\"T\""));
        let list = list_projects(&projects);
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|p| p.title == "T"));
        assert_eq!(read_project_file(&projects, &a, "source.pdf").unwrap(), b"%PDF-1.4");
    }

    #[test]
    fn records_marker_runs_and_backs_up() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("a.pdf");
        fs::write(&pdf, b"%PDF").unwrap();
        let projects = tmp.path().join("projects");
        let slug = create_project(&projects, &pdf).unwrap();
        let dir = projects.join(&slug);
        assert_eq!(marker_run(&projects, &slug).unwrap(), None);
        fs::create_dir_all(dir.join("marker")).unwrap();
        record_marker_run(&dir, "fast").unwrap();
        assert_eq!(marker_run(&projects, &slug).unwrap().unwrap().mode, "fast");
        assert_eq!(list_projects(&projects)[0].marker_mode.as_deref(), Some("fast"));

        assert!(!backup_project(&projects, &slug).unwrap());
        save_project(&projects, &slug, "v1").unwrap();
        assert!(backup_project(&projects, &slug).unwrap());
        save_project(&projects, &slug, "v2").unwrap();
        assert_eq!(fs::read_to_string(dir.join("project.backup.json")).unwrap(), "v1");
    }

    #[test]
    fn settings_carry_over_from_the_old_name() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let new_file = home.join("new/settings.json");
        let old_file = home.join("old/settings.json");
        // Fresh install: the new folder name.
        assert!(load_settings(&new_file, Some(&old_file), home).projects_dir.ends_with("Documents/Movable Typo"));
        // Readings already in the old folder: keep using it.
        fs::create_dir_all(home.join("Documents/PDF Transcriber")).unwrap();
        assert!(load_settings(&new_file, Some(&old_file), home).projects_dir.ends_with("Documents/PDF Transcriber"));
        // Old settings file: used as is until settings are saved under the new name.
        let mut old = Settings::defaults(home);
        old.export_dir = "/somewhere/else".into();
        save_settings(&old_file, &old).unwrap();
        assert_eq!(load_settings(&new_file, Some(&old_file), home).export_dir, "/somewhere/else");
        let mut new = old.clone();
        new.export_dir = "/new".into();
        save_settings(&new_file, &new).unwrap();
        assert_eq!(load_settings(&new_file, Some(&old_file), home).export_dir, "/new");
    }

    #[test]
    fn refuses_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_project_file(tmp.path(), "..", "x").is_err());
        assert!(read_project_file(tmp.path(), "a", "../../etc/passwd").is_err());
        assert!(read_project_file(tmp.path(), "a", "/etc/passwd").is_err());
    }

    #[test]
    fn export_writes_and_reports_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("readings");
        assert!(export_conflicts(&out, "essay").unwrap().is_empty());
        let ex = Export {
            slug: "essay".into(),
            html: "<html></html>".into(),
            markdown: "# x".into(),
            images: vec![ExportImage { name: "fig.jpeg".into(), data: "anBn".into() }],
        };
        write_export(&out, &ex).unwrap();
        assert!(out.join("essay/essay.html").exists());
        assert!(out.join("essay/essay.md").exists());
        assert_eq!(fs::read(out.join("essay/images/fig.jpeg")).unwrap(), b"jpg");
        assert_eq!(export_conflicts(&out, "essay").unwrap().len(), 2);
    }
}
