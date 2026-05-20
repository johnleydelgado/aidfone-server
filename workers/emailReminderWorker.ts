import { supabaseAdmin } from '../lib/clients';
import { sendTrialReminderEmail } from '../services/emailService';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 25;

let intervalHandle: NodeJS.Timeout | null = null;
let isRunning = false;

interface EmailReminderRow {
  id: string;
  reminder_type: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  attempts: number;
}

async function processDueReminders(): Promise<void> {
  // Re-entrancy guard — if a previous tick is still running (e.g. Resend is slow),
  // skip this tick rather than stacking parallel sends.
  if (isRunning) {
    console.log('[EmailWorker] Previous tick still running, skipping');
    return;
  }
  isRunning = true;

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('email_reminders')
      .select('id, reminder_type, stripe_customer_id, stripe_subscription_id, attempts')
      .is('sent_at', null)
      .lte('send_at', new Date().toISOString())
      .lt('attempts', MAX_ATTEMPTS)
      .order('send_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      console.error('[EmailWorker] Failed to fetch due reminders:', error);
      return;
    }

    if (!rows || rows.length === 0) return;

    console.log(`[EmailWorker] Processing ${rows.length} due reminder(s)`);

    for (const row of rows as EmailReminderRow[]) {
      await processOne(row);
    }
  } finally {
    isRunning = false;
  }
}

async function processOne(row: EmailReminderRow): Promise<void> {
  try {
    if (row.reminder_type.startsWith('trial_reminder_')) {
      await sendTrialReminderEmail(row.stripe_customer_id);
    } else {
      throw new Error(`Unknown reminder_type: ${row.reminder_type}`);
    }

    const { error: updateError } = await supabaseAdmin
      .from('email_reminders')
      .update({
        sent_at: new Date().toISOString(),
        attempts: row.attempts + 1,
        last_attempt_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    if (updateError) {
      console.error(`[EmailWorker] Sent reminder ${row.id} but failed to mark sent:`, updateError);
      return;
    }

    console.log(`[EmailWorker] Sent ${row.reminder_type} for customer ${row.stripe_customer_id}`);
  } catch (sendError) {
    const message = sendError instanceof Error ? sendError.message : String(sendError);
    console.error(`[EmailWorker] Failed to send reminder ${row.id} (attempt ${row.attempts + 1}):`, message);

    await supabaseAdmin
      .from('email_reminders')
      .update({
        attempts: row.attempts + 1,
        last_error: message.slice(0, 500),
        last_attempt_at: new Date().toISOString(),
      })
      .eq('id', row.id);
  }
}

export function startEmailReminderWorker(): void {
  if (intervalHandle) {
    console.warn('[EmailWorker] Already started');
    return;
  }

  // Run once on boot to catch any reminders that came due while the server was down,
  // then on a 5-minute interval.
  processDueReminders().catch((err) => {
    console.error('[EmailWorker] Initial tick crashed:', err);
  });

  intervalHandle = setInterval(() => {
    processDueReminders().catch((err) => {
      console.error('[EmailWorker] Tick crashed:', err);
    });
  }, POLL_INTERVAL_MS);

  console.log(`[EmailWorker] Started — polling every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopEmailReminderWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[EmailWorker] Stopped');
  }
}

// Exported for unit testing
export const __test = { processDueReminders, processOne };
