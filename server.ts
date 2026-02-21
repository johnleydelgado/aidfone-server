// Simple Express server for AidFone configuration API
// This server handles configuration sync between web platform and Android app
// Real-time events (fall alerts, distress alerts, config sync) go through Firebase Realtime Database

import * as dotenv from 'dotenv';
dotenv.config();  // Load server/.env (ANTHROPIC_API_KEY etc.)

import express, { Request, Response, Application } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import * as admin from 'firebase-admin';
import serviceAccount from './firebase-adminsdk.json';

// ============================================================================
// Firebase Admin Setup
// ============================================================================

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
  databaseURL: 'https://aidfone-e6a5c-default-rtdb.firebaseio.com',
});

const db = admin.database();

// ============================================================================
// Supabase Client Setup
// ============================================================================

const supabaseUrl = process.env.SUPABASE_URL || 'https://tutgzciyrhztfnotudby.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1dGd6Y2l5cmh6dGZub3R1ZGJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5ODU0MDMsImV4cCI6MjA4NTU2MTQwM30.Zyp6AIuS_3cl2617LIvtq9DdyIJUCOOTuQSiyOti-XQ';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ============================================================================
// Type Definitions
// ============================================================================

interface DeviceConfig {
  version?: string;
  profileType?: string;
  templateId?: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

interface DeviceSummary {
  deviceId: string;
  profileType?: string;
  templateId?: string;
  lastUpdated?: string;
}

interface HealthCheckResponse {
  status: string;
  timestamp: string;
}

interface DeployConfigResponse {
  success: boolean;
  message: string;
  deviceId: string;
  configVersion?: string;
}

interface ErrorResponse {
  error: string;
  deviceId?: string;
}

interface DeviceRegistrationBody {
  deviceId: string;
  fcmToken?: string;
  platform?: string;
}

interface DeviceRegistrationResponse {
  success: boolean;
  message: string;
  deviceId: string;
}

// ============================================================================
// Activation Types (for QR code activation flow)
// ============================================================================

interface ActivationContact {
  name: string;
  phone: string;
  relationship: string | null;
  photoUrl: string | null;
  isEmergency: boolean;
  aliases: string[];
}

interface ActivationSenior {
  id: string;
  name: string;
}

interface ActivationSubscription {
  planTier: string;
  status: string;
}

interface ActivationResponse {
  success: boolean;
  templateId: string;
  senior: ActivationSenior;
  contacts: ActivationContact[];
  subscription: ActivationSubscription;
}

// ============================================================================
// Server Setup
// ============================================================================

const app: Application = express();
const PORT: number = parseInt(process.env.PORT || '5001', 10);

app.use(cors());
app.use(bodyParser.json());

// ============================================================================
// Sophie Chatbot System Prompt
// ============================================================================

const SOPHIE_SYSTEM_PROMPT = `You are Sophie, AidFone's friendly Care Assistant. You're warm, empathetic, and knowledgeable — like a helpful nurse friend who happens to know everything about AidFone. Your job is to answer questions from visitors (primarily adult children caring for aging parents) and guide them toward trying AidFone.

## Your Personality
- Warm and genuinely caring (you understand caregiving is hard)
- Direct and helpful (don't waste their time)
- Knowledgeable but not pushy
- Speak naturally, like a supportive friend — not a robot
- Use "I" and speak as Sophie, not "we" or "AidFone"
- Encourage them to try the free trial, but don't be salesy
- If you don't know something, say so honestly
- Match their language (if they write in French, respond in French; if in Spanish, respond in Spanish)

## About AidFone
AidFone is a smartphone accessibility APP that transforms any Android phone into a complete care system for seniors and people with disabilities. It was founded by Normand Lapointe, a registered nurse with 10 years of geriatric care experience (in-home care, nursing homes, and memory care units), who built it originally for his own 93-year-old mother Céline.

## KEY POINT: AidFone is an APP with THREE PILLARS
It installs on their EXISTING Android phone. No new phone required.

**1. 📞 COMMUNICATION**
- Big buttons, simplified interface
- Voice control: "Call my daughter" just works
- Photo-based contacts (tap their face to call)
- One-tap calling

**2. 🛡️ PROTECTION**
- Emergency SOS button (always visible)
- Location sharing for caregivers
- Locked settings (they can't accidentally change things)
- Fall Detection pendant coming soon (AidFone Guardian™ - buy once, no monthly fees with Plus & Complete plans)

**3. 💊 CARE**
- Medication reminders
- Activity dashboard for caregivers
- Remote configuration from caregiver's phone

## Pricing:
- Essential Plan: $8.99/month
- Plus Plan: $10.99/month
- Complete Plan: $14.99/month
- 14-day FREE trial, no credit card required
- Cancel anytime

## Coming Soon: AidFone Guardian™
A wearable fall detection pendant with:
- Automatic fall detection with instant alerts
- One-touch SOS panic button
- **Buy once. No monthly fees** on Plus & Complete plans (unlike competitors who charge $25-45/month)
- Fully integrated with the caregiver dashboard
People can join the waitlist on the website.

## Key Differentiator: $0 Device Cost
Unlike competitors who require buying proprietary hardware:
- RAZ Memory Phone: $309+ device
- GrandPad: $299 tablet
- Lively (Jitterbug): $80+ device
- AidFone: $0 - just an app on their existing phone

## Technical Requirements:
- Works on any Android phone version 8.0 or later
- Uses their existing phone and phone plan
- Download from Google Play Store
- Setup takes about 2 minutes

## Who It's For:
- Seniors who struggle with smartphone complexity
- People with memory challenges (including Alzheimer's)
- People with physical limitations (vision, motor control)
- People with intellectual disabilities
- Anyone who finds modern smartphones overwhelming

## The Founder's Story:
Normand's 93-year-old mother could still drive and manage online banking, but couldn't figure out smartphones. He tried every senior phone and launcher app on the market. Nothing worked. So he built AidFone.

## Response Guidelines:
- Keep responses concise (2-4 sentences for simple questions)
- Use bullet points sparingly
- If they seem ready to try, mention the free trial
- If they ask about iPhone, apologize and say Android only for now
- ALWAYS clarify that AidFone is an APP with three pillars if there's any confusion
- Mention AidFone Guardian™ (fall detection) when relevant - it's coming soon and it's a competitive advantage`;

// ============================================================================
// Chat Types
// ============================================================================

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
  language?: 'en' | 'es' | 'fr';
}

// ============================================================================
// REST API Endpoints
// ============================================================================

// Health check
app.get('/api/health', (_req: Request, res: Response<HealthCheckResponse>): void => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Client Info Endpoint
interface ClientInfoResponse {
  ip: string;
  userAgent: string;
  referrer: string | null;
}

app.get('/api/client-info', (req: Request, res: Response<ClientInfoResponse>): void => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = typeof forwardedFor === 'string'
    ? forwardedFor.split(',')[0].trim()
    : req.socket.remoteAddress || 'unknown';

  res.json({
    ip,
    userAgent: req.headers['user-agent'] || 'unknown',
    referrer: (req.headers['referer'] as string) || null,
  });
});

// Sophie Chatbot Streaming Proxy Endpoint (Server-Sent Events)
app.post(
  '/api/chat/sophie',
  async (req: Request<object, unknown, ChatRequestBody>, res: Response): Promise<void> => {
    const { messages, language = 'en' } = req.body;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not configured');
      res.status(500).json({ success: false, error: 'Chat service not configured' });
      return;
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ success: false, error: 'Messages array is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    try {
      let systemPrompt = SOPHIE_SYSTEM_PROMPT;
      if (language === 'es') {
        systemPrompt += '\n\nIMPORTANT: The user has selected Spanish. Respond in Spanish (Latin American Spanish).';
      } else if (language === 'fr') {
        systemPrompt += '\n\nIMPORTANT: The user has selected French. Respond in French (Canadian French).';
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          stream: true,
          system: systemPrompt,
          messages: messages
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        console.error('Anthropic API error:', response.status, errorData);
        res.write(`data: ${JSON.stringify({ error: 'Failed to get response from AI' })}\n\n`);
        res.end();
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        res.write(`data: ${JSON.stringify({ error: 'No response body' })}\n\n`);
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
              }
              if (parsed.type === 'message_stop') {
                res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
              }
            } catch {
              // Skip non-JSON lines
            }
          }
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();

    } catch (err) {
      console.error('Chat proxy error:', err);
      res.write(`data: ${JSON.stringify({ error: 'Server error processing chat request' })}\n\n`);
      res.end();
    }
  }
);

// Deploy configuration to device (writes to Firebase so Android picks it up)
app.post(
  '/api/devices/:deviceId/config',
  async (req: Request<{ deviceId: string }, DeployConfigResponse | ErrorResponse, DeviceConfig>, res: Response<DeployConfigResponse>): Promise<void> => {
    const { deviceId } = req.params;
    const config: DeviceConfig = req.body;

    console.log(`[${new Date().toISOString()}] POST /api/devices/${deviceId}/config`);

    const storedConfig = {
      ...config,
      lastUpdated: new Date().toISOString(),
      _updatedAt: Date.now(),
    };

    // Write to Firebase so Android device picks it up in real-time
    await db.ref(`devices/${deviceId}/config`).set(storedConfig);
    console.log(`Config written to Firebase: devices/${deviceId}/config`);

    res.json({
      success: true,
      message: 'Configuration deployed successfully',
      deviceId,
      configVersion: config.version,
    });
  }
);

// Get current device configuration (reads from Firebase)
app.get(
  '/api/devices/:deviceId/config',
  async (req: Request<{ deviceId: string }>, res: Response): Promise<void> => {
    const { deviceId } = req.params;
    const snapshot = await db.ref(`devices/${deviceId}/config`).once('value');

    if (!snapshot.exists()) {
      res.status(404).json({ error: 'Configuration not found for device', deviceId });
      return;
    }

    res.json(snapshot.val());
  }
);

// Register device for push notifications
app.post(
  '/api/devices/register',
  (req: Request<object, DeviceRegistrationResponse, DeviceRegistrationBody>, res: Response<DeviceRegistrationResponse>): void => {
    const { deviceId, fcmToken, platform } = req.body;
    console.log(`Registering device ${deviceId} (platform: ${platform || 'unknown'})`);
    void fcmToken;
    res.json({ success: true, message: 'Device registered successfully', deviceId });
  }
);

// List all configured devices (reads from Firebase)
app.get('/api/devices', async (_req: Request, res: Response<DeviceSummary[]>): Promise<void> => {
  const snapshot = await db.ref('devices').once('value');
  const devices: DeviceSummary[] = [];

  if (snapshot.exists()) {
    snapshot.forEach((child) => {
      const config = child.val()?.config;
      devices.push({
        deviceId: child.key!,
        profileType: config?.profileType,
        templateId: config?.templateId,
        lastUpdated: config?.lastUpdated,
      });
    });
  }

  res.json(devices);
});

// ============================================================================
// Fall Detection Notification Endpoint
// ============================================================================

interface FallDetectionNotification {
  seniorId: string;
  impactMagnitude: number;
  impactTime: string;
  deviceId: string;
  location?: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
  sensorData?: {
    x: number;
    y: number;
    z: number;
    svm: number;
  }[];
}

interface FallDetectionResponse {
  success: boolean;
  message: string;
  alertId?: string;
}

app.post(
  '/api/fall-detection/alert',
  async (req: Request<object, FallDetectionResponse | ErrorResponse, FallDetectionNotification>, res: Response<FallDetectionResponse | ErrorResponse>): Promise<void> => {
    const { seniorId, impactMagnitude, impactTime, deviceId, location, sensorData } = req.body;

    console.log(`[${new Date().toISOString()}] 🚨 FALL DETECTION ALERT for senior: ${seniorId}`);

    try {
      // 1. Get senior info
      const { data: senior, error: seniorError } = await supabase
        .from('seniors')
        .select('id, name, caregiver_id')
        .eq('id', seniorId)
        .single();

      if (seniorError || !senior) {
        res.status(404).json({ error: 'Senior not found' });
        return;
      }

      // 2. Insert fall event into Supabase
      const { data: fallEvent, error: insertError } = await supabase
        .from('fall_events')
        .insert({
          senior_id: seniorId,
          impact_magnitude: impactMagnitude,
          impact_time: impactTime,
          device_id: deviceId,
          location: location ? JSON.stringify(location) : null,
          sensor_data: sensorData ? JSON.stringify(sensorData) : null,
          status: 'pending',
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) {
        console.error('Failed to insert fall event:', insertError);
        res.status(500).json({ error: 'Failed to record fall event' });
        return;
      }

      // 3. Write to Firebase RTDB — dashboard listens and shows alert
      const alertId = fallEvent.id || `fall-${Date.now()}`;
      const notification = {
        alertId,
        seniorId,
        seniorName: senior.name,
        impactMagnitude,
        impactTime,
        location: location || null,
        timestamp: new Date().toISOString(),
        _createdAt: Date.now(),
      };

      await db.ref(`falls/${alertId}`).set(notification);
      console.log(`Fall alert written to Firebase: falls/${alertId}`);

      res.json({
        success: true,
        message: 'Fall detection alert received and caregiver notified',
        alertId,
      });

    } catch (err) {
      console.error('Fall detection error:', err);
      res.status(500).json({ error: 'Server error processing fall detection alert' });
    }
  }
);

// Acknowledge fall detection alert
app.post(
  '/api/fall-detection/:alertId/acknowledge',
  async (req: Request<{ alertId: string }>, res: Response): Promise<void> => {
    const { alertId } = req.params;
    console.log(`[${new Date().toISOString()}] Acknowledging fall alert: ${alertId}`);
    // Remove from Firebase so dashboard clears it
    await db.ref(`falls/${alertId}`).remove();
    res.json({ success: true, message: 'Alert acknowledged' });
  }
);

// Mark fall detection as false alarm
app.post(
  '/api/fall-detection/:alertId/false-alarm',
  async (req: Request<{ alertId: string }>, res: Response): Promise<void> => {
    const { alertId } = req.params;
    console.log(`[${new Date().toISOString()}] Marking as false alarm: ${alertId}`);
    await db.ref(`falls/${alertId}`).remove();
    res.json({ success: true, message: 'Marked as false alarm' });
  }
);

// Get fall detection history for a senior
app.get(
  '/api/seniors/:seniorId/fall-history',
  async (req: Request<{ seniorId: string }>, res: Response): Promise<void> => {
    const { seniorId } = req.params;
    try {
      const { data: events, error } = await supabase
        .from('fall_events')
        .select('*')
        .eq('senior_id', seniorId)
        .order('impact_time', { ascending: false })
        .limit(50);

      if (error) {
        res.status(500).json({ error: 'Failed to fetch fall history' });
        return;
      }
      res.json({ success: true, events: events || [] });
    } catch (err) {
      console.error('Fall history error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// TEST ENDPOINT — Trigger a test fall alert
app.post(
  '/api/fall-detection/test-alert',
  async (_req: Request, res: Response): Promise<void> => {
    console.log('[TEST] Broadcasting test fall alert to Firebase');

    const testAlert = {
      alertId: `test-${Date.now()}`,
      seniorId: 'test-senior',
      seniorName: 'Test Senior',
      impactMagnitude: 3.5,
      impactTime: new Date().toISOString(),
      location: {
        latitude: 45.5017,
        longitude: -73.5673,
        accuracy: 15,
      },
      timestamp: new Date().toISOString(),
      _createdAt: Date.now(),
    };

    await db.ref(`falls/${testAlert.alertId}`).set(testAlert);
    console.log('[TEST] Test alert written to Firebase:', testAlert.alertId);

    res.json({
      success: true,
      message: 'Test alert written to Firebase Realtime Database',
      alert: testAlert,
    });
  }
);

// ============================================================================
// Activation Endpoint (for QR code scanning on Android)
// ============================================================================

app.get(
  '/api/config/activate/:activationCode',
  async (req: Request<{ activationCode: string }>, res: Response<ActivationResponse | ErrorResponse>): Promise<void> => {
    const { activationCode } = req.params;
    const normalizedCode = activationCode.toUpperCase().trim();

    console.log(`[${new Date().toISOString()}] GET /api/config/activate/${normalizedCode}`);

    try {
      const { data: configuration, error: configError } = await supabase
        .from('configurations')
        .select('*')
        .eq('activation_code', normalizedCode)
        .single();

      if (configError || !configuration) {
        res.status(404).json({ error: 'Invalid activation code' });
        return;
      }

      const { data: senior, error: seniorError } = await supabase
        .from('seniors')
        .select('id, name')
        .eq('id', configuration.senior_id)
        .single();

      if (seniorError || !senior) {
        res.status(404).json({ error: 'Senior not found for this configuration' });
        return;
      }

      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan_tier, status')
        .eq('senior_id', configuration.senior_id)
        .single();

      const { data: contacts } = await supabase
        .from('senior_contacts')
        .select('name, phone, relationship, is_emergency, photo_url, aliases')
        .eq('senior_id', configuration.senior_id)
        .order('sort_order', { ascending: true });

      await supabase
        .from('configurations')
        .update({ activated_at: new Date().toISOString() })
        .eq('id', configuration.id);

      const response: ActivationResponse = {
        success: true,
        templateId: configuration.layout_id,
        senior: { id: senior.id, name: senior.name },
        contacts: (contacts || []).map((c: { name: string; phone: string; relationship?: string; photo_url?: string; is_emergency: boolean; aliases?: string[] }) => ({
          name: c.name,
          phone: c.phone,
          relationship: c.relationship || null,
          photoUrl: c.photo_url || null,
          isEmergency: c.is_emergency,
          aliases: c.aliases || [],
        })),
        subscription: {
          planTier: subscription?.plan_tier || 'essential',
          status: subscription?.status || 'trial',
        },
      };

      console.log(`Activation successful for senior: ${senior.name}`);
      res.json(response);

    } catch (err) {
      console.error('Activation error:', err);
      res.status(500).json({ error: 'Server error during activation' });
    }
  }
);

// ============================================================================
// Config Sync Endpoint (Dashboard → Android via Firebase)
// ============================================================================

interface ConfigSyncResponse {
  success: boolean;
  message: string;
  seniorId: string;
}

app.post(
  '/api/seniors/:seniorId/sync-config',
  async (req: Request<{ seniorId: string }>, res: Response<ConfigSyncResponse | ErrorResponse>): Promise<void> => {
    const { seniorId } = req.params;

    console.log(`[${new Date().toISOString()}] POST /api/seniors/${seniorId}/sync-config`);

    try {
      const { data: configuration, error: configError } = await supabase
        .from('configurations')
        .select('*')
        .eq('senior_id', seniorId)
        .single();

      if (configError || !configuration) {
        res.status(404).json({ error: 'Configuration not found for senior' });
        return;
      }

      const { data: senior } = await supabase
        .from('seniors')
        .select('id, name')
        .eq('id', seniorId)
        .single();

      const { data: contacts } = await supabase
        .from('senior_contacts')
        .select('name, phone, relationship, is_emergency, photo_url, aliases')
        .eq('senior_id', seniorId)
        .order('sort_order', { ascending: true });

      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan_tier, status')
        .eq('senior_id', seniorId)
        .single();

      const configPayload = {
        templateId: configuration.layout_id,
        senior: {
          id: senior?.id || seniorId,
          name: senior?.name || 'Senior',
        },
        contacts: (contacts || []).map((c: { name: string; phone: string; relationship?: string; photo_url?: string; is_emergency: boolean; aliases?: string[] }) => ({
          name: c.name,
          phone: c.phone,
          relationship: c.relationship || null,
          photoUrl: c.photo_url || null,
          isEmergency: c.is_emergency,
          aliases: c.aliases || [],
        })),
        subscription: {
          planTier: subscription?.plan_tier || 'essential',
          status: subscription?.status || 'trial',
        },
        updatedAt: new Date().toISOString(),
        _updatedAt: Date.now(),
      };

      // Write to Firebase — Android listens and applies config in real-time
      await db.ref(`devices/${seniorId}/config`).set(configPayload);
      console.log(`Config written to Firebase: devices/${seniorId}/config`);

      res.json({
        success: true,
        message: 'Configuration updated and pushed to device via Firebase',
        seniorId,
      });

    } catch (err) {
      console.error('Config sync error:', err);
      res.status(500).json({ error: 'Server error during config sync' });
    }
  }
);

// ============================================================================
// Voice Interpret — Claude AI Fallback
// ============================================================================

interface VoiceInterpretRequest {
  seniorId: string;
  transcript: string;
}

interface VoiceInterpretResponse {
  success: boolean;
  speak: string;
  matchedContact: { name: string; phone: string } | null;
  needsEmergency: boolean;
}

app.post(
  '/api/voice/interpret',
  async (
    req: Request<object, VoiceInterpretResponse | ErrorResponse, VoiceInterpretRequest>,
    res: Response<VoiceInterpretResponse | ErrorResponse>
  ): Promise<void> => {
    const { seniorId, transcript } = req.body;

    if (!seniorId || !transcript) {
      res.status(400).json({ error: 'seniorId and transcript are required' });
      return;
    }

    console.log(`[Voice] senior=${seniorId} transcript="${transcript}"`);

    try {
      const { data: contacts, error: contactsError } = await supabase
        .from('senior_contacts')
        .select('name, phone, relationship, aliases')
        .eq('senior_id', seniorId)
        .order('sort_order', { ascending: true });

      if (contactsError) {
        res.status(500).json({ error: 'Failed to fetch contacts' });
        return;
      }

      const contactList = (contacts || [])
        .map((c: { name: string; phone: string; relationship?: string; aliases?: string[] }) => {
          const aliasPart = c.aliases?.length ? ` (nicknames: ${c.aliases.join(', ')})` : '';
          const relPart = c.relationship ? ` [${c.relationship}]` : '';
          return `• ${c.name}${aliasPart}${relPart} — ${c.phone}`;
        })
        .join('\n');

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        res.status(500).json({ error: 'AI service not configured' });
        return;
      }

      const systemPrompt = `You are AidFone's voice assistant helping elderly users (80+) make phone calls.

AVAILABLE CONTACTS:
${contactList}

RULES:
1. Be EXTREMELY concise. Max 1 short sentence.
2. SINGLE MATCH — set contact field + say "Calling [name] now." for ANY of these:
   - Exact name match
   - Phonetic match (skylor→Skyler, tiler→Tyler, etc.)
   - Mispronunciation or typo of a name
   - Nickname or partial name that only matches one contact
   - Relational phrase ("my son", "the doctor") that matches one contact
3. AMBIGUOUS — only when 2+ contacts are equally likely: ask "Do you mean [A] or [B]?" with contact=null.
4. NO MATCH — say "I don't have that contact. You have: [first names only]." with contact=null.
5. EMERGENCY — if user says help/fallen/i fell/emergency/scared/pain/911/urgence/aide/au secours/j'ai mal/j'ai peur/je suis tombé → set emergency=true, ask "Do you need me to call 911?"
6. Respond in the SAME language the user spoke (French or English).
7. Return ONLY valid JSON — no markdown, no extra text.

RESPONSE FORMAT:
{"speak":"...","contact":{"name":"...","phone":"..."},"emergency":false}
If no contact matched, use: "contact":null`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          system: systemPrompt,
          messages: [{ role: 'user', content: transcript }],
        }),
      });

      if (!claudeRes.ok) {
        res.status(502).json({ error: 'AI service error' });
        return;
      }

      const claudeData = (await claudeRes.json()) as {
        content: Array<{ type: string; text: string }>;
      };

      const rawText = claudeData.content?.[0]?.text?.trim() || '{}';
      const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonText = fenceMatch ? fenceMatch[1].trim() : rawText;

      let parsed: { speak?: string; contact?: { name: string; phone: string } | null; emergency?: boolean };
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        parsed = { speak: rawText, contact: null, emergency: false };
      }

      res.json({
        success: true,
        speak: parsed.speak || "I'm sorry, I didn't understand that.",
        matchedContact: parsed.contact || null,
        needsEmergency: parsed.emergency || false,
      });

    } catch (err) {
      console.error('[Voice] Unexpected error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ============================================================================
// Start Server
// ============================================================================

app.listen(PORT, (): void => {
  console.log(`\nAidFone Config Server running on port ${PORT}`);
  console.log(`   REST API:    http://localhost:${PORT}/api/`);
  console.log(`   Firebase DB: https://aidfone-e6a5c-default-rtdb.firebaseio.com\n`);
});

export { app };
