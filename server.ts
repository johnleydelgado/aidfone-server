// Simple Express server for AidFone configuration API
// This server handles configuration sync between web platform and Android app

import * as dotenv from 'dotenv';
dotenv.config();  // Load server/.env (ANTHROPIC_API_KEY etc.)

import express, { Request, Response, Application } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server as SocketIOServer, Socket } from 'socket.io';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';

// ============================================================================
// Supabase Client Setup
// ============================================================================

const supabaseUrl = process.env.SUPABASE_URL || 'https://tutgzciyrhztfnotudby.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR1dGd6Y2l5cmh6dGZub3R1ZGJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5ODU0MDMsImV4cCI6MjA4NTU2MTQwM30.Zyp6AIuS_3cl2617LIvtq9DdyIJUCOOTuQSiyOti-XQ';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Device configuration interface - represents the config stored/sent to devices
 */
interface DeviceConfig {
  version?: string;
  profileType?: string;
  templateId?: string;
  lastUpdated?: string;
  [key: string]: unknown; // Allow additional properties
}

/**
 * Stored device configuration with required lastUpdated timestamp
 */
interface StoredDeviceConfig extends DeviceConfig {
  lastUpdated: string;
}

/**
 * Device summary for listing devices
 */
interface DeviceSummary {
  deviceId: string;
  profileType?: string;
  templateId?: string;
  lastUpdated?: string;
}

/**
 * Health check response
 */
interface HealthCheckResponse {
  status: string;
  timestamp: string;
}

/**
 * Deploy config response
 */
interface DeployConfigResponse {
  success: boolean;
  message: string;
  deviceId: string;
  configVersion?: string;
}

/**
 * Error response
 */
interface ErrorResponse {
  error: string;
  deviceId?: string;
}

/**
 * Device registration request body
 */
interface DeviceRegistrationBody {
  deviceId: string;
  fcmToken?: string;
  platform?: string;
}

/**
 * Device registration response
 */
interface DeviceRegistrationResponse {
  success: boolean;
  message: string;
  deviceId: string;
}

/**
 * Socket.IO register event data
 */
interface SocketRegisterData {
  deviceId: string;
}

/**
 * Socket.IO config update event data
 */
interface SocketConfigUpdateData {
  deviceId: string;
  config: DeviceConfig;
}

/**
 * Extended Socket with deviceId property
 */
interface ExtendedSocket extends Socket {
  deviceId?: string;
}

/**
 * Extended WebSocket with deviceId property
 */
interface ExtendedWebSocket extends WebSocket {
  deviceId?: string;
}

/**
 * WebSocket message from Android app
 */
interface WebSocketMessage {
  type: 'REGISTER' | 'CONFIG_UPDATE' | 'DEVICE_STATUS' | string;
  deviceId?: string;
  data?: DeviceConfig & {
    batteryLevel?: number;
    isCharging?: boolean;
    deviceModel?: string;
    deviceManufacturer?: string;
    androidVersion?: string;
    heartbeat?: boolean;
  };
}

/**
 * WebSocket outgoing message
 */
interface WebSocketOutgoingMessage {
  type: 'CONFIG_UPDATE' | 'CONFIG_SYNC';
  data: DeviceConfig;
}

// ============================================================================
// Activation Types (for QR code activation flow)
// SIMPLIFIED format - matches Android's ActivationResponse data class
// ============================================================================

/**
 * Contact information from senior_contacts table
 */
interface ActivationContact {
  name: string;
  phone: string;
  relationship: string | null;
  photoUrl: string | null;
  isEmergency: boolean;
  aliases: string[];
}

/**
 * Senior information
 */
interface ActivationSenior {
  id: string;
  name: string;
}

/**
 * Subscription information
 */
interface ActivationSubscription {
  planTier: string;
  status: string;
}

/**
 * SIMPLIFIED activation response sent to Android
 * Uses templateId to determine which fixed layout to display:
 * - cognitive_1: Memory Simple (2 large photo contacts)
 * - cognitive_2: Memory Essential (911 + 6 photo grid)
 * - cognitive_3: Memory Standard (911 + vertical rows + assistance)
 * - cognitive_4: Memory Full (911 + text grid + assistance)
 * Note: Template IDs use "cognitive" internally for backwards compatibility
 */
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

// Middleware
app.use(cors());
app.use(bodyParser.json());

// In-memory storage (use a real database in production)
const deviceConfigs: Map<string, StoredDeviceConfig> = new Map();
const deviceConnections: Map<string, ExtendedSocket> = new Map(); // Socket.IO connections
const wsConnections: Map<string, ExtendedWebSocket> = new Map(); // Raw WebSocket connections (Android)

// Cache recent alerts so dashboards that connect after an event still receive it
const recentDistressAlerts: any[] = [];  // last 10, kept for 5 minutes
const recentFallAlerts: any[] = [];

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

/**
 * Client Info Endpoint
 * Returns the client's IP address, user agent, and referrer
 * Used for wizard session tracking and analytics
 */
interface ClientInfoResponse {
  ip: string;
  userAgent: string;
  referrer: string | null;
}

app.get('/api/client-info', (req: Request, res: Response<ClientInfoResponse>): void => {
  // Get IP address - check various headers for proxied requests
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

    // Validate API key exists
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not configured');
      res.status(500).json({
        success: false,
        error: 'Chat service not configured'
      });
      return;
    }

    // Validate messages
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Messages array is required'
      });
      return;
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    try {
      // Add language instruction to system prompt if not English
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

      // Stream the response
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

              // Handle content_block_delta events (streaming text)
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
              }

              // Handle message_stop event
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

// Deploy configuration to device
app.post(
  '/api/devices/:deviceId/config',
  (req: Request<{ deviceId: string }, DeployConfigResponse | ErrorResponse, DeviceConfig>, res: Response<DeployConfigResponse>): void => {
    const { deviceId } = req.params;
    const config: DeviceConfig = req.body;

    console.log(`[${new Date().toISOString()}] POST /api/devices/${deviceId}/config`);
    console.log(`Deploying config to device ${deviceId}:`, JSON.stringify(config, null, 2));

    // Store configuration
    const storedConfig: StoredDeviceConfig = {
      ...config,
      lastUpdated: new Date().toISOString(),
    };
    deviceConfigs.set(deviceId, storedConfig);

    // Send real-time update via Socket.IO
    const socket = deviceConnections.get(deviceId);
    if (socket && socket.connected) {
      socket.emit('config_update', config);
      console.log(`Sent config via Socket.IO to ${deviceId}`);
    }

    // Send real-time update via raw WebSocket (Android)
    const ws = wsConnections.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message: WebSocketOutgoingMessage = { type: 'CONFIG_UPDATE', data: config };
      ws.send(JSON.stringify(message));
      console.log(`Sent config via WebSocket to ${deviceId}`);
    }

    res.json({
      success: true,
      message: 'Configuration deployed successfully',
      deviceId,
      configVersion: config.version,
    });
  }
);

// Get current device configuration
app.get(
  '/api/devices/:deviceId/config',
  (req: Request<{ deviceId: string }>, res: Response<StoredDeviceConfig | ErrorResponse>): void => {
    const { deviceId } = req.params;
    const config = deviceConfigs.get(deviceId);

    if (!config) {
      res.status(404).json({
        error: 'Configuration not found for device',
        deviceId,
      });
      return;
    }

    res.json(config);
  }
);

// Register device for push notifications
app.post(
  '/api/devices/register',
  (req: Request<object, DeviceRegistrationResponse, DeviceRegistrationBody>, res: Response<DeviceRegistrationResponse>): void => {
    const { deviceId, fcmToken, platform } = req.body;

    console.log(`Registering device ${deviceId} with FCM token (platform: ${platform || 'unknown'})`);
    // Note: fcmToken would be used for push notifications in production
    void fcmToken; // Acknowledge unused variable

    res.json({
      success: true,
      message: 'Device registered successfully',
      deviceId,
    });
  }
);

// List all configured devices (admin endpoint)
app.get('/api/devices', (_req: Request, res: Response<DeviceSummary[]>): void => {
  const devices: DeviceSummary[] = Array.from(deviceConfigs.entries()).map(
    ([id, config]: [string, StoredDeviceConfig]): DeviceSummary => ({
      deviceId: id,
      profileType: config.profileType,
      templateId: config.templateId,
      lastUpdated: config.lastUpdated,
    })
  );

  res.json(devices);
});

// ============================================================================
// Fall Detection Notification Endpoint
// ============================================================================

/**
 * Fall detection notification interface
 */
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

/**
 * Receive fall detection alert from Android device
 * Stores in database and notifies caregiver in real-time
 */
app.post(
  '/api/fall-detection/alert',
  async (req: Request<object, FallDetectionResponse | ErrorResponse, FallDetectionNotification>, res: Response<FallDetectionResponse | ErrorResponse>): Promise<void> => {
    const { seniorId, impactMagnitude, impactTime, deviceId, location, sensorData } = req.body;

    console.log(`[${new Date().toISOString()}] 🚨 FALL DETECTION ALERT for senior: ${seniorId}`);
    console.log(`   Impact: ${impactMagnitude}g at ${impactTime}`);
    console.log(`   Device: ${deviceId}`);
    if (location) {
      console.log(`   Location: ${location.latitude}, ${location.longitude}`);
    }

    try {
      // 1. Get senior info
      const { data: senior, error: seniorError } = await supabase
        .from('seniors')
        .select('id, name, caregiver_id')
        .eq('id', seniorId)
        .single();

      if (seniorError || !senior) {
        console.error('Senior not found:', seniorError);
        res.status(404).json({
          error: 'Senior not found',
        });
        return;
      }

      // 2. Insert fall event into database
      const { data: fallEvent, error: insertError } = await supabase
        .from('fall_events')
        .insert({
          senior_id: seniorId,
          impact_magnitude: impactMagnitude,
          impact_time: impactTime,
          device_id: deviceId,
          location: location ? JSON.stringify(location) : null,
          sensor_data: sensorData ? JSON.stringify(sensorData) : null,
          status: 'pending', // pending, acknowledged, false_alarm
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) {
        console.error('Failed to insert fall event:', insertError);
        res.status(500).json({
          error: 'Failed to record fall event',
        });
        return;
      }

      console.log(`Fall event recorded with ID: ${fallEvent.id}`);

      // 3. Send real-time notification to caregiver via WebSocket/Socket.IO
      const notification = {
        type: 'FALL_DETECTED',
        data: {
          alertId: fallEvent.id,
          seniorId: seniorId,
          seniorName: senior.name,
          impactMagnitude: impactMagnitude,
          impactTime: impactTime,
          location: location,
          timestamp: new Date().toISOString(),
        },
      };

      // Broadcast to all caregivers watching this senior (Socket.IO rooms)
      io.to(`senior:${seniorId}`).emit('fall_alert', notification.data);
      console.log(`Fall alert broadcasted to caregiver for senior: ${senior.name}`);

      // Also try to notify via caregiver's connection if they're online
      io.to(`caregiver:${senior.caregiver_id}`).emit('fall_alert', notification.data);

      res.json({
        success: true,
        message: 'Fall detection alert received and caregiver notified',
        alertId: fallEvent.id,
      });

    } catch (err) {
      console.error('Fall detection error:', err);
      res.status(500).json({
        error: 'Server error processing fall detection alert',
      });
    }
  }
);

/**
 * Acknowledge fall detection alert (caregiver confirms they've seen it)
 */
app.post(
  '/api/fall-detection/:alertId/acknowledge',
  async (req: Request<{ alertId: string }>, res: Response): Promise<void> => {
    const { alertId } = req.params;

    console.log(`[${new Date().toISOString()}] Acknowledging fall alert: ${alertId}`);

    // For now, just return success (alert IDs are timestamp-based, not UUIDs)
    // TODO: Implement proper alert tracking in memory or with correct UUID handling
    res.json({ success: true, message: 'Alert acknowledged' });
  }
);

/**
 * Mark fall detection as false alarm
 */
app.post(
  '/api/fall-detection/:alertId/false-alarm',
  async (req: Request<{ alertId: string }>, res: Response): Promise<void> => {
    const { alertId } = req.params;

    console.log(`[${new Date().toISOString()}] Marking as false alarm: ${alertId}`);

    // For now, just return success (alert IDs are timestamp-based, not UUIDs)
    // TODO: Implement proper alert tracking in memory or with correct UUID handling
    res.json({ success: true, message: 'Marked as false alarm' });
  }
);

/**
 * Get fall detection history for a senior
 */
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

/**
 * TEST ENDPOINT - Trigger a test fall alert without database
 * Only for development/testing purposes
 */
app.post(
  '/api/fall-detection/test-alert',
  (_req: Request, res: Response): void => {
    console.log('[TEST] Broadcasting test fall alert to all clients');

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
    };

    // Broadcast to ALL connected clients (no room filtering)
    io.emit('fall_alert', testAlert);
    console.log('[TEST] Test alert broadcasted to all clients:', testAlert);

    res.json({
      success: true,
      message: 'Test alert broadcasted to all connected clients',
      alert: testAlert,
    });
  }
);

// ============================================================================
// Activation Endpoint (for QR code scanning on Android)
// ============================================================================

/**
 * Activate device using activation code from QR scan
 * Returns full configuration + contacts + senior info
 */
app.get(
  '/api/config/activate/:activationCode',
  async (req: Request<{ activationCode: string }>, res: Response<ActivationResponse | ErrorResponse>): Promise<void> => {
    const { activationCode } = req.params;
    const normalizedCode = activationCode.toUpperCase().trim();

    console.log(`[${new Date().toISOString()}] GET /api/config/activate/${normalizedCode}`);

    try {
      // 1. Find configuration by activation code
      const { data: configuration, error: configError } = await supabase
        .from('configurations')
        .select('*')
        .eq('activation_code', normalizedCode)
        .single();

      if (configError || !configuration) {
        console.log(`Activation code not found: ${normalizedCode}`);
        console.log(`Config error:`, configError);
        res.status(404).json({
          error: 'Invalid activation code',
        });
        return;
      }

      // 2. Get senior info
      const { data: senior, error: seniorError } = await supabase
        .from('seniors')
        .select('id, name')
        .eq('id', configuration.senior_id)
        .single();

      if (seniorError || !senior) {
        res.status(404).json({
          error: 'Senior not found for this configuration',
        });
        return;
      }

      // 3. Get subscription
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan_tier, status')
        .eq('senior_id', configuration.senior_id)
        .single();

      // 4. Get contacts (including photo_url for Android to display)
      const { data: contacts } = await supabase
        .from('senior_contacts')
        .select('name, phone, relationship, is_emergency, photo_url, aliases')
        .eq('senior_id', configuration.senior_id)
        .order('sort_order', { ascending: true });

      // 5. Mark as activated (update activated_at timestamp)
      await supabase
        .from('configurations')
        .update({ activated_at: new Date().toISOString() })
        .eq('id', configuration.id);

      // 6. Build SIMPLIFIED response for Android
      // Android uses templateId to select fixed layout (cognitive_1/2/3/4)
      const response: ActivationResponse = {
        success: true,
        templateId: configuration.layout_id,
        senior: {
          id: senior.id,
          name: senior.name,
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
      };

      console.log(`Activation successful for senior: ${senior.name} (${senior.id})`);
      console.log(`Template ID: ${configuration.layout_id}`);
      res.json(response);

    } catch (err) {
      console.error('Activation error:', err);
      res.status(500).json({
        error: 'Server error during activation',
      });
    }
  }
);

// ============================================================================
// Config Sync Endpoint (for Dashboard -> Android real-time updates)
// ============================================================================

/**
 * Push configuration update to connected Android device
 * Called from Dashboard when caregiver changes layout or other settings
 * Uses senior_id to find and notify connected device
 */
interface ConfigSyncResponse {
  success: boolean;
  message: string;
  seniorId: string;
  deviceNotified: boolean;
}

app.post(
  '/api/seniors/:seniorId/sync-config',
  async (req: Request<{ seniorId: string }>, res: Response<ConfigSyncResponse | ErrorResponse>): Promise<void> => {
    const { seniorId } = req.params;

    console.log(`[${new Date().toISOString()}] POST /api/seniors/${seniorId}/sync-config`);

    try {
      // 1. Fetch full configuration from Supabase
      const { data: configuration, error: configError } = await supabase
        .from('configurations')
        .select('*')
        .eq('senior_id', seniorId)
        .single();

      if (configError || !configuration) {
        console.log(`Configuration not found for senior: ${seniorId}`);
        res.status(404).json({
          error: 'Configuration not found for senior',
        });
        return;
      }

      // 2. Get senior info
      const { data: senior } = await supabase
        .from('seniors')
        .select('id, name')
        .eq('id', seniorId)
        .single();

      // 3. Get contacts
      const { data: contacts } = await supabase
        .from('senior_contacts')
        .select('name, phone, relationship, is_emergency, photo_url, aliases')
        .eq('senior_id', seniorId)
        .order('sort_order', { ascending: true });

      // 4. Get subscription
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan_tier, status')
        .eq('senior_id', seniorId)
        .single();

      // 5. Build config update payload (same format as activation response)
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
      };

      // 6. Store in memory (using seniorId as deviceId)
      const storedConfig: StoredDeviceConfig = {
        ...configPayload,
        lastUpdated: new Date().toISOString(),
      };
      deviceConfigs.set(seniorId, storedConfig);

      // 7. Push to connected device via WebSocket (Android registers with seniorId after activation)
      let deviceNotified = false;

      // Try WebSocket first (Android)
      const ws = wsConnections.get(seniorId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        const message: WebSocketOutgoingMessage = { type: 'CONFIG_UPDATE', data: configPayload };
        ws.send(JSON.stringify(message));
        console.log(`Sent config update via WebSocket to device ${seniorId}`);
        deviceNotified = true;
      }

      // Also try Socket.IO (web clients watching this senior)
      const socket = deviceConnections.get(seniorId);
      if (socket && socket.connected) {
        socket.emit('config_update', configPayload);
        console.log(`Sent config update via Socket.IO to ${seniorId}`);
        deviceNotified = true;
      }

      // Also broadcast to all sockets in a room named after the seniorId
      io.to(`senior:${seniorId}`).emit('config_update', configPayload);

      console.log(`Config sync completed for senior ${seniorId}, device notified: ${deviceNotified}`);

      res.json({
        success: true,
        message: deviceNotified
          ? 'Configuration updated and device notified'
          : 'Configuration updated (device not connected)',
        seniorId,
        deviceNotified,
      });

    } catch (err) {
      console.error('Config sync error:', err);
      res.status(500).json({
        error: 'Server error during config sync',
      });
    }
  }
);

// ============================================================================
// HTTP Server Setup
// ============================================================================

const server: http.Server = http.createServer(app);

// ============================================================================
// Socket.IO Server (for Web Platform)
// ============================================================================

const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Socket.IO connection handling (Web Platform)
io.on('connection', (socket: ExtendedSocket): void => {
  console.log('New Socket.IO connection:', socket.id);

  // Handle caregiver joining rooms for fall detection alerts
  socket.on('join_room', (data: { room: string }): void => {
    const { room } = data;
    socket.join(room);
    console.log(`Socket ${socket.id} joined room: ${room}`);

    // Replay any recent alerts missed while the dashboard was not connected (5 min window)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const missedDistress = recentDistressAlerts.filter(a => a._cachedAt > fiveMinutesAgo);
    const missedFalls = recentFallAlerts.filter(a => a._cachedAt > fiveMinutesAgo);
    missedDistress.forEach(alert => socket.emit('distress_alert', alert));
    missedFalls.forEach(alert => socket.emit('fall_alert', alert));
    if (missedDistress.length > 0 || missedFalls.length > 0) {
      console.log(`Replayed ${missedDistress.length} distress + ${missedFalls.length} fall alerts to reconnecting dashboard`);
    }
  });

  socket.on('register', (data: SocketRegisterData): void => {
    const { deviceId } = data;
    if (deviceId) {
      socket.deviceId = deviceId;
      deviceConnections.set(deviceId, socket);
      console.log(`Device ${deviceId} registered via Socket.IO`);

      const config = deviceConfigs.get(deviceId);
      if (config) {
        socket.emit('config_sync', config);
      }
    }
  });

  socket.on('config_update', (data: SocketConfigUpdateData): void => {
    const { deviceId, config } = data;
    if (deviceId && config) {
      const storedConfig: StoredDeviceConfig = {
        ...config,
        lastUpdated: new Date().toISOString(),
      };
      deviceConfigs.set(deviceId, storedConfig);

      // Notify Android device via WebSocket
      const ws = wsConnections.get(deviceId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        const message: WebSocketOutgoingMessage = { type: 'CONFIG_UPDATE', data: config };
        ws.send(JSON.stringify(message));
        console.log(`Forwarded config to Android device ${deviceId}`);
      }
    }
  });

  socket.on('disconnect', (): void => {
    if (socket.deviceId) {
      deviceConnections.delete(socket.deviceId);
      console.log(`Device ${socket.deviceId} disconnected from Socket.IO`);
    }
  });
});

// ============================================================================
// Raw WebSocket Server (for Android App)
// ============================================================================

const wss: WebSocketServer = new WebSocketServer({ server });

wss.on('connection', (ws: ExtendedWebSocket): void => {
  console.log('New WebSocket connection from Android');

  ws.on('message', async (message: WebSocket.RawData): Promise<void> => {
    try {
      const data: WebSocketMessage = JSON.parse(message.toString());
      console.log('WebSocket message:', data);

      if (data.type === 'REGISTER' && data.deviceId) {
        const deviceId: string = data.deviceId;
        ws.deviceId = deviceId;
        wsConnections.set(deviceId, ws);
        console.log(`Android device ${deviceId} registered via WebSocket`);

        // Send current config if exists
        const config = deviceConfigs.get(deviceId);
        if (config) {
          const syncMessage: WebSocketOutgoingMessage = { type: 'CONFIG_SYNC', data: config };
          ws.send(JSON.stringify(syncMessage));
          console.log(`Sent existing config to ${deviceId}`);
        }
      }

      // Handle fall detection alerts via WebSocket (same as device status)
      if (data.type === 'FALL_DETECTED' && data.deviceId) {
        const { deviceId } = data;
        const fallData = data.data || {};

        console.log(`[${new Date().toISOString()}] 🚨 FALL DETECTION via WebSocket from device: ${deviceId}`);
        console.log(`   Impact: ${fallData.impactMagnitude}g at ${fallData.impactTime}`);

        // Store in database (use deviceId as seniorId for now)
        supabase
          .from('fall_events')
          .insert({
            senior_id: deviceId,
            impact_magnitude: fallData.impactMagnitude,
            impact_time: fallData.impactTime,
            device_id: fallData.deviceId || deviceId,
            location: fallData.location ? JSON.stringify(fallData.location) : null,
            sensor_data: fallData.sensorData ? JSON.stringify(fallData.sensorData) : null,
            status: 'pending',
            created_at: new Date().toISOString(),
          })
          .select()
          .single()
          .then(({ data: fallEvent, error }) => {
            if (error) {
              console.error('Failed to store fall event:', error);
              return;
            }

            console.log(`✅ Fall event stored with ID: ${fallEvent?.id}`);

            // Broadcast to dashboard via Socket.IO
            const notification = {
              alertId: fallEvent?.id || `fall-${Date.now()}`,
              seniorId: deviceId,
              seniorName: fallData.seniorName || 'Senior',
              impactMagnitude: fallData.impactMagnitude,
              impactTime: fallData.impactTime,
              location: fallData.location,
              timestamp: new Date().toISOString(),
            };

            // Cache for late-connecting dashboards
            recentFallAlerts.unshift({ ...notification, _cachedAt: Date.now() });
            if (recentFallAlerts.length > 10) recentFallAlerts.pop();

            // Broadcast to ALL connected Socket.IO clients
            io.emit('fall_alert', notification);
            console.log(`📡 Fall alert broadcasted to dashboard:`, notification);
          });
      }

      // Handle distress audio detection alerts (YAMNet)
      if (data.type === 'DISTRESS_DETECTED' && data.deviceId) {
        const { deviceId } = data;
        const distressData = data.data || {};

        console.log(`[${new Date().toISOString()}] 🆘 DISTRESS AUDIO via WebSocket from device: ${deviceId}`);
        console.log(`   Label: ${distressData.distressLabel}, Senior: ${distressData.seniorName}`);

        const notification = {
          alertId: `distress-${Date.now()}`,
          seniorId: deviceId,
          seniorName: distressData.seniorName || 'Senior',
          distressLabel: distressData.distressLabel,
          detectedAt: distressData.detectedAt || new Date().toISOString(),
          source: 'yamnet_audio',
          timestamp: new Date().toISOString(),
        };

        // Cache for late-connecting dashboards (keep last 10, expire after 5 min)
        recentDistressAlerts.unshift({ ...notification, _cachedAt: Date.now() });
        if (recentDistressAlerts.length > 10) recentDistressAlerts.pop();

        // Broadcast to ALL connected Socket.IO clients (caregiver dashboard)
        io.emit('distress_alert', notification);
        console.log(`📡 Distress alert broadcasted to dashboard:`, notification);
      }

      // Handle device status updates (battery, device info, heartbeat)
      if (data.type === 'DEVICE_STATUS' && data.deviceId) {
        const { deviceId } = data;
        const status = data.data || {};

        // Build upsert payload — only include fields that were sent
        const upsertData: Record<string, unknown> = {
          senior_id: deviceId,
          is_online: true,
          last_seen: new Date().toISOString(),
        };
        if (status.batteryLevel !== undefined && status.batteryLevel >= 0) {
          upsertData.battery_level = status.batteryLevel;
        }
        if (status.isCharging !== undefined) {
          upsertData.is_charging = status.isCharging;
        }
        if (status.deviceModel) {
          upsertData.device_model = status.deviceModel;
        }
        if (status.deviceManufacturer) {
          upsertData.device_manufacturer = status.deviceManufacturer;
        }
        if (status.androidVersion) {
          upsertData.android_version = status.androidVersion;
        }

        const { error: upsertError } = await supabase
          .from('device_status')
          .upsert(upsertData, { onConflict: 'senior_id' });

        if (upsertError) {
          console.error(`Device status upsert error for ${deviceId}:`, upsertError.message);
        } else {
          console.log(`Device status updated for ${deviceId}`);
        }
      }
    } catch (err) {
      console.error('WebSocket message parse error:', err);
    }
  });

  ws.on('close', async (): Promise<void> => {
    if (ws.deviceId) {
      wsConnections.delete(ws.deviceId);
      console.log(`Android device ${ws.deviceId} disconnected`);

      // Mark device offline in Supabase
      const { error } = await supabase
        .from('device_status')
        .upsert({
          senior_id: ws.deviceId,
          is_online: false,
          last_seen: new Date().toISOString(),
        }, { onConflict: 'senior_id' });

      if (error) {
        console.error(`Failed to mark ${ws.deviceId} offline:`, error.message);
      }
    }
  });

  ws.on('error', (err: Error): void => {
    console.error('WebSocket error:', err);
  });
});

// ============================================================================
// Voice Interpret — Claude AI Fallback
// POST /api/voice/interpret
// Called by Android when local alias matching returns NoMatch.
// Fetches the senior's contacts, sends transcript + contacts to Claude,
// returns structured { speak, matchedContact, needsEmergency }.
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
      // 1. Fetch contacts for this senior from Supabase
      const { data: contacts, error: contactsError } = await supabase
        .from('senior_contacts')
        .select('name, phone, relationship, aliases')
        .eq('senior_id', seniorId)
        .order('sort_order', { ascending: true });

      if (contactsError) {
        console.error('[Voice] Error fetching contacts:', contactsError);
        res.status(500).json({ error: 'Failed to fetch contacts' });
        return;
      }

      // 2. Build contact list for Claude's context
      const contactList = (contacts || [])
        .map((c: { name: string; phone: string; relationship?: string; aliases?: string[] }) => {
          const aliasPart = c.aliases?.length ? ` (nicknames: ${c.aliases.join(', ')})` : '';
          const relPart = c.relationship ? ` [${c.relationship}]` : '';
          return `• ${c.name}${aliasPart}${relPart} — ${c.phone}`;
        })
        .join('\n');

      // 3. Call Claude API (Haiku — fast + cheap for real-time voice)
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error('[Voice] ANTHROPIC_API_KEY not set');
        res.status(500).json({ error: 'AI service not configured' });
        return;
      }

      const systemPrompt = `You are AidFone's voice assistant helping elderly users (80+) make phone calls.

AVAILABLE CONTACTS:
${contactList}

RULES:
1. Be EXTREMELY concise. Max 2 short sentences.
2. If you clearly match ONE contact, set the contact field and say: "Should I call [name] now?"
3. If multiple possible matches: "Do you mean [A] or [B]?"
4. If no match: say "I don't have that person. Your contacts are: [list first names only]."
5. If user says help / fallen / i fell / emergency / scared / pain / 911 / urgence / aide / au secours / j'ai mal / j'ai peur / je suis tombé, set emergency=true and ask: "Do you need me to call 911?"
6. Respond in the SAME language the user spoke (French or English).
7. Return ONLY valid JSON — no markdown, no explanation, no extra text.

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
        console.error('[Voice] Claude API error:', claudeRes.status, await claudeRes.text());
        res.status(502).json({ error: 'AI service error' });
        return;
      }

      const claudeData = (await claudeRes.json()) as {
        content: Array<{ type: string; text: string }>;
      };

      const rawText = claudeData.content?.[0]?.text?.trim() || '{}';
      console.log(`[Voice] Claude raw response: ${rawText}`);

      // Strip markdown code fences if Claude wrapped the JSON in ```json ... ```
      const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonText = fenceMatch ? fenceMatch[1].trim() : rawText;

      let parsed: { speak?: string; contact?: { name: string; phone: string } | null; emergency?: boolean };
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        // Claude returned non-JSON — wrap as plain speak text
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

server.listen(PORT, (): void => {
  console.log(`\nAidFone Config Server running on port ${PORT}`);
  console.log(`   REST API: http://localhost:${PORT}/api/`);
  console.log(`   Socket.IO: ws://localhost:${PORT} (Web Platform)`);
  console.log(`   WebSocket: ws://localhost:${PORT} (Android)\n`);
});

// Export for testing purposes
export { app, server, io, wss };
export type {
  DeviceConfig,
  StoredDeviceConfig,
  DeviceSummary,
  WebSocketMessage,
  WebSocketOutgoingMessage,
  ExtendedSocket,
  ExtendedWebSocket,
};
