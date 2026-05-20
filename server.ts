import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

// Initialize shared clients (side-effect: sets up Firebase, Supabase, Stripe)
import './lib/clients';

// Route modules
import { registerStripeWebhook, registerStripeRoutes, ensureStripeProduct } from './routes/stripe';
import { registerChatRoutes } from './routes/chat';
import { registerDeviceRoutes } from './routes/devices';
import { registerFallDetectionRoutes } from './routes/fallDetection';
import { registerVoiceRoutes } from './routes/voice';
import { startEmailReminderWorker } from './workers/emailReminderWorker';

const app = express();
const PORT = parseInt(process.env.PORT || '5001', 10);

// Stripe webhook MUST be registered BEFORE bodyParser.json() (needs raw body)
registerStripeWebhook(app);

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Routes
registerChatRoutes(app);
registerDeviceRoutes(app);
registerFallDetectionRoutes(app);
registerVoiceRoutes(app);
registerStripeRoutes(app);

// Start server
app.listen(PORT, async (): Promise<void> => {
  console.log(`\nAidFone Config Server running on port ${PORT}`);
  console.log(`   REST API:    http://localhost:${PORT}/api/`);
  console.log(`   Firebase DB: https://aidfone-e6a5c-default-rtdb.firebaseio.com\n`);

  // Ensure Stripe product exists (non-blocking)
  try {
    await ensureStripeProduct();
  } catch (err) {
    console.error('[Stripe] Failed to verify/create product:', err);
  }

  // The email worker writes to email_reminders, which has RLS `USING (false)`.
  // Without the service-role key, supabaseAdmin silently falls back to the anon
  // client (see lib/clients.ts) and every write would be rejected, dropping
  // 30-day trial reminders into the void. Refuse to start in that state.
  if (process.env.NODE_ENV === 'production' && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      '[EmailWorker] REFUSING TO START — SUPABASE_SERVICE_ROLE_KEY is missing in production. ' +
      'Trial reminders will not be scheduled. Set the env var on Render and redeploy.'
    );
  } else {
    startEmailReminderWorker();
  }
});

export { app };
