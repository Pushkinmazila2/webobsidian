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

/**
 * `showOpenFilePicker` only exists in secure contexts (https / localhost). A self-hosted server on plain http has none, and
 * libraries that prefer it (Excalidraw's "Open" in the stencil library) then silently do nothing. This stand-in opens the
 * ordinary file dialog and returns file handles of the shape those libraries use.
 */
export function installFilePickerPolyfill(force = false): void {
  const w = window as any;
  if (!force && typeof w.showOpenFilePicker === 'function') return;
  w.showOpenFilePicker = (opts?: { multiple?: boolean; types?: { accept?: Record<string, string[]> }[] }) =>
    new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!opts?.multiple;
      const accept = (opts?.types ?? []).flatMap((t) => Object.entries(t.accept ?? {}).flatMap(([mime, exts]) => [mime, ...(exts ?? [])]));
      if (accept.length) input.accept = accept.join(',');
      input.style.display = 'none';
      document.body.appendChild(input);
      const abort = () => { input.remove(); reject(new DOMException('The user aborted a request.', 'AbortError')); };
      input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        input.remove();
        if (!files.length) return reject(new DOMException('The user aborted a request.', 'AbortError'));
        resolve(files.map((f) => ({
          kind: 'file', name: f.name, getFile: async () => f,
          queryPermission: async () => 'granted', requestPermission: async () => 'granted', isSameEntry: async () => false,
        })));
      });
      input.addEventListener('cancel', abort);
      input.click(); // still inside the user's click, so the browser allows it
    });
}
installFilePickerPolyfill();
