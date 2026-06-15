import { Application, Request, Response } from 'express';
import {
  resolveCountry,
  isCheckoutAllowed,
  ALLOWED_CHECKOUT_COUNTRIES,
} from '../lib/geo';

// US-gate prep (US / dual-currency ticket — spec pending).
//
// Read-only endpoint: reports the visitor's resolved country and whether paid
// checkout is allowed (CA/US). The frontend uses this to decide, BEFORE
// starting checkout, whether to proceed or show the "coming to your region
// soon" screen with email capture. This endpoint changes no behavior on its
// own — actual enforcement in /api/checkout/create-session lands with the
// finalized ticket.
export function registerGeoRoutes(app: Application): void {
  app.get('/api/geo', (req: Request, res: Response): void => {
    const geo = resolveCountry(req);
    res.json({
      country: geo.country,
      source: geo.source,
      allowed: isCheckoutAllowed(geo.country),
      allowedCountries: ALLOWED_CHECKOUT_COUNTRIES,
    });
  });
}
