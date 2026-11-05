import { expect, test, type CDPSession, type Page } from '@playwright/test';

// Spec L3: runtime ceilings, absolute. Chromium + CDP, 4× CPU throttle, median of 5 runs.
const RUNS = 5;
const CEILINGS = {
  evalInitMs: 8,
  trackUs: 10,
  idleScriptMsPer10s: 1,
  heapDeltaMb: 2,
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

async function open(page: Page): Promise<CDPSession> {
  await page.goto('/bench.html');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Performance.enable');
  // The bench measures the SDK, not the fake bridge's logging or sends.
  await page.evaluate(() => Object.assign((window as unknown as { __native: object }).__native, { log: false, post: false }));
  return cdp;
}

async function heapMb(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return usedSize / 1024 / 1024;
}

async function scriptSeconds(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'ScriptDuration')?.value ?? 0;
}

/** Eval + `init()` with the default captures, then 2,000 `track()` calls; returns ms and µs. */
function evalInitAndTrack(src: string): { evalInitMs: number; trackUs: number } {
  const t0 = performance.now();
  const Rum = new Function(`${src}; return Rum;`)() as typeof import('../../packages/capacitor/dist/index.mjs') & typeof import('../../packages/core/dist/index.mjs');
  Rum.EdgeRum.init({ captures: Rum.defaultCaptures() });
  const evalInitMs = performance.now() - t0;
  const N = 2000;
  const t1 = performance.now();
  for (let i = 0; i < N; i++) Rum.EdgeRum.track('bench', { i });
  const trackUs = ((performance.now() - t1) / N) * 1000;
  (window as unknown as { Rum: unknown }).Rum = Rum;
  return { evalInitMs, trackUs };
}

test('L3 runtime ceilings', async ({ page, request }) => {
  test.setTimeout(180_000);
  const src = await (await request.get('/dist/bench.js')).text();
  const runs: Record<keyof typeof CEILINGS, number[]> = { evalInitMs: [], trackUs: [], idleScriptMsPer10s: [], heapDeltaMb: [] };

  for (let i = 0; i < RUNS; i++) {
    const cdp = await open(page);
    const before = await heapMb(cdp);
    const { evalInitMs, trackUs } = await page.evaluate(evalInitAndTrack, src);
    // Let native state land and the hand-offs drain before measuring what stays resident.
    await page.waitForTimeout(2_500);
    runs.heapDeltaMb.push((await heapMb(cdp)) - before);
    runs.evalInitMs.push(evalInitMs);
    runs.trackUs.push(trackUs);

    // A static screen: nothing happens for 10 s; only the SDK can run script.
    const s0 = await scriptSeconds(cdp);
    await page.waitForTimeout(10_000);
    runs.idleScriptMsPer10s.push(((await scriptSeconds(cdp)) - s0) * 1000);
    await cdp.detach();
  }

  const result = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, median(v)])) as typeof CEILINGS;
  console.log('[L3 bench] medians', JSON.stringify(result), 'ceilings', JSON.stringify(CEILINGS));
  for (const k of Object.keys(CEILINGS) as (keyof typeof CEILINGS)[]) {
    expect.soft(result[k], `${k} median over ${RUNS} runs`).toBeLessThanOrEqual(CEILINGS[k]);
  }
});
