import { Component, NgZone, inject, type OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';

import { DemoScenarios, isScenario } from './scenarios';

declare global {
  interface Window { runScenario?: (name: string) => void }
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [IonApp, IonRouterOutlet],
  template: '<ion-app><ion-router-outlet></ion-router-outlet></ion-app>',
})
export class AppComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);

  ngOnInit(): void {
    // Deep links: native evals runScenario; `listen` hands over one that arrived before the app was up.
    window.runScenario = (name) => {
      if (isScenario(name)) this.zone.run(() => void this.router.navigateByUrl('/' + name));
    };
    DemoScenarios.listen().then((r) => r.scenario && window.runScenario?.(r.scenario), () => undefined);
  }
}
