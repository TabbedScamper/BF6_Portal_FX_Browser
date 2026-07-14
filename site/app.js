/* ============================================================
   BF6 Portal FX Library
   Card grid + WebGL2 particle player (flipbook billboards,
   procedural sparks, mesh particles). Parameters come from
   manifest.json + editor_fx_params.json, both decoded from game
   data by tools/build_manifest.py; approximations are documented
   in the README and flagged in the data files.

   Viewer stage: orbit (drag) / dolly (wheel) / pan (MMB) plus
   RMB freelook + WASD fly — same control scheme as the BF6
   Portal Model Library site.
   ============================================================ */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const CLASS_ORDER = ["fire", "smoke", "explosion", "spark", "water", "debris", "other"];
const CLASS_ICON = {
  fire: "\u{1F525}", smoke: "☁", explosion: "☀", spark: "⚡",
  water: "\u{1F4A7}", debris: "▪", other: "✦",
};
const TIER_LABEL = { 1: "LIVE", 2: "PROC", 3: "SOON", 4: "MESH" };
const TIER_TITLE = {
  1: "Live preview: real flipbook sprites + decoded parameters",
  2: "Procedural approximation of the game's GPU spark sim",
  3: "No live preview yet (baked shaders or unmined map bundle)",
  4: "Mesh-particle preview: real game mesh + decoded spawn parameters",
};

let MANIFEST = null;
let ED = { class_defaults: {}, graphs: {} };
let FILTER = { cls: "all", q: "", onlyLive: false, map: "all" };
let SB_URL = "https://tabbedscamper.github.io/BF6_Portal_SoundBoard/";

/* ------------------------------------------------------------ boot ---- */
Promise.all([
  fetch("manifest.json").then((r) => r.json()),
  fetch("editor_fx_params.json").then((r) => r.json()).catch(() => ED),
])
  .then(([m, ep]) => {
    MANIFEST = m;
    ED = ep || ED;
    if (m._meta.soundboard_url) SB_URL = m._meta.soundboard_url;
    buildStats(m);
    buildChips(m);
    buildMapSelect(m);
    renderGrid();
    $("#loader").classList.add("hide");
  })
  .catch((e) => {
    $("#loader .loader-text").textContent = "FAILED TO LOAD MANIFEST";
    console.error(e);
  });

function buildStats(m) {
  const t = m._meta.tiers;
  const s = [
    [m._meta.portal_fx_total, "placeable FX"],
    [t.tier1_flipbook, "live previews"],
    [(t.tier2_procedural || 0) + (t.tier4_mesh || 0), "proc + mesh"],
    [Object.keys(m._meta.classes).length, "categories"],
  ];
  $("#headerStats").innerHTML = s
    .map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`)
    .join("");
}

function buildChips(m) {
  const counts = {};
  m.fx.forEach((e) => (counts[e.class] = (counts[e.class] || 0) + 1));
  const chips = [["all", m.fx.length]].concat(
    CLASS_ORDER.filter((c) => counts[c]).map((c) => [c, counts[c]])
  );
  $("#classChips").innerHTML = chips
    .map(
      ([c, n]) =>
        `<button class="chip${c === "all" ? " on" : ""}" data-cls="${c}">${
          c === "all" ? "All" : c
        }<b>${n}</b></button>`
    )
    .join("");
  $$(".chip").forEach((ch) =>
    ch.addEventListener("click", () => {
      $$(".chip").forEach((x) => x.classList.remove("on"));
      ch.classList.add("on");
      FILTER.cls = ch.dataset.cls;
      renderGrid();
    })
  );
}

/* per-map availability filter — the same per-map view the SFX/FX Folders
   addon gives creators inside the SDK (maps from the SDK level restrictions) */
function mapLabel(code) {
  return code.replace(/^MP_/, "").replace(/_/g, " ");
}
function buildMapSelect(m) {
  const codes = new Set();
  m.fx.forEach((e) => (e.maps || []).forEach((c) => codes.add(c)));
  const opts = [...codes].sort((a, b) => mapLabel(a).localeCompare(mapLabel(b)));
  const sel = $("#mapSel");
  sel.innerHTML =
    `<option value="all">All maps</option>` +
    `<option value="global">Global (no restriction)</option>` +
    opts.map((c) => `<option value="${c}">${mapLabel(c)}</option>`).join("");
  sel.addEventListener("change", () => {
    FILTER.map = sel.value;
    renderGrid();
  });
}

$("#search").addEventListener("input", (e) => {
  FILTER.q = e.target.value.trim().toLowerCase();
  $("#searchWrap").classList.toggle("has-text", !!FILTER.q);
  renderGrid();
});
$("#searchClear").addEventListener("click", () => {
  $("#search").value = "";
  FILTER.q = "";
  $("#searchWrap").classList.remove("has-text");
  renderGrid();
});
$("#onlyLive").addEventListener("change", (e) => {
  FILTER.onlyLive = e.target.checked;
  renderGrid();
});
$("#aboutBtn").addEventListener("click", () => ($("#aboutOverlay").hidden = false));
$("#aboutClose").addEventListener("click", () => ($("#aboutOverlay").hidden = true));
$("#aboutOverlay").addEventListener("click", (e) => {
  if (e.target === $("#aboutOverlay")) $("#aboutOverlay").hidden = true;
});

/* ------------------------------------------------------------ grid ---- */
function fxMatches(e) {
  if (FILTER.cls !== "all" && e.class !== FILTER.cls) return false;
  if (FILTER.onlyLive && e.tier === 3) return false;
  if (FILTER.map === "global") {
    if (e.maps && e.maps.length) return false;
  } else if (FILTER.map !== "all") {
    if (e.maps && e.maps.length && !e.maps.includes(FILTER.map)) return false;
  }
  if (FILTER.q) {
    const hay = (
      e.name + " " + (e.maps || []).join(" ") + " " +
      e.emitters.map((m) => m.graph).join(" ")
    ).toLowerCase();
    if (!hay.includes(FILTER.q)) return false;
  }
  return true;
}

let thumbObserver = null;

function renderGrid() {
  const grid = $("#grid");
  const list = MANIFEST.fx.filter(fxMatches);
  $("#empty").hidden = list.length > 0;
  grid.innerHTML = "";
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(onThumbVisible, { rootMargin: "200px" });
  list.forEach((e) => {
    const card = document.createElement("div");
    card.className = "card" + (e.tier === 3 ? " dim" : "");
    card.dataset.name = e.name;
    const mapsBadge = e.maps && e.maps.length
      ? `<span class="badge maps" title="${e.maps.join(", ")}">${e.maps.length} map${e.maps.length > 1 ? "s" : ""}</span>`
      : `<span class="badge maps" title="No level restriction">all maps</span>`;
    const sndBadge = (e.sounds_ref || []).some((s) => s.clip)
      ? `<span class="badge snd" title="Linked SFX Library clip">♪</span>` : "";
    card.innerHTML = `
      <div class="card-thumb"><span class="thumb-ico">${CLASS_ICON[e.class] || "✦"}</span>
        <div class="card-play"><span>${e.tier === 3 ? "ℹ" : "▶"}</span></div>
      </div>
      <div class="card-body">
        <div class="card-name">${e.name}</div>
        <div class="card-meta">
          <span class="badge tier${e.tier}" title="${TIER_TITLE[e.tier]}">${TIER_LABEL[e.tier]}</span>
          <span class="badge cls-${e.class}">${e.class}</span>
          ${mapsBadge}${sndBadge}
        </div>
      </div>`;
    card.addEventListener("click", () => openPlayer(e));
    grid.appendChild(card);
    if (e.tier !== 3) thumbObserver.observe(card);
  });
}

/* ---- lazy sprite thumbnails on cards ---- */
const IMG_CACHE = new Map();
function loadImage(file) {
  if (IMG_CACHE.has(file)) return IMG_CACHE.get(file);
  const p = new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = file;
  });
  IMG_CACHE.set(file, p);
  return p;
}

function spriteFrameRect(sp, idx, imgW, imgH) {
  const fw = imgW / sp.cols, fh = imgH / sp.rows;
  const c = idx % sp.cols, r = Math.floor(idx / sp.cols);
  return [c * fw, r * fh, fw, fh];
}

function onThumbVisible(entries) {
  entries.forEach((en) => {
    if (!en.isIntersecting) return;
    thumbObserver.unobserve(en.target);
    const e = MANIFEST.fx.find((x) => x.name === en.target.dataset.name);
    if (e) drawThumb(en.target.querySelector(".card-thumb"), e);
  });
}

/* decoded linear-RGB param color -> css/display sRGB triple (0..255) */
function linToSrgb(x) {
  x = Math.max(0, Math.min(1, x));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}
function paramColor(p, key) {
  const v = p && p[key];
  if (Array.isArray(v)) {
    const m = Math.max(v[0], v[1], v[2]);
    if (m <= 0) return [0, 0, 0];  // authored black tint (dark smoke cores)
    const s = m > 1 ? 1 / m : 1;   // HDR emissive colors: normalize hue, clamp
    return [linToSrgb(v[0] * s), linToSrgb(v[1] * s), linToSrgb(v[2] * s)];
  }
  if (typeof v === "number" && v > 0 && v !== 1)
    return [linToSrgb(Math.min(v, 1)), linToSrgb(Math.min(v, 1)), linToSrgb(Math.min(v, 1))];
  return null;
}
function emitterTintCss(em) {
  const c = paramColor(em.params, "color1") || paramColor(em.params, "color0");
  if (!c) return null;
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
}

function renderModeFor(em) {
  // decoded per-sheet render hint (see manifest _meta.evidence.blend);
  // fall back to the old name heuristic for entries without a sprite
  if (em.sprite && em.sprite.render) return em.sprite.render;
  const n = (em.graph + " " + ((em.sprite && em.sprite.file) || "")).toLowerCase();
  if (/fire|flame|ember|glow|muzzle|tracer|lava|molten/.test(n)) return "emissive";
  return em.sprite && em.sprite.left_right_tiles ? "sixway" : "lit";
}

async function drawThumb(holder, e) {
  const em = e.emitters.find((m) => m.renderable && m.sprite);
  const cv = document.createElement("canvas");
  cv.width = 320; cv.height = 200;
  const ctx = cv.getContext("2d");
  if (em) {
    try {
      const img = await loadImage(em.sprite.file);
      const fi = Math.floor(em.sprite.frames * 0.28);
      const [sx, sy, sw, sh] = spriteFrameRect(em.sprite, fi, img.width, img.height);
      const mode = renderModeFor(em);
      if (mode === "emissive") ctx.globalCompositeOperation = "lighter";
      const s = Math.min(cv.width / sw, cv.height / sh) * 0.92;
      const dw = sw * s, dh = sh * s;
      ctx.drawImage(img, sx, sy, sw, sh,
        (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
      if (mode !== "emissive" && em.sprite.left_right_tiles) {
        // 6-way lighting base: flatten the RGB weights to the decoded tint
        // (colored marker smokes) or neutral smoke grey
        const t = emitterTintCss(em);
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = t
          ? `rgba(${t[0]},${t[1]},${t[2]},0.85)`
          : "rgba(178,182,190,0.82)";
        ctx.fillRect(0, 0, cv.width, cv.height);
      }
    } catch (_e) { /* keep icon */ }
  } else if (e.tier === 2) {
    drawSparkThumb(ctx, cv.width, cv.height);
  } else if (e.tier === 4) {
    drawMeshThumb(ctx, cv.width, cv.height);
  } else {
    return;
  }
  holder.querySelector(".thumb-ico")?.remove();
  holder.prepend(cv);
}

function drawSparkThumb(ctx, w, h) {
  ctx.globalCompositeOperation = "lighter";
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 26; i++) {
    const x = w / 2 + (rnd() - 0.5) * 30, y = h * 0.42;
    const a = rnd() * Math.PI * 2, len = 14 + rnd() * 46;
    const dx = Math.cos(a) * len, dy = Math.sin(a) * len * 0.9 + len * 0.35;
    const g = ctx.createLinearGradient(x, y, x + dx, y + dy);
    g.addColorStop(0, "rgba(255,240,190,0.9)");
    g.addColorStop(1, "rgba(255,120,20,0)");
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + dx * 0.5, y + dy * 0.5 - 6, x + dx, y + dy);
    ctx.stroke();
  }
}

function drawMeshThumb(ctx, w, h) {
  // stylized tumbling-chunk glyph
  ctx.strokeStyle = "rgba(201,161,122,0.75)";
  ctx.lineWidth = 2;
  let seed = 13;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 7; i++) {
    const x = w * (0.25 + rnd() * 0.5), y = h * (0.2 + rnd() * 0.55);
    const s = 8 + rnd() * 18, a = rnd() * Math.PI;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.strokeRect(-s / 2, -s / 3, s, s * 0.66);
    ctx.restore();
  }
}

/* ============================================================
   PLAYER — WebGL2: flipbook billboards, spark streaks, meshes
   ============================================================ */
const Player = {
  gl: null, canvas: null, raf: 0, emitters: [], lastT: 0,
  cam: {
    yaw: 0.5, pitch: 0.22, dist: 9, target: [0, 1.4, 0],
    flying: false, flySpeed: 1,
  },
  frameSize: 10, stageR: 8, stageH: 6,
  progQuad: null, progGrid: null, progMesh: null,
  quadVAO: null, gridVAO: null, gridN: 0, boxVAO: null, boxBuf: null, boxN: 0,
  instBuf: null,
  texCache: new Map(), glbCache: new Map(), running: false,
  keys: {}, audio: null, replayBursts: true,
};

function cubic(c, t) {
  // decoded *OverLife / *Curve params: cubic envelope a*t^3+b*t^2+c*t+d
  return ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
}

function lookFor(em) {
  // per-graph decoded look + per-class fallbacks (editor_fx_params.json)
  const g = (ED.graphs && ED.graphs[em.graph]) || {};
  const cd = ED.class_defaults || {};
  let cls;
  if (em.mesh) cls = cd.meshdebris;
  else if (!em.sprite) cls = cd.sparks;
  else cls = renderModeFor(em) === "emissive" ? cd.globalsorting_fire : cd.globalsorting_smoke;
  return { g, cls: cls || {} };
}

function openPlayer(e) {
  $("#playerOverlay").hidden = false;
  $("#playerName").textContent = e.name;
  const mapsTxt = e.maps && e.maps.length ? e.maps.join(", ") : "all maps";
  $("#playerBadges").innerHTML =
    `<span class="badge tier${e.tier}">${TIER_LABEL[e.tier]}</span>` +
    `<span class="badge cls-${e.class}">${e.class}</span>` +
    `<span class="badge maps" title="${mapsTxt}">${e.maps && e.maps.length ? e.maps.length + " map" + (e.maps.length > 1 ? "s" : "") : "all maps"}</span>`;
  buildSidePanel(e);
  buildSoundButton(e);
  const renderables = e.emitters.filter(
    (m) => m.renderable && (m.sprite || m.mesh || m.family === "sparks" ||
           m.family === "thindebris" || m.family === "pebbles"));
  const anyBurst = renderables.some((m) => m.spawn_mode === "burst");
  $("#replayWrap").hidden = !anyBurst;
  if (!renderables.length) {
    $("#playerPlaceholder").hidden = false;
    $("#phReason").textContent = placeholderReason(e);
    stopPlayer();
    return;
  }
  $("#playerPlaceholder").hidden = true;
  startPlayer(renderables);
}

function placeholderReason(e) {
  if (e.status === "not_in_dumps")
    return "This effect lives in a map bundle that has not been mined yet. An in-game capture is planned.";
  if (e.status === "stub_or_empty")
    return "The effect's visual content is baked into runtime logic (one-shot / scripted). An in-game capture is planned.";
  return "This family (screen effect / decal / distortion) runs on baked GPU compute shaders that cannot be re-simulated from data. An in-game capture is planned.";
}

/* ---- optional linked audio (clips stay hosted on the SFX Library) ---- */
function stopAudio() {
  if (Player.audio) {
    Player.audio.pause();
    Player.audio = null;
  }
  $("#soundBtn").classList.remove("on");
}
function buildSoundButton(e) {
  const btn = $("#soundBtn");
  stopAudio();
  const match = (e.sounds_ref || []).find((s) => s.clip);
  if (!match) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.title = "Play the linked SFX Library clip: " + match.sb_name;
  btn.onclick = () => {
    if (Player.audio) { stopAudio(); return; }
    const a = new Audio(SB_URL + match.clip);
    a.loop = !!match.loop;
    a.volume = 0.7;
    a.play().catch(() => {});
    Player.audio = a;
    btn.classList.add("on");
    a.onended = () => { if (!a.loop) stopAudio(); };
  };
}
$("#replayChk").addEventListener("change", (e) => {
  Player.replayBursts = e.target.checked;
});

$("#playerClose").addEventListener("click", closePlayer);
$("#playerOverlay").addEventListener("click", (e) => {
  if (e.target === $("#playerOverlay")) closePlayer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#playerOverlay").hidden) closePlayer();
    else if (!$("#aboutOverlay").hidden) $("#aboutOverlay").hidden = true;
  }
  if (!$("#playerOverlay").hidden) Player.keys[e.key.toLowerCase()] = true;
});
document.addEventListener("keyup", (e) => {
  Player.keys[e.key.toLowerCase()] = false;
});
function closePlayer() {
  $("#playerOverlay").hidden = true;
  stopAudio();
  stopPlayer();
}

/* ---- side panel ---- */
function fmt(v, d = 2) {
  if (v === null || v === undefined) return "—";
  return typeof v === "number" ? (+v.toFixed(d)).toString() : String(v);
}
function swatchFor(p, key) {
  const c = paramColor(p, key);
  if (!c) return null;
  const css = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
  return `<span class="swatch" style="background:${css}"></span>`;
}
function colorRow(p) {
  const s0 = swatchFor(p, "color0"), s1 = swatchFor(p, "color1");
  if (!s0 && !s1) return "";
  const v = p.color1 || p.color0;
  const label = !Array.isArray(v) ? fmt(v)
    : Math.max(v[0], v[1], v[2]) > 8
      ? "HDR ×" + fmt(Math.max(v[0], v[1], v[2]), 0)
      : v.slice(0, 3).map((x) => fmt(x, 2)).join(", ");
  return `<div class="prow"><span class="k">tint</span><span class="v">${s0 || ""}${s1 || ""}${label}</span></div>`;
}
function buildSidePanel(e) {
  const rows = [];
  e.emitters.forEach((m) => {
    if (m.family === "dummy") return;
    const p = m.params || {};
    const spr = m.sprite
      ? `<div class="prow"><span class="k">flipbook</span><span class="v">${m.sprite.cols}×${m.sprite.rows} · ${m.sprite.frames}f${m.sprite.left_right_tiles ? " · 6-way" : ""}</span></div>` +
        `<div class="prow"><span class="k">render</span><span class="v">${m.sprite.render || "—"}</span></div>`
      : "";
    const mesh = m.mesh
      ? `<div class="prow"><span class="k">mesh</span><span class="v hl">${m.mesh.mesh_name}</span></div>`
      : "";
    rows.push(`
      <div class="pcard">
        <h3>${m.graph}<span class="fam">${m.family}${m.from_child ? " · child" : ""}</span></h3>
        <div class="prow"><span class="k">spawn</span><span class="v hl">${m.spawn_mode === "burst" ? "burst × " + fmt(m.max_count, 0) : fmt(m.spawn_rate.value) + " /s"}${m.spawn_rate.source === "graph_default" && m.spawn_mode !== "burst" ? " *" : ""}</span></div>
        <div class="prow"><span class="k">lifetime</span><span class="v hl">${fmt(m.lifetime.value)} s</span></div>
        <div class="prow"><span class="k">max particles</span><span class="v">${fmt(m.max_count, 0)}</span></div>
        ${p.basesize !== undefined ? `<div class="prow"><span class="k">base size</span><span class="v hl">${fmt(p.basesize)} m</span></div>` : ""}
        ${p.spawnspeed !== undefined ? `<div class="prow"><span class="k">spawn speed</span><span class="v">${fmt(p.spawnspeed)} m/s</span></div>` : ""}
        ${p.drag !== undefined ? `<div class="prow"><span class="k">drag</span><span class="v">${fmt(p.drag)}</span></div>` : ""}
        ${p.windstrength !== undefined ? `<div class="prow"><span class="k">wind</span><span class="v">${fmt(p.windstrength)}</span></div>` : ""}
        ${p.buoyancy !== undefined && p.buoyancy !== 0 ? `<div class="prow"><span class="k">buoyancy</span><span class="v">${fmt(p.buoyancy)}</span></div>` : ""}
        ${p.gravity !== undefined ? `<div class="prow"><span class="k">gravity</span><span class="v">${fmt(p.gravity)} m/s²</span></div>` : ""}
        ${p.restitution !== undefined ? `<div class="prow"><span class="k">bounce</span><span class="v">${fmt(p.restitution)}</span></div>` : ""}
        ${p.temperature !== undefined ? `<div class="prow"><span class="k">temperature</span><span class="v">${fmt(p.temperature)}</span></div>` : ""}
        ${p.opacity !== undefined ? `<div class="prow"><span class="k">opacity</span><span class="v">${fmt(p.opacity)}</span></div>` : ""}
        ${p.emissiveintensitymult !== undefined ? `<div class="prow"><span class="k">emissive ×</span><span class="v">${fmt(Array.isArray(p.emissiveintensitymult) ? p.emissiveintensitymult[0] : p.emissiveintensitymult, 0)}</span></div>` : ""}
        ${colorRow(p)}
        ${m.n_overrides ? `<div class="prow"><span class="k">authored overrides</span><span class="v">${m.n_overrides}</span></div>` : ""}
        ${spr}${mesh}
      </div>`);
  });
  (e.sounds_ref || []).forEach((s) => {
    rows.push(`
      <div class="pcard">
        <h3>Sound<span class="fam">config</span></h3>
        <div class="prow"><span class="k">config</span><span class="v">${s.config}</span></div>
        ${s.clip
          ? `<div class="prow"><span class="k">SFX Library</span><span class="v hl">${s.sb_name}</span></div>
             <div class="prow"><span class="k">clip</span><span class="v">${fmt(s.dur, 1)} s${s.loop ? " · loop" : ""}</span></div>`
          : `<div class="prow"><span class="k">SFX Library</span><span class="v">no matching clip</span></div>`}
      </div>`);
  });
  if (!rows.length) rows.push(`<div class="pcard"><h3>No emitter data</h3>
    <div class="pnote">${placeholderReason(e)}</div></div>`);
  rows.push(`<div class="pcard"><div class="pnote">Values decoded from the game's
    effect blueprints, emitter-graph templates and per-emitter override tables.
    * = template default (no per-effect override). Tints are the decoded
    Color0/Color1 pair (linear RGB). Flipbook playback speed is baked into
    compiled shaders &mdash; the player spreads frames over the particle
    lifetime.</div></div>`);
  $("#playerEmitters").innerHTML = rows.join("");
}

/* ---- GL shaders ---- */
const VS_QUAD = `#version 300 es
layout(location=0) in vec2 corner;      // -0.5..0.5 unit quad
layout(location=1) in vec4 iPosSize;    // xyz world pos, w size
layout(location=2) in vec4 iMisc;       // frame, alpha, rot, stretch
layout(location=3) in vec4 iVelU;       // xyz velocity (streaks), w life frac
uniform mat4 uVP;
uniform vec3 uCamRight, uCamUp;
uniform vec2 uGrid;                     // cols, rows
uniform float uStreak;                  // 0 = billboard, 1 = velocity streak
out vec2 vUV;
out float vAlpha;
out float vU;
void main(){
  float frame = floor(iMisc.x);
  float c = mod(frame, uGrid.x);
  float r = floor(frame / uGrid.x);
  vec2 cell = vec2(1.0/uGrid.x, 1.0/uGrid.y);
  vec2 corn = corner;
  float rot = iMisc.z;
  mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
  corn = R * corn;
  vec3 right, up, wp;
  if (uStreak > 0.5) {
    vec3 dir = normalize(iVelU.xyz + vec3(0.0001));
    right = dir * (iMisc.w * iPosSize.w);
    up = normalize(cross(dir, vec3(0.12,0.93,0.35))) * iPosSize.w * 0.08;
    wp = iPosSize.xyz + right*corn.x + up*corn.y;
  } else {
    right = uCamRight * iPosSize.w;
    up = uCamUp * iPosSize.w;
    wp = iPosSize.xyz + right*corn.x + up*corn.y;
  }
  gl_Position = uVP * vec4(wp, 1.0);
  vUV = (vec2(c, r) + corner + 0.5) * cell;
  vAlpha = iMisc.y;
  vU = iVelU.w;
}`;

const FS_QUAD = `#version 300 es
precision mediump float;
in vec2 vUV;
in float vAlpha;
in float vU;
uniform sampler2D uTex;
uniform int uMode;        // 0 emissive-additive, 1 lit-alpha, 2 sixway, 3 streak
uniform vec4 uTint0;      // decoded Color0 (display sRGB)
uniform vec4 uTint1;      // decoded Color1 (display sRGB)
uniform vec3 uLightDir;   // weights for the 6-way lighting base
out vec4 frag;
void main(){
  vec4 tint = mix(uTint0, uTint1, clamp(vU, 0.0, 1.0));
  if (uMode == 3) {
    float core = 1.0 - abs(vUV.y*2.0-1.0);
    frag = vec4(tint.rgb * core * vAlpha, 0.0);
    return;
  }
  vec4 t = texture(uTex, vUV);
  if (uMode == 0) {
    frag = vec4(t.rgb * tint.rgb * (t.a * vAlpha * tint.a), 0.0);
  } else if (uMode == 2) {
    float lit = clamp(dot(t.rgb, uLightDir) * 1.55 + 0.14, 0.0, 1.3);
    vec3 col = tint.rgb * lit;
    float a = t.a * vAlpha * tint.a;
    frag = vec4(col * a, a);
  } else {
    float a = t.a * vAlpha * tint.a;
    frag = vec4(t.rgb * tint.rgb * a, a);
  }
}`;

const VS_MESH = `#version 300 es
layout(location=0) in vec3 pos;
layout(location=1) in vec3 nrm;
layout(location=2) in vec4 iPosScale;   // world pos, uniform scale
layout(location=3) in vec4 iAxisAng;    // rotation axis xyz, angle w
uniform mat4 uVP;
out vec3 vN;
vec3 rot(vec3 p, vec3 ax, float an){
  return p*cos(an) + cross(ax,p)*sin(an) + ax*dot(ax,p)*(1.0-cos(an));
}
void main(){
  vec3 ax = normalize(iAxisAng.xyz + vec3(0.0001));
  vec3 wp = rot(pos * iPosScale.w, ax, iAxisAng.w) + iPosScale.xyz;
  vN = rot(nrm, ax, iAxisAng.w);
  gl_Position = uVP * vec4(wp, 1.0);
}`;

const FS_MESH = `#version 300 es
precision mediump float;
in vec3 vN;
uniform vec4 uTint;
out vec4 frag;
void main(){
  vec3 L1 = normalize(vec3(0.5, 0.8, 0.3));
  vec3 L2 = normalize(vec3(-0.6, 0.2, -0.5));
  float d = max(dot(normalize(vN), L1), 0.0) + 0.35*max(dot(normalize(vN), L2), 0.0);
  vec3 col = uTint.rgb * (0.22 + 0.85 * d);
  frag = vec4(col, 1.0);
}`;

/* stage: floor grid + viewing-box lines (same dark-stage presentation as the
   Model Library viewer). p.xyz = line vertex, fade by distance from centre. */
const VS_GRID = `#version 300 es
layout(location=0) in vec3 p;
uniform mat4 uVP;
uniform float uFadeR;
out float vFade;
void main(){
  gl_Position = uVP * vec4(p,1.0);
  vFade = clamp(1.0 - length(p.xz)/uFadeR, 0.0, 1.0);
}`;
const FS_GRID = `#version 300 es
precision mediump float;
in float vFade;
uniform vec4 uCol;
out vec4 frag;
void main(){ frag = vec4(uCol.rgb, uCol.a * vFade); }`;

function makeProg(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(t);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function initGL() {
  if (Player.gl) return true;
  const canvas = $("#stage");
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, premultipliedAlpha: true });
  if (!gl) return false;
  Player.gl = gl;
  Player.canvas = canvas;
  Player.progQuad = makeProg(gl, VS_QUAD, FS_QUAD);
  Player.progGrid = makeProg(gl, VS_GRID, FS_GRID);
  Player.progMesh = makeProg(gl, VS_MESH, FS_MESH);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const corners = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
  const cb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cb);
  gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  Player.instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, Player.instBuf);
  const stride = 12 * 4;
  for (const [loc, n, off] of [[1, 4, 0], [2, 4, 16], [3, 4, 32]]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off);
    gl.vertexAttribDivisor(loc, 1);
  }
  Player.quadVAO = vao;

  // floor grid: 1 m minor lines over an 80 m square (fade radius set per FX)
  const minor = [], major = [];
  for (let i = -40; i <= 40; i++) {
    (i % 5 === 0 ? major : minor).push(i, 0, -40, i, 0, 40, -40, 0, i, 40, 0, i);
  }
  const lines = minor.concat(major);
  Player.gridMinorN = minor.length / 3;
  const gvao = gl.createVertexArray();
  gl.bindVertexArray(gvao);
  const gb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  Player.gridVAO = gvao;
  Player.gridN = lines.length / 3;

  // viewing box (rebuilt per effect to the stage bounds)
  const bvao = gl.createVertexArray();
  gl.bindVertexArray(bvao);
  Player.boxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, Player.boxBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  Player.boxVAO = bvao;
  gl.bindVertexArray(null);
  bindControls(canvas);
  return true;
}

function buildStageBox(r, h) {
  const gl = Player.gl;
  const v = [];
  const c = [[-r, -r], [r, -r], [r, r], [-r, r]];
  for (let i = 0; i < 4; i++) {
    const [x, z] = c[i], [x2, z2] = c[(i + 1) % 4];
    v.push(x, 0, z, x, h, z);          // corner posts
    v.push(x, h, z, x2, h, z2);        // top frame
    v.push(x, 0, z, x2, 0, z2);        // floor frame
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, Player.boxBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
  Player.boxN = v.length / 3;
  Player.stageR = r;
  Player.stageH = h;
}

function getTexture(file) {
  const gl = Player.gl;
  if (Player.texCache.has(file)) return Player.texCache.get(file);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 40]));
  loadImage(file).then((img) => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  });
  Player.texCache.set(file, tex);
  return tex;
}

/* ---- minimal GLB loader (POSITION/NORMAL/indices, single primitive) ---- */
async function loadGLB(url) {
  if (Player.glbCache.has(url)) return Player.glbCache.get(url);
  const p = (async () => {
    const buf = await (await fetch(url)).arrayBuffer();
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error("not glb");
    let off = 12, json = null, bin = null;
    while (off < buf.byteLength) {
      const len = dv.getUint32(off, true);
      const type = dv.getUint32(off + 4, true);
      const data = buf.slice(off + 8, off + 8 + len);
      if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(data));
      else if (type === 0x004E4942) bin = data;
      off += 8 + len + (len % 4 ? 4 - (len % 4) : 0);
    }
    const prim = json.meshes[0].primitives[0];
    function accessor(idx) {
      const a = json.accessors[idx];
      const bv = json.bufferViews[a.bufferView];
      const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
      const n = a.count * { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
      if (a.componentType === 5126) return new Float32Array(bin, start, n);
      if (a.componentType === 5123) return new Uint16Array(bin, start, n);
      if (a.componentType === 5125) return new Uint32Array(bin, start, n);
      if (a.componentType === 5121) return new Uint8Array(bin, start, n);
      throw new Error("componentType " + a.componentType);
    }
    const pos = accessor(prim.attributes.POSITION);
    let nrm = prim.attributes.NORMAL !== undefined ? accessor(prim.attributes.NORMAL) : null;
    let idx = prim.indices !== undefined ? accessor(prim.indices) : null;
    if (!nrm) {   // flat normals fallback
      nrm = new Float32Array(pos.length);
      const I = idx || Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const k of [a, b, c]) { nrm[k] += nx; nrm[k + 1] += ny; nrm[k + 2] += nz; }
      }
    }
    // radius for auto-scale
    let r = 0;
    for (let i = 0; i < pos.length; i += 3)
      r = Math.max(r, Math.hypot(pos[i], pos[i + 1], pos[i + 2]));
    const gl = Player.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nb);
    gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    let count, itype;
    if (idx) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      let ubuf = idx;
      if (idx instanceof Uint8Array) { ubuf = Uint16Array.from(idx); }
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ubuf, gl.STATIC_DRAW);
      count = idx.length;
      itype = ubuf instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    } else {
      count = pos.length / 3;
      itype = null;
    }
    const instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    for (const [loc, n, off2] of [[2, 4, 0], [3, 4, 16]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 32, off2);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return { vao, count, itype, instBuf, radius: r };
  })();
  Player.glbCache.set(url, p);
  return p;
}

/* ---- emitter runtimes ---- */
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blackbody(temp) {
  const t = Math.min(Math.max(temp, 0), 1);
  return [1.0, 0.38 + 0.55 * t, 0.08 + 0.72 * t * t];
}

function tintVec(p, key, fallback) {
  const c = paramColor(p, key);
  if (!c) return fallback;
  return [c[0], c[1], c[2], 1];
}

function num(v, dflt) {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v[0];
  return dflt;
}

function makeEmitterRuntime(em, idx) {
  const p = em.params || {};
  const { g, cls } = lookFor(em);
  const rate = em.spawn_rate.value || 1;
  const life = em.lifetime.value || 2;
  const maxN = Math.min(em.max_count || 64, 4000);
  const burst = em.spawn_mode === "burst" || rate * life > maxN * 2.5;
  const bbox = em.bbox || [[-0.5, 0, -0.5], [0.5, 1, 0.5]];
  const ext = [
    Math.abs(bbox[1][0] - bbox[0][0]),
    Math.abs(bbox[1][1] - bbox[0][1]),
    Math.abs(bbox[1][2] - bbox[0][2]),
  ];
  const meanExt = (ext[0] + ext[1] + ext[2]) / 3;
  const isSpark = !em.sprite && !em.mesh;
  const isMesh = !!em.mesh;
  const render = renderModeFor(em);
  const mode = isMesh ? 4 : isSpark ? 3
    : render === "emissive" ? 0
    : render === "sixway" ? 2 : 1;
  // size: decoded BaseSize (meters) when authored, class default otherwise
  const baseSize = num(p.basesize, null);
  let s0, s1;
  if (baseSize !== null && baseSize > 0) {
    s0 = baseSize * 0.85;
    s1 = baseSize * 1.15;
  } else {
    const extScale = Math.min(Math.max(meanExt / 2.5, 0.55), 2.6);
    s0 = (cls.size_min ?? 0.6) * extScale;
    s1 = (cls.size_max ?? 1.2) * extScale;
  }
  // decoded colors (linear RGB, converted for display); Color0 -> Color1
  // over particle life. Sparks fall back to the blackbody Temperature tint.
  const sparkCol = blackbody(p.temperature !== undefined ? num(p.temperature, 0.5) : 0.5);
  const white = [1, 1, 1, 1];
  let tint0 = tintVec(p, "color0", null);
  let tint1 = tintVec(p, "color1", null);
  if (!tint0 && !tint1) { tint0 = white; tint1 = white; }
  else if (!tint0) tint0 = tint1;
  else if (!tint1) tint1 = tint0;
  if (mode === 3) tint0 = tint1 = [...sparkCol, 1];
  const op = p.opacity !== undefined ? num(p.opacity, 1) : 1;
  tint0 = [...tint0]; tint1 = [...tint1];
  tint0[3] = (tint0[3] ?? 1) * op;
  tint1[3] = (tint1[3] ?? 1) * op;
  const fps = g.fps || (em.sprite ? em.sprite.frames / life : 0);
  // spawn velocity: decoded SpawnSpeed (m/s) when authored
  const spawnSpeed = num(p.spawnspeed, null);
  const spawnSpeedMin = num(p.spawnspeedmin, 0.7);
  // long-lived meshes (UAV, birds, rats -- flight/flock sims are baked into
  // compute shaders) -> anchored turntable display, not falling debris
  const meshDisplay = isMesh && (life >= 100 || (maxN <= 2 && life >= 3));
  return {
    em, idx, rate, life, maxN, burst, bbox, mode, meshDisplay,
    s0, s1, grow: cls.grow ?? 1.6,
    sizeCurve: Array.isArray(p.sizecurve) ? p.sizecurve : null,
    opCurve: Array.isArray(p.opacityoverlife) ? p.opacityoverlife : null,
    rise: (cls.rise_mps ?? 1.0) + num(p.buoyancy, 0) * 0.6,
    spawnSpeed, spawnSpeedMin,
    tint0, tint1,
    drag: p.drag !== undefined ? num(p.drag, 0.3) : 0.3,
    wind: num(p.windstrength, 0) * 0.35,
    gravity: p.gravity !== undefined ? num(p.gravity, -9.8) : (isSpark || isMesh ? -9.8 : 0),
    restitution: p.restitution !== undefined ? num(p.restitution, 0.3) : 0.3,
    speedMult: p.speedmult !== undefined ? Math.min(num(p.speedmult, 2.5), 12) : (isSpark ? 5 : 2.5),
    lifeMinMult: p.lifeminmult !== undefined ? num(p.lifeminmult, 0.8) : 0.8,
    rotSpeed: num(p.rotationspeed, 10) * Math.PI / 180,
    spawnRot: num(p.spawnrot, 30) * Math.PI / 180,
    tumble: (cls.tumble_dps ?? 300) * Math.PI / 180,
    streakStretch: cls.streak_stretch ?? 4,
    grid: em.sprite ? [em.sprite.cols, em.sprite.rows] : [1, 1],
    frames: em.sprite ? em.sprite.frames : 1,
    fps,
    tex: em.sprite ? getTexture(em.sprite.file) : null,
    glb: null, glbReady: false,
    parts: [], acc: 0, cycleT: 0, rnd: mulberry(1234 + idx * 7919),
    pos: em.pos || [0, 0, 0],
  };
}

function spawnParticle(rt) {
  const r = rt.rnd;
  const b = rt.bbox;
  const px = rt.pos[0] + (b[0][0] + (b[1][0] - b[0][0]) * r()) * 0.35;
  const py = rt.pos[1] + Math.max(b[0][1], 0) + (b[1][1] - b[0][1]) * r() * 0.15;
  const pz = rt.pos[2] + (b[0][2] + (b[1][2] - b[0][2]) * r()) * 0.35;
  if (rt.meshDisplay) {
    if (rt.parts.length >= rt.maxN) return;          // permanent display row
    const i = rt.parts.length;                       // spread a row
    const off = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.max(rt.s1, 0.8);
    rt.parts.push({
      x: rt.pos[0] + off, y: Math.max(rt.pos[1], 1.6), z: rt.pos[2],
      vx: 0, vy: 0, vz: 0, age: 0, life: 1e9,
      rot: 0.6 + i, rotV: 0.35, ax: 0, ay: 1, az: 0, scl: 1,
    });
    return;
  }
  let vx, vy, vz;
  if (rt.mode === 3 || rt.mode === 4) {
    const a = r() * Math.PI * 2;
    const base = rt.spawnSpeed !== null && rt.spawnSpeed > 0 ? rt.spawnSpeed : rt.speedMult;
    const v = base * (rt.spawnSpeedMin + (1 - rt.spawnSpeedMin) * r());
    vx = Math.cos(a) * v * (0.4 + r() * 0.6);
    vy = v * (0.5 + r() * 0.8);
    vz = Math.sin(a) * v * (0.4 + r() * 0.6);
  } else if (rt.spawnSpeed !== null && rt.spawnSpeed > 0) {
    // decoded initial speed, up-biased cone (authored direction is baked)
    const a = r() * Math.PI * 2;
    const v = rt.spawnSpeed * (rt.spawnSpeedMin + (1 - rt.spawnSpeedMin) * r());
    const lat = 0.25 + r() * 0.2;
    vx = Math.cos(a) * v * lat;
    vy = v * (0.8 + r() * 0.25);
    vz = Math.sin(a) * v * lat;
  } else {
    vx = (r() - 0.5) * 0.5;
    vy = rt.rise * (0.75 + r() * 0.5);
    vz = (r() - 0.5) * 0.5;
  }
  rt.parts.push({
    x: px, y: py, z: pz, vx, vy, vz,
    age: 0,
    life: rt.life * (rt.lifeMinMult + (1 - rt.lifeMinMult) * r()),
    rot: (r() - 0.5) * 2 * rt.spawnRot,
    rotV: (r() - 0.5) * 2 * (rt.mode === 4 ? rt.tumble : rt.rotSpeed),
    ax: r() - 0.5, ay: r() - 0.5, az: r() - 0.5,
    scl: 0.8 + r() * 0.45,
  });
}

function stepEmitter(rt, dt) {
  if (rt.burst) {
    rt.cycleT += dt;
    const period = rt.life * 1.35 + 0.6;
    const first = rt.cycleT === dt && !rt.parts.length;
    if (first || (Player.replayBursts && rt.cycleT >= period)) {
      rt.cycleT = 0.0001;
      const n = Math.min(rt.maxN, 600);
      for (let i = 0; i < n; i++) spawnParticle(rt);
    }
  } else {
    rt.acc += rt.rate * dt;
    while (rt.acc >= 1 && rt.parts.length < rt.maxN) {
      rt.acc -= 1;
      spawnParticle(rt);
    }
    if (rt.acc > 4) rt.acc = 4;
  }
  const drag = Math.min(rt.drag, 3);
  const g = rt.gravity;
  const windX = rt.wind, windZ = rt.wind * 0.4;
  const grounded = (rt.mode === 3 || rt.mode === 4) && !rt.meshDisplay;
  // billboards with a decoded spawn speed keep a gentle buoyant assist so
  // plumes don't stall once drag eats the initial speed (baked-sim drift)
  const lift = (rt.mode <= 2 && rt.spawnSpeed !== null) ? rt.rise * 0.3 : 0;
  for (let i = rt.parts.length - 1; i >= 0; i--) {
    const p = rt.parts[i];
    p.age += dt;
    if (p.age >= p.life) { rt.parts.splice(i, 1); continue; }
    if (grounded) p.vy += g * dt;
    if (lift) p.vy += lift * (1 - p.age / p.life) * dt;   // buoyancy decays
    p.vx += windX * dt;
    p.vz += windZ * dt;
    const dr = Math.max(0, 1 - drag * dt);
    p.vx *= dr; p.vy *= (grounded ? dr : Math.max(0, 1 - drag * 0.4 * dt)); p.vz *= dr;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (grounded && p.y < 0.02) {
      p.y = 0.02;
      p.vy *= -rt.restitution;
      p.vx *= 0.6; p.vz *= 0.6;
    }
    p.rot += p.rotV * dt;
  }
}

/* ---- camera: orbit + dolly + pan, RMB freelook + WASD fly ----
   (control scheme mirrors the Model Library inspector) */
function camDir() {
  const c = Player.cam;
  return [
    Math.cos(c.pitch) * Math.sin(c.yaw),
    Math.sin(c.pitch),
    Math.cos(c.pitch) * Math.cos(c.yaw),
  ];
}
function camEye() {
  const c = Player.cam, d = camDir();
  return [c.target[0] + c.dist * d[0], c.target[1] + c.dist * d[1], c.target[2] + c.dist * d[2]];
}

function bindControls(canvas) {
  const c = Player.cam;
  let mode = null;           // "orbit" | "pan" | "fly"
  let lx = 0, ly = 0;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    lx = e.clientX; ly = e.clientY;
    if (e.button === 2) {
      mode = "fly";
      c.flying = true;
      canvas.classList.add("flying");
    } else if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      mode = "pan";
    } else if (e.button === 0) {
      mode = "orbit";
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!mode) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    if (mode === "orbit") {
      c.yaw -= dx * 0.008;
      c.pitch = Math.min(1.5, Math.max(-0.35, c.pitch + dy * 0.006));
    } else if (mode === "pan") {
      const d = camDir();
      const f = [-d[0], -d[1], -d[2]];              // view forward
      const s = [-f[2], 0, f[0]];                   // screen right
      const sl = Math.hypot(...s) || 1;
      s[0] /= sl; s[2] /= sl;
      const u = [                                    // screen up = s x f
        s[1] * f[2] - s[2] * f[1],
        s[2] * f[0] - s[0] * f[2],
        s[0] * f[1] - s[1] * f[0],
      ];
      const k = c.dist * 0.0016;
      // grabby pan: the scene follows the cursor
      c.target[0] += -s[0] * dx * k + u[0] * dy * k;
      c.target[1] += -s[1] * dx * k + u[1] * dy * k;
      c.target[2] += -s[2] * dx * k + u[2] * dy * k;
    } else if (mode === "fly") {
      // freelook: rotate around the EYE (keep it fixed, move the target)
      const eye = camEye();
      c.yaw -= dx * 0.0032;
      c.pitch = Math.min(1.5, Math.max(-1.5, c.pitch + dy * 0.0032));
      const d = camDir();
      c.target = [eye[0] - c.dist * d[0], eye[1] - c.dist * d[1], eye[2] - c.dist * d[2]];
    }
  });
  const endPointer = (e) => {
    if (mode === "fly") {
      // re-anchor the orbit pivot straight ahead (a stale pivot left behind
      // by freelook otherwise snaps the camera on the next orbit/zoom)
      const eye = camEye();
      const nd = Math.max(Player.frameSize * 0.4, 1);
      const d = camDir();
      c.dist = nd;
      c.target = [eye[0] - nd * d[0], eye[1] - nd * d[1], eye[2] - nd * d[2]];
      c.flying = false;
      canvas.classList.remove("flying");
    }
    mode = null;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (c.flying) {
      c.flySpeed = Math.max(0.05, Math.min(30, c.flySpeed * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      flashHint(`fly speed ×${c.flySpeed.toFixed(2)}`);
      return;
    }
    // proportional dolly: one 120 px notch = ~4% of the current distance,
    // smooth-scroll bursts of tiny deltas sum to the same travel
    const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const k = Math.pow(0.96, Math.max(-6, Math.min(6, -px / 120)));
    c.dist = Math.max(Player.frameSize * 0.02,
      Math.min(Player.frameSize * 12, c.dist * k));
  }, { passive: false });
}

let hintTimer = 0;
function flashHint(msg) {
  const el = $("#playerHint");
  el.dataset.base = el.dataset.base || el.textContent;
  el.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.textContent = el.dataset.base; }, 900);
}

function flyStep(dt) {
  const c = Player.cam;
  if (!c.flying) return;
  const k = Player.keys;
  const sp = Player.frameSize * 0.6 * c.flySpeed * (k["shift"] ? 3 : 1) * dt;
  const d = camDir();
  const fwd = [-d[0], -d[1], -d[2]];
  const right = [-fwd[2], 0, fwd[0]];   // screen right (fwd x worldUp)
  const rl = Math.hypot(...right) || 1;
  right[0] /= rl; right[2] /= rl;
  const mv = [0, 0, 0];
  if (k["w"]) { mv[0] += fwd[0]; mv[1] += fwd[1]; mv[2] += fwd[2]; }
  if (k["s"]) { mv[0] -= fwd[0]; mv[1] -= fwd[1]; mv[2] -= fwd[2]; }
  if (k["d"]) { mv[0] += right[0]; mv[2] += right[2]; }
  if (k["a"]) { mv[0] -= right[0]; mv[2] -= right[2]; }
  if (k["e"]) mv[1] += 1;
  if (k["q"]) mv[1] -= 1;
  const l = Math.hypot(...mv);
  if (l > 0) {
    c.target[0] += mv[0] / l * sp;
    c.target[1] += mv[1] / l * sp;
    c.target[2] += mv[2] / l * sp;
  }
}

function mat4Multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

function camMatrices(w, h) {
  const c = Player.cam;
  const eye = camEye();
  let f = [c.target[0] - eye[0], c.target[1] - eye[1], c.target[2] - eye[2]];
  const fl = Math.hypot(...f) || 1; f = f.map((v) => v / fl);
  // s = f x worldUp (true screen right). The previous player used the
  // negation, which rendered the whole stage rotated 180° about the view
  // axis (rising smoke drifted DOWN on screen).
  let s = [-f[2], 0, f[0]];
  const sl = Math.hypot(...s) || 1; s = s.map((v) => v / sl);
  const u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]];
  const view = new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
    (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]), 1,
  ]);
  const fov = 50 * Math.PI / 180, asp = w / h, near = 0.05, far = 900;
  const t = 1 / Math.tan(fov / 2);
  const proj = new Float32Array([
    t / asp, 0, 0, 0,
    0, t, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
  return { vp: mat4Multiply(proj, view), right: s, up: u, eye, fwd: f };
}

/* ---- run loop ---- */
function startPlayer(renderables) {
  if (!initGL()) {
    $("#playerPlaceholder").hidden = false;
    $("#phReason").textContent = "WebGL2 is not available in this browser.";
    return;
  }
  Player.emitters = renderables.map((em, i) => makeEmitterRuntime(em, i));
  Player.emitters.forEach((rt) => {
    if (rt.mode === 4) {
      loadGLB(rt.em.mesh.glb).then((glb) => {
        rt.glb = glb;
        // mesh scale: keep mesh at authored size; clamp huge meshes for the stage
        rt.meshScale = glb.radius > 6 ? 6 / glb.radius : 1;
        rt.glbReady = true;
        const r = glb.radius * rt.meshScale;
        if (rt.meshDisplay) {
          // frame the anchored display row, not the (huge) authored bbox
          Player.cam.target = [rt.pos[0], Math.max(rt.pos[1], 1.6), rt.pos[2]];
          Player.cam.dist = Math.max(3, r * 2.4 + 1.5 + rt.maxN * rt.s1 * 0.5);
        } else {
          Player.cam.dist = Math.max(Player.cam.dist, r * 4 + 3);
        }
      }).catch(() => {});
    }
  });
  // frame the effect: bounds from authored bboxes + decoded sizes + rise
  let top = 2, rad = 3;
  Player.emitters.forEach((rt) => {
    const b = rt.bbox;
    top = Math.max(top, rt.pos[1] + b[1][1] * 0.6 + rt.s1);
    if (rt.mode <= 2) {
      const v0 = rt.spawnSpeed !== null ? rt.spawnSpeed : rt.rise;
      top = Math.max(top, v0 / Math.max(rt.drag, 0.25) * 0.8 + rt.s1);
    }
    rad = Math.max(rad, Math.abs(b[0][0]), Math.abs(b[1][0]), 2 + rt.s1 * 2, top * 0.55);
  });
  top = Math.min(top, 30);
  rad = Math.min(rad, 40);
  Player.frameSize = Math.max(rad, top);
  buildStageBox(Math.max(4, rad * 1.15), Math.max(3.5, top * 1.1));
  Player.cam.yaw = 0.5;
  Player.cam.pitch = 0.2;
  Player.cam.flySpeed = 1;
  Player.cam.target = [0, Math.min(top * 0.42, 8), 0];
  Player.cam.dist = Math.min(Math.max(rad * 2.4, 5.5), 60);
  Player.lastT = performance.now();
  Player.emitters.forEach((rt) => {
    if (!rt.burst) for (let i = 0; i < 120; i++) stepEmitter(rt, rt.life / 100);
  });
  if (!Player.running) {
    Player.running = true;
    Player.raf = requestAnimationFrame(tick);
  }
}

function stopPlayer() {
  Player.running = false;
  cancelAnimationFrame(Player.raf);
  Player.emitters = [];
}

function drawStage(gl, vp) {
  gl.useProgram(Player.progGrid);
  const UG = (n) => gl.getUniformLocation(Player.progGrid, n);
  gl.uniformMatrix4fv(UG("uVP"), false, vp);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(Player.gridVAO);
  gl.uniform1f(UG("uFadeR"), Player.stageR * 2.4);
  gl.uniform4fv(UG("uCol"), [0.28, 0.31, 0.35, 0.16]);        // minor lines
  gl.drawArrays(gl.LINES, 0, Player.gridMinorN);
  gl.uniform4fv(UG("uCol"), [0.36, 0.40, 0.45, 0.28]);        // major lines
  gl.drawArrays(gl.LINES, Player.gridMinorN, Player.gridN - Player.gridMinorN);
  // viewing box
  gl.bindVertexArray(Player.boxVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, Player.boxBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.uniform1f(UG("uFadeR"), Player.stageR * 4.0);
  gl.uniform4fv(UG("uCol"), [1.0, 0.42, 0.10, 0.16]);         // BF orange frame
  gl.drawArrays(gl.LINES, 0, Player.boxN);
}

function tick(now) {
  if (!Player.running) return;
  const gl = Player.gl, canvas = Player.canvas;
  const dt = Math.min((now - Player.lastT) / 1000, 0.05);
  Player.lastT = now;
  flyStep(dt);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * devicePixelRatio || canvas.height !== h * devicePixelRatio) {
    canvas.width = w * devicePixelRatio;
    canvas.height = h * devicePixelRatio;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.078, 0.086, 0.10, 1);   // dark stage (model-library style)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const { vp, right, up, eye, fwd } = camMatrices(w, h);

  drawStage(gl, vp);

  // meshes first (opaque, depth), then alpha sprites, then additive
  for (const rt of Player.emitters) stepEmitter(rt, dt);

  const meshRts = Player.emitters.filter((r) => r.mode === 4 && r.glbReady && r.parts.length);
  if (meshRts.length) {
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(Player.progMesh);
    const UM = (n) => gl.getUniformLocation(Player.progMesh, n);
    gl.uniformMatrix4fv(UM("uVP"), false, vp);
    for (const rt of meshRts) {
      const buf = new Float32Array(rt.parts.length * 8);
      let o = 0;
      for (const p of rt.parts) {
        buf[o++] = p.x; buf[o++] = p.y; buf[o++] = p.z;
        buf[o++] = rt.meshScale * p.scl;
        buf[o++] = p.ax; buf[o++] = p.ay; buf[o++] = p.az;
        buf[o++] = p.rot + p.rotV * p.age;
      }
      gl.bindVertexArray(rt.glb.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, rt.glb.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
      gl.uniform4fv(UM("uTint"), [0.62, 0.58, 0.53, 1]);
      if (rt.glb.itype)
        gl.drawElementsInstanced(gl.TRIANGLES, rt.glb.count, rt.glb.itype, 0, rt.parts.length);
      else
        gl.drawArraysInstanced(gl.TRIANGLES, 0, rt.glb.count, rt.parts.length);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  gl.useProgram(Player.progQuad);
  const U = (n) => gl.getUniformLocation(Player.progQuad, n);
  gl.uniformMatrix4fv(U("uVP"), false, vp);
  gl.uniform3fv(U("uCamRight"), right);
  gl.uniform3fv(U("uCamUp"), up);
  gl.uniform3fv(U("uLightDir"), [0.55, 0.62, 0.42]);
  gl.bindVertexArray(Player.quadVAO);

  const order = Player.emitters.filter((r) => r.mode !== 4).sort((a, b) =>
    (a.mode === 0 || a.mode === 3 ? 1 : 0) - (b.mode === 0 || b.mode === 3 ? 1 : 0));
  for (const rt of order) {
    if (!rt.parts.length) continue;
    const add = rt.mode === 0 || rt.mode === 3;
    if (add) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied
    let parts = rt.parts;
    if (!add) {
      parts = parts.slice().sort((p, q) =>
        ((q.x - eye[0]) * fwd[0] + (q.y - eye[1]) * fwd[1] + (q.z - eye[2]) * fwd[2]) -
        ((p.x - eye[0]) * fwd[0] + (p.y - eye[1]) * fwd[1] + (p.z - eye[2]) * fwd[2]));
    }
    const buf = new Float32Array(parts.length * 12);
    let o = 0;
    for (const p of parts) {
      const u = p.age / p.life;
      // size envelope: decoded SizeCurve cubic when authored, class grow otherwise
      const grow = rt.mode === 3 ? 1
        : rt.sizeCurve ? Math.max(cubic(rt.sizeCurve, u), 0.05)
        : 1 + (rt.grow - 1) * u;
      const size = (rt.s0 + (rt.s1 - rt.s0) * (p.scl - 0.8) / 0.45) * grow;
      // opacity envelope: decoded OpacityOverLife cubic when authored
      let alpha;
      if (rt.opCurve) {
        alpha = Math.max(0, Math.min(cubic(rt.opCurve, u), 1));
      } else {
        const fadeIn = Math.min(u * 6, 1);
        const fadeOut = rt.mode === 0 ? 1 - u * u : 1 - u;
        alpha = fadeIn * Math.max(fadeOut, 0);
      }
      const frame = rt.fps > 0
        ? (p.age * rt.fps) % rt.frames
        : Math.min(u * rt.frames, rt.frames - 0.001);
      const stretch = rt.mode === 3
        ? Math.min(rt.streakStretch + Math.hypot(p.vx, p.vy, p.vz) * 0.8, 10) : 0;
      buf[o++] = p.x; buf[o++] = p.y; buf[o++] = p.z;
      buf[o++] = rt.mode === 3 ? 0.06 : size;
      buf[o++] = frame; buf[o++] = alpha; buf[o++] = rt.mode === 3 ? 0 : p.rot;
      buf[o++] = stretch;
      buf[o++] = p.vx; buf[o++] = p.vy; buf[o++] = p.vz;
      buf[o++] = u;
    }
    gl.bindVertexArray(Player.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, Player.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    gl.uniform1i(U("uMode"), rt.mode);
    gl.uniform4fv(U("uTint0"), rt.tint0);
    gl.uniform4fv(U("uTint1"), rt.tint1);
    gl.uniform2fv(U("uGrid"), rt.grid);
    gl.uniform1f(U("uStreak"), rt.mode === 3 ? 1 : 0);
    if (rt.tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rt.tex);
      gl.uniform1i(U("uTex"), 0);
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, parts.length);
  }
  Player.raf = requestAnimationFrame(tick);
}
