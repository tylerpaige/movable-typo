mod files;
mod marker;

use files::{Export, ProjectSummary, Settings};
use std::path::PathBuf;
use tauri::Manager;
use tauri::ipc::Response;

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn settings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(files::err)?.join("settings.json"))
}

/// Where settings lived when the app was called PDF Transcriber.
const LEGACY_IDENTIFIER: &str = "codes.typo.pdf-transcriber";

fn settings(app: &tauri::AppHandle) -> Result<Settings, String> {
    let file = settings_file(app)?;
    let legacy = file.parent().and_then(|d| d.parent()).map(|d| d.join(LEGACY_IDENTIFIER).join("settings.json"));
    Ok(files::load_settings(&file, legacy.as_deref(), &home()))
}

fn projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(PathBuf::from(settings(app)?.projects_dir))
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    settings(&app)
}

#[tauri::command]
fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    files::save_settings(&settings_file(&app)?, &settings)
}

#[tauri::command]
fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectSummary>, String> {
    Ok(files::list_projects(&projects_dir(&app)?))
}

#[tauri::command]
fn create_project(app: tauri::AppHandle, pdf_path: String) -> Result<String, String> {
    files::create_project(&projects_dir(&app)?, &PathBuf::from(pdf_path))
}

#[tauri::command]
async fn run_marker(app: tauri::AppHandle, slug: String, mode: Option<String>) -> Result<(), String> {
    let s = settings(&app)?;
    // A mode chosen for this run only; otherwise the one in settings.
    let mode = mode.unwrap_or(s.marker_mode.clone());
    if !files::MARKER_MODES.contains(&mode.as_str()) {
        return Err(format!("unknown Marker mode: {mode}"));
    }
    let dir = files::project_dir(&PathBuf::from(&s.projects_dir), &slug)?;
    marker::run(app, &s.marker_path, &mode, &dir, &slug).await
}

#[tauri::command]
fn marker_run(app: tauri::AppHandle, slug: String) -> Result<Option<files::MarkerRun>, String> {
    files::marker_run(&projects_dir(&app)?, &slug)
}

#[tauri::command]
fn backup_project(app: tauri::AppHandle, slug: String) -> Result<bool, String> {
    files::backup_project(&projects_dir(&app)?, &slug)
}

#[tauri::command]
fn read_marker_json(app: tauri::AppHandle, slug: String) -> Result<String, String> {
    let p = files::marker_json_path(&projects_dir(&app)?, &slug)?;
    std::fs::read_to_string(p).map_err(files::err)
}

#[tauri::command]
fn read_project_file(app: tauri::AppHandle, slug: String, rel: String) -> Result<Response, String> {
    Ok(Response::new(files::read_project_file(&projects_dir(&app)?, &slug, &rel)?))
}

#[tauri::command]
fn load_project(app: tauri::AppHandle, slug: String) -> Result<Option<String>, String> {
    files::load_project(&projects_dir(&app)?, &slug)
}

#[tauri::command]
fn save_project(app: tauri::AppHandle, slug: String, json: String) -> Result<(), String> {
    files::save_project(&projects_dir(&app)?, &slug, &json)
}

#[tauri::command]
fn export_conflicts(app: tauri::AppHandle, slug: String) -> Result<Vec<String>, String> {
    files::export_conflicts(&PathBuf::from(settings(&app)?.export_dir), &slug)
}

#[tauri::command]
fn write_export(app: tauri::AppHandle, export: Export) -> Result<String, String> {
    files::write_export(&PathBuf::from(settings(&app)?.export_dir), &export)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            list_projects,
            create_project,
            run_marker,
            marker_run,
            backup_project,
            read_marker_json,
            read_project_file,
            load_project,
            save_project,
            export_conflicts,
            write_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Movable Typo");
}
