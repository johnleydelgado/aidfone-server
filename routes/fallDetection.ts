import { Application, Request, Response } from 'express';
import { db, supabase } from '../lib/clients';

interface ErrorResponse {
  error: string;
}

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

export function registerFallDetectionRoutes(app: Application): void {
  // Receive fall alert from Android
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
}
