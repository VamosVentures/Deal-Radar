import { createApp } from './app';
import { startScheduler } from './services/schedule';
import { env, modes } from './env';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`Vamos Deal Radar API listening on :${env.PORT}`);
  console.log(
    `Modes → HubSpot: ${modes.hubspot()} · Outlook: ${modes.outlook()} · AI: ${modes.ai()}`,
  );
  if (modes.hubspot() === 'mock' && modes.outlook() === 'mock') {
    console.log('Demo Mode: all external actions are simulated locally. See .env.example to go live.');
  }
});

startScheduler(); // no-op unless RUN_SCHEDULER=true
