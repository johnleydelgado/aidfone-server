import express, { Application, Request, Response } from 'express';
import Stripe from 'stripe';
import { stripe, supabaseAdmin, protectionPriceId, setProtectionPriceId } from '../lib/clients';
import { sendTrialReminderEmail, sendWelcomeEmail } from '../services/emailService';

// ============================================================================
// Ensure Stripe Product + Price Exist
// ============================================================================

export async function ensureStripeProduct(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_not_configured') return;

  // If a price ID is configured, verify it exists
  if (protectionPriceId) {
    try {
      await stripe.prices.retrieve(protectionPriceId);
      console.log(`[Stripe] Protection price verified: ${protectionPriceId}`);
      return;
    } catch {
      console.warn(`[Stripe] Configured price ${protectionPriceId} not found — will create new one`);
    }
  }

  // Check if product already exists by metadata lookup
  const existingProducts = await stripe.products.list({ limit: 100 });
  let product = existingProducts.data.find(p => p.metadata.aidfone_plan === 'protection');

  if (!product) {
    product = await stripe.products.create({
      name: 'AidFone Protection Plan',
      description: 'Simple, safe smartphone for seniors — $10.99 CAD/month with 30-day free trial.',
      metadata: { aidfone_plan: 'protection' },
    });
    console.log(`[Stripe] Created product: ${product.id}`);
  }

  // Check if an active monthly CAD price exists for this product
  const existingPrices = await stripe.prices.list({ product: product.id, active: true, limit: 10 });
  let price = existingPrices.data.find(p => p.currency === 'cad' && p.recurring?.interval === 'month' && p.unit_amount === 1099);

  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1099, // $10.99 CAD
      currency: 'cad',
      recurring: { interval: 'month' },
    });
    console.log(`[Stripe] Created price: ${price.id}`);
  }

  setProtectionPriceId(price.id);
  console.log(`[Stripe] Protection price ready: ${price.id}`);
}

// ============================================================================
// Stripe Webhook — MUST be registered BEFORE bodyParser.json()
// ============================================================================

export function registerStripeWebhook(app: Application): void {
  app.post('/api/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response): Promise<void> => {
      const sig = req.headers['stripe-signature'] as string;
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

      let event: Stripe.Event;

      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        console.error('[Stripe] Webhook signature verification failed:', err);
        res.status(400).send('Webhook Error');
        return;
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const seniorId = session.metadata?.seniorId;
          if (seniorId) {
            // Keep status as 'trial' since checkout includes a 30-day trial.
            // Status changes to 'active' when Stripe sends customer.subscription.updated after trial ends.
            const { error: dbError } = await supabaseAdmin
              .from('subscriptions')
              .update({
                stripe_customer_id: session.customer as string,
                stripe_subscription_id: session.subscription as string,
              })
              .eq('senior_id', seniorId);
            if (dbError) {
              console.error(`[Stripe] Failed to activate subscription for senior ${seniorId}:`, dbError);
              res.status(500).json({ error: 'DB update failed' });
              return;
            }
            console.log(`[Stripe] Subscription activated for senior ${seniorId}`);

            // Send welcome email with activation code + QR code
            try {
              await sendWelcomeEmail(session.customer as string, seniorId);
            } catch (emailError) {
              // Don't fail the webhook if email fails — subscription is already active
              console.error('[Email] Failed to send welcome email:', emailError);
            }
          }
          break;
        }
        case 'customer.subscription.created': {
          const createdSubscription = event.data.object as Stripe.Subscription;
          if (createdSubscription.status === 'trialing' && createdSubscription.trial_end) {
            const now = Math.floor(Date.now() / 1000);
            const sendAt = createdSubscription.trial_end - (7 * 24 * 60 * 60); // 7 days before trial end
            const delayMs = Math.max(0, (sendAt - now) * 1000);

            console.log(`[Stripe] Trial subscription created. Scheduling reminder email in ${Math.round(delayMs / 1000 / 3600)} hours`);

            const customerId = typeof createdSubscription.customer === 'string'
              ? createdSubscription.customer
              : createdSubscription.customer.id;

            // MVP: setTimeout — lost on server restart. Future: use Supabase-backed scheduler.
            setTimeout(async () => {
              try {
                await sendTrialReminderEmail(customerId);
              } catch (error) {
                console.error('[Email] Failed to send trial reminder:', error);
              }
            }, delayMs);
          }
          break;
        }
        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          // Look up by stripe_subscription_id for reliability
          const { error: dbError } = await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'cancelled' })
            .eq('stripe_subscription_id', subscription.id);
          if (dbError) {
            console.error(`[Stripe] Failed to cancel subscription ${subscription.id}:`, dbError);
            res.status(500).json({ error: 'DB update failed' });
            return;
          }
          console.log(`[Stripe] Subscription cancelled: ${subscription.id}`);
          break;
        }
      }

      res.json({ received: true });
    }
  );
}

// ============================================================================
// Stripe Checkout + Test Endpoints
// ============================================================================

export function registerStripeRoutes(app: Application): void {
  // Create checkout session
  app.post('/api/checkout/create-session', async (req: Request, res: Response): Promise<void> => {
    try {
      const { seniorId, planTier, caregiverEmail, caregiverFirstName, seniorName, language } = req.body;

      if (!planTier || !caregiverEmail) {
        res.status(400).json({ error: 'Missing required fields: planTier, caregiverEmail' });
        return;
      }

      if (!protectionPriceId) {
        res.status(503).json({ error: 'Payment system not ready. Please try again in a moment.' });
        return;
      }

      // Create Stripe customer with metadata for trial reminder emails
      const customer = await stripe.customers.create({
        email: caregiverEmail,
        metadata: {
          caregiver_first_name: caregiverFirstName || '',
          senior_name: seniorName || '',
          language: language || 'en',
          ...(seniorId && { seniorId }),
        },
      });

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        customer: customer.id,
        line_items: [
          {
            price: protectionPriceId,
            quantity: 1,
          },
        ],
        subscription_data: {
          trial_period_days: 30,
          metadata: { ...(seniorId && { seniorId }), planTier },
        },
        success_url: `${process.env.FRONTEND_URL || 'https://aidfone.com'}/dashboard?checkout=success`,
        cancel_url: `${process.env.FRONTEND_URL || 'https://aidfone.com'}/dashboard?checkout=cancelled`,
        metadata: { ...(seniorId && { seniorId }), planTier },
      });

      console.log(`[Stripe] Checkout session created for senior ${seniorId}`);
      res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
      console.error('[Stripe] Checkout error:', error);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  // Dev-only test endpoints — not registered in production
  if (process.env.NODE_ENV === 'production') return;

  app.post('/api/test/trial-reminder', async (req: Request, res: Response): Promise<void> => {
    try {
      const { customerId, testEmail } = req.body;
      if (!customerId) {
        res.status(400).json({ error: 'Missing customerId' });
        return;
      }
      await sendTrialReminderEmail(customerId, testEmail);
      res.json({ success: true, message: 'Trial reminder email sent' });
    } catch (error) {
      console.error('[Test] Trial reminder error:', error);
      res.status(500).json({ error: 'Failed to send trial reminder' });
    }
  });

  // Dev only — test welcome activation email
  app.post('/api/test/welcome-email', async (req: Request, res: Response): Promise<void> => {
    try {
      const { customerId, seniorId } = req.body;
      if (!customerId || !seniorId) {
        res.status(400).json({ error: 'Missing customerId or seniorId' });
        return;
      }
      await sendWelcomeEmail(customerId, seniorId);
      res.json({ success: true, message: 'Welcome email sent' });
    } catch (error) {
      console.error('[Test] Welcome email error:', error);
      res.status(500).json({ error: 'Failed to send welcome email' });
    }
  });
}
