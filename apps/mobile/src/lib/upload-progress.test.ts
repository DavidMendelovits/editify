import { describe, expect, it } from 'vitest';
import { describeImport, formatBytes, importFraction } from './upload-progress';

const MB = 1024 * 1024;

describe('upload progress', () => {
  it('reads sizes in MB below a gigabyte and GB above', () => {
    expect(formatBytes(412 * MB)).toBe('412 MB');
    expect(formatBytes(1843 * MB)).toBe('1.8 GB');
  });

  it('labels one big clip by bytes, and a batch by bytes plus clips', () => {
    expect(describeImport({ done: 0, total: 1, sentBytes: 412 * MB, totalBytes: 1843 * MB })).toBe('412 MB of 1.8 GB · 22%');
    expect(describeImport({ done: 1, total: 3, sentBytes: 600 * MB, totalBytes: 1200 * MB })).toBe('600 MB of 1.2 GB · 50% · 1 of 3 clips');
  });

  it('falls back to counting files when no size is known', () => {
    expect(describeImport({ done: 1, total: 3, sentBytes: 0, totalBytes: 0 })).toBe('1 of 3 clips');
    expect(describeImport({ done: 0, total: 1, sentBytes: 0, totalBytes: 0 })).toBe('uploading');
    expect(importFraction({ done: 1, total: 4, sentBytes: 0, totalBytes: 0 })).toBe(0.25);
  });

  it('never reports past 100% when the server sees a few more bytes than the file size', () => {
    expect(importFraction({ done: 0, total: 1, sentBytes: 110, totalBytes: 100 })).toBe(1);
    expect(describeImport({ done: 0, total: 1, sentBytes: 101 * MB, totalBytes: 100 * MB })).toBe('100 MB of 100 MB · 100%');
  });
});
