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
// SIMPLIFIED format - matches Android's ActivationResponse data class
// ============================================================================

/**
 * Contact information from senior_contacts table
 */
interface ActivationContact {
  name: string;
  phone: string;
  photoUrl: string | null;
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
 * SIMPLIFIED activation response sent to Android
 * Uses templateId to determine which fixed layout to display:
 * - cognitive_1: Simple (2 large photo contacts)
 * - cognitive_2: Essential (911 + 6 photo grid)
 * - cognitive_3: Standard (911 + vertical rows + assistance)
 * - cognitive_4: Full (911 + text grid + assistance)
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

      // 3. Get subscription
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan_tier, status')
        .eq('senior_id', configuration.senior_id)
        .single();

      // 4. Get contacts
      const { data: contacts } = await supabase
        .from('senior_contacts')
        .select('name, phone, relationship, is_emergency')
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
        contacts: (contacts || []).map((c: { name: string; phone: string; photo_url?: string; is_emergency: boolean }) => ({
          name: c.name,
          phone: c.phone,
          photoUrl: c.photo_url || null,
          isEmergency: c.is_emergency,
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
