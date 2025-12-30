// Simple Express server for AidFone configuration API
// This server handles configuration sync between web platform and Android app

import express, { Request, Response, Application } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server as SocketIOServer, Socket } from 'socket.io';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';

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
