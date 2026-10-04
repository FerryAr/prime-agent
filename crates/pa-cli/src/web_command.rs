//! Native Rust subcommand `prime-agent web` for the web interface.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::api_command::{find_flag_value, get_api_data_dir, read_gateway_info, stop_gateway};
use crate::public_command::{handled_failed, handled_with_exit, PublicCommandResult};

pub fn run_web(args: &[String]) -> PublicCommandResult {
    let is_stop = args.iter().any(|a| a == "stop" || a == "--stop" || a == "shutdown" || a == "--shutdown");
    let is_restart = args.iter().any(|a| a == "restart" || a == "--restart");
    let is_status = args.iter().any(|a| a == "status" || a == "--status");
    let no_open = args.iter().any(|a| a == "--no-open");

    let port: u16 = find_flag_value(args, "--port")
        .and_then(|p| p.parse().ok())
        .or_else(|| std::env::var("PRIME_AGENT_WEB_PORT").ok().and_then(|p| p.parse().ok()))
        .or_else(|| std::env::var("PRIME_AGENT_API_PORT").ok().and_then(|p| p.parse().ok()))
        .unwrap_or(4677);

    let host = find_flag_value(args, "--host")
        .or_else(|| std::env::var("PRIME_AGENT_WEB_HOST").ok())
        .or_else(|| std::env::var("PRIME_AGENT_API_HOST").ok())
        .unwrap_or_else(|| "0.0.0.0".to_string());

    let data_dir = get_api_data_dir();
    let _ = fs::create_dir_all(&data_dir);
    let gateway_info_path = data_dir.join("gateway.json");

    if is_stop {
        let stopped = stop_gateway(&gateway_info_path);
        if stopped {
            println!("Prime Agent web interface stopped.");
        } else {
            println!("Prime Agent web interface is not running.");
        }
        return handled_with_exit(0);
    }

    if is_status {
        if let Some(info) = read_gateway_info(&gateway_info_path) {
            println!("Prime Agent web interface is running at {} (PID: {}).", info.url, info.pid);
            if !info.token.is_empty() {
                println!("Auth token: {}", info.token);
            }
        } else {
            println!("Prime Agent web interface is not running.");
        }
        return handled_with_exit(0);
    }

    if is_restart {
        println!("Restarting Prime Agent web interface...");
        let _ = stop_gateway(&gateway_info_path);
        std::thread::sleep(Duration::from_millis(300));
    }

    // Check if gateway is already running
    let (url, token) = if let Some(info) = read_gateway_info(&gateway_info_path) {
        (info.url, info.token)
    } else {
        // Start api gateway in background
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

        let mut child_args = vec![
            "api".to_string(),
            "--foreground".to_string(),
            "--port".to_string(),
            port.to_string(),
            "--host".to_string(),
            host.clone(),
        ];
        if let Some(t) = find_flag_value(args, "--token") {
            child_args.push("--token".to_string());
            child_args.push(t);
        }
        if let Some(ds) = find_flag_value(args, "--daemon-socket") {
            child_args.push("--daemon-socket".to_string());
            child_args.push(ds);
        }

        let log_path = PathBuf::from("/tmp/prime-agent-rust-api.log");
        let log_file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path);

        let mut cmd = std::process::Command::new(&current_exe);
        cmd.args(&child_args);
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
            Ok(_) => {
                let start = Instant::now();
                let mut resolved = None;
                while start.elapsed() < Duration::from_secs(6) {
                    if let Some(info) = read_gateway_info(&gateway_info_path) {
                        resolved = Some((info.url, info.token));
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                match resolved {
                    Some(pair) => pair,
                    None => {
                        let display_host = if host == "0.0.0.0" { "127.0.0.1" } else { &host };
                        (format!("http://{display_host}:{port}"), String::new())
                    }
                }
            }
            Err(err) => {
                eprintln!("Failed to launch Prime Agent web background service: {err}");
                return handled_failed();
            }
        }
    };

    let full_url = if !token.is_empty() {
        format!("{url}/?token={token}")
    } else {
        url
    };

    println!("Prime Agent web interface: {full_url}");

    if !no_open {
        if let Err(e) = open_browser(&full_url) {
            eprintln!("Could not automatically open browser ({e}). Please visit: {full_url}");
        }
    }

    handled_with_exit(0)
}

pub fn open_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn()?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let browsers = ["xdg-open", "sensible-browser", "x-www-browser"];
        let mut launched = false;
        for b in browsers {
            if std::process::Command::new(b).arg(url).spawn().is_ok() {
                launched = true;
                break;
            }
        }
        if !launched {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "No browser launcher found",
            ));
        }
    }
    Ok(())
}
