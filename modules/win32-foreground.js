// Windows 前台窗口/全屏探测(原生 koffi P/Invoke 版)
//
// 这是 PowerShell 版 FS_CHECK_SCRIPT 的替代实现。原方案每次探测都要:
//   spawn powershell.exe → -ExecutionPolicy Bypass → Add-Type 现场编译 C# → 写 %TEMP%\*.cs
// 三个问题:
//   1) 行为画像与"利用 PowerShell 执行可疑脚本"高度重合,杀软会拦(实测火绒每 3 秒一次必报)
//   2) 每次约 1 秒(冷启动),而轮询间隔只有 3 秒 —— 长期占着一份 CPU 空转
//   3) Add-Type 受环境块大小影响,>64KB 时编译失败、检测永久失效(原脚本注释里记过)
//
// 现在改为进程内直接 P/Invoke user32.dll / kernel32.dll:零子进程、零临时文件、零代码生成,
// 单次探测约 6µs。判据与原 ps1 逐条对齐(见 judge()),行为不变。
//
// 判据(与原 ps1 一致,2026-10 加固版):
//   1. 铺满屏幕**且非最大化** —— 最大化窗口也铺满屏幕,但不是全屏
//   2. 窗口类名不在**外壳黑名单**里 —— 桌面/任务栏/输入法宿主/窗口框架代理本就铺满且无标题栏
//   3. 高度必须超过**工作区高度** —— 最大化窗口贴着工作区(扣掉任务栏),真全屏占满整屏
//
// DPI 注意:本模块必须在 Electron 主进程中调用。Electron 主进程默认 DPI-aware,
// GetWindowRect/GetMonitorInfoW 返回物理像素,与 Electron screen API 的 Display.bounds 同单位。
// 实测(125% 缩放):普通 node 进程读到 2048x1152,Electron 进程读到 2560x1440 —— 差 1.25 倍。
// 若在非 DPI-aware 进程中调用,判据会系统性失灵(窗口永远"铺不满"屏幕),届时需先 SetProcessDPIAware。
'use strict';

const TOLERANCE = 8; // 与 ps1 一致:容忍 8px 偏差(浏览器全屏视频可能有微小边框)

// 外壳窗口黑名单:桌面/任务栏/输入法候选窗/窗口框架代理。
// 它们本就铺满屏幕且无标题栏,一旦成为前台就会被误判成全屏
// (实测 Progman 与 Windows.UI.Core.CoreWindow 均中招)。类名比较不区分大小写。
const SHELL_CLASSES = new Set([
  'progman', 'workerw', 'shell_traywnd', 'shell_secondarytraywnd',
  'windows.ui.core.corewindow', 'applicationframehost',
  'multitaskingviewframe', 'foregroundstaging', 'xamlxplorerhostislandwindow',
  'windows.internal.shell.tabproxywindow', 'tasklistthumbnailwnd',
]);

// 常量
const GWL_STYLE = -16;
const WS_CAPTION = 0x00c00000;
const MONITOR_DEFAULTTOPRIMARY = 1;
const MONITOR_DEFAULTTONEAREST = 2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

// ---- 纯判定函数(无 IO,便于单测) ----

// 矩形是否铺满某个显示器(遍历所有显示器,覆盖任一即算铺满,支持副屏)
function coversMonitor(rect, monitor, tolerance) {
  const tol = typeof tolerance === 'number' ? tolerance : TOLERANCE;
  if (!rect || !monitor) return false;
  return (
    rect.Left <= monitor.Left + tol &&
    rect.Top <= monitor.Top + tol &&
    rect.Right >= monitor.Right - tol &&
    rect.Bottom >= monitor.Bottom - tol
  );
}

// 判定链,对齐 ps1 的最终分支。输入是纯数据,输出 { fullscreen, reason }
//   win:     { rect, hasCaption, isMaximized, className }
//   monitor: { rcMonitor:{Left,Top,Right,Bottom}, rcWork:{...} }
function judge({ win, monitor, tolerance }) {
  const tol = typeof tolerance === 'number' ? tolerance : TOLERANCE;
  if (!win || !win.rect || !monitor) return { fullscreen: false, reason: 'no-window' };

  // 类名是外壳窗口黑名单的唯一依据,取不到就无法排除 Progman/任务栏这类
  // "铺满且无标题栏"的窗口 —— 此时必须保守判为非全屏(宁可桌宠不避让,
  // 也不能因为把桌面当全屏而让桌宠永久消失)。
  const cls = String(win.className || '').toLowerCase();
  if (!cls) return { fullscreen: false, reason: 'no-class-name' };
  if (SHELL_CLASSES.has(cls)) return { fullscreen: false, reason: 'shell-class' };

  // 1. 必须铺满屏幕
  if (!coversMonitor(win.rect, monitor.rcMonitor, tol)) {
    return { fullscreen: false, reason: 'not-covering' };
  }
  // 2. 必须有标题栏才排除。真全屏窗口通常无标题栏;
  //    Chromium 全屏虽带 WS_MAXIMIZE 但无 WS_CAPTION,所以用标题栏判据(比最大化判据更准)
  if (win.hasCaption) return { fullscreen: false, reason: 'has-caption' };

  // 3. 工作区分水岭:最大化窗口高度 == 工作区高度(任务栏被扣掉);真全屏 == 整屏高度 > 工作区。
  //    只在任务栏确实占用空间时才启用该判据,任务栏自动隐藏时不误杀。
  const screenH = win.rect.Bottom - win.rect.Top;
  const workH = monitor.rcWork.Bottom - monitor.rcWork.Top;
  const beatsWorkArea = workH > 0 && screenH > workH + tol;

  if (beatsWorkArea) return { fullscreen: true, reason: 'geometry' };
  // 任务栏被自动隐藏时整屏高度也可能等于工作区,此时退回"非最大化"判据
  if (!win.isMaximized) return { fullscreen: true, reason: 'geometry-no-taskbar' };
  return { fullscreen: false, reason: 'maximized' };
}

// ---- 原生绑定(惰性创建,只在 Windows 上初始化) ----

function create({ log } = {}) {
  const wlog = typeof log === 'function' ? log : () => {};

  let api = null; // 惰性初始化的绑定集合
  let broken = false; // 绑定失败一次就不再重试(降级为不检测,但照常轮询)
  let warned = null;

  function warnOnce(msg) {
    if (warned === msg) return;
    warned = msg;
    wlog('[win32]', msg);
  }

  // 建立 koffi 绑定。任何一步失败都抛错,由 init() 捕获并降级。
  function bind() {
    // 惰性 require:koffi 是原生模块,非 Windows 平台不该被加载
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    const RECT = koffi.struct('RECT', { Left: 'int', Top: 'int', Right: 'int', Bottom: 'int' });
    const MONITORINFO = koffi.struct('MONITORINFO', {
      cbSize: 'uint32',
      rcMonitor: RECT,
      rcWork: RECT,
      dwFlags: 'uint32',
    });

    return {
      koffi,
      RECT,
      MONITORINFO,
      GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
      GetWindowRect: user32.func('bool GetWindowRect(void *hWnd, _Out_ RECT *lpRect)'),
      GetWindowLongA: user32.func('int32 GetWindowLongA(void *hWnd, int nIndex)'),
      IsZoomed: user32.func('bool IsZoomed(void *hWnd)'),
      GetClassNameW: user32.func('int GetClassNameW(void *hWnd, _Out_ uint16_t *lpClassName, int nMaxCount)'),
      MonitorFromWindow: user32.func('void *MonitorFromWindow(void *hWnd, uint32 dwFlags)'),
      GetMonitorInfoW: user32.func('bool GetMonitorInfoW(void *hMonitor, _Inout_ MONITORINFO *lpmi)'),
      GetWindowThreadProcessId: user32.func(
        'uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)'),
      OpenProcess: kernel32.func('void *OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)'),
      QueryFullProcessImageNameW: kernel32.func(
        'bool QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32 *lpdwSize)'),
      CloseHandle: kernel32.func('bool CloseHandle(void *hObject)'),
    };
  }

  function ensureApi() {
    if (api) return api;
    if (broken) return null;
    try {
      api = bind();
      // 预热一次:首次调用会有符号解析开销(实测约 0-5ms),不想让它落在第一次真实轮询上
      api.GetForegroundWindow();
      return api;
    } catch (e) {
      broken = true;
      // 降级而不是崩溃:koffi 缺失/被安全软件拦/平台不支持,都只是"不检测全屏",
      // 绝不能让悬浮球/鲸鱼娘因为探测失败而永久隐藏(原 ps1 也有同样的兜底考量)
      warnOnce(`原生绑定不可用(${e.message}),已降级为不检测全屏`);
      return null;
    }
  }

  // 读前台窗口的进程名(仅 wantProc 时调用,保持隐私门控语义)
  function readProcessName(a, hwnd) {
    try {
      const pidBox = [0];
      a.GetWindowThreadProcessId(hwnd, pidBox);
      const pid = pidBox[0];
      if (!pid) return null;
      const h = a.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!h) return null;
      try {
        const buf = Buffer.alloc(32768); // 32768 字节 = 16384 个 UTF-16 字符,够长路径
        const sizeBox = [16384];
        if (!a.QueryFullProcessImageNameW(h, 0, buf, sizeBox)) return null;
        const full = buf.toString('utf16le', 0, sizeBox[0] * 2);
        const base = full.split('\\').pop() || '';
        const name = base.replace(/\.exe$/i, '').trim();
        return name || null;
      } finally {
        a.CloseHandle(h);
      }
    } catch (e) {
      return null;
    }
  }

  // 一次探测。契约与 modules/x11-foreground.js 完全一致:
  //   probe(wantProc, cb) → cb(null, { fullscreen, processName, reason })
  // 探测不可用时返回"非全屏"而不是 err,避免调用方 wasFullscreen 卡在 true。
  function probe(wantProc, cb) {
    const done = (res) => cb(null, res);
    const a = ensureApi();
    if (!a) return done({ fullscreen: false, processName: null, reason: 'unavailable' });

    try {
      const hwnd = a.GetForegroundWindow();
      if (!hwnd) return done({ fullscreen: false, processName: null, reason: 'no-foreground' });

      const rect = {};
      if (!a.GetWindowRect(hwnd, rect)) {
        return done({ fullscreen: false, processName: null, reason: 'no-rect' });
      }

      const style = a.GetWindowLongA(hwnd, GWL_STYLE);
      const hasCaption = (style & WS_CAPTION) !== 0;
      const isMaximized = !!a.IsZoomed(hwnd);

      const clsBuf = Buffer.alloc(256 * 2); // 256 个 UTF-16 字符
      const n = a.GetClassNameW(hwnd, clsBuf, 256);
      const className = n > 0 ? clsBuf.toString('utf16le', 0, n * 2) : '';

      const mon = a.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
      const mi = { cbSize: 40 }; // sizeof(MONITORINFO) = 4 + 16 + 16 + 4
      const gotMonitor = mon && a.GetMonitorInfoW(mon, mi);
      // 拿不到显示器信息时退回主屏(与原 ps1 遍历屏幕集合的兜底同义)
      const monitor = gotMonitor ? { rcMonitor: mi.rcMonitor, rcWork: mi.rcWork } : primaryMonitor();

      const verdict = judge({
        win: { rect, hasCaption, isMaximized, className },
        monitor,
        tolerance: TOLERANCE,
      });

      // 隐私门控:wantProc 为假时不读进程名(与原 ps1 的 DS_FG_MODE 门控等价)
      const processName = wantProc ? readProcessName(a, hwnd) : null;

      done({ fullscreen: verdict.fullscreen, processName, reason: verdict.reason });
    } catch (e) {
      // 单次异常不终结检测链:返回非全屏继续轮询(与原 ps1 的失败处理一致)
      done({ fullscreen: false, processName: null, reason: 'error:' + e.message });
    }
  }

  // 主屏兜底:用 MonitorFromWindow(NULL, PRIMARY)
  function primaryMonitor() {
    const a = ensureApi();
    const empty = { rcMonitor: { Left: 0, Top: 0, Right: 0, Bottom: 0 }, rcWork: { Left: 0, Top: 0, Right: 0, Bottom: 0 } };
    if (!a) return empty;
    try {
      const mon = a.MonitorFromWindow(null, MONITOR_DEFAULTTOPRIMARY);
      if (!mon) return empty;
      const mi = { cbSize: 40 };
      if (!a.GetMonitorInfoW(mon, mi)) return empty;
      return { rcMonitor: mi.rcMonitor, rcWork: mi.rcWork };
    } catch (e) {
      return empty;
    }
  }

  return { probe };
}

module.exports = {
  create,
  // 纯函数(单测用)
  judge,
  coversMonitor,
  SHELL_CLASSES,
  TOLERANCE,
};
