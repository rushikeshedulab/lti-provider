import type { Request, Response } from 'express';

export function clientIp(req: Request): string | null {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  const ip = req.ip ?? req.socket.remoteAddress ?? null;
  // Normalise the IPv4-mapped IPv6 form Node reports on localhost.
  return ip?.replace(/^::ffff:/, '') ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Standalone error page. The launch endpoint can fail before any React app is
 * loaded, and it renders inside the consumer's iframe, so this is plain HTML.
 */
export function renderErrorPage(
  res: Response,
  status: number,
  title: string,
  message: string,
  code?: string,
): void {
  res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#f6f7f9; color:#1a1d23; padding:24px; }
  .card { max-width:560px; background:#fff; border:1px solid #e3e6ea; border-radius:12px;
          padding:28px 32px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  h1 { margin:0 0 10px; font-size:19px; }
  p  { margin:0 0 12px; color:#4a5058; }
  .tag { display:inline-block; font:12px ui-monospace,SFMono-Regular,Menlo,monospace;
         background:#fdecec; color:#b3261e; border:1px solid #f5c6c4;
         border-radius:6px; padding:3px 8px; margin-bottom:14px; }
  .hint { font-size:13px; color:#6b7280; border-top:1px solid #eceff2; padding-top:14px; margin-top:6px; }
</style></head>
<body><div class="card">
  ${code ? `<div class="tag">${escapeHtml(code)}</div>` : ''}
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <p class="hint">LTI 1.3 Content Provider &middot; HTTP ${status}</p>
</div></body></html>`);
}
