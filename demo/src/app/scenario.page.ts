import { HttpClient } from '@angular/common/http';
import { Component, inject, type OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { EdgeRumService } from '@nathanclaire/rum-angular';
import { firstValueFrom } from 'rxjs';

import { DemoScenarios, later, type Scenario } from './scenarios';

/** Runs its route's scenario on entry (button or deep link). */
@Component({
  standalone: true,
  imports: [IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar],
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/"></ion-back-button></ion-buttons>
        <ion-title>{{ name }}</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <p id="status">{{ status }}</p>
      @if (name === 'rage-tap') {
        <ion-button id="dead">Does nothing</ion-button>
      }
    </ion-content>
  `,
})
export class ScenarioPage implements OnInit {
  readonly name = inject(ActivatedRoute).snapshot.routeConfig?.path as Scenario;
  status = 'running';
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly rum = inject(EdgeRumService);

  private readonly scenarios: Record<Scenario, () => unknown> = {
    // Q3 gate: navigation (this route, with phase keys), an HttpClient XHR to an allowlisted host
    // (traceparent), a timed plugin call; going home closes the screen's window → bridge.summary.
    happy: async () => {
      await firstValueFrom(this.http.get('ping.json'));
      await DemoScenarios.slow({ ms: 0 });
      await this.router.navigateByUrl('/');
    },
    'js-error': () => setTimeout(() => {
      throw new Error('Demo unhandled error');
    }),
    'native-crash': () => DemoScenarios.crash(),
    'renderer-kill': () => DemoScenarios.killRenderer(),
    // ≥ 5 s main-thread block: app.anr on Android, app.hang on both.
    hang: () => DemoScenarios.hang({ ms: 6000 }),
    'slow-bridge': () => DemoScenarios.slow({ ms: 1500 }),
    // Turn on airplane mode first: these queue in the outbox and replay once back online.
    offline: () => {
      for (let i = 0; i < 30; i++) this.rum.track('offline.burst', { n: i, online: navigator.onLine });
    },
    // Three taps < 1 s on a button that does nothing: ui.rage + ui.dead. Waits out the page
    // transition first, and the 1 s dead window after, so neither counts as the taps' DOM change.
    'rage-tap': async () => {
      await later(800);
      for (let i = 0; i < 3; i++) document.getElementById('dead')?.click();
      await later(1500);
    },
    'mark-ready': () => this.rum.markReady(),
    task: () => {
      this.rum.startTask('checkout');
      void later(500).then(() => this.rum.completeTask('checkout'));
    },
    // 600 > the 500 custom-event cap: 100 drops reported as sdk.health cap.custom.
    caps: () => {
      for (let i = 0; i < 600; i++) this.rum.track('caps.burst', { n: i });
    },
  };

  async ngOnInit(): Promise<void> {
    try {
      await this.scenarios[this.name]();
      this.status = 'ran ' + this.name;
    } catch (e) {
      this.status = `${this.name} failed: ${String(e)}`;
    }
  }
}
