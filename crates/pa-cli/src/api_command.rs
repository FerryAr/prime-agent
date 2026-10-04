//! Native Rust subcommand `prime-agent api` for the headless API gateway.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use pa_api::ServerOptions;

use crate::public_command::{handled_failed, handled_with_exit, PublicCommandResult};

pub fn run_api(args: &[String]) -> PublicCommandResult {
    let is_stop = args.iter().any(|a| a == "stop" || a == "--stop" || a == "shutdown" || a == "--shutdown");
    let is_restart = args.iter().any(|a| a == "restart" || a == "--restart");
    let is_status = args.iter().any(|a| a == "status" || a == "--status");
    let is_foreground = args.iter().any(|a| a == "-f" || a == "--foreground" || a == "--no-daemon");

    let port: u16 = find_flag_value(args, "--port")
        .and_then(|p| p.parse().ok())
        .or_else(|| std::env::var("PRIME_AGENT_API_PORT").ok().and_then(|p| p.parse().ok()))
        .unwrap_or(4677);

    let host = find_flag_value(args, "--host")
        .or_else(|| std::env::var("PRIME_AGENT_API_HOST").ok())
        .unwrap_or_else(|| "0.0.0.0".to_string());

    let token = find_flag_value(args, "--token")
        .or_else(|| std::env::var("PRIME_AGENT_API_TOKEN").ok());

    let daemon_socket = find_flag_value(args, "--daemon-socket").map(PathBuf::from);

    let data_dir = get_api_data_dir();
    let _ = fs::create_dir_all(&data_dir);
    let gateway_info_path = data_dir.join("gateway.json");

    if is_stop {
        let stopped = stop_gateway(&gateway_info_path);
        if stopped {
            println!("Prime Agent API gateway stopped.");
        } else {
            println!("Prime Agent API gateway is not running.");
        }
        return handled_with_exit(0);
    }

    if is_status {
        if let Some(info) = read_gateway_info(&gateway_info_path) {
            println!("Prime Agent API gateway is running at {} (PID: {}).", info.url, info.pid);
            if !info.token.is_empty() {
                println!("Auth token: {}", info.token);
            }
        } else {
            println!("Prime Agent API gateway is not running.");
        }
        return handled_with_exit(0);
    }

    if is_restart {
        println!("Restarting Prime Agent API gateway...");
        let _ = stop_gateway(&gateway_info_path);
        std::thread::sleep(Duration::from_millis(300));
    } else if let Some(info) = read_gateway_info(&gateway_info_path) {
        println!("Prime Agent API gateway is already running at {} (PID: {}).", info.url, info.pid);
        if !info.token.is_empty() {
            println!("Auth token: {}", info.token);
        }
        return handled_with_exit(0);
    }

    if is_foreground {
        run_foreground(host, port, token, daemon_socket, &gateway_info_path)
    } else {
        run_background(args, &gateway_info_path, host, port)
    }
}

fn run_foreground(
    host: String,
    port: u16,
    token: Option<String>,
    daemon_socket: Option<PathBuf>,
    gateway_info_path: &Path,
) -> PublicCommandResult {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Failed to initialize async runtime: {e}");
            return handled_failed();
        }
    };

    let gw_path = gateway_info_path.to_path_buf();
    rt.block_on(async move {
        // Ensure the Prime Agent supervisor daemon is running
        let socket_path = daemon_socket.clone().unwrap_or_else(pa_daemon::socket::default_daemon_socket_path);
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        if let Err(e) = crate::interactive_mode::ensure_daemon_running(&socket_path, &cwd).await {
            eprintln!("⚠️ Notice: Daemon check/spawn encountered an issue: {e}");
        }

        let resolved_token = token.unwrap_or_else(pa_api::auth::get_or_create_dedicated_token);
        let pid = std::process::id();
        let display_host = if host == "0.0.0.0" { "127.0.0.1" } else { &host };
        let url = format!("http://{display_host}:{port}");

        let info = serde_json::json!({
            "pid": pid,
            "port": port,
            "host": host,
            "url": url,
            "token": resolved_token,
            "version": "0.9.8",
            "startedAt": chrono_now_iso(),
        });

        if let Ok(serialized) = serde_json::to_string_pretty(&info) {
            let _ = fs::write(&gw_path, serialized);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&gw_path, fs::Permissions::from_mode(0o600));
            }
        }

        let cleanup_path = gw_path.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let _ = fs::remove_file(cleanup_path);
                std::process::exit(0);
            }
        });

        let options = ServerOptions {
            host,
            port,
            token: Some(resolved_token),
            daemon_socket,
            ..Default::default()
        };

        let result = pa_api::start_api_server(options).await;
        let _ = fs::remove_file(&gw_path);

        match result {
            Ok(()) => handled_with_exit(0),
            Err(err) => {
                eprintln!("API server error: {err}");
                handled_failed()
            }
        }
    })
}

fn run_background(
    args: &[String],
    gateway_info_path: &Path,
    host: String,
    port: u16,
) -> PublicCommandResult {
    let current_exe = match std::env::current_exe() {
        Ok(mut exe) => {
            let exe_str = exe.to_string_lossy().to_string();
            if let Some(clean) = exe_str.strip_suffix(" (deleted)") {
                let clean_path = std::path::PathBuf::from(clean);
                if clean_path.exists() {
                    exe = clean_path;
                }
            }
            exe
        }
        Err(e) => {
            eprintln!("Failed to determine current executable path: {e}");
            return handled_failed();
        }
    };

    let mut filtered_args: Vec<String> = vec!["api".to_string(), "--foreground".to_string()];
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--restart" || a == "restart" || a == "-d" || a == "--detach" || a == "--background" || a == "-f" || a == "--foreground" {
            i += 1;
            continue;
        }
        filtered_args.push(a.clone());
        i += 1;
    }

    let log_path = PathBuf::from("/tmp/prime-agent-rust-api.log");
    let log_file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path);

    let mut cmd = Command::new(&current_exe);
    cmd.args(&filtered_args);
    cmd.stdin(std::process::Stdio::null());
    pa_core::platform::process::set_new_process_group(&mut cmd);

    if let Ok(file) = log_file {
        if let Ok(f) = file.try_clone() { cmd.stdout(f); } else { cmd.stdout(std::process::Stdio::null()); }
        cmd.stderr(file);
    } else {
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
    }

    match cmd.spawn() {
        Ok(_child) => {
            let start = Instant::now();
            let mut resolved_url = format!("http://{}:{port}", if host == "0.0.0.0" { "127.0.0.1" } else { &host });
            let mut resolved_token = String::new();

            while start.elapsed() < Duration::from_secs(6) {
                if let Some(info) = read_gateway_info(gateway_info_path) {
                    resolved_url = info.url;
                    resolved_token = info.token;
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }

            println!("Prime Agent API gateway: {resolved_url}");
            if !resolved_token.is_empty() {
                println!("Auth token: {resolved_token}");
            }
            handled_with_exit(0)
        }
        Err(err) => {
            eprintln!("Failed to start Prime Agent API gateway: {err}");
            handled_failed()
        }
    }
}

pub(crate) struct GatewayInfo {
    pub(crate) pid: u32,
    pub(crate) url: String,
    pub(crate) token: String,
}

pub(crate) fn read_gateway_info(path: &Path) -> Option<GatewayInfo> {
    let content = fs::read_to_string(path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&content).ok()?;
    let pid = val.get("pid").and_then(|p| p.as_u64())? as u32;

    #[cfg(unix)]
    {
        if unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
            let _ = fs::remove_file(path);
            return None;
        }
    }

    let url = val.get("url").and_then(|u| u.as_str()).unwrap_or("http://127.0.0.1:4677").to_string();
    let token = val.get("token").and_then(|t| t.as_str()).unwrap_or_default().to_string();

    Some(GatewayInfo { pid, url, token })
}

pub(crate) fn stop_gateway(path: &Path) -> bool {
    if let Some(info) = read_gateway_info(path) {
        #[cfg(unix)]
        {
            let pid = info.pid as libc::pid_t;
            let _ = unsafe { libc::kill(pid, libc::SIGTERM) };
            let start = Instant::now();
            while start.elapsed() < Duration::from_millis(1500) {
                if unsafe { libc::kill(pid, 0) } != 0 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if unsafe { libc::kill(pid, 0) } == 0 {
                let _ = unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
        let _ = fs::remove_file(path);
        true
    } else {
        false
    }
}

pub(crate) fn find_flag_value(args: &[String], flag: &str) -> Option<String> {
    for (i, a) in args.iter().enumerate() {
        if a == flag {
            return args.get(i + 1).cloned();
        }
        if let Some(val) = a.strip_prefix(&format!("{flag}=")) {
            return Some(val.to_string());
        }
    }
    None
}

pub(crate) fn get_api_data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".prime").join("agent").join("prime-agent-api")
}

fn chrono_now_iso() -> String {
    let now = std::time::SystemTime::now();
    let duration = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    format!("{}", duration.as_secs())
}
