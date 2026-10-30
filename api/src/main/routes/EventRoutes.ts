import express from 'express';
import path from 'path';
import EventController from '../controllers/EventController';

const loadFileRoutes = (app: express.Application) => {
  const eventController = new EventController();
  const baseUrl = '/api/v1';
  
  // This route can be used to check the status of the event service
  app
    .route(`${baseUrl}/events/status`)
    .get((req, res) => {
    res.json({ status: 'The WebSocket event service is active' });
  });
  
  // Route to send a test event. Authorization is enforced by the permission
  // rules (organization key with scope ALL, or ADMIN user); it is disabled in
  // production unless ENABLE_TEST_EVENTS=true.
  app
  .route(`${baseUrl}/events/test-event`)
  .post((req, res) => {
    if (process.env.ENVIRONMENT === 'production' && process.env.ENABLE_TEST_EVENTS !== 'true') {
      return res.status(404).json({ error: 'Test events are disabled in production (set ENABLE_TEST_EVENTS=true to enable them)' });
    }

    const { serviceName, pricingVersion } = req.body ?? {};
    
    if (!serviceName || !pricingVersion) {
      return res.status(400).json({ error: 'The fields serviceName and pricingVersion are required' });
    }
    
    eventController.emitPricingMessage(serviceName, pricingVersion);
    res.json({ success: true, message: 'Event sent successfully' });
  });
  
  // Route to serve the WebSocket client HTML
  app
  .route(`${baseUrl}/events/client`)
  .get((_req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'static', 'websocket-client.html'));
  });
};

export default loadFileRoutes;
