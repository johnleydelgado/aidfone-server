import * as admin from 'firebase-admin';
import * as fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// ============================================================================
// Firebase Admin
// ============================================================================

let serviceAccount: admin.ServiceAccount;
if (process.env.FIREBASE_ADMIN_SDK) {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK) as admin.ServiceAccount;
} else {
  const keyPath = `${__dirname}/../firebase-adminsdk.json`;
  serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as admin.ServiceAccount;
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://aidfone-e6a5c-default-rtdb.firebaseio.com',
});

export const db = admin.database();

// ============================================================================
// Supabase
// ============================================================================

const supabaseUrl = process.env.SUPABASE_URL || 'https://tutgzciyrhztfnotudby.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1dGd6Y2l5cmh6dGZub3R1ZGJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5ODU0MDMsImV4cCI6MjA4NTU2MTQwM30.Zyp6AIuS_3cl2617LIvtq9DdyIJUCOOTuQSiyOti-XQ';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export const supabaseAdmin = supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey)
  : supabase;

// ============================================================================
// Stripe
// ============================================================================

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[Stripe] STRIPE_SECRET_KEY not set — Stripe endpoints will not work');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_not_configured', {
  apiVersion: '2025-02-24.acacia' as Stripe.LatestApiVersion,
});

// Mutable — set by ensureStripeProduct() in stripe routes
export let protectionPriceId = process.env.STRIPE_PRICE_ID_PROTECTION || '';
export function setProtectionPriceId(id: string): void {
  protectionPriceId = id;
}
