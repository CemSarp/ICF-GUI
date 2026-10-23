import { describe, expect, it } from 'vitest';
import { learnedPartitions, resolveWorkingDir } from '../src/logic/jobs/jobRequest';
import { clusterTime, displayTime, formatTime } from '../src/logic/format';
import type { JobReceipt } from '../src/types';

describe('one time format', () => {
  const now = new Date(2026, 9, 16, 23, 0);
  it('cluster and local times read the same way; the date appears only when not today', () => {
    expect(clusterTime('2026-10-16T22:16:01', now)).toBe(displayTime(new Date(2026, 9, 16, 22, 16), now));
    expect(clusterTime('2026-10-16T22:16:01', now)).not.toMatch(/Oct|T|2026/);
    expect(clusterTime('2026-10-15T16:20:00', now)).toMatch(/Oct 15, /);
    expect(clusterTime('Unknown', now)).toBe('Unknown');
    expect(clusterTime(null)).toBe('—');
    expect(formatTime('not a date')).toBe('—');
  });
});

describe('wizard helpers', () => {
  it('resolves working directories inside home', () => {
    expect(resolveWorkingDir('', '/home/s1')).toBe('/home/s1');
    expect(resolveWorkingDir(' icfcc-smoke/ ', '/home/s1')).toBe('/home/s1/icfcc-smoke');
    expect(resolveWorkingDir('~/p', '/home/s1')).toBe('/home/s1/p');
    expect(resolveWorkingDir('/home/s1/x/', '/home/s1')).toBe('/home/s1/x');
  });

  it('learns the newest decisive outcome per partition', () => {
    const r = (partition: string, status: JobReceipt['status'], accessDenied = false) =>
      ({ partition, status, accessDenied }) as JobReceipt;
    const m = learnedPartitions([
      r('Teaching', 'rejected'), // e.g. time limit: teaches nothing
      r('Teaching', 'accepted'),
      r('ICF-Free', 'rejected', true),
      r('ICF-Free', 'accepted'), // older than the denial
    ]);
    expect([m.get('Teaching'), m.get('ICF-Free'), m.get('Interactive')]).toEqual(['accepted', 'denied', undefined]);
  });
});
