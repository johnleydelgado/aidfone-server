// Simple Express server for AidFone configuration API
// This server handles configuration sync between web platform and Android app

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

const supabaseUrl = process.env.SUPABASE_URL || 'https://akfyobmqdiqglqembhhi.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrZnlvYm1xZGlxZ2xxZW1iaGhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MzU1NzcsImV4cCI6MjA4MzIxMTU3N30.IfOp6Tqu8g_fLrwqyrHjfqk32PMYs3fAKMYh0FTasI4';
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
  type: 'REGISTER' | 'CONFIG_UPDATE' | string;
  deviceId?: string;
  data?: DeviceConfig;
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
// ============================================================================

/**
 * Contact information from senior_contacts table
 */
interface ActivationContact {
  name: string;
  phone: string;
  relationship: string;
  isEmergency: boolean;
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
 * Full activation response sent to Android
 */
interface ActivationResponse {
  success: boolean;
  message?: string;
  config: {
    userId: string;
    profileType: string;
    templateId: string;
    enabledFeatures: string[];
    accessibility: {
      largeButtons: boolean;
      highContrast: boolean;
      voiceControl: boolean;
      simplifiedUI: boolean;
      textSize: string;
      textSizePercent: number;
    };
    version: number;
    timestamp: string;
  };
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

// ============================================================================
// REST API Endpoints
// ============================================================================

// Health check
app.get('/api/health', (_req: Request, res: Response<HealthCheckResponse>): void => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

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

      // 3. Get assessment (for profile type)
      const { data: assessment } = await supabase
        .from('assessments')
        .select('profile_type, severity')
        .eq('senior_id', configuration.senior_id)
        .single();

      // 4. Get subscription
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan_tier, status')
        .eq('senior_id', configuration.senior_id)
        .single();

      // 5. Get contacts
      const { data: contacts } = await supabase
        .from('senior_contacts')
        .select('name, phone, relationship, is_emergency')
        .eq('senior_id', configuration.senior_id)
        .order('sort_order', { ascending: true });

      // 6. Mark as activated (update activated_at timestamp)
      await supabase
        .from('configurations')
        .update({ activated_at: new Date().toISOString() })
        .eq('id', configuration.id);

      // 7. Build enabled features based on layout, plan, AND actual configuration
      const enabledFeatures = buildEnabledFeatures(
        configuration.layout_id,
        assessment?.profile_type || 'cognitive',
        subscription?.plan_tier || 'essential',
        {
          geo_fence_enabled: configuration.geo_fence_enabled,
          geo_fence_alert_on_exit: configuration.geo_fence_alert_on_exit,
          health_medication_reminders: configuration.health_medication_reminders,
          health_daily_checkin: configuration.health_daily_checkin,
        }
      );

      // 8. Build accessibility settings based on profile
      const accessibility = buildAccessibilitySettings(
        assessment?.profile_type || 'cognitive',
        assessment?.severity || 'moderate'
      );

      // 9. Build response
      const response: ActivationResponse = {
        success: true,
        config: {
          userId: senior.id,
          profileType: assessment?.profile_type?.toUpperCase() || 'COGNITIVE',
          templateId: configuration.layout_id,
          enabledFeatures,
          accessibility,
          version: Date.now(),
          timestamp: new Date().toISOString(),
        },
        senior: {
          id: senior.id,
          name: senior.name,
        },
        contacts: (contacts || []).map((c: { name: string; phone: string; relationship: string; is_emergency: boolean }) => ({
          name: c.name,
          phone: c.phone,
          relationship: c.relationship,
          isEmergency: c.is_emergency,
        })),
        subscription: {
          planTier: subscription?.plan_tier || 'essential',
          status: subscription?.status || 'trial',
        },
      };

      console.log(`Activation successful for senior: ${senior.name} (${senior.id})`);
      res.json(response);

    } catch (err) {
      console.error('Activation error:', err);
      res.status(500).json({
        error: 'Server error during activation',
      });
    }
  }
);

/**
 * Configuration settings from database
 */
interface ConfigurationSettings {
  geo_fence_enabled?: boolean;
  geo_fence_alert_on_exit?: boolean;
  health_medication_reminders?: boolean;
  health_daily_checkin?: boolean;
}

/**
 * Build enabled features list based on layout, profile, plan, and actual configuration
 * Features are based on AidFone_Web_Platform_Spec_v2.pdf
 */
function buildEnabledFeatures(
  layoutId: string,
  profileType: string,
  planTier: string,
  config?: ConfigurationSettings
): string[] {
  const features: string[] = [];

  // =========================================================================
  // COMMUNICATION (All Tiers) - 8 features
  // =========================================================================
  features.push(
    'simplifiedCalling',      // Large buttons, one-tap to call
    'photoMessaging',         // Send photos to family easily
    'voiceAssistant',         // "Call Marie" voice commands
    'contactFavorites',       // Quick access to important people
    'emergencySOS',           // One-tap Emergency (911)
    'voiceMessages',          // Record and send audio
    'largeButtonInterface',   // Easy to see and tap
    'autoAnswer'              // Automatically answer trusted callers
  );

  // =========================================================================
  // SAFETY & PROTECTION - Essential (3 features)
  // =========================================================================
  features.push(
    'emergencyContactAlert',  // Notifies family of SOS
    'lowBatteryAlerts'        // Caregiver notified when low
  );

  // =========================================================================
  // SAFETY & PROTECTION - Plus adds (7 features)
  // Only enable if plan allows AND feature is configured
  // =========================================================================
  if (planTier === 'plus' || planTier === 'complete') {
    // Geo-fencing - only if enabled in configuration
    if (config?.geo_fence_enabled) {
      features.push('geoFencing');           // "Know if mom wanders"
      features.push('gpsLocationSharing');   // "See where she is"
    }

    // These are always included with Plus/Complete (not configurable)
    features.push(
      'phoneDropAlert',       // "Know if something happened"
      'voiceDistressDetection', // "Know if she needs help"
      'inactivityAlerts',     // "Know if she's okay"
      'caregiverDashboard',   // "See her activity anytime"
      'scamCallBlocking'      // "Protect from scammers"
    );
  }

  // =========================================================================
  // SAFETY & PROTECTION - Complete adds (2 features)
  // =========================================================================
  if (planTier === 'complete') {
    features.push(
      'locationHistory',      // See where she's been
      'multipleCaregiverAccess' // Share with siblings
    );
  }

  // =========================================================================
  // HEALTH COMPANION - Essential (1 feature)
  // =========================================================================
  features.push(
    'appointmentReminders'    // Basic calendar alerts
  );

  // =========================================================================
  // HEALTH COMPANION - Complete adds (11 features)
  // Only enable if plan allows AND feature is configured
  // =========================================================================
  if (planTier === 'complete') {
    // Medication reminders - only if enabled in configuration
    if (config?.health_medication_reminders) {
      features.push('medicationReminders');  // Voice + visual reminders
      features.push('medicationTracking');   // Log when taken
    }

    // Daily check-in - only if enabled in configuration
    if (config?.health_daily_checkin) {
      features.push('dailyWellnessCheckin'); // "How are you feeling?"
    }

    // These are always included with Complete (not configurable)
    features.push(
      'videoCalling',         // Face-to-face connection
      'sleepMonitoring',      // Phone placement analysis
      'healthReport',         // Weekly summary for family
      'stepCounter',          // Activity tracking
      'heartRate',            // Pulse measurement (camera)
      'oximeter',             // Blood oxygen estimate (camera)
      'prioritySupport',      // 24/7 Human help anytime
      'caregiverNotes'        // Share notes with family
    );
  }

  // =========================================================================
  // PROFILE-SPECIFIC UI FEATURES
  // =========================================================================
  // Cognitive profile
  if (profileType === 'cognitive') {
    features.push(
      'simplifiedNavigation', // Reduced options, clear paths
      'reminderAssist',       // Extra reminders and prompts
      'confusionPrevention'   // Prevents accidental actions
    );
  }

  // Physical profile
  if (profileType === 'physical') {
    features.push(
      'extraLargeTapTargets', // Maximum touch area
      'gestureSimplification', // Single taps only, no swipes required
      'hapticFeedback',       // Strong vibration confirmation
      'voiceControl'          // Full voice control enabled
    );
  }

  // Visual profile
  if (profileType === 'visual') {
    features.push(
      'highContrastMode',     // Maximum contrast UI
      'screenReader',         // TalkBack/VoiceOver integration
      'voiceReadback',        // Read all UI elements aloud
      'voiceControl',         // Full voice control enabled
      'audioFeedback'         // Sound confirmations for actions
    );
  }

  return features;
}

/**
 * Build accessibility settings based on profile and severity
 */
function buildAccessibilitySettings(
  profileType: string,
  severity: string
): {
  largeButtons: boolean;
  highContrast: boolean;
  voiceControl: boolean;
  simplifiedUI: boolean;
  textSize: string;
  textSizePercent: number;
} {
  const settings = {
    largeButtons: false,
    highContrast: false,
    voiceControl: false,
    simplifiedUI: false,
    textSize: 'NORMAL' as string,
    textSizePercent: 100,
  };

  // Profile-based defaults
  switch (profileType) {
    case 'physical':
      settings.largeButtons = true;
      settings.voiceControl = true;
      settings.textSize = severity === 'severe' ? 'EXTRA_LARGE' : 'LARGE';
      settings.textSizePercent = severity === 'severe' ? 150 : 125;
      break;
    case 'visual':
      settings.largeButtons = true;
      settings.highContrast = true;
      settings.voiceControl = true;
      settings.textSize = 'EXTRA_LARGE';
      settings.textSizePercent = 150;
      break;
    case 'cognitive':
      settings.simplifiedUI = true;
      settings.textSize = severity === 'severe' ? 'LARGE' : 'NORMAL';
      settings.textSizePercent = severity === 'severe' ? 125 : 100;
      break;
  }

  // Severity adjustments
  if (severity === 'severe') {
    settings.largeButtons = true;
    settings.simplifiedUI = true;
  }

  return settings;
}

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

  ws.on('message', (message: WebSocket.RawData): void => {
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
    } catch (err) {
      console.error('WebSocket message parse error:', err);
    }
  });

  ws.on('close', (): void => {
    if (ws.deviceId) {
      wsConnections.delete(ws.deviceId);
      console.log(`Android device ${ws.deviceId} disconnected`);
    }
  });

  ws.on('error', (err: Error): void => {
    console.error('WebSocket error:', err);
  });
});

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
