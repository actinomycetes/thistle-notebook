// Minimal ZIP reader (stored + deflate via the browser's DecompressionStream) and writer (stored only).
// Used for .docx/.pptx/.xlsx sources, .tflow workspaces with FCS files, and Word export. No data leaves the browser.

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  if (p > u8.length) throw new Error('Truncated zip central directory');
  const entries = new Map();
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (p + 46 > u8.length) throw new Error('Truncated zip central directory');
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    if (p + 46 + nlen + elen + clen > u8.length) throw new Error('Truncated zip central directory');
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    entries.set(name, async () => {
      if (loff + 30 > u8.length || dv.getUint32(loff, true) !== 0x04034b50) throw new Error('Corrupt zip local header');
      const ln = dv.getUint16(loff + 26, true), le = dv.getUint16(loff + 28, true);
      const start = loff + 30 + ln + le;
      if (start + csize > u8.length) throw new Error('Truncated zip entry');
      const data = u8.subarray(start, start + csize);
      let out;
      if (method === 0) out = data;
      else if (method === 8) out = await inflateRaw(data);
      else throw new Error('Unsupported zip compression ' + method);
      if (out.length !== usize || crc32(out) !== crc) throw new Error(`Corrupt zip entry "${name}" (length or CRC mismatch)`);
      return out;
    });
  }
  return {
    names: [...entries.keys()],
    has: nm => entries.has(nm),
    bytes: nm => entries.has(nm) ? entries.get(nm)() : Promise.resolve(null),
    text: async nm => { const b = entries.has(nm) && await entries.get(nm)(); return b ? dec.decode(b) : null; },
  };
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// files: [{name, data: string|Uint8Array}] -> Blob (stored, no compression)
export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const now = new Date();
  const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
  const dosDate = ((Math.max(0, now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    parts.push(lh, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const csize = central.reduce((s, x) => s + (x.byteLength ?? x.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, end].map(x => x.buffer && !(x instanceof Uint8Array) ? new Uint8Array(x.buffer) : x));
}
