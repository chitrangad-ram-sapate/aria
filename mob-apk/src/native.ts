// Share sheet, file open and "open with" handling. Native APIs on Android/iOS, web APIs elsewhere.
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export const isNative = Capacitor.isNativePlatform();
export const SVCR_MIME = 'application/vnd.aria.svcr+json';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Share a file through the OS share sheet; on the web falls back to a download. */
export async function shareFile(name: string, data: Uint8Array | string, mime: string): Promise<void> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (isNative) {
    const { uri } = await Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: Directory.Cache });
    await Share.share({ title: name, files: [uri], dialogTitle: name });
    return;
  }
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Share a short text (a team code) through the share sheet; copies it when sharing is not available. → 'copied' | 'shared'. */
export async function shareText(title: string, text: string): Promise<'shared' | 'copied'> {
  if (isNative) { await Share.share({ title, text, dialogTitle: title }); return 'shared'; }
  if (navigator.share) {
    try { await navigator.share({ title, text }); return 'shared'; } catch (e: any) { if (e?.name === 'AbortError') return 'shared'; }
  }
  await navigator.clipboard?.writeText(text);
  return 'copied';
}

/** Calls handler for .svcr files opened from other apps ("open with", share to ARIA). */
export function onFileOpened(handler: (name: string, bytes: Uint8Array | null, error?: string) => void) {
  const read = async (url: string | undefined) => {
    if (!url || url.startsWith('app.aria.planner:')) return;
    const { data } = await Filesystem.readFile({ path: url });
    const name = decodeURIComponent(url.split('/').pop() || 'record.svcr');
    handler(name, typeof data === 'string' ? fromBase64(data) : new Uint8Array(await data.arrayBuffer()));
  };
  if (isNative) {
    App.addListener('appUrlOpen', ({ url }) => read(url).catch((e) => handler('', null, `Could not read the file: ${e?.message ?? e}`)));
    App.getLaunchUrl().then((r) => read(r?.url)).catch((e) => handler('', null, `Could not read the file: ${e?.message ?? e}`));
  } else if ('launchQueue' in window) {
    // Installed web app registered as a .svcr file handler (manifest file_handlers).
    (window as any).launchQueue.setConsumer(async (p: any) => {
      for (const fh of p.files || []) {
        const f = await fh.getFile();
        handler(f.name, new Uint8Array(await f.arrayBuffer()));
      }
    });
  }
}
