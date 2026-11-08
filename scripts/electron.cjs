// Launch Electron with a clean environment. Editors such as VS Code export
// ELECTRON_RUN_AS_NODE=1 to child shells, which would make Electron start as plain Node.
const { spawn } = require('node:child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--dev')) env.CALAMUS_DEV = '1';

const extra = process.argv.slice(2).filter((a) => a !== '--dev');
const child = spawn(electron, ['.', ...extra], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
