// 托盘:图标 + 右键菜单(每次弹出前重建,保证勾选状态与真实设置一致)
//
// 项序 / 分组不在这里定义 —— 唯一来源是 modules/menu-model.js(与悬浮球菜单共用),
// 本文件只负责把模型画成原生菜单。加项/调顺序请改 menu-model.js。
const { Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const menuModel = require('./menu-model');

const LOGO = path.join(__dirname, '..', 'ui', 'logo.png');

function create({ log, state, onMenuAction, getMenuContext, beforeMenu }) {
  // 模型项 → 原生菜单项。radio/checkbox 要带 type,其余是普通项。
  function toItem(it) {
    const mi = { label: it.label, enabled: it.enabled !== false };
    if (it.type === 'radio' || it.type === 'checkbox') {
      mi.type = it.type;
      mi.checked = !!it.checked;
      // checkbox 传"目标值"(=反值,即切换);radio 的动作自身知道要切到哪,payload 会被忽略
      mi.click = () => onMenuAction(it.act, { checked: !it.checked });
    } else {
      mi.click = () => onMenuAction(it.act);
    }
    return mi;
  }

  // 模型 → 原生模板:group 之间出分隔线;submenu 块出原生子菜单,items 块直接铺开。
  // 嵌套 submenu(播放动作 → 分类 → 动作)必须递归转成二级原生子菜单 —— 否则分类块
  // 会被当成普通项,渲染成一行点不动的"分类名",三级菜单在托盘里就断了。
  function toEntry(block) {
    if (block.kind === menuModel.SUBMENU) {
      const out = { label: block.label };
      if (block.enabled === false) out.enabled = false;
      out.submenu = (block.items || []).map(toEntry);
      return out;
    }
    return toItem(block);
  }

  function toTemplate(ctx) {
    const out = [];
    menuModel.build(ctx).forEach((group, gi) => {
      if (gi > 0) out.push({ type: 'separator' });
      for (const block of group.blocks || []) {
        if (block.kind === menuModel.SUBMENU) {
          out.push(toEntry(block));
        } else {
          for (const it of block.items || []) out.push(toItem(it));
        }
      }
    });
    return out;
  }

  function buildAppMenu() {
    const ctx = getMenuContext ? getMenuContext() : {};
    log(
      '[tray] menu rebuilt: mode =', ctx.mode,
      'size =', ctx.size,
      'autoStart =', ctx.autoStart,
      'mainVisible =', ctx.mainVisible,
    );
    return Menu.buildFromTemplate(toTemplate(ctx));
  }

  function createTray() {
    // Windows 托盘 16px(任务栏小图标);Linux 托盘(StatusNotifierItem)按面板高度缩放,
    // 16px 在高 DPI 下会糊,用 22px —— 与 GNOME/KDE 图标网格的常用尺寸一致。
    const iconSize = process.platform === 'win32' ? 16 : 22;
    const trayIcon = nativeImage.createFromPath(LOGO).resize({ width: iconSize, height: iconSize });
    try {
      state.tray = new Tray(trayIcon);
    } catch (e) {
      // Linux 上托盘需要 StatusNotifierItem 支持:GNOME 默认无托盘区(需 AppIndicator 扩展),
      // 纯 Wayland 无 XWayland 也可能构造失败。托盘失败不能拖垮应用 —— 记日志后照常启动,
      // 只是少一个入口(主窗、悬浮球菜单都还在)。
      log('[tray] 创建失败(缺少托盘宿主?):', e && e.message);
      state.tray = null;
      return;
    }
    // 悬浮提示:只显示产品名(与窗口标题、快捷方式名统一为 DeepSeek)
    state.tray.setToolTip('DeepSeek');

    state.tray.setContextMenu(buildAppMenu());
    // 每次弹出菜单前重建:保证"开机启动"勾选状态与注册表实际一致(只构建一次会显示过期状态)。
    // 同时先刷新动作目录:菜单项按「播放动作 → 分类 → 动作」分三级,分类数据要现取。
    state.tray.on('right-click', () => {
      const done = () => state.tray && !state.tray.isDestroyed() && state.tray.setContextMenu(buildAppMenu());
      if (beforeMenu) beforeMenu().then(done, done); // 取目录失败也要照常弹菜单
      else done();
    });
    // 左键单击/双击:直接唤出主窗(原有行为,不改)。"隐藏"只在菜单首项里提供
    state.tray.on('click', () => onMenuAction('show-main'));
    state.tray.on('double-click', () => onMenuAction('show-main'));
    // Linux 的 StatusNotifierItem 用 activate 表示单击(Wayland 下 click 事件不可靠)
    if (process.platform !== 'win32') {
      try {
        state.tray.on('activate', () => onMenuAction('show-main'));
      } catch (e) {
        /* 该事件在旧版 Electron 上不存在的可能性,忽略 */
      }
    }
  }

  // 置顶等状态变化时主动刷新托盘菜单(不依赖 right-click 事件重建,保证勾选状态实时一致)
  function refresh() {
    if (state.tray && !state.tray.isDestroyed()) {
      state.tray.setContextMenu(buildAppMenu());
    }
  }

  // 系统提示(首次"关闭到托盘"、桌宠被隐藏时用)
  //   Windows:Tray.displayBalloon(气泡,由托盘宿主绘制)
  //   Linux/macOS:displayBalloon 不存在,改走标准 Notification(freedesktop 通知服务,
  //   GNOME/KDE 都有);两者都不可用时静默跳过 —— 提示失败绝不能影响主流程
  function notify(title, content) {
    if (process.platform === 'win32') {
      if (!state.tray || state.tray.isDestroyed()) return;
      try {
        state.tray.displayBalloon({ title, content });
      } catch (e) {
        log('[tray] balloon failed:', e && e.message);
      }
      return;
    }
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body: content, silent: true });
      // 点击通知 → 唤出主窗(与气泡行为的直觉一致)
      n.on('click', () => onMenuAction('show-main'));
      n.show();
    } catch (e) {
      log('[tray] notification failed:', e && e.message);
    }
  }

  return { createTray, buildAppMenu, refresh, notify, toTemplate };
}

module.exports = { create };
