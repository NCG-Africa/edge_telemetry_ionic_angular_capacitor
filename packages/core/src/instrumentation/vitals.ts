import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import type { Metric } from 'web-vitals';
import { healthMonitor } from '../internal/health';

export type VitalsMetricAttributes = {
  'metric.unit': 'ms' | 'score';
  'metric.rating': 'good' | 'needs-improvement' | 'poor';
  'metric.screen': string;
};

export interface VitalsDeps {
  recordMetric: (metricName: string, value: number, attributes: VitalsMetricAttributes) => void;
  getCurrentRoute: () => string;
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
        deps.recordMetric(metric.name, metric.value, {
          'metric.unit': unitFor(metric.name),
          'metric.rating': metric.rating,
          'metric.screen': deps.getCurrentRoute(),
        });
      } catch (err) {
        healthMonitor.reportError('vitals.recordMetric', err);
      }
    });
  }
}
