/**
 * qr.js — a QR encoder.
 *
 * Written out rather than pulled from a package because this project has no
 * build step and no dependencies, and because QR earns its place twice: once
 * for pairing a phone, and again for the printed labels that go on equipment.
 *
 * Byte mode only. That covers URLs and arbitrary text, which is everything
 * this archive needs; numeric and alphanumeric modes would pack tighter but
 * add a mode-selection pass for no practical gain here.
 *
 * ISO/IEC 18004. The tables below are from that specification.
 */

// ── Specification tables ────────────────────────────────────────────────────
//
// Indexed [eccLevel][version]. Version 0 is unused, hence the leading -1.
// test/qr.test.mjs cross-checks both tables against the module geometry
// computed independently below — a mistyped entry does not survive that.

const ECC_CODEWORDS_PER_BLOCK = [
  // L
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28,
   28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  // M
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
   26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  // Q
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26,
   30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  // H
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26,
   28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_BLOCKS = [
  // L
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7,
   8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  // M
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14,
   16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  // Q
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21,
   20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  // H
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25,
   25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** L tolerates ~7% damage, M ~15%, Q ~25%, H ~30%. */
export const ECC = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS = { 0: 1, 1: 0, 2: 3, 3: 2 };   // the spec's own ordering

// ── Geometry ────────────────────────────────────────────────────────────────

export const sizeOf = version => version * 4 + 17;

/** Modules available for data and error correction, before any are spent. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export const totalCodewords = version => Math.floor(rawDataModules(version) / 8);

export function dataCodewords(version, ecc) {
  return totalCodewords(version)
    - ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_BLOCKS[ecc][version];
}

/**
 * How many blocks the codewords are split into, and how many error-correction
 * codewords each carries.
 *
 * Exported because it cannot be recovered from capacity alone — several
 * layouts satisfy the same arithmetic — and anything reading a symbol back
 * needs the real figures.
 */
export function layout(version, ecc) {
  return {
    blocks: NUM_BLOCKS[ecc][version],
    eccPerBlock: ECC_CODEWORDS_PER_BLOCK[ecc][version],
  };
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26
    : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const out = [6];
  for (let pos = sizeOf(version) - 7; out.length < numAlign; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ── Reed-Solomon over GF(256) ───────────────────────────────────────────────

/** Multiply in GF(256) with the QR field's primitive polynomial, 0x11D. */
function gfMul(a, b) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xff;
}

function generatorPoly(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** The error-correction codewords for one block. */
export function rsRemainder(data, degree) {
  const gen = generatorPoly(degree);
  const result = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(gen[i], factor);
  }
  return result;
}

// ── Encoding ────────────────────────────────────────────────────────────────

function pickVersion(byteLength, ecc, minVersion = 1) {
  for (let v = minVersion; v <= 40; v++) {
    // 4 bits of mode indicator, then an 8- or 16-bit length.
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (dataCodewords(v, ecc) * 8 >= headerBits + byteLength * 8) return v;
  }
  throw new Error(`${byteLength} bytes will not fit in a QR code at this level`);
}

function toBitstream(bytes, version, ecc) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4);                                   // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacity = dataCodewords(version, ecc) * 8;
  push(0, Math.min(4, capacity - bits.length));      // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  // Alternating pad bytes, as the specification requires — not zeroes, which
  // would leave large blank runs that confuse decoders.
  const pad = [0xec, 0x11];
  for (let i = 0; bits.length < capacity; i++) push(pad[i % 2], 8);

  const out = new Uint8Array(bits.length / 8);
  bits.forEach((bit, i) => { out[i >>> 3] |= bit << (7 - (i & 7)); });
  return out;
}

/**
 * Split into blocks, add error correction, then interleave.
 *
 * Interleaving is what makes a QR code survive a smudge: consecutive modules
 * on the symbol come from different blocks, so localised damage is spread
 * thinly across all of them rather than destroying one block outright.
 */
function addEcc(data, version, ecc) {
  const numBlocks = NUM_BLOCKS[ecc][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const total = totalCodewords(version);
  const shortBlockLen = Math.floor(total / numBlocks) - eccLen;
  const numShort = numBlocks - (total % numBlocks);

  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    blocks.push({ data: dat, ecc: rsRemainder(dat, eccLen) });
  }

  const result = new Uint8Array(total);
  let n = 0;
  for (let i = 0; i < shortBlockLen + 1; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < blocks[b].data.length) result[n++] = blocks[b].data[i];
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < numBlocks; b++) result[n++] = blocks[b].ecc[i];
  }
  return result;
}

// ── Matrix ──────────────────────────────────────────────────────────────────

function blankMatrix(size) {
  return {
    modules: Array.from({ length: size }, () => new Uint8Array(size)),
    // Function patterns must not be masked or overwritten by data.
    reserved: Array.from({ length: size }, () => new Uint8Array(size)),
    size,
  };
}

function set(m, x, y, dark, isFunction = true) {
  if (x < 0 || y < 0 || x >= m.size || y >= m.size) return;
  m.modules[y][x] = dark ? 1 : 0;
  if (isFunction) m.reserved[y][x] = 1;
}

function drawFunctionPatterns(m, version, ecc) {
  const size = m.size;

  for (let i = 0; i < size; i++) {
    const dark = i % 2 === 0;
    set(m, 6, i, dark);     // timing
    set(m, i, 6, dark);
  }

  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(m, cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }

  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      // The three corners already carry finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1)
        || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(m, align[j] + dx, align[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  drawFormat(m, ecc, 0);        // placeholder; rewritten once a mask is chosen
  drawVersion(m, version);
}

function drawFormat(m, ecc, mask) {
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;        // BCH(15,5), then masked
  const size = m.size;
  const bit = i => ((bits >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) set(m, 8, i, bit(i));
  set(m, 8, 7, bit(6));
  set(m, 8, 8, bit(7));
  set(m, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(m, 14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) set(m, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(m, 8, size - 15 + i, bit(i));
  set(m, 8, size - 8, true);                          // always-dark module
}

function drawVersion(m, version) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(m, a, b, dark);
    set(m, b, a, dark);
  }
}

/** Zigzag placement: two columns at a time, right to left, skipping column 6. */
function drawCodewords(m, data) {
  let i = 0;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (m.reserved[y][x]) continue;
        if (i < data.length * 8) {
          m.modules[y][x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.reserved[y][x] && MASKS[mask](x, y)) m.modules[y][x] ^= 1;
    }
  }
}

/**
 * Score a masked symbol. Lower is better.
 *
 * The four rules penalise what confuses a scanner: long same-colour runs,
 * solid blocks, patterns resembling a finder, and a lopsided ratio of dark
 * to light.
 */
function penalty(m) {
  const size = m.size;
  const at = (x, y) => m.modules[y][x];
  let score = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rule 1, both directions: runs of five or more.
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (x + dx * 4 >= size || y + dy * 4 >= size) continue;
        const c = at(x, y);
        let run = 1;
        while (run < size && x + dx * run < size && y + dy * run < size
          && at(x + dx * run, y + dy * run) === c) run++;
        if (run >= 5) {
          const before = x - dx >= 0 && y - dy >= 0 && at(x - dx, y - dy) === c;
          if (!before) score += 3 + (run - 5);
        }
      }

      // Rule 2: 2x2 blocks of one colour.
      if (x + 1 < size && y + 1 < size) {
        const c = at(x, y);
        if (at(x + 1, y) === c && at(x, y + 1) === c && at(x + 1, y + 1) === c) score += 3;
      }

      // Rule 3: the 1:1:3:1:1 finder-like pattern with four light modules.
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (x + dx * 10 >= size || y + dy * 10 >= size) continue;
        const read = n => at(x + dx * n, y + dy * n);
        const seq = Array.from({ length: 11 }, (_, n) => read(n)).join('');
        if (seq.startsWith('10111010000') || seq.startsWith('00001011101')) score += 40;
      }
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += at(x, y);
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * Encode text as a QR matrix.
 *
 * @returns {{modules: Uint8Array[], size: number, version: number, mask: number}}
 */
export function encode(text, { ecc = ECC.M, minVersion = 1 } = {}) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length, ecc, minVersion);

  const codewords = addEcc(toBitstream(bytes, version, ecc), version, ecc);

  const m = blankMatrix(sizeOf(version));
  drawFunctionPatterns(m, version, ecc);
  drawCodewords(m, codewords);

  // Try every mask and keep the one a scanner will find easiest.
  let best = { score: Infinity, mask: 0, modules: null };
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, mask);
    drawFormat(m, ecc, mask);
    const score = penalty(m);
    if (score < best.score) {
      best = { score, mask, modules: m.modules.map(row => row.slice()) };
    }
    applyMask(m, mask);   // masking is its own inverse
  }

  return { modules: best.modules, size: m.size, version, mask: best.mask, ecc };
}

/**
 * Render as SVG.
 *
 * One path of rectangles rather than an element per module: a version 11
 * symbol is 3,721 modules, and 3,721 DOM nodes is enough to notice.
 */
export function toSvg(text, { ecc = ECC.M, margin = 4, size = 240, label } = {}) {
  const qr = encode(text, { ecc });
  const dim = qr.size + margin * 2;

  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" `
    + `width="${size}" height="${size}" shape-rendering="crispEdges" `
    + `role="img" aria-label="${escapeAttr(label || 'QR code')}">`
    + `<rect width="${dim}" height="${dim}" fill="#fff"/>`
    + `<path d="${path}" fill="#000"/></svg>`;
}

const escapeAttr = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
