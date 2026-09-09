// view_image tool: hand a local image file to a vision-capable model. Reads the
// file, sniffs the real format from magic bytes (the API detects format from
// content, not filename — so the data: prefix must be right), and returns it in
// the result's image field. reactLoop serializes that into an input_image part
// of the function_call_output item; only a vision model (agent.json "model")
// processes it — see lib/react.ts.
import { readFileSync } from 'fs';
import type { Tool, ToolResult } from '../lib/react';

type Detail = 'low' | 'high' | 'original' | 'auto';
const DETAILS: readonly Detail[] = ['low', 'high', 'original', 'auto'];
const MAX_INLINE_BYTES = 32 * 1024 * 1024; // DeepSeek per-image inline limit; Files API lifts it — swap ref shape in react.ts if ever needed

/** Sniff MIME from file content. JPEG/PNG/GIF/WebP only (the API's supported set). */
export function detectImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 6) {
    const head = buf.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const viewImage: Tool = {
  name: 'view_image',
  description:
    'Send a local image file (JPEG/PNG/GIF/WebP, up to 32 MB) to your vision — the image content itself is returned to you, so you can see it. Use it to read screenshots, diagrams, charts, photos, or text inside pictures. The path is on this Windows machine. The observation text tells you the file, format and size.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'absolute or relative path to the image file' },
      detail: { type: 'string', enum: [...DETAILS], description: 'image processing level (default: original). low = downscaled to 512x512, cheaper/faster' },
    },
    required: ['path'],
  },
  run: async (args): Promise<ToolResult> => {
    const path = String(args.path ?? '').trim();
    if (!path) return { ok: false, output: 'Usage: view_image with a path to a local image file' };
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch (e) {
      return { ok: false, output: `Cannot read ${path}: ${(e as Error).message}` };
    }
    if (buf.length === 0) return { ok: false, output: `${path} is empty` };
    if (buf.length > MAX_INLINE_BYTES)
      return { ok: false, output: `${path} is ${(buf.length / 1048576).toFixed(1)} MB — over the 32 MB inline limit (base64 would push the 48 MB request body too far)` };
    const mime = detectImageMime(buf);
    if (!mime) return { ok: false, output: `${path} is not a supported image (JPEG/PNG/GIF/WebP detected from content, not extension)` };
    const rawDetail = String(args.detail ?? '');
    const detail = (DETAILS as readonly string[]).includes(rawDetail) ? (rawDetail as Detail) : undefined;
    const image: ToolResult['image'] = { url: `data:${mime};base64,${buf.toString('base64')}` };
    if (detail) image.detail = detail;
    return {
      ok: true,
      output: `Sent ${path} (${mime}, ${(buf.length / 1024).toFixed(1)} KiB) — see the attached image.`,
      image,
    };
  },
};
