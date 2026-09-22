// 実数信号用の radix-2 FFT。スペクトログラム計算専用なので振幅だけ返す。

export class FFT {
  constructor(size) {
    if (size & (size - 1)) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  // input は窓掛け済みの size 点。out に size/2+1 点の振幅を書く。
  magnitude(input, out) {
    const { size, re, im, rev } = this;
    for (let i = 0; i < size; i++) {
      re[rev[i]] = input[i];
      im[rev[i]] = 0;
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let i = 0; i <= size / 2; i++) out[i] = Math.hypot(re[i], im[i]);
    return out;
  }
}
