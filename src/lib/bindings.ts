// Effective key bindings (defaults + keybindings.json), shared by the key handler,
// the command palette, menus and the Settings → Keyboard page.
import { useSyncExternalStore } from 'react';
import { effectiveBindings, shortcutFor, type Binding } from './keys';
import { userKeybindings } from '../store';

export let bindings: Binding[] = effectiveBindings([]);
let version = 0;
const subs = new Set<() => void>();

export function rebuildBindings() {
  bindings = effectiveBindings(userKeybindings);
  version++;
  subs.forEach((f) => f());
}
export function useBindingsVersion() {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => version);
}
/** Display label for a command's shortcut, honouring user overrides. */
export function keysFor(command: string, fallback?: string) {
  return shortcutFor(command, bindings) ?? fallback;
}
