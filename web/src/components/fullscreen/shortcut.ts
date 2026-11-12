// Shortcut to enter and exit full screen (Contracts 20.1): ⌃⇧F, Control + Shift + F on macOS (not Command).
// Chosen by testing (Reports/W46):
// - Chrome on macOS has only two Control shortcuts, Control+F2 and Control+F5, and no Control+Shift+F;
// - Monaco on macOS uses Control+F to move the cursor right and combines Control+Shift only with A, E, M, R and the arrows, not Control+Shift+F;
// - Claude Code in the terminal does not use Control+F; Codex does (move right, next page). Only the Shift combination is taken here,
//   so Control+F without Shift still reaches the terminal
export const FULLSCREEN_SHORTCUT_LABEL = '⌃⇧F';

export function isFullscreenShortcut(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.code === 'KeyF'
  );
}
