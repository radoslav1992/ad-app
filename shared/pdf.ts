// A small PDF writer for carousels as one document (LinkedIn "document" posts, sharing): one page per JPEG slide, each
// page the picture's size (at 72 dpi), the JPEG embedded as it is (DCTDecode), so nothing is re-encoded. No dependency.

/** Width, height and colour components of a baseline or progressive JPEG (its SOF segment), or null. */
export function jpegInfo(bytes: Uint8Array): { width: number; height: number; components: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    // Fill bytes and markers without a length.
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6], width = (bytes[i + 7] << 8) | bytes[i + 8], components = bytes[i + 9];
      return width > 0 && height > 0 && [1, 3, 4].includes(components) ? { width, height, components } : null;
    }
    if (marker === 0xda || length < 2) return null;
    i += 2 + length;
  }
  return null;
}

const ascii = (text: string) => new TextEncoder().encode(text);
/** A PDF string literal: printable ASCII only, with its special characters escaped. */
const literal = (text: string) => `(${text.replace(/[^\x20-\x7e]/g, "").replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** One PDF of the JPEGs, a page each in order. Throws on anything that is not a JPEG. */
export function jpegsToPdf(images: Uint8Array[], title = ""): Uint8Array<ArrayBuffer> {
  if (!images.length) throw new Error("No pages");
  const parts: Uint8Array[] = [], offsets: number[] = [];
  let size = 0;
  const push = (chunk: Uint8Array | string) => { const b = typeof chunk === "string" ? ascii(chunk) : chunk; parts.push(b); size += b.length; };
  const object = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = size;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) { push("stream\n"); push(stream); push("\nendstream\n"); }
    push("endobj\n");
  };
  // Objects: 1 catalog, 2 pages, 3 info, then per page: page, contents, image.
  const pageIds = images.map((_, i) => 4 + i * 3);
  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${images.length} >>`);
  object(3, `<< /Producer (Hookstreak)${title ? ` /Title ${literal(title.slice(0, 200))}` : ""} >>`);
  images.forEach((jpeg, i) => {
    const info = jpegInfo(jpeg);
    if (!info) throw new Error("Not a JPEG");
    const id = pageIds[i], w = info.width, h = info.height;
    const draw = ascii(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    object(id + 1, `<< /Length ${draw.length} >>`, draw);
    const space = info.components === 1 ? "/DeviceGray" : info.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
    object(id + 2, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  });
  const count = 4 + images.length * 3, xref = size;
  push(`xref\n0 ${count}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
