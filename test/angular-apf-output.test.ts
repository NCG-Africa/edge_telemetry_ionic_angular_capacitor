/**
 * Integration tests for the Angular Package Format (APF) build output.
 *
 * These tests validate that ng-packagr produces correct Ivy partial compilation
 * output, ensuring AOT consumers never hit "JIT compiler unavailable".
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ANGULAR_DIST = join(ROOT, 'packages', 'angular', 'dist');
const FESM_DIR = join(ANGULAR_DIST, 'fesm2022');
const FESM_BUNDLE = join(FESM_DIR, 'nathanclaire-rum-angular.mjs');

const hasDist = existsSync(ANGULAR_DIST);

// ---------------------------------------------------------------------------
// APF directory structure
// ---------------------------------------------------------------------------
describe.skipIf(!hasDist)('Angular APF output structure', () => {
  it('dist/ exists after build', () => {
    expect(existsSync(ANGULAR_DIST)).toBe(true);
  });

  it('contains fesm2022/ directory', () => {
    expect(existsSync(FESM_DIR)).toBe(true);
  });

  it('contains the FESM bundle file', () => {
    expect(existsSync(FESM_BUNDLE)).toBe(true);
  });

  it('contains a FESM source map', () => {
    expect(existsSync(`${FESM_BUNDLE}.map`)).toBe(true);
  });

  it('contains esm2022/ directory with individual compiled files', () => {
    const esm = join(ANGULAR_DIST, 'esm2022');
    expect(existsSync(esm)).toBe(true);
    const files = readdirSync(esm);
    expect(files.length).toBeGreaterThan(0);
  });

  it('emits index.d.ts at the dist root', () => {
    expect(existsSync(join(ANGULAR_DIST, 'index.d.ts'))).toBe(true);
  });

  it('emits individual .d.ts files for each source module', () => {
    const expectedDts = [
      'EdgeRumModule.d.ts',
      'EdgeRumService.d.ts',
      'ErrorCapture.d.ts',
      'IonicLifecycleCapture.d.ts',
      'RouterCapture.d.ts',
    ];
    for (const file of expectedDts) {
      expect(existsSync(join(ANGULAR_DIST, file))).toBe(true);
    }
  });

  it('emits a package.json in dist/ with APF entry points', () => {
    const distPkgPath = join(ANGULAR_DIST, 'package.json');
    expect(existsSync(distPkgPath)).toBe(true);

    const distPkg = JSON.parse(readFileSync(distPkgPath, 'utf-8'));
    expect(distPkg.module).toBeDefined();
    expect(distPkg.typings).toBeDefined();
  });

  it('does NOT contain tsup artifacts (index.mjs, index.cjs)', () => {
    expect(existsSync(join(ANGULAR_DIST, 'index.mjs'))).toBe(false);
    expect(existsSync(join(ANGULAR_DIST, 'index.cjs'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ivy partial compilation metadata
// ---------------------------------------------------------------------------
describe.skipIf(!hasDist)('Ivy partial compilation metadata', () => {
  let bundleContent: string;

  beforeAll(() => {
    bundleContent = readFileSync(FESM_BUNDLE, 'utf-8');
  });

  it('contains ɵɵngDeclareFactory for all injectable classes', () => {
    const classes = [
      'EdgeRumService',
      'EdgeRumErrorCapture',
      'RouterCapture',
      'IonicLifecycleCapture',
      'EdgeRumModule',
    ];
    for (const cls of classes) {
      expect(bundleContent).toContain(`type: ${cls}`);
    }
    // All 5 classes should have factory declarations
    const factoryCount = (bundleContent.match(/ɵɵngDeclareFactory/g) ?? []).length;
    expect(factoryCount).toBeGreaterThanOrEqual(5);
  });

  it('contains ɵɵngDeclareInjectable for all @Injectable classes', () => {
    const injectableCount = (bundleContent.match(/ɵɵngDeclareInjectable/g) ?? []).length;
    // EdgeRumService, EdgeRumErrorCapture, RouterCapture, IonicLifecycleCapture = 4
    expect(injectableCount).toBeGreaterThanOrEqual(4);
  });

  it('contains ɵɵngDeclareNgModule for EdgeRumModule', () => {
    expect(bundleContent).toContain('ɵɵngDeclareNgModule');
  });

  it('contains ɵɵngDeclareInjector for EdgeRumModule', () => {
    expect(bundleContent).toContain('ɵɵngDeclareInjector');
  });

  it('declares compilationMode partial (minVersion: "12.0.0")', () => {
    expect(bundleContent).toContain('minVersion: "12.0.0"');
  });

  it('does NOT contain full JIT compilation artifacts', () => {
    // Full compilation would use ɵɵdefineInjectable, ɵɵdefineNgModule etc.
    // Partial uses ɵɵngDeclare* instead
    expect(bundleContent).not.toContain('ɵɵdefineInjectable');
    expect(bundleContent).not.toContain('ɵɵdefineNgModule');
  });

  it('does NOT contain raw __decorateClass helpers (tsup artifact)', () => {
    expect(bundleContent).not.toContain('__decorateClass');
  });

  it('does NOT contain __decorate helpers (tsc artifact)', () => {
    expect(bundleContent).not.toContain('__decorate(');
  });
});

// ---------------------------------------------------------------------------
// DI token wiring in compiled output
// ---------------------------------------------------------------------------
describe.skipIf(!hasDist)('DI token wiring in compiled output', () => {
  let bundleContent: string;

  beforeAll(() => {
    bundleContent = readFileSync(FESM_BUNDLE, 'utf-8');
  });

  it('RouterCapture factory declares Router as a dependency token', () => {
    // ng-packagr should emit: deps: [{ token: Router }]
    // This proves Router was imported as a value (not type-only)
    const routerCaptureFactory = bundleContent.match(
      /type: RouterCapture.*?ɵɵFactoryTarget/s,
    );
    expect(routerCaptureFactory).not.toBeNull();
    const match = routerCaptureFactory?.[0] ?? '';
    expect(match).toContain('token:');
    expect(match).toContain('Router');
  });

  it('EdgeRumErrorCapture factory declares optional dependency on ERROR_ROUTE_PROVIDER', () => {
    const errorFactory = bundleContent.match(
      /type: EdgeRumErrorCapture.*?ɵɵFactoryTarget/s,
    );
    expect(errorFactory).not.toBeNull();
    const match = errorFactory?.[0] ?? '';
    expect(match).toContain('token: ERROR_ROUTE_PROVIDER');
    expect(match).toContain('optional: true');
  });

  it('IonicLifecycleCapture factory declares optional dependency on LIFECYCLE_EVENT_SOURCE', () => {
    const lifecycleFactory = bundleContent.match(
      /type: IonicLifecycleCapture.*?ɵɵFactoryTarget/s,
    );
    expect(lifecycleFactory).not.toBeNull();
    const match = lifecycleFactory?.[0] ?? '';
    expect(match).toContain('token: LIFECYCLE_EVENT_SOURCE');
    expect(match).toContain('optional: true');
  });

  it('EdgeRumService factory has zero dependencies (no constructor params)', () => {
    const serviceFactory = bundleContent.match(
      /type: EdgeRumService,\s*deps:\s*\[\]/,
    );
    expect(serviceFactory).not.toBeNull();
  });

  it('EdgeRumModule factory has zero dependencies', () => {
    const moduleFactory = bundleContent.match(
      /type: EdgeRumModule,\s*deps:\s*\[\]/,
    );
    expect(moduleFactory).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Type definitions contain Ivy static fields
// ---------------------------------------------------------------------------
describe.skipIf(!hasDist)('Type definitions contain Ivy fields', () => {
  const DTS_FILES: Array<{ file: string; fields: string[] }> = [
    {
      file: 'EdgeRumService.d.ts',
      fields: ['ɵfac', 'ɵprov'],
    },
    {
      file: 'ErrorCapture.d.ts',
      fields: ['ɵfac', 'ɵprov'],
    },
    {
      file: 'RouterCapture.d.ts',
      fields: ['ɵfac', 'ɵprov'],
    },
    {
      file: 'IonicLifecycleCapture.d.ts',
      fields: ['ɵfac', 'ɵprov'],
    },
    {
      file: 'EdgeRumModule.d.ts',
      fields: ['ɵfac', 'ɵmod', 'ɵinj'],
    },
  ];

  for (const { file, fields } of DTS_FILES) {
    describe(file, () => {
      let content: string;

      beforeAll(() => {
        content = readFileSync(join(ANGULAR_DIST, file), 'utf-8');
      });

      for (const field of fields) {
        it(`declares static ${field}`, () => {
          expect(content).toContain(`static ${field}`);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Public API surface — no OTel leaks in .d.ts
// ---------------------------------------------------------------------------
describe.skipIf(!hasDist)('Public API surface in .d.ts files', () => {
  const BANNED_TERMS = [
    'TracerProvider',
    'SpanProcessor',
    'MeterProvider',
    'LoggerProvider',
    'opentelemetry',
    'otlp',
    'spanId',
    'traceId',
    'resourceSpans',
  ];

  it('index.d.ts exports all expected public symbols', () => {
    const content = readFileSync(join(ANGULAR_DIST, 'index.d.ts'), 'utf-8');

    const expectedExports = [
      'EdgeRumService',
      'EdgeRumModule',
      'provideEdgeRum',
      'EDGE_RUM_CONFIG',
      'edgeRumInitializerFactory',
      'RouterCapture',
      'EdgeRumErrorCapture',
      'ERROR_ROUTE_PROVIDER',
      'IonicLifecycleCapture',
      'LIFECYCLE_EVENT_SOURCE',
    ];

    for (const symbol of expectedExports) {
      expect(content).toContain(symbol);
    }
  });

  it('no .d.ts file contains banned OTel terminology', () => {
    const dtsFiles = readdirSync(ANGULAR_DIST).filter((f) => f.endsWith('.d.ts'));

    for (const file of dtsFiles) {
      const content = readFileSync(join(ANGULAR_DIST, file), 'utf-8');
      for (const term of BANNED_TERMS) {
        expect(content, `${file} contains banned term "${term}"`).not.toContain(term);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FESM bundle — no OTel leaks in runtime code
// ---------------------------------------------------------------------------
describe.skipIf(!hasDist)('FESM bundle terminology compliance', () => {
  let bundleContent: string;

  beforeAll(() => {
    bundleContent = readFileSync(FESM_BUNDLE, 'utf-8');
  });

  it('does not contain banned OTel identifiers in the FESM bundle', () => {
    const banned = [
      'TracerProvider',
      'SpanProcessor',
      'MeterProvider',
      'LoggerProvider',
      'resourceSpans',
      'instrumentationScope',
    ];
    for (const term of banned) {
      expect(bundleContent, `FESM bundle contains "${term}"`).not.toContain(term);
    }
  });
});

// ---------------------------------------------------------------------------
// dist/package.json — generated manifest correctness
// ---------------------------------------------------------------------------
describe.skipIf(!hasDist)('dist/package.json manifest', () => {
  let distPkg: Record<string, unknown>;

  beforeAll(() => {
    distPkg = JSON.parse(readFileSync(join(ANGULAR_DIST, 'package.json'), 'utf-8'));
  });

  it('has name @nathanclaire/rum-angular', () => {
    expect(distPkg.name).toBe('@nathanclaire/rum-angular');
  });

  it('has sideEffects: false', () => {
    expect(distPkg.sideEffects).toBe(false);
  });

  it('has peerDependencies for Angular core, common, and router', () => {
    const peers = distPkg.peerDependencies as Record<string, string>;
    expect(peers['@angular/core']).toBeDefined();
    expect(peers['@angular/common']).toBeDefined();
    expect(peers['@angular/router']).toBeDefined();
  });

  it('has @nathanclaire/rum as a peer dependency', () => {
    const peers = distPkg.peerDependencies as Record<string, string>;
    expect(peers['@nathanclaire/rum']).toBeDefined();
  });

  it('does NOT include devDependencies (stripped by ng-packagr)', () => {
    expect(distPkg.devDependencies).toBeUndefined();
  });

  it('does NOT include scripts (stripped by ng-packagr)', () => {
    expect(distPkg.scripts).toBeUndefined();
  });

  it('has exports with types condition', () => {
    const exports = distPkg.exports as Record<string, Record<string, string>>;
    expect(exports).toBeDefined();
    expect(exports['.']).toBeDefined();
    expect(exports['.'].types).toBeDefined();
  });
});

// We need beforeAll imported for the describe blocks above
import { beforeAll } from 'vitest';
