// Must be the first import of the app: some bundled CommonJS libraries (readable-stream, util, create-hash…)
// expect globals `Buffer` and `process`. This `process` is the plain *browser* shim (`process.browser`, no
// `versions.node`) so the app's own libraries keep detecting a browser; plugins get an Electron-like one in
// their own scope (see nodeShims.pluginProcess).
import { Buffer } from 'buffer';
import processShim from 'process';
const w = window as unknown as { Buffer?: typeof Buffer; global?: unknown; process?: unknown };
w.Buffer ??= Buffer;
w.global ??= window;
w.process ??= processShim;
