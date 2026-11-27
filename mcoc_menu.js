/*
 * MCOC MOD MENU —— 只对自己生效
 *
 * 敌我判据（实机确认）：
 *   UltimatePlayerController.Controls (offset 1432)
 *     有值  = 玩家（玩家角色挂 UltimateControls）
 *     null  = 敌人（AI 角色没有输入控制对象）
 *
 * 单一挂钩点：ApplyDamageInternal(float damage, ...)  —— 最终落地伤害
 *   攻击者是玩家 → damage × ATK
 *   攻击者是敌人 → damage ÷ DEF   （等价于玩家受到的伤害变小）
 *
 * 配置：/data/local/tmp/mcoc_cfg.txt   "atk=5.0 def=3.0"
 */
// mod APK 版：依次尝试多个配置文件，都没有就用内置默认值
const CFG_CANDIDATES = [
  "/sdcard/mcoc_cfg.txt",
  "/data/local/tmp/mcoc_cfg.txt",
  "/sdcard/Android/data/com.kabam.marvelbattle/files/mcoc_cfg.txt",
];
const DEFAULT_ATK = 3.0;
const DEFAULT_DEF = 3.0;
let CFG_PATH = CFG_CANDIDATES[0];
const LOGFILE = "/data/local/tmp/mcoc_hook.log";
const OFF_CONTROLS = 1432;

const CONFIG = { atkMult: 1.0, defMult: 1.0, logFirst: 10 };
let buf = [];
const LOG = (t, b) => {
  send({ tag: t, body: b });
  try { buf.push(new Date().toISOString().slice(11, 23) + " " + t + " " + JSON.stringify(b)); } catch (e) {}
};
setInterval(() => {
  if (!buf.length) return;
  let prev = "";
  try { prev = File.readAllText(LOGFILE); } catch (e) {}
  if (prev.length > 60000) prev = prev.slice(-30000);
  try { File.writeAllText(LOGFILE, prev + buf.join("\n") + "\n"); buf = []; } catch (e) {}
}, 500);

function bind(mod, n, r, a) { try { const p = mod.findExportByName(n); return p ? new NativeFunction(p, r, a) : null; } catch (e) { return null; } }
function cstr(p) { try { return p.isNull() ? null : p.readUtf8String(); } catch (e) { return null; } }

/* -------- 配置轮询 -------- */
let lastRaw = "";
function pollConfig() {
  try {
    let txt = "";
    for (let i = 0; i < CFG_CANDIDATES.length; i++) {
      try { txt = File.readAllText(CFG_CANDIDATES[i]).trim(); if (txt) { CFG_PATH = CFG_CANDIDATES[i]; break; } } catch (e) {}
    }
    if (!txt) { if (CONFIG.atkMult === 1) CONFIG.atkMult = DEFAULT_ATK; if (CONFIG.defMult === 1) CONFIG.defMult = DEFAULT_DEF; return; }
    if (txt === lastRaw) return;
    lastRaw = txt;
    const m = txt.match(/atk=([0-9.]+)\s+def=([0-9.]+)/);
    if (m) {
      const a = parseFloat(m[1]), d = parseFloat(m[2]);
      if (isFinite(a) && a >= 1 && a <= 10) CONFIG.atkMult = a;
      if (isFinite(d) && d >= 1 && d <= 10) CONFIG.defMult = d;
      LOG("cfg", { atk: CONFIG.atkMult, def: CONFIG.defMult });
    }
  } catch (e) {}
}
setInterval(pollConfig, 400);
pollConfig();

function waitMod(name, cb) {
  let n = 0;
  const iv = setInterval(() => {
    n++;
    let m = null;
    try { m = Process.getModuleByName(name); } catch (e) {}
    if (m) { clearInterval(iv); cb(m); } else if (n > 300) { clearInterval(iv); LOG("fatal", { why: name }); }
  }, 200);
}

waitMod("libil2cpp.so", (mod) => {
  const F = {
    domain_get: bind(mod, "il2cpp_domain_get", "pointer", []),
    thread_attach: bind(mod, "il2cpp_thread_attach", "pointer", ["pointer"]),
    domain_assembly_open: bind(mod, "il2cpp_domain_assembly_open", "pointer", ["pointer", "pointer"]),
    assembly_get_image: bind(mod, "il2cpp_assembly_get_image", "pointer", ["pointer"]),
    class_from_name: bind(mod, "il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]),
    class_get_methods: bind(mod, "il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]),
    method_get_name: bind(mod, "il2cpp_method_get_name", "pointer", ["pointer"]),
    method_get_param_count: bind(mod, "il2cpp_method_get_param_count", "uint32", ["pointer"]),
    object_get_class: bind(mod, "il2cpp_object_get_class", "pointer", ["pointer"]),
    class_get_name: bind(mod, "il2cpp_class_get_name", "pointer", ["pointer"]),
  };
  function typeName(p) {
    try {
      if (!p || p.isNull()) return "null";
      const k = F.object_get_class(p);
      return cstr(F.class_get_name(k)) || "?";
    } catch (e) { return "err"; }
  }

  const domain = F.domain_get();
  if (domain.isNull()) return LOG("fatal", { why: "no domain" });
  F.thread_attach(domain);
  const asm = F.domain_assembly_open(domain, Memory.allocUtf8String("Marvel.Runtime"));
  if (!asm || asm.isNull()) return LOG("fatal", { why: "no assembly" });
  const img = F.assembly_get_image(asm);

  // 解析 ApplyDamageInternal 与 ApplyDamage（保险：两个都挂，但只让 internal 生效）
  const PUC = (() => {
    for (const ns of ["", "Kabam", "Marvel"]) {
      const c = F.class_from_name(img, Memory.allocUtf8String(ns), Memory.allocUtf8String("UltimatePlayerController"));
      if (c && !c.isNull()) return c;
    }
    return null;
  })();
  if (!PUC) return LOG("fatal", { why: "no UltimatePlayerController" });

  const M = {};
  const it = Memory.alloc(Process.pointerSize);
  it.writePointer(ptr(0));
  let m, g = 0;
  while (g++ < 1500) {
    m = F.class_get_methods(PUC, it);
    if (!m || m.isNull()) break;
    const mn = cstr(F.method_get_name(m));
    if (mn === "ApplyDamageInternal") M.internal = { ptr: m.readPointer(), params: F.method_get_param_count(m) };
    if (mn === "ApplyDamage") M.public = { ptr: m.readPointer(), params: F.method_get_param_count(m) };
  }
  LOG("resolved", { internal: !!M.internal, public: !!M.public, rule: "Controls(1432)!=null => player" });

  const n = { player: 0, enemy: 0, skip: 0 };
  const seen = {};

  function kindOf(puc) {
    try {
      if (!puc || puc.isNull()) return -1;
      const c = puc.add(OFF_CONTROLS).readPointer();
      return c.isNull() ? 0 : 1;      // 1=玩家, 0=敌人
    } catch (e) { return -1; }
  }

  const target = M.internal || M.public;
  if (!target) return LOG("fatal", { why: "no hook target" });

  Interceptor.attach(target.ptr, {
    onEnter() {
      try {
        const self = this.context.x0;
        const k = kindOf(self);
        if (k === -1) { n.skip++; return; }
        const before = this.context.s0;
        if (typeof before !== "number" || !isFinite(before) || before <= 0) return;

        // 只做实例普查一次，方便核对
        const key = self.toString();
        if (!seen[key]) {
          seen[key] = true;
          LOG("instance", {
            self: key, type: typeName(self),
            controls: typeName(self.add(OFF_CONTROLS).readPointer()),
            role: k === 1 ? "player" : "enemy",
          });
        }

        if (k === 1) {
          // 玩家是「受伤方」→ 减伤
          if (CONFIG.defMult === 1) return;
          this.context.s0 = before / CONFIG.defMult;
          n.player++;
          if (n.player <= CONFIG.logFirst) LOG("DEF", { n: n.player, role: "player_hurt", before: before, after: before / CONFIG.defMult, x: CONFIG.defMult });
        } else {
          // 敌人是「受伤方」→ 伤害放大（等于玩家输出变强）
          if (CONFIG.atkMult === 1) return;
          this.context.s0 = before * CONFIG.atkMult;
          n.enemy++;
          if (n.enemy <= CONFIG.logFirst) LOG("ATK", { n: n.enemy, role: "enemy_hurt", before: before, after: before * CONFIG.atkMult, x: CONFIG.atkMult });
        }
      } catch (e) { n.skip++; }
    },
  });
  LOG("hooked", { fn: M.internal ? "ApplyDamageInternal" : "ApplyDamage", ptr: target.ptr.toString(), params: target.params });

  setInterval(() => {
    LOG("stat", { player: n.player, enemy: n.enemy, skip: n.skip, cfg: { a: CONFIG.atkMult, d: CONFIG.defMult } });
  }, 15000);

  LOG("ready", {});
});

/* ---------- 启动内置悬浮菜单 Service ---------- */
(function launchModMenu() {
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if (tries > 40) { clearInterval(iv); return; }
    try {
      if (typeof Java === "undefined" || !Java.available) return;
      var started = false;
      Java.perform(function () {
        try {
          var UnityPlayer = Java.use("com.unity3d.player.UnityPlayer");
          var act = UnityPlayer.currentActivity.value;
          if (!act) return;
          var Intent = Java.use("android.content.Intent");
          var i = Intent.$new();
          i.setClassName(act, "com.rea.modmenu.ModMenuService");
          act.startForegroundService(i);
          started = true;
        } catch (e) {}
      });
      if (started) { clearInterval(iv); }
    } catch (e) {}
  }, 2000);
})();