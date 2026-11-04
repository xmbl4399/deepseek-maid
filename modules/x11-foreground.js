// X11 前台窗口/全屏探测(Linux):PowerShell 版 FS_CHECK_SCRIPT 的跨平台对应物
//
// Windows 用 user32.dll 拿前台窗口 + 屏幕集合;Linux 上等价信息由 EWMH 提供:
//   _NET_ACTIVE_WINDOW  根窗口属性 = 当前活动窗口 id
//   _NET_WM_STATE       窗口的 _NET_WM_STATE_FULLSCREEN / _NET_WM_STATE_MAXIMIZED_*
//   _NET_WM_PID         窗口所属进程 pid(→ /proc/<pid>/comm 取进程名,喂给 focus.classify)
//   xwininfo 几何       判断是否铺满某个显示器
//
// 为什么不用 xdotool/wmctrl:它们是额外依赖。xprop + xwininfo 同属 x11-utils,
// Ubuntu 桌面版默认安装(xdotool/wmctrl 不是)。deb 里仍把它列为 Recommends 兜底。
//
// 降级策略(不是所有 Linux 都能探测):
//   - Wayland 原生会话:xprop 只能看到 XWayland 客户端,活动窗口常为 0x0 ⇒ 探测失败
//   - 没装 x11-utils / 无 DISPLAY:execFile ENOENT ⇒ 探测失败
//   以上一律**静默降级**:返回 WINDOWED + 不报错,只记一次日志,由调用方照常轮询即可,
//   绝不因为测不到前台就把悬浮球/鲸鱼娘藏起来(藏了又恢复不了 = 永久消失)。
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOLERANCE = 8; // 与 Windows 版一致:容忍 8px 偏差(全屏视频偶有 1px 边框)

// ---- 纯解析函数(无 IO,便于单测) ----

// 真实输出两种写法(取决于是否带 -notype):
//   `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3600003`
//   `_NET_ACTIVE_WINDOW: window id # 0x3600003`
// 无活动窗口时 id 为 0x0(桌面本身);属性不存在时 xprop 输出 "not found"。
// 都返回 null ⇒ 调用方按"非全屏"处理。
function parseActiveWindow(text) {
  const s = String(text || '');
  const line = (s.match(/^_NET_ACTIVE_WINDOW.*$/m) || [])[0];
  if (!line) return null;
  const m = line.match(/(0x[0-9a-fA-F]+)\s*$/);
  if (!m) return null;
  const id = m[1].toLowerCase();
  return /^0x0+$/.test(id) ? null : id;
}

// xprop 多属性输出 → 状态集合
//   _NET_WM_STATE(ATOM) = _NET_WM_STATE_FULLSCREEN
//   _NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ
//   _NET_WM_PID(CARDINAL) = 3312
//   WM_CLASS(STRING) = "navigator", "firefox"
function parseProps(text) {
  const s = String(text || '');
  // 类型后缀可选:xprop 带 -notype 时输出 `_NET_WM_STATE = ...`,不带时是 `_NET_WM_STATE(ATOM) = ...`
  const stateLine = (s.match(/_NET_WM_STATE(?:\(ATOM\))?\s*=\s*(.*)/) || [])[1] || '';
  const pidLine = (s.match(/_NET_WM_PID(?:\(CARDINAL\))?\s*=\s*(\d+)/) || [])[1] || '';
  const classLine = (s.match(/WM_CLASS(?:\(STRING\))?\s*=\s*(.*)/) || [])[1] || '';
  // WM_CLASS 形如 "navigator", "firefox":第二段才是类名,兜底取最后一段
  const classNames = classLine
    .split(',')
    .map((v) => v.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  return {
    fullscreen: /_NET_WM_STATE_FULLSCREEN/.test(stateLine),
    maximized: /_NET_WM_STATE_MAXIMIZED_(VERT|HORZ)/.test(stateLine),
    // 关卡型窗口(下拉菜单/工具提示)不该参与全屏判定
    skipTaskbar: /_NET_WM_STATE_SKIP_TASKBAR/.test(stateLine),
    pid: pidLine ? Number(pidLine) : null,
    wmClass: classNames.length ? classNames[classNames.length - 1] : null,
    raw: stateLine,
  };
}

// xwininfo 输出 → { x, y, w, h }
function parseGeometry(text) {
  const num = (re) => {
    const m = String(text || '').match(re);
    return m ? Number(m[1]) : null;
  };
  const g = {
    x: num(/Absolute upper-left X:\s*(-?\d+)/),
    y: num(/Absolute upper-left Y:\s*(-?\d+)/),
    w: num(/\n\s*Width:\s*(\d+)/),
    h: num(/\n\s*Height:\s*(\d+)/),
  };
  return g.x === null || g.y === null || g.w === null || g.h === null ? null : g;
}

// 几何是否铺满某个显示器(与 Windows 版"遍历所有显示器,覆盖任一即算铺满"等价)
// screens 来自 Electron 的 Display.bounds,字段是 width/height(不是 w/h);
// 这里两种都接受,免得调用方还要做一次转换。
function coversDisplay(geo, screens, tolerance) {
  const tol = typeof tolerance === 'number' ? tolerance : TOLERANCE;
  if (!geo) return false;
  const dim = (b, a, c) => (typeof b[a] === 'number' ? b[a] : b[c]);
  return (screens || []).some((b) => {
    if (!b) return false;
    const bw = dim(b, 'w', 'width');
    const bh = dim(b, 'h', 'height');
    if (typeof bw !== 'number' || typeof bh !== 'number') return false;
    return (
      geo.x <= b.x + tol &&
      geo.y <= b.y + tol &&
      geo.x + geo.w >= b.x + bw - tol &&
      geo.y + geo.h >= b.y + bh - tol
    );
  });
}

// 判定链(对齐 Windows 版):显式全屏状态 → 铺满 + 非最大化;外壳/关卡窗口一律不算
// 返回 { fullscreen, reason }
function judge({ props, geometry, screens }) {
  const p = props || {};
  if (p.skipTaskbar && !p.fullscreen) return { fullscreen: false, reason: 'skip-taskbar' };
  // 最可靠判据:应用自己声明了全屏(浏览器 F11/视频全屏/游戏都走这条)
  if (p.fullscreen) return { fullscreen: true, reason: 'state' };
  if (!coversDisplay(geometry, screens)) return { fullscreen: false, reason: 'not-covering' };
  // 最大化窗口也铺满屏幕,但有最大化状态标记 ⇒ 不是全屏(与 Windows 的标题栏判据同义)
  if (p.maximized) return { fullscreen: false, reason: 'maximized' };
  return { fullscreen: true, reason: 'geometry' };
}

// ---- 探测(有 IO,带自身降级) ----

function create({ log }) {
  const xlog = typeof log === 'function' ? log : () => {};
  let warned = null; // 只警告一次,避免每轮轮询刷日志
  let broken = false; // x11-utils 缺失 / 无 DISPLAY:一次都不再尝试

  function warnOnce(msg) {
    if (warned === msg) return;
    warned = msg;
    xlog('[x11]', msg);
  }

  function sessionNote() {
    const t = String(process.env.XDG_SESSION_TYPE || '').toLowerCase();
    if (t === 'wayland') {
      warnOnce('Wayland 会话:原生窗口不可见,X11 前台探测降级(全屏自动隐藏可能不生效)');
    }
  }

  function screenBounds() {
    try {
      const electron = require('electron');
      const screen = electron && electron.screen;
      if (!screen) return [];
      const list = typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : [screen.getPrimaryDisplay()];
      return (list || []).filter(Boolean).map((d) => (d.bounds ? d.bounds : d.workArea)).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function readName(pid) {
    if (!pid) return null;
    try {
      const comm = fs.readFileSync(path.join('/proc', String(pid), 'comm'), 'utf8').trim();
      return comm || null;
    } catch (e) {
      return null;
    }
  }

  // 一次探测:xprop 取活动窗口 → xprop/xwininfo 取属性与几何 → 判定
  // cb(err, { fullscreen, processName }) —— 探测不可用时 cb(null,{fullscreen:false,processName:null})
  function probe(wantProc, cb) {
    const done = (res) => cb(null, res);
    if (broken) return done({ fullscreen: false, processName: null });
    sessionNote();

    execFile('xprop', ['-root', '-notype', '_NET_ACTIVE_WINDOW'], { timeout: 1500 }, (err1, stdout1) => {
      if (err1) {
        // ENOENT:x11-utils 没装;/ 无 DISPLAY:纯 Wayland 或 headless。都只降级,不抛错
        broken = true;
        warnOnce(`前台探测不可用(${err1.code || err1.message}),已降级为不检测全屏`);
        return done({ fullscreen: false, processName: null });
      }
      const id = parseActiveWindow(stdout1);
      // 无活动窗口(桌面本身):不是全屏
      if (!id) return done({ fullscreen: false, processName: null });

      execFile(
        'xprop',
        ['-id', id, '-notype', '_NET_WM_STATE', '_NET_WM_PID', 'WM_CLASS'],
        { timeout: 1500 },
        (err2, stdout2) => {
          const props = err2 ? {} : parseProps(stdout2);
          const finish = (geometry) => {
            const verdict = judge({ props, geometry, screens: screenBounds() });
            const processName = wantProc ? readName(props.pid) || props.wmClass || null : null;
            done({ fullscreen: verdict.fullscreen, processName, reason: verdict.reason });
          };
          // 已声明全屏时不必再量几何(省一次进程启动)
          if (props.fullscreen) return finish(null);
          execFile('xwininfo', ['-id', id], { timeout: 1500 }, (err3, stdout3) => {
            finish(err3 ? null : parseGeometry(stdout3));
          });
        },
      );
    });
  }

  return { probe };
}

module.exports = {
  create,
  // 纯函数(单测用)
  parseActiveWindow,
  parseProps,
  parseGeometry,
  coversDisplay,
  judge,
  TOLERANCE,
};
