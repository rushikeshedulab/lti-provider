/**
 * An error that kept the response body.
 *
 * Endpoint validation reports which FIELD is wrong and why, and a plain Error
 * would throw all of that away and leave the form showing one flat sentence.
 * Existing `catch (e) { setError((e as Error).message) }` call sites are
 * unaffected - the message is still the message.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new ApiError(
      body.message ?? body.error ?? `Request failed (${response.status})`,
      body.error ?? null,
      body,
    );
  }
  return body as T;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '-';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export interface UploadResult {
  path: string;
  bytes: number;
  contentType: 'video' | 'audio' | 'pdf' | 'image';
  mimeType: string;
  filename: string;
  originalName: string;
}

/**
 * Sends the File itself as the request body - no FormData, no multipart. The
 * provider pipes the stream straight to disk, so a 500 MB video never has to be
 * held in memory on either end.
 *
 * XHR rather than fetch(): only XHR reports upload progress, and a large video
 * with no progress bar looks indistinguishable from a hung page.
 */
export function uploadFile(
  file: File,
  token: string,
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/admin/content/upload?filename=${encodeURIComponent(file.name)}`);
    request.setRequestHeader('authorization', `Bearer ${token}`);
    request.setRequestHeader('content-type', 'application/octet-stream');

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };

    request.onload = () => {
      let body: Record<string, string> = {};
      try {
        body = JSON.parse(request.responseText || '{}');
      } catch {
        /* a proxy may return non-JSON on failure */
      }
      if (request.status >= 200 && request.status < 300) resolve(body as unknown as UploadResult);
      else reject(new Error(body.message ?? body.error ?? `Upload failed (${request.status})`));
    };
    request.onerror = () => reject(new Error('Upload failed: the connection dropped.'));
    request.onabort = () => reject(new Error('Upload cancelled.'));

    request.send(file);
  });
}

/**
 * Reads duration out of the file in the browser. The provider has no ffmpeg, and
 * duration is only used for display, so the honest cheap answer is to let the
 * media element that will play it tell us. Resolves to 0 for anything without a
 * timeline (or if the browser cannot decode it).
 */
export function readMediaDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) return resolve(0);
    const element = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    const objectUrl = URL.createObjectURL(file);
    const finish = (seconds: number) => {
      URL.revokeObjectURL(objectUrl);
      resolve(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0);
    };
    element.preload = 'metadata';
    element.onloadedmetadata = () => finish(element.duration);
    element.onerror = () => finish(0);
    element.src = objectUrl;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
