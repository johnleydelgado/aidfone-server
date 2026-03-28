import { Application, Request, Response } from 'express';
import { db, supabase } from '../lib/clients';

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

interface ConfigSyncResponse {
  success: boolean;
  message: string;
  seniorId: string;
}

export function registerDeviceRoutes(app: Application): void {
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

  // Activation Endpoint (for QR code scanning on Android)
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

  // Config Sync (Dashboard → Android via Firebase)
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
}
