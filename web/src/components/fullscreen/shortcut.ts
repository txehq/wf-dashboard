// 进入与退出全屏的快捷键（Contracts 20.1）：⌃⇧F，即 macOS 上的 Control + Shift + F（不是 Command）。
// 实测选定（Reports/W46）：
// - macOS 上的 Chrome 只有 Control+F2、Control+F5 两个 Control 快捷键，没有 Control+Shift+F；
// - Monaco 在 macOS 上把 Control+F 用作光标右移，Control+Shift 只与 A、E、M、R 和方向键组合，没有 Control+Shift+F；
// - 终端中的 Claude Code 不用 Control+F，Codex 用 Control+F（右移、下一页）。这里只认带 Shift 的组合，
//   不带 Shift 的 Control+F 照常进入终端
export const FULLSCREEN_SHORTCUT_LABEL = '⌃⇧F';

export function isFullscreenShortcut(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.code === 'KeyF'
  );
}
