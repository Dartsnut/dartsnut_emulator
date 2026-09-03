use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

pub const BRIDGE_READY_EVENT: &str = "dartsnut:bridge-ready";
pub const BRIDGE_EVENT: &str = "dartsnut:bridge-event";

pub mod agent;
pub mod commands;
pub mod deploy;
pub mod emulator;
pub mod oauth;
pub mod parity;
pub mod pending_inputs;
pub mod projects;
pub mod provider;
pub mod proxy;
pub mod rig_runtime;
pub mod runtime;
pub mod updates;
pub mod workspace;

/// Ensure Reqwest's `rustls-no-provider` build has a process-wide TLS
/// provider before constructing any HTTP client. Safe to call repeatedly.
pub fn ensure_rustls_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

async fn shutdown_resources(app: &tauri::AppHandle) {
    let state = app.state::<commands::AppState>();
    if let Ok(mut slot) = state.sideload.lock() {
        if let Some(client) = slot.take() {
            client.close();
        }
    }
    let connection = state.deploy.lock().ok().and_then(|mut slot| slot.take());
    if let Some(connection) = connection {
        let _ = connection.close().await;
    }
    state.emulator.stop().await;
}

pub fn run() {
    // reqwest is built with `rustls-no-provider`; install the ring provider
    // before any command, plugin, or background task can create a client.
    // Installing twice is harmless, so feature-specific construction paths
    // may keep their defensive initialization as well.
    ensure_rustls_crypto_provider();

    let mut updater = tauri_plugin_updater::Builder::new();
    if let Ok(pubkey) = std::env::var("TAURI_SIGNING_PUBLIC_KEY") {
        if !pubkey.trim().is_empty() {
            updater = updater.pubkey(pubkey);
        }
    }
    tauri::Builder::default()
        .plugin(updater.build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::VISIBLE
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .manage(commands::AppState::default())
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let app = window.app_handle().clone();
            let state = app.state::<commands::AppState>();
            // CloseRequested is allowed to destroy the last window immediately.
            // Hold it until Rust has stopped widget descendants and shared memory.
            if state.quit_cleanup_started.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            let window = window.clone();
            tauri::async_runtime::spawn(async move {
                shutdown_resources(&app).await;
                let _ = window.close();
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap_state,
            commands::renderer_ready,
            commands::health,
            commands::bridge_ready,
            commands::emit_bridge_event,
            commands::list_projects,
            commands::create_project,
            commands::remove_project,
            commands::create_chat,
            commands::archive_chat,
            commands::select_project,
            commands::select_chat,
            commands::get_provider_settings,
            commands::save_provider_settings,
            commands::get_python_runtime_status,
            commands::get_python_runtime_progress,
            commands::retry_python_runtime_setup,
            commands::deploy_get_eligibility,
            commands::get_widget_config,
            commands::community_get_session,
            commands::get_app_update_status,
            commands::get_app_update_auto_download,
            commands::set_app_update_auto_download,
            parity::report_renderer_error,
            parity::open_startup_logs,
            parity::copy_startup_diagnostics,
            parity::reset_renderer_state,
            parity::restart_without_gpu,
            parity::generate_chat_title,
            parity::get_window_chrome_insets,
            parity::install_app_update_now,
            parity::download_app_update,
            parity::check_app_update,
            parity::set_shell_ui_theme,
            parity::pick_workspace,
            parity::assets_pick_source_file,
            parity::machine_mcp_submit_question_answer,
            parity::agent_question_submit_answer,
            parity::emulator_command,
            parity::emulator_pick_path,
            parity::emulator_get_last_path,
            parity::emulator_get_background,
            parity::emulator_open_capture_folder,
            parity::deploy_connect,
            parity::deploy_disconnect,
            parity::deploy_run,
            parity::deploy_reload,
            parity::deploy_apply_widget_params,
            parity::deploy_stop,
            parity::deploy_open_local_network_settings,
            parity::community_login,
            parity::community_set_password,
            parity::community_cancel_google_login,
            parity::community_logout,
            parity::community_get_llm_quota,
            parity::community_list_deploy_devices,
            parity::community_list_my_games,
            parity::community_get_publish_options,
            parity::community_list_app_versions,
            parity::community_create_app,
            parity::community_upload_native_image,
            parity::community_submit_app_version,
            parity::community_update_workspace_version,
            parity::community_withdraw_app_version,
            parity::assets_get_manifest,
            parity::assets_bind_slot,
            parity::assets_unbind_slot,
            parity::assets_apply_assets,
            parity::assets_read_preview,
            agent::send_prompt,
            agent::cancel_agent,
            agent::get_workspace_session_summary,
            agent::reset_workspace_session
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
            }
            app.emit(BRIDGE_READY_EVENT, commands::health())?;
            let handle = app.handle().clone();
            let runtime = handle.state::<commands::AppState>().runtime.clone();
            runtime.start(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Dartsnut Agent")
        .run(|app, event| {
            let RunEvent::ExitRequested { api, code, .. } = event else {
                return;
            };
            let state = app.state::<commands::AppState>();
            // Menu/app exits do not necessarily produce WindowEvent::CloseRequested.
            // Prevent exit, perform identical cleanup, then request exit again; the
            // second event observes the guard and is allowed through.
            if state.quit_cleanup_started.swap(true, Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                shutdown_resources(&app).await;
                app.exit(code.unwrap_or(0));
            });
        });
}
