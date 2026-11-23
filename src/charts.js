// Gráficos de línea planos sobre <canvas>. Sin dependencias.
const Charts = (() => {
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  /**
   * @param canvas  elemento <canvas>
   * @param series  [{ data:number[], color:string }]
   * @param opt     { max:number|null (auto), fmt:(v)=>string, points:number }
   */
  function line(canvas, series, opt = {}) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const n = opt.points || 90;
    let max = opt.max;
    if (!max) {
      max = Math.max(1, ...series.flatMap((s) => s.data));
      const mag = Math.pow(10, Math.floor(Math.log10(max)));
      max = Math.ceil(max / mag) * mag;
    }
    const fmt = opt.fmt || ((v) => v.toFixed(0));

    ctx.font = "11px ui-monospace, monospace";
    const labelW = Math.max(...[0, max / 2, max].map((v) => ctx.measureText(fmt(v)).width));
    const pad = { l: Math.ceil(labelW) + 14, r: 8, t: 8, b: 6 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(pad.t + (ih * i) / 4) + 0.5;
      ctx.strokeStyle = css("--line");
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = css("--muted");
      ctx.textAlign = "right";
      ctx.fillText(fmt(max * (1 - i / 4)), pad.l - 6, y);
    }

    for (const s of series) {
      const d = s.data.slice(-n);
      if (d.length < 2) continue;
      const step = iw / (n - 1);
      const x0 = pad.l + iw - (d.length - 1) * step;
      const pts = d.map((v, i) => [x0 + i * step, pad.t + ih - Math.min(1, v / max) * ih]);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke();
      ctx.lineTo(pts[pts.length - 1][0], pad.t + ih);
      ctx.lineTo(pts[0][0], pad.t + ih);
      ctx.closePath();
      ctx.globalAlpha = 0.1; ctx.fillStyle = s.color; ctx.fill(); ctx.globalAlpha = 1;
    }
  }
  return { line, css };
})();

// Sparkline mínima para las tarjetas resumen.
Charts.spark = (canvas, data, color, max = 100) => {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const n = 90, step = w / (n - 1), x0 = w - (data.length - 1) * step;
  const pts = data.map((v, i) => [x0 + i * step, h - 2 - Math.min(1, v / max) * (h - 4)]);
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke();
  ctx.lineTo(pts.at(-1)[0], h); ctx.lineTo(pts[0][0], h); ctx.closePath();
  ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
};
