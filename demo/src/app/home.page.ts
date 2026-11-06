import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonButton, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';

import { SCENARIOS } from './scenarios';

@Component({
  standalone: true,
  imports: [RouterLink, IonButton, IonContent, IonHeader, IonTitle, IonToolbar],
  template: `
    <ion-header><ion-toolbar><ion-title>Edge RUM demo</ion-title></ion-toolbar></ion-header>
    <ion-content class="ion-padding">
      @for (s of scenarios; track s) {
        <ion-button expand="block" [id]="s" [routerLink]="'/' + s">{{ s }}</ion-button>
      }
    </ion-content>
  `,
})
export class HomePage {
  readonly scenarios = SCENARIOS;
}
