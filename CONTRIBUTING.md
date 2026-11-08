# Contributing to Calamus

Thanks for helping. A few notes keep things smooth.

## Getting set up

```bash
npm install
npm run dev
```

Before opening a pull request, run:

```bash
npm run typecheck
npm run selftest
```

`selftest` launches the app against a throwaway folder and checks that the window renders, files can be read and written, the terminal starts, git operations work and the TypeScript language server initializes.

## Pull requests

- Keep each pull request focused on one change, and describe what it fixes and how you tested it.
- Match the existing style: design values come from `src/styles/tokens.css`, never hard-coded colours.
- New commands go in `src/commands.ts` so they appear in the Command Palette and can be bound to keys.
- UI text is short and plain. Write labels the way you'd say them.

## Reporting bugs

Open an issue with your OS and version, the Calamus version (Settings → About), what you expected and what happened. A screen recording or the steps to reproduce help a lot.
