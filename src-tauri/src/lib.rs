use std::{fs, sync::Mutex, time::Instant};

use serde::Serialize;
use sysinfo::{
    Disks, Networks, Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, Signal, System,
    UpdateKind, Users,
};
use tauri::State;

struct Monitor {
    sys: System,
    users: Users,
    nets: Networks,
    disks: Disks,
    last: Instant,
}

struct AppState(Mutex<Monitor>);

#[derive(Serialize)]
struct ProcInfo {
    pid: u32,
    ppid: u32,
    name: String,
    cmd: String,
    user: String,
    cpu: f32,
    mem: u64,
    /// Bytes/s leídos y escritos a disco.
    io_r: u64,
    io_w: u64,
    status: &'static str,
}

#[derive(Serialize)]
struct NetInfo {
    name: String,
    rx: u64,
    tx: u64,
    total_rx: u64,
    total_tx: u64,
}

#[derive(Serialize)]
struct Snapshot {
    procs: Vec<ProcInfo>,
    cpu_total: f32,
    cores_usage: Vec<f32>,
    mem_used: u64,
    mem_total: u64,
    swap_used: u64,
    swap_total: u64,
    load: [f64; 3],
    uptime: u64,
    nets: Vec<NetInfo>,
    self_pid: u32,
}

#[derive(Serialize)]
struct SysInfo {
    host: String,
    os: String,
    kernel: String,
    cpu_brand: String,
    cores: usize,
}

#[derive(Serialize)]
struct DiskInfo {
    name: String,
    mount: String,
    fs: String,
    kind: String,
    total: u64,
    free: u64,
}

#[derive(Serialize)]
struct Details {
    exe: String,
    cwd: String,
    cmd: String,
    start: u64,
    run_time: u64,
    virt: u64,
    threads: Option<u32>,
    nice: Option<i32>,
    fds: Option<usize>,
    io_read_total: u64,
    io_write_total: u64,
    parent: String,
}

fn status_label(s: ProcessStatus) -> &'static str {
    match s {
        ProcessStatus::Run => "run",
        ProcessStatus::Sleep => "sleep",
        ProcessStatus::Idle => "idle",
        ProcessStatus::Stop => "stop",
        ProcessStatus::Zombie => "zombie",
        ProcessStatus::Dead => "dead",
        _ => "other",
    }
}

fn refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_disk_usage()
        .with_user(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .with_exe(UpdateKind::OnlyIfNotSet)
        .with_cwd(UpdateKind::OnlyIfNotSet)
}

/// El kernel recorta `comm` a 15 caracteres. Si el nombre llega recortado,
/// intentamos recuperar el nombre completo desde el ejecutable o el comando.
fn full_name(name: String, exe: Option<&std::path::Path>, cmd0: Option<&str>) -> String {
    if name.chars().count() < 15 {
        return name;
    }
    let candidates = [
        exe.and_then(|e| e.file_name()).map(|s| s.to_string_lossy().into_owned()),
        cmd0.and_then(|c| c.rsplit('/').next()).map(str::to_owned),
    ];
    for c in candidates.into_iter().flatten() {
        if c.starts_with(&name) && c.len() > name.len() {
            return c;
        }
    }
    name
}

#[tauri::command]
fn snapshot(state: State<AppState>) -> Snapshot {
    let mut guard = state.0.lock().unwrap();
    let m = &mut *guard;
    let secs = m.last.elapsed().as_secs_f64().max(0.2);
    m.last = Instant::now();

    m.sys.refresh_cpu_usage();
    m.sys.refresh_memory();
    m.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
    m.nets.refresh(true);

    let users = &m.users;
    let procs = m
        .sys
        .processes()
        .values()
        .filter(|p| p.thread_kind().is_none())
        .map(|p| {
            let cmd_vec: Vec<String> =
                p.cmd().iter().map(|s| s.to_string_lossy().into_owned()).collect();
            let name = full_name(
                p.name().to_string_lossy().into_owned(),
                p.exe(),
                cmd_vec.first().map(String::as_str),
            );
            let du = p.disk_usage();
            ProcInfo {
                pid: p.pid().as_u32(),
                ppid: p.parent().map(|x| x.as_u32()).unwrap_or(0),
                name,
                cmd: cmd_vec.join(" "),
                user: p
                    .user_id()
                    .and_then(|u| users.get_user_by_id(u))
                    .map(|u| u.name().to_string())
                    .unwrap_or_default(),
                cpu: p.cpu_usage(),
                mem: p.memory(),
                io_r: (du.read_bytes as f64 / secs) as u64,
                io_w: (du.written_bytes as f64 / secs) as u64,
                status: status_label(p.status()),
            }
        })
        .collect();

    let nets = m
        .nets
        .iter()
        .filter(|(n, _)| n.as_str() != "lo")
        .map(|(n, d)| NetInfo {
            name: n.clone(),
            rx: (d.received() as f64 / secs) as u64,
            tx: (d.transmitted() as f64 / secs) as u64,
            total_rx: d.total_received(),
            total_tx: d.total_transmitted(),
        })
        .collect();

    let la = System::load_average();
    Snapshot {
        procs,
        cpu_total: m.sys.global_cpu_usage(),
        cores_usage: m.sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
        mem_used: m.sys.used_memory(),
        mem_total: m.sys.total_memory(),
        swap_used: m.sys.used_swap(),
        swap_total: m.sys.total_swap(),
        load: [la.one, la.five, la.fifteen],
        uptime: System::uptime(),
        nets,
        self_pid: std::process::id(),
    }
}

#[tauri::command]
fn system_info(state: State<AppState>) -> SysInfo {
    let m = state.0.lock().unwrap();
    SysInfo {
        host: System::host_name().unwrap_or_default(),
        os: System::long_os_version().unwrap_or_default(),
        kernel: System::kernel_version().unwrap_or_default(),
        cpu_brand: m.sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default(),
        cores: m.sys.cpus().len(),
    }
}

#[tauri::command]
fn disks(state: State<AppState>) -> Vec<DiskInfo> {
    let mut m = state.0.lock().unwrap();
    m.disks.refresh(true);
    m.disks
        .iter()
        .filter(|d| d.total_space() > 0)
        .map(|d| DiskInfo {
            name: d.name().to_string_lossy().into_owned(),
            mount: d.mount_point().to_string_lossy().into_owned(),
            fs: d.file_system().to_string_lossy().into_owned(),
            kind: d.kind().to_string(),
            total: d.total_space(),
            free: d.available_space(),
        })
        .collect()
}

fn proc_stat_fields(pid: u32) -> Option<(i32, u32)> {
    let s = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest: Vec<&str> = s[s.rfind(')')? + 2..].split_whitespace().collect();
    Some((rest.get(16)?.parse().ok()?, rest.get(17)?.parse().ok()?))
}

#[tauri::command]
fn process_details(pid: u32, state: State<AppState>) -> Result<Details, String> {
    let m = state.0.lock().unwrap();
    let p = m.sys.process(Pid::from_u32(pid)).ok_or("El proceso ya no existe")?;
    let stat = proc_stat_fields(pid);
    let du = p.disk_usage();
    Ok(Details {
        exe: p.exe().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(),
        cwd: p.cwd().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(),
        cmd: p.cmd().iter().map(|s| s.to_string_lossy()).collect::<Vec<_>>().join(" "),
        start: p.start_time(),
        run_time: p.run_time(),
        virt: p.virtual_memory(),
        threads: stat.map(|s| s.1),
        nice: stat.map(|s| s.0),
        fds: fs::read_dir(format!("/proc/{pid}/fd")).ok().map(|d| d.count()),
        io_read_total: du.total_read_bytes,
        io_write_total: du.total_written_bytes,
        parent: p
            .parent()
            .and_then(|pp| m.sys.process(pp))
            .map(|pp| pp.name().to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
}

fn protected(pid: u32) -> Option<&'static str> {
    if pid <= 1 {
        Some("init (PID 1) está protegido")
    } else if pid == std::process::id() {
        Some("Procly no puede actuar sobre sí mismo")
    } else {
        None
    }
}

/// Envía una señal a varios procesos. Devuelve la lista de errores (vacía = todo bien).
/// `signal`: term | kill | stop | cont
#[tauri::command]
fn signal_processes(pids: Vec<u32>, signal: String, state: State<AppState>) -> Vec<String> {
    let sig = match signal.as_str() {
        "term" => Signal::Term,
        "kill" => Signal::Kill,
        "stop" => Signal::Stop,
        "cont" => Signal::Continue,
        other => return vec![format!("Señal desconocida: {other}")],
    };
    let mut m = state.0.lock().unwrap();
    let targets: Vec<Pid> = pids.iter().copied().map(Pid::from_u32).collect();
    m.sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&targets),
        true,
        ProcessRefreshKind::nothing(),
    );
    let mut errors = Vec::new();
    for pid in pids {
        if let Some(why) = protected(pid) {
            errors.push(format!("{pid}: {why}"));
            continue;
        }
        match m.sys.process(Pid::from_u32(pid)) {
            None => errors.push(format!("{pid}: ya no existe")),
            Some(p) => {
                if p.kill_with(sig) != Some(true) {
                    errors.push(format!("{pid}: permiso denegado"));
                }
            }
        }
    }
    errors
}

/// Cambia la prioridad (nice, -20..19). Bajarla (valor mayor) no requiere root.
#[tauri::command]
fn set_priority(pids: Vec<u32>, nice: i32) -> Vec<String> {
    let nice = nice.clamp(-20, 19);
    let mut errors = Vec::new();
    for pid in pids {
        if let Some(why) = protected(pid) {
            errors.push(format!("{pid}: {why}"));
            continue;
        }
        // SAFETY: llamada FFI sin punteros.
        let r = unsafe { libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, nice) };
        if r != 0 {
            errors.push(format!("{pid}: {}", std::io::Error::last_os_error()));
        }
    }
    errors
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
    sys.refresh_cpu_all();
    sys.refresh_memory();

    tauri::Builder::default()
        .manage(AppState(Mutex::new(Monitor {
            sys,
            users: Users::new_with_refreshed_list(),
            nets: Networks::new_with_refreshed_list(),
            disks: Disks::new_with_refreshed_list(),
            last: Instant::now(),
        })))
        .invoke_handler(tauri::generate_handler![
            snapshot,
            system_info,
            disks,
            process_details,
            signal_processes,
            set_priority
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Procly");
}
