import { Resend } from 'resend';
import Stripe from 'stripe';
import * as fs from 'fs';
import * as path from 'path';

const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

function renderTemplate(templatePath: string, vars: Record<string, string>): string {
  let html = fs.readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return html;
}

export async function sendTrialReminderEmail(customerId: string, testEmail?: string): Promise<void> {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return;

  const email = customer.email;
  if (!email) return;

  const name = customer.metadata.caregiver_first_name || 'there';
  const seniorName = customer.metadata.senior_name || 'your loved one';
  const language = customer.metadata.language || 'en';
  const dashboardUrl = process.env.FRONTEND_URL
    ? `${process.env.FRONTEND_URL}/dashboard`
    : 'https://aidfone.com/dashboard';

  // Get active trialing subscription
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'trialing',
  });
  const subscription = subscriptions.data[0];
  if (!subscription?.trial_end) return;

  // Format dates
  const trialEndDate = new Date(subscription.trial_end * 1000);
  const locale = language === 'fr' ? 'fr-CA' : 'en-CA';
  const formattedDate = trialEndDate.toLocaleDateString(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Load and render template
  const templateFile = language === 'fr'
    ? 'trial-ending-reminder-FR.html'
    : 'trial-ending-reminder-EN.html';
  const templatePath = path.join(__dirname, '..', 'emails', templateFile);

  const html = renderTemplate(templatePath, {
    CAREGIVER_FIRST_NAME: name,
    TRIAL_END_DATE: formattedDate,
    CHARGE_DATE: formattedDate,
    SENIOR_NAME: seniorName,
    DASHBOARD_URL: dashboardUrl,
    SIGNUP_EMAIL: email,
  });

  const subject = language === 'fr'
    ? 'Votre essai AidFone se termine dans 7 jours'
    : 'Your AidFone trial ends in 7 days';

  const recipient = testEmail || email;
  const result = await resend.emails.send({
    from: 'AidFone <support@aidfone.com>',
    to: recipient,
    subject,
    html,
  });

  console.log(`[Email] Trial reminder result:`, JSON.stringify(result));
  console.log(`[Email] Trial reminder sent to ${email} (${language})`);
}
