// Modifier glyphs for shortcut labels. Kept dependency-free so any module can import it.
import { isMac } from './bridge';

export const keyLabel = {
  mod: isMac ? '⌘' : 'Ctrl+',
  alt: isMac ? '⌥' : 'Alt+',
  shift: isMac ? '⇧' : 'Shift+',
  ctrl: isMac ? '⌃' : 'Ctrl+',
};
