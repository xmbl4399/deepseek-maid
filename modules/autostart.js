// 开机启动(Linux):XDG autostart .desktop 文件
//
// 为什么不用 app.setLoginItemSettings:该 API 在 Electron 里只实现了 Windows / macOS,
// Linux 上是空操作(文档标注 "macOS and Windows only"),调用不报错但什么也不做 ——
// 比报错更糟,用户会以为勾上了。所以 Linux 走标准 XDG 机制:
//   $XDG_CONFIG_HOME(默认 ~/.config)/autostart/<name>.desktop
// GNOME / KDE / Xfce / Cinnamon 等桌面环境都会在登录时扫描该目录。
//
// Exec 取值:
//   - AppImage 运行:必须在 .desktop 里指向 $APPIMAGE 本体,而不是挂载点里的可执行文件
//     (挂载点每次启动都变,写死会导致下次开机启动失败)
//   - deb 安装:指向 /opt/<productName>/<binary>
// 两者都从运行时环境推断,不做符号链接假设。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE_NAME = 'deepseek-desktop.desktop';
const DISPLAY_NAME = 'DeepSeek';

function configHome() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
}

function desktopPath() {
  return path.join(configHome(), 'autostart', FILE_NAME);
}

// .desktop 的 Exec 值按 spec 用双引号包裹可执行文件路径,
// 内部的双引号/反斜杠/反引号/$ 需转义(否则被 Exec 解析器吞掉)
function quoteExec(p) {
  const escaped = String(p).replace(/(["\\`$])/g, '\\$1');
  return `"${escaped}"`;
}

// 运行时真实可执行路径:AppImage 优先用 $APPIMAGE(本体),其余用 process.execPath
function targetExec() {
  if (process.env.APPIMAGE && path.isAbsolute(process.env.APPIMAGE)) return process.env.APPIMAGE;
  return process.execPath;
}

function desktopEntry(execPath) {
  const exec = execPath || targetExec();
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${DISPLAY_NAME}`,
    'Comment=DeepSeek 网页版桌面客户端',
    `Exec=${quoteExec(exec)}`,
    'Terminal=false',
    'Hidden=false',
    'NoDisplay=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupNotify=false',
    '',
  ].join('\n');
}

function isEnabled() {
  try {
    const text = fs.readFileSync(desktopPath(), 'utf8');
    // Hidden=true 或 X-GNOME-Autostart-enabled=false 都表示"文件在但被禁用"
    if (/^\s*Hidden\s*=\s*true\s*$/im.test(text)) return false;
    if (/^\s*X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(text)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function setEnabled(enabled) {
  const p = desktopPath();
  try {
    if (enabled) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, desktopEntry(), 'utf8');
      // 部分桌面环境要求 .desktop 可执行才识别(标准不要求,但保险)
      try {
        fs.chmodSync(p, 0o644);
      } catch (e) {
        /* ignore */
      }
    } else if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
    return true;
  } catch (e) {
    return false;
  }
}

// 桌面环境菜单项:让应用出现在"活动/程序"列表里(deb 由 electron-builder 装好,
// AppImage 无安装过程,用户想手动加菜单项时可调用)
function create({ log } = {}) {
  const alog = typeof log === 'function' ? log : () => {};
  return {
    isEnabled,
    setEnabled,
    desktopPath,
    desktopEntry,
    targetExec,
    // 带日志的包装:托盘/设置里调用,失败要能在日志里看见原因
    enable() {
      const ok = setEnabled(true);
      alog('[autostart] enable ->', ok, p());
      return ok;
    },
    disable() {
      const ok = setEnabled(false);
      alog('[autostart] disable ->', ok, p());
      return ok;
    },
    set(value) {
      return value ? this.enable() : this.disable();
    },
  };
  function p() {
    return desktopPath();
  }
}

module.exports = {
  create,
  isEnabled,
  setEnabled,
  desktopPath,
  desktopEntry,
  targetExec,
  quoteExec,
  FILE_NAME,
};
