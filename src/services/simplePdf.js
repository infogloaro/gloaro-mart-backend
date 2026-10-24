/**
 * A small text-only PDF writer (A4, the standard Helvetica and Courier fonts),
 * enough for an invoice sent on WhatsApp without a PDF library. Lines are
 * { text, font: 'regular' | 'bold' | 'mono' | 'monoBold', size } and flow onto
 * new pages as needed. The standard fonts are WinAnsi only, so other
 * characters (₹, Tamil…) are written as "Rs." or "?".
 */

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const FONTS = { regular: 'F1', bold: 'F2', mono: 'F3', monoBold: 'F4' };
const BASE = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Courier', F4: 'Courier-Bold' };

function clean(text) {
  return String(text ?? '')
    .replace(/₹\s?/g, 'Rs.')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/[\\()]/g, (c) => `\\${c}`);
}

/** Lines → PDF bytes (Buffer). */
function render(lines) {
  const pages = [[]];
  let y = PAGE_H - MARGIN;
  for (const line of lines) {
    const size = line.size ?? 9;
    const lead = line.gap ?? size * 1.35;
    if (y - lead < MARGIN) {
      pages.push([]);
      y = PAGE_H - MARGIN;
    }
    y -= lead;
    if (line.rule) {
      pages[pages.length - 1].push(`0.6 w ${MARGIN} ${y + lead / 2} m ${PAGE_W - MARGIN} ${y + lead / 2} l S`);
      continue;
    }
    if (line.text) {
      const font = FONTS[line.font ?? 'regular'];
      pages[pages.length - 1].push(`BT /${font} ${size} Tf ${MARGIN} ${y.toFixed(1)} Td (${clean(line.text)}) Tj ET`);
    }
  }

  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add(null);
  const pageTree = add(null);
  const fontIds = Object.fromEntries(
    Object.entries(BASE).map(([key, name]) => [key, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`)])
  );
  const fontRes = Object.entries(fontIds).map(([k, id]) => `/${k} ${id} 0 R`).join(' ');
  const pageIds = pages.map((ops) => {
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${fontRes} >> >> /Contents ${content} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { render };
