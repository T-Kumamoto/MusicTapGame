// 譜面生成はメインスレッドを止めないよう Worker で行う。

import { analyze } from './analyze.js';
import { buildGrid, generateChart, DIFFICULTIES } from './generate.js';

self.onmessage = (e) => {
  const { samples, sampleRate, seed } = e.data;
  try {
    const progress = (p) => self.postMessage({ type: 'progress', value: p });
    const features = analyze(samples, sampleRate, progress);
    const gridInfo = buildGrid(features);
    const charts = {};
    for (const diff of Object.keys(DIFFICULTIES)) charts[diff] = generateChart(features, gridInfo, diff, seed);
    self.postMessage({
      type: 'done',
      result: { bpm: features.bpm, firstBeat: features.firstBeat, duration: features.duration, charts },
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
  }
};
