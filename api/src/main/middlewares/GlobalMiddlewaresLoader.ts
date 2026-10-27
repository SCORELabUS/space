import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { analyticsTrackerMiddleware } from './AnalyticsMiddleware';
import { authenticateApiKeyMiddleware } from './AuthMiddleware';
import { isProtectedStaticPath } from '../services/pricingFiles';

interface OriginValidatorCallback {
  (err: Error | null, allow?: boolean): void;
}

const originValidator = (origin: string | undefined, cb: OriginValidatorCallback): void => {
  const allowedOrigins: string[] = ['http://localhost:5403', ...((process.env.ALLOWED_ORIGINS ?? '').split(';').map(s => s.trim()).filter(Boolean))];

  // origin === undefined ocurre en curl, postman, etc. Lo puedes permitir
  if (!origin || !process.env.ALLOWED_ORIGINS || allowedOrigins.includes(origin)) {
    return cb(null, true);
  }
  return cb(null, false);
}

const corsOptions: cors.CorsOptions = {
    origin: originValidator,
    methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE'], // Specify allowed methods
    credentials: true // Allow credentials if needed
  }

const loadGlobalMiddlewares = (app: express.Application) => {
  app.use(express.json({limit: '2mb'}));
  app.use(express.urlencoded({limit: '2mb', extended: true}));
  
  // This replacer will convert Maps to plain objects in JSON responses
  app.set('json replacer', (key: any, value: any) => {
    if (value instanceof Map) {
      return Object.fromEntries(value);
    }
    return value;
  });
  
  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions)); // maneja todas las preflight

  // Do not force API key auth on OPTIONS requests
  app.use((req, res, next) => {
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(helmet(
    {
      crossOriginResourcePolicy: false // allows loading of files from /public
    }
  ));
  // Pricing files are never served statically: they are stored outside public/
  // and read through the authorised GET .../pricings/{version}?format=yaml. As a
  // second line of defence, nothing under /static/pricings (or /private) is
  // served, however the path is spelled; existing and missing files get the
  // same 404, so the answer does not reveal which files exist.
  app.use((req, res, next) => {
    if (isProtectedStaticPath(req.path)) {
      return res.status(404).json({ error: 'Not found' });
    }
    next();
  });
  app.use(express.static('public'));
  
  // Populate request with user info based on API key
  app.use(authenticateApiKeyMiddleware);

  // Apply analytics tracking middleware
  app.use(analyticsTrackerMiddleware);
};

export default loadGlobalMiddlewares;
