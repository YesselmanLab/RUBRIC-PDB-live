/* Builds a ZIP of entry reports in the browser, as the reports download.
 *
 * Each report is stored as gzip (a 10-byte header, a deflate stream, then CRC-32 and
 * the uncompressed size). A ZIP entry with method 8 holds the same deflate stream, so
 * the stream is copied into the archive as is: nothing is decompressed or recompressed,
 * and unzipping gives plain .json files.
 */
(function (root) {
  "use strict";

  const u16 = (v, n) => { v.push(n & 0xff, (n >>> 8) & 0xff); };
  const u32 = (v, n) => { v.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff); };
  const enc = new TextEncoder();

  // Splits a gzip member into its deflate stream, CRC-32 and uncompressed size.
  function gzipToDeflate(gz) {
    if (gz.length < 18 || gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 8) throw new Error("not gzip");
    const flags = gz[3];
    let p = 10;
    if (flags & 4) p += 2 + (gz[p] | (gz[p + 1] << 8));    // FEXTRA
    if (flags & 8) { while (gz[p++] !== 0); }              // FNAME
    if (flags & 16) { while (gz[p++] !== 0); }             // FCOMMENT
    if (flags & 2) p += 2;                                 // FHCRC
    const end = gz.length - 8;
    const dv = new DataView(gz.buffer, gz.byteOffset + end, 8);
    return { data: gz.subarray(p, end), crc: dv.getUint32(0, true), size: dv.getUint32(4, true) };
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  // write(chunk) is called with each Uint8Array in order and may return a promise.
  function ZipWriter(write) {
    const entries = [];
    const { time, date } = dosDateTime(new Date());
    let offset = 0;
    let chain = Promise.resolve();

    const emit = (chunk) => {
      offset += chunk.length;
      chain = chain.then(() => write(chunk));
      return chain;
    };

    function header(e, central) {
      const v = [];
      u32(v, central ? 0x02014b50 : 0x04034b50);
      if (central) u16(v, 20);              // version made by
      u16(v, 20);                           // version needed
      u16(v, 0x0800);                       // UTF-8 names
      u16(v, e.method);
      u16(v, time); u16(v, date);
      u32(v, e.crc); u32(v, e.csize); u32(v, e.size);
      u16(v, e.name.length); u16(v, 0);
      if (central) { u16(v, 0); u16(v, 0); u16(v, 0); u32(v, 0); u32(v, e.offset); }
      const out = new Uint8Array(v.length + e.name.length);
      out.set(v); out.set(e.name, v.length);
      return out;
    }

    function add(name, data, crc, size, method) {
      const e = { name: enc.encode(name), crc, size, csize: data.length, offset, method };
      if (offset + data.length > 0xfffffff0) throw new Error("archive larger than 4 GB");
      entries.push(e);
      emit(header(e, false));
      return emit(data);
    }

    return {
      // Adds one file from its gzip bytes; resolves when it has been written.
      addGzip(name, gzBytes) {
        const { data, crc, size } = gzipToDeflate(gzBytes);
        return add(name, data, crc, size, 8);
      },
      addText(name, text) {
        const data = enc.encode(text);
        return add(name, data, crc32(data), data.length, 0);
      },
      count: () => entries.length,
      bytes: () => offset,
      finish() {
        if (entries.length > 0xffff) throw new Error("more than 65,535 files");
        const start = offset;
        for (const e of entries) emit(header(e, true));
        const v = [];
        u32(v, 0x06054b50); u16(v, 0); u16(v, 0);
        u16(v, entries.length); u16(v, entries.length);
        u32(v, offset - start); u32(v, start); u16(v, 0);
        return emit(new Uint8Array(v));
      },
    };
  }

  root.RubricZip = { ZipWriter, gzipToDeflate };
})(typeof window !== "undefined" ? window : globalThis);
