import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export const allLanguages = languages;

export function detectLanguage(name: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, name) ?? null;
}

export function languageByName(name: string): LanguageDescription | null {
  return LanguageDescription.matchLanguageName(languages, name, false) ?? null;
}

const cache = new Map<string, Promise<LanguageSupport>>();
export function loadLanguage(desc: LanguageDescription): Promise<LanguageSupport> {
  let p = cache.get(desc.name);
  if (!p) { p = desc.load(); cache.set(desc.name, p); }
  return p;
}

/** Line comment token per language, used by Toggle Comment fallbacks and the status bar. */
export function displayLanguage(desc: LanguageDescription | null): string {
  return desc?.name ?? 'Plain Text';
}
