// Kiosk QR sign-in (client): a small QR code maker for the tablet screen.
// Byte mode, error correction level M, versions 1-20 (a sign-in link is about
// 50-80 characters: version 4 or 5). No library: the algorithm follows the
// QR code standard (ISO/IEC 18004) the way the well-known reference
// implementations do. Pure, no DOM: tests decode its output with a real reader.

/** Error-correction codewords per block, level M, index = version (1-20). */
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
/** Number of error-correction blocks, level M, index = version (1-20). */
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
/** Level M in the format information. */
const FORMAT_BITS_M = 0;
export const QR_MAX_VERSION = 20;

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function utf8(text: string): number[] {
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
  const out: number[] = [];
  const s = unescape(encodeURIComponent(text));
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** A QR code as rows of booleans (true = dark), without the quiet zone. Throws when the text is too long. */
export function makeQr(text: string): boolean[][] {
  const bytes = utf8(text);
  let ver = 1;
  for (; ver <= QR_MAX_VERSION; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > QR_MAX_VERSION) throw new Error('makeQr: text too long');
  const countBits = ver <= 9 ? 8 : 16;
  const capacityBits = dataCodewords(ver) * 8;

  // Data bits: mode (byte), count, bytes, terminator, byte padding, pad codewords.
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, countBits);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacityBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }

  // Blocks + error correction, interleaved.
  const numBlocks = BLOCKS_M[ver];
  const eccLen = ECC_PER_BLOCK_M[ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) codewords.push(block[i]);
    });
  }

  const size = ver * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; isFn[y][x] = true; };

  // Function patterns: timing, finders, alignment, format (placeholder), version.
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx; const y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = alignmentPositions(ver, size);
  const na = align.length;
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask: number) => {
    const fdata = (FORMAT_BITS_M << 3) | mask;
    let rem = fdata;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((fdata << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((fbits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((vbits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      setFn(a, b, dark); setFn(b, a, dark);
    }
  }

  // Codewords in the zigzag order.
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && bi < codewords.length * 8) {
          modules[y][x] = ((codewords[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0;
          bi++;
        }
      }
    }
  }

  const maskFn = (m: number, x: number, y: number): boolean => {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && maskFn(m, x, y)) modules[y][x] = !modules[y][x];
  };

  // Pick the mask with the lowest penalty (rules N1-N4).
  let best = 0; let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const score = penalty(modules);
    if (score < bestScore) { best = m; bestScore = score; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return modules;
}

function penalty(mod: boolean[][]): number {
  const size = mod.length;
  let result = 0;
  const finderLike = (line: boolean[], i: number) => {
    // 1:1:3:1:1 dark pattern with 4 light modules on one side.
    const p = [true, false, true, true, true, false, true];
    for (let k = 0; k < 7; k++) if (line[i + k] !== p[k]) return false;
    const lightRun = (from: number, to: number) => { for (let k = from; k < to; k++) if (k >= 0 && k < line.length && line[k]) return false; return true; };
    return lightRun(i - 4, i) || lightRun(i + 7, i + 11);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      const line: boolean[] = [];
      for (let b = 0; b < size; b++) line.push(pass === 0 ? mod[a][b] : mod[b][a]);
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && line[b] === line[b - 1]) run++;
        else { if (run >= 5) result += 3 + (run - 5); run = 1; }
      }
      for (let b = 0; b + 7 <= size; b++) if (finderLike(line, b)) result += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
    const c = mod[y][x];
    if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) result += 3;
  }
  let dark = 0;
  for (const row of mod) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(0, k) * 10;
  return result;
}

/** One SVG path ("M x y h1 v1 h-1 z" per dark module, quiet zone `margin` modules) for a viewBox of size+2*margin. */
export function qrPath(modules: boolean[][], margin = 4): string {
  let d = '';
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + margin} ${y + margin}h1v1h-1z`; }));
  return d;
}
