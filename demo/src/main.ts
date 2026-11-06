import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { ionicUi, provideEdgeRum } from '@nathanclaire/rum-angular';
import { defaultCaptures } from '@nathanclaire/rum-capacitor';

import { AppComponent } from './app/app.component';
import { routes } from './app/routes';

bootstrapApplication(AppComponent, {
  providers: [
    provideIonicAngular(),
    provideRouter(routes),
    provideHttpClient(), // XHR backend: the spec Q3 `HttpClient` check
    provideEdgeRum({
      captures: [...defaultCaptures(), ionicUi()],
      // X4: the app's own origin (https://localhost, capacitor://localhost), where ping.json lives.
      traceHostAllowlist: ['localhost'],
      release: 'demo',
      debug: true,
    }),
  ],
}).catch((e) => console.error(e));
