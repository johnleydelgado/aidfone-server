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
});

export { app };
