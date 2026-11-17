import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import type { Metric } from 'web-vitals';
import { healthMonitor } from '../internal/health';

export type VitalsMetricAttributes = {
  'metric.unit': 'ms' | 'score';
  'metric.rating': 'good' | 'needs-improvement' | 'poor';
  'screen.name': string;
};

export interface VitalsDeps {
  recordMetric: (metricName: string, value: number, attributes: VitalsMetricAttributes) => void;
  getCurrentRoute: () => string;
  /** Hand off now: LCP / CLS / INP are final as the page hides, after core's own hidden hand-off. */
  flush?: () => void;
}

type Subscriber = (cb: (metric: Metric) => void) => void;

const SUBSCRIBERS: Subscriber[] = [onLCP, onINP, onCLS, onFCP, onTTFB];

function unitFor(metricName: Metric['name']): 'ms' | 'score' {
  return metricName === 'CLS' ? 'score' : 'ms';
}

export function registerVitalsCapture(deps: VitalsDeps): void {
  for (const subscribe of SUBSCRIBERS) {
    subscribe((metric) => {
      try {
        // #149: catalogue names (`perf.lcp`, ...); the processor reads the old upper-case ones as aliases.
        deps.recordMetric(`perf.${metric.name.toLowerCase()}`, metric.value, {
          'metric.unit': unitFor(metric.name),
          'metric.rating': metric.rating,
          'screen.name': deps.getCurrentRoute(),
        });
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') deps.flush?.();
      } catch (err) {
        healthMonitor.reportError('vitals.recordMetric', err);
      }
    });
  }
}
