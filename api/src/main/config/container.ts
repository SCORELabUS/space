import SphereSyncRepository from '../repositories/mongoose/SphereSyncRepository';
import SphereSyncService from '../services/sphere/SphereSyncService';
// deno-lint-ignore-file no-explicit-any
import process from "node:process";

import { asClass, asValue, AwilixContainer,createContainer } from "awilix";
import dotenv from "dotenv";

import MongooseServiceRepository from "../repositories/mongoose/ServiceRepository";
import MongooseUserRepository from "../repositories/mongoose/UserRepository";
import MongoosePricingRepository from "../repositories/mongoose/PricingRepository";
import MongooseContractRepository from "../repositories/mongoose/ContractRepository";
import MongooseAnalyticsRepository from "../repositories/mongoose/AnalyticsRepository";
import MongooseOrganizationRepository from "../repositories/mongoose/OrganizationRepository";

import CacheService from "../services/CacheService";
import ServiceService from "../services/ServiceService";
import UserService from "../services/UserService";
import ContractService from "../services/ContractService";
import FeatureEvaluationService from "../services/FeatureEvaluationService";
import EventService from "../services/EventService";
import AnalyticsService from "../services/AnalyticsService";
import OrganizationService from "../services/OrganizationService";

dotenv.config();

function initContainer(databaseType: string): AwilixContainer {
  const container: AwilixContainer = createContainer();
  let userRepository, serviceRepository, pricingRepository, contractRepository, organizationRepository, analyticsRepository;
  switch (databaseType) {
    case "mongoDB":
      userRepository = new MongooseUserRepository();
      serviceRepository = new MongooseServiceRepository();
      pricingRepository = new MongoosePricingRepository();
      contractRepository = new MongooseContractRepository();
      organizationRepository = new MongooseOrganizationRepository();
      analyticsRepository = new MongooseAnalyticsRepository();
      break;
    default:
      throw new Error(`Unsupported database type: ${databaseType}`);
  }
  container.register({
    userRepository: asValue(userRepository),
    serviceRepository: asValue(serviceRepository),
    pricingRepository: asValue(pricingRepository),
    contractRepository: asValue(contractRepository),
    organizationRepository: asValue(organizationRepository),
    analyticsRepository: asValue(analyticsRepository),
    userService: asClass(UserService).singleton(),
    sphereSyncRepository: asClass(SphereSyncRepository).singleton(),
    sphereSyncService: asClass(SphereSyncService).singleton(),
    serviceService: asClass(ServiceService).singleton(),
    cacheService: asClass(CacheService).singleton(),
    contractService: asClass(ContractService).singleton(),
    analyticsService: asClass(AnalyticsService).singleton(),
    featureEvaluationService: asClass(FeatureEvaluationService).singleton(),
    eventService: asClass(EventService).singleton(),
    organizationService: asClass(OrganizationService).singleton(),
  });
  return container;
}

let container: AwilixContainer | null = null;
if (!container) { container = initContainer(process.env.DATABASE_TECHNOLOGY ?? "mongoDB"); }

export default container as AwilixContainer;