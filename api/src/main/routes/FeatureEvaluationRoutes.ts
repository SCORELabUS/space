import express from 'express';

import FeatureEvaluationController from '../controllers/FeatureEvaluationController';
import * as FeatureEvaluationValidation from '../controllers/validation/FeatureEvaluationValidation';
import { handleValidation } from '../middlewares/ValidationHandlingMiddleware';
import { idempotent } from '../middlewares/IdempotencyMiddleware';

/** A single-feature evaluation writes when it consumes (a non-empty body) or reverts. */
const writesUsage = (req: express.Request): boolean =>
  req.query?.revert === 'true' ||
  (!!req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0);

const loadFileRoutes = function (app: express.Application) {
  const featureEvaluationController = new FeatureEvaluationController();

  const baseUrl = '/api/v1';

  app
    .route(baseUrl + '/features')
    .get(featureEvaluationController.index);

  app
    .route(baseUrl + '/features/:userId')
    .post(featureEvaluationController.eval);

  app
    .route(baseUrl + '/features/:userId/pricing-token')
    .post(featureEvaluationController.generatePricingToken);

  app
    .route(baseUrl + '/features/:userId/:featureId')
    .post(
      FeatureEvaluationValidation.expectedConsumptionSingleFeature,
      handleValidation,
      idempotent({ when: writesUsage }),
      featureEvaluationController.evalFeature
    );
};

export default loadFileRoutes;
