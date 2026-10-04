//! Native Rust subcommand `prime-agent telegram` for the Telegram bot.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use pa_telegram::{run_bot, BotConfig};

use crate::public_command::{handled_failed, handled_with_exit, PublicCommandResult};

pub fn run_telegram(args: &[String]) -> PublicCommandResult {
    let is_stop = args.iter().any(|a| a == "stop" || a == "--stop" || a == "shutdown" || a == "--shutdown");
    let is_restart = args.iter().any(|a| a == "restart" || a == "--restart");
    let is_status = args.iter().any(|a| a == "status" || a == "--status");
    let is_foreground = args.iter().any(|a| a == "-f" || a == "--foreground" || a == "--no-daemon");

    let data_dir = get_telegram_data_dir();
    let _ = fs::create_dir_all(&data_dir);
    let info_path = data_dir.join("gateway.json");

    if is_stop {
        let (stopped, pid_opt) = stop_bot(&info_path);
        if stopped {
            if let Some(pid) = pid_opt {
                println!("Prime Agent Telegram bot stopped (PID: {}).", pid);
            } else {
                println!("Prime Agent Telegram bot stopped.");
            }
        } else {
            println!("Prime Agent Telegram bot is not running.");
        }
        return handled_with_exit(0);
    }

    if is_status {
        if let Some(info) = read_bot_info(&info_path) {
            let user_part = info.bot_username.map_or(String::new(), |u| format!(", @{u}"));
            println!("Prime Agent Telegram bot is running (PID: {}{user_part}).", info.pid);
        } else {
            println!("Prime Agent Telegram bot is not running.");
        }
        return handled_with_exit(0);
    }

    if is_restart {
        println!("Restarting Prime Agent Telegram bot...");
        let _ = stop_bot(&info_path);
        std::thread::sleep(Duration::from_millis(300));
    } else if let Some(info) = read_bot_info(&info_path) {
        let user_part = info.bot_username.map_or(String::new(), |u| format!(", @{u}"));
        println!("Prime Agent Telegram bot is already running (PID: {}{user_part}).", info.pid);
        return handled_with_exit(0);
    }

    let config = match BotConfig::from_env_and_args(args) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Error: {err}");
            return handled_failed();
        }
    };

    // Ensure prime-agent-api gateway is running
    let api_data_dir = crate::api_command::get_api_data_dir();
    let gw_info_path = api_data_dir.join("gateway.json");
    if crate::api_command::read_gateway_info(&gw_info_path).is_none() {
        if let Ok(current_exe) = std::env::current_exe() {
            let mut api_cmd = Command::new(&current_exe);
            api_cmd.arg("api");
            api_cmd.stdout(std::process::Stdio::null());
            api_cmd.stderr(std::process::Stdio::null());
            let _ = api_cmd.spawn();
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    if is_foreground {
        run_foreground(config, &info_path)
    } else {
        run_background(args, &info_path, &data_dir)
    }
}

fn run_foreground(config: BotConfig, info_path: &Path) -> PublicCommandResult {
    let pid = std::process::id();
    let info = serde_json::json!({
        "pid": pid,
        "apiUrl": config.api_url,
        "version": "0.9.8",
        "startedAt": chrono_now_iso(),
    });

    if let Ok(content) = serde_json::to_string_pretty(&info) {
        let _ = fs::write(info_path, content);
    }

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Failed to initialize Tokio runtime: {e}");
            return handled_failed();
        }
    };

    let info_clone = info_path.to_path_buf();
    println!("🚀 Starting Prime Agent Telegram bot...");
    let res = rt.block_on(async {
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let _ = fs::remove_file(info_clone);
                std::process::exit(0);
            }
        });
        run_bot(config).await
    });
    let _ = fs::remove_file(info_path);

    match res {
        Ok(()) => handled_with_exit(0),
        Err(err) => {
            eprintln!("Telegram bot error: {err}");
            handled_failed()
        }
    }
}

fn run_background(args: &[String], info_path: &Path, data_dir: &Path) -> PublicCommandResult {
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

    let mut filtered_args: Vec<String> = vec!["telegram".to_string(), "--foreground".to_string()];
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

    let log_path = data_dir.join("bot.log");
    let log_file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(&log_path);

    let mut cmd = Command::new(&current_exe);
    cmd.args(&filtered_args);
    cmd.stdin(std::process::Stdio::null());
    pa_core::platform::process::set_new_process_group(&mut cmd);

    if let Ok(file) = log_file {
        if let Ok(f) = file.try_clone() {
            cmd.stdout(f);
        } else {
            cmd.stdout(std::process::Stdio::null());
        }
        cmd.stderr(file);
    } else {
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
    }

    match cmd.spawn() {
        Ok(_child) => {
            let start = Instant::now();
            let mut resolved_info = None;
            while start.elapsed() < Duration::from_secs(6) {
                if let Some(info) = read_bot_info(info_path) {
                    resolved_info = Some(info);
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }

            if let Some(info) = resolved_info {
                let user_part = info.bot_username.map_or(String::new(), |u| format!(" as @{u}"));
                println!("Prime Agent Telegram bot started successfully{user_part}!");
            } else {
                println!("Prime Agent Telegram bot started in background.");
            }
            handled_with_exit(0)
        }
        Err(err) => {
            eprintln!("Failed to launch Prime Agent Telegram bot: {err}");
            handled_failed()
        }
    }
}

pub(crate) struct BotInfo {
    pub(crate) pid: u32,
    pub(crate) bot_username: Option<String>,
}

pub(crate) fn read_bot_info(path: &Path) -> Option<BotInfo> {
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

    let bot_username = val.get("botUsername")
        .or_else(|| val.get("username"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Some(BotInfo { pid, bot_username })
}

pub(crate) fn stop_bot(path: &Path) -> (bool, Option<u32>) {
    if let Some(info) = read_bot_info(path) {
        let pid = info.pid;
        #[cfg(unix)]
        {
            let p = pid as libc::pid_t;
            let _ = unsafe { libc::kill(p, libc::SIGTERM) };
            let start = Instant::now();
            while start.elapsed() < Duration::from_millis(1500) {
                if unsafe { libc::kill(p, 0) } != 0 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if unsafe { libc::kill(p, 0) } == 0 {
                let _ = unsafe { libc::kill(p, libc::SIGKILL) };
            }
        }
        let _ = fs::remove_file(path);
        (true, Some(pid))
    } else {
        (false, None)
    }
}

pub(crate) fn get_telegram_data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".prime").join("agent").join("prime-agent-telegram")
}

fn chrono_now_iso() -> String {
    let now = std::time::SystemTime::now();
    let duration = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    format!("{}", duration.as_secs())
}
