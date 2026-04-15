import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import type { Metric } from 'web-vitals';

export type VitalsEventAttributes = {
  'performance.metric_name': 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
  'performance.value': number;
  'performance.unit': 'ms' | 'score';
  'performance.rating': 'good' | 'needs-improvement' | 'poor';
  'performance.screen': string;
};

export interface VitalsDeps {
  recordEvent: (eventName: 'performance', attributes: VitalsEventAttributes) => void;
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
        deps.recordEvent('performance', {
          'performance.metric_name': metric.name as VitalsEventAttributes['performance.metric_name'],
          'performance.value': metric.value,
          'performance.unit': unitFor(metric.name),
          'performance.rating': metric.rating,
          'performance.screen': deps.getCurrentRoute(),
        });
      } catch {
        // Never let capture errors escape into consumer code.
      }
    });
  }
}
