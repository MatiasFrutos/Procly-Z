// Genera las capturas de docs/screenshots/ con datos simulados (no muestra tus procesos reales).
// Requiere Playwright:  npm i --no-save playwright && node scripts/screenshots.cjs
const { chromium } = require("playwright");
const path = require("path");
const root = path.resolve(__dirname, "..");
const out = path.join(root, "docs", "screenshots");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("procly.settings", JSON.stringify({ lang: "en", interval: 500, theme: "dark", accent: "blue" }));
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const templates = [
      ["Hyprland", "/usr/bin/Hyprland", 1, 2.5, 180e6], ["waybar", "/usr/bin/waybar", 1, 0.6, 95e6], ["firefox", "/usr/lib/firefox/firefox", 1, 5, 780e6],
      ["Isolated Web Content", "/usr/lib/firefox/firefox -contentproc", 3, 1.5, 420e6], ["code", "/opt/visual-studio-code/code", 1, 4, 640e6],
      ["rust-analyzer", "/usr/bin/rust-analyzer", 1, 3, 910e6], ["cargo", "/usr/bin/cargo build --release", 1, 22, 240e6], ["rustc", "/usr/bin/rustc", 2, 40, 520e6],
      ["node", "/usr/bin/node server.js", 2, 1.2, 130e6], ["postgres", "/usr/bin/postgres -D /var/lib/postgres/data", 5, 0.4, 70e6],
      ["docker", "/usr/bin/dockerd", 1, 0.8, 110e6], ["pipewire", "/usr/bin/pipewire", 1, 0.9, 28e6], ["wireplumber", "/usr/bin/wireplumber", 1, 0.3, 40e6],
      ["kitty", "/usr/bin/kitty", 3, 0.4, 90e6], ["nvim", "/usr/bin/nvim", 2, 0.5, 60e6], ["systemd", "/usr/lib/systemd/systemd --user", 1, 0.1, 18e6],
      ["dbus-daemon", "/usr/bin/dbus-daemon --session", 1, 0.1, 6e6], ["NetworkManager", "/usr/bin/NetworkManager", 1, 0.2, 30e6],
      ["chromium", "/usr/lib/chromium/chromium", 1, 3, 540e6], ["spotify", "/usr/bin/spotify", 1, 1.8, 380e6], ["obsidian", "/usr/bin/obsidian", 1, 0.7, 310e6],
    ];
    const procs = []; let pid = 700; const users = ["matias", "matias", "matias", "root"];
    for (const [name, cmd, n, cpu, mem] of templates) {
      for (let i = 0; i < n; i++) {
        pid += 1 + Math.floor(rnd() * 90);
        procs.push({ pid, ppid: i ? procs.at(-1).pid : 1, name, cmd, user: name === "docker" || name === "NetworkManager" || name === "systemd" && false ? "root" : users[Math.floor(rnd() * 3)], base: cpu * (0.4 + rnd()), mem: mem * (0.6 + rnd() * 0.8), io: rnd() < .25 ? rnd() * 4e6 : 0, status: rnd() < .12 ? "sleep" : "run" });
      }
    }
    procs.find((p) => p.name === "spotify").status = "stop";
    let cpuT = 28, mem = 0.41, rx = 1.2e6, tx = 2e5;
    window.__TAURI__ = { webview: {}, core: { invoke: async (c, a) => {
      if (c === "snapshot") {
        cpuT = Math.max(6, Math.min(88, cpuT + (rnd() - 0.48) * 9)); rx = Math.max(1e5, rx * (0.7 + rnd() * 0.7)); tx = Math.max(2e4, tx * (0.7 + rnd() * 0.7));
        return {
          procs: procs.map((p) => ({ ...p, cpu: Math.max(0, p.base * (0.6 + rnd() * 0.9)) * 8 * cpuT / 40, mem: Math.floor(p.mem), io_r: Math.floor(p.io), io_w: 0 })),
          cpu_total: cpuT, cores_usage: Array.from({ length: 12 }, () => Math.max(2, Math.min(100, cpuT + (rnd() - 0.5) * 60))),
          mem_used: 13.1e9 + rnd() * 4e8, mem_total: 31.2e9, swap_used: 0.6e9, swap_total: 8e9, load: [1.42, 1.18, 0.96], uptime: 190000,
          nets: [{ name: "wlan0", rx, tx, total_rx: 41e9, total_tx: 3.2e9 }, { name: "docker0", rx: 0, tx: 0, total_rx: 8e6, total_tx: 2e6 }], self_pid: 1,
        };
      }
      if (c === "system_info") return { host: "omarchy", os: "Arch Linux", kernel: "6.12.8-arch1-1", cpu_brand: "AMD Ryzen 7 7840U", cores: 12 };
      if (c === "disks") return [
        { name: "/dev/nvme0n1p2", mount: "/", fs: "btrfs", kind: "SSD", total: 1e12, free: 3.9e11 },
        { name: "/dev/nvme0n1p1", mount: "/boot", fs: "vfat", kind: "SSD", total: 2e9, free: 1.6e9 },
        { name: "/dev/sda1", mount: "/mnt/data", fs: "ext4", kind: "HDD", total: 4e12, free: 3.1e11 },
      ];
      if (c === "process_details") { const p = procs.find((x) => x.pid === a.pid) || procs[0]; return { exe: p.cmd.split(" ")[0], cwd: "/home/matias", cmd: p.cmd, start: Math.floor(Date.now() / 1000) - 5400, run_time: 5400, virt: p.mem * 3, threads: 14, nice: 0, fds: 64, io_read_total: 2.4e8, io_write_total: 1.1e7, parent: "systemd" }; }
      return [];
    } } };
  });
  await page.goto("file://" + path.join(root, "src", "index.html"));
  await page.waitForTimeout(16000); // acumula historial para los gráficos
  const shot = (name) => page.screenshot({ path: path.join(out, name + ".png") });

  // Procesos (oscuro)
  await page.click('.row:has-text("rust-analyzer")'); await page.waitForTimeout(400);
  await shot("processes-dark");
  // Árbol + filtro
  await page.click('[data-mode="tree"]'); await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  // Diálogo de confirmación
  await page.click('[data-mode="list"]'); await page.click('.row:has-text("cargo")'); await page.keyboard.press("Delete"); await page.waitForTimeout(250);
  await shot("confirm-dialog");
  await page.keyboard.press("Escape");
  // Rendimiento, red, discos
  for (const [tab, name] of [["perf", "performance-dark"], ["net", "network-dark"], ["disks", "disks-dark"], ["settings", "settings-dark"]]) {
    await page.click(`[data-tab="${tab}"]`); await page.waitForTimeout(500); await shot(name);
  }
  // Tema claro + acento verde
  await page.click('[data-theme-opt="light"]'); await page.click('[data-accent="green"]'); await page.waitForTimeout(300); await shot("settings-light");
  await page.click('[data-tab="perf"]'); await page.waitForTimeout(500); await shot("performance-light");
  await page.click('[data-tab="procs"]'); await page.click('[data-mode="group"]'); await page.waitForTimeout(500); await shot("processes-light");
  await browser.close();
})();
