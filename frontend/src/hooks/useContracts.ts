import { useEffect, useMemo, useState } from 'react';
import type { Subscription } from '@/types/Subscription';
import { getContracts } from '@/api/contracts/contractsApi';

export default function useContracts(apiKey: string, organizationId?: string) {
  const [contracts, setContracts] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [serviceFilter, setServiceFilter] = useState<string | undefined>(undefined);
  const [total, setTotal] = useState<number | undefined>(undefined);

  // (pricing cache removed) we fetch active pricings via getServices when computing revenue

  useEffect(() => {
    if (!organizationId) return;
    setLoading(true);
    // Build request body with service filter if present (API supports requestBody)
    const body = serviceFilter ? { services: [serviceFilter] } : undefined;
    getContracts(apiKey, organizationId, { limit, page }, body)
      .then(result => {
        setContracts(result.data);
        setTotal(result.total);
      })
      .catch(e => setError(e.message || 'Failed to fetch contracts'))
      .finally(() => setLoading(false));
  }, [apiKey, organizationId, page, limit, serviceFilter]);

  const totalContracts = contracts.length;

  const { plansDistribution, addonsByPlan } = useMemo(() => {
    const map: Record<string, number> = {};
    const addonMap: Record<string, Record<string, number>> = {};

    for (const c of contracts) {
      if (c.subscriptionPlans) {
        for (const [serviceName, planName] of Object.entries(c.subscriptionPlans)) {
          const plan = planName || 'unknown';
          map[plan] = (map[plan] || 0) + 1;
          // collect add-ons for this plan if present in subscriptionAddOns map
          const addonsForService = c.subscriptionAddOns ? (c.subscriptionAddOns as Record<string, Record<string, number>>)[serviceName] : undefined;
          if (addonsForService) {
            addonMap[plan] = addonMap[plan] || {};
            for (const [addonName, qty] of Object.entries(addonsForService || {})) {
              addonMap[plan][addonName] = (addonMap[plan][addonName] || 0) + Number(qty || 0);
            }
          }
        }
      }
      if (c.services) {
        for (const s of c.services) {
          const plan = s.subscriptionPlan ?? 'unknown';
          map[plan] = (map[plan] || 0) + 1;
          if (s.subscriptionAddOns) {
            addonMap[plan] = addonMap[plan] || {};
            for (const [addonName, qty] of Object.entries(s.subscriptionAddOns || {})) {
              addonMap[plan][addonName] = (addonMap[plan][addonName] || 0) + Number(qty || 0);
            }
          }
        }
      }
    }

    return { plansDistribution: map, addonsByPlan: addonMap };
  }, [contracts]);

  async function computeExpectedMonthlyRevenue(): Promise<number> {
    // Fetch all services with their active pricings (returns Service objects)
    let totalRevenue = 0;
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);

    let servicesList: any[] = [];
    try {
      // getServices returns an array of Service objects with activePricings map
      // Note: if organizationId is missing, skip
      if (organizationId) servicesList = await (await import('@/api/services/servicesApi')).getServices(apiKey, organizationId);
    } catch (e) {
      console.warn('Failed to retrieve services/pricings for revenue calc', e);
      servicesList = [];
    }

    // Build a map: serviceName -> { activePricings: Record<version,Pricing>, latest: Pricing }
    const servicesMap: Record<string, { activePricings: Record<string, any>; latest?: any }> = {};
    for (const s of servicesList || []) {
      const activePricings = s.activePricings || {};
      let latest: any | undefined = undefined;
      // choose latest by createdAt if available
      for (const p of Object.values(activePricings || {})) {
        if (!latest) latest = p;
        else if (
          p && (p as any).createdAt && latest && (latest as any).createdAt && new Date((p as any).createdAt) > new Date((latest as any).createdAt)
        ) latest = p;
      }
      const key = String(s.name || '').toLowerCase();
      servicesMap[key] = { activePricings, latest };
    }

    // debug info
    console.debug('[Revenue] services discovered:', Object.keys(servicesMap).length);
    if (import.meta.env.NODE_ENV !== 'production') {
      console.debug('[Revenue] services list sample:', Object.keys(servicesMap).slice(0, 10));
    }

    // Fetch all contracts (paginate) to compute revenue across the whole dataset, not only the current page
    const allContracts: Subscription[] = [];
    try {
      if (!organizationId) throw new Error('Organization ID required for revenue calculation');
      const pageSize = 200;
      let p = 1;
      while (true) {
        const body = undefined;
  // fetch a page
  const res = await getContracts(apiKey, organizationId, { limit: pageSize, page: p }, body);
        if (!res || !res.data || res.data.length === 0) break;
        allContracts.push(...res.data);
        if (res.total && allContracts.length >= res.total) break;
        if (res.data.length < pageSize) break;
        p += 1;
      }
    } catch (e) {
      console.warn('Failed to fetch all contracts for revenue calculation', e);
    }

    console.debug('[Revenue] total contracts fetched for revenue calc:', allContracts.length);

    for (const c of allContracts) {
      // include only contracts that will be active next month
      const bp = c.billingPeriod;
      const willAutoRenew = bp && ((bp as any).autoRenewal === true || (bp as any).autoRenew === true);
      const endsAfterNextMonth = bp && bp.endDate ? new Date(bp.endDate) > nextMonth : false;
      if (!willAutoRenew && !endsAfterNextMonth) continue;

      let contractSum = 0;

      // Helper to resolve pricing for a service+version (falls back to latest active)
      const resolvePricing = (serviceName: string, version?: string) => {
        const key = String(serviceName || '').toLowerCase();
        const svc = servicesMap[key];
        if (!svc) {
          console.debug('[Revenue] service not found in servicesMap:', serviceName, 'available:', Object.keys(servicesMap).slice(0, 20));
          return null;
        }
        if (version && svc.activePricings && svc.activePricings[version]) return svc.activePricings[version];
        return svc.latest ?? null;
      };

      const findPlanPrice = (pricing: any, planName?: string) => {
        if (!pricing || !pricing.plans || !planName) return 0;
        // try exact key first
        if (pricing.plans[planName] && pricing.plans[planName].price !== undefined) return Number(pricing.plans[planName].price || 0);
        // case-insensitive search
        const key = Object.keys(pricing.plans).find(k => k.toLowerCase() === String(planName).toLowerCase());
        if (key) return Number(pricing.plans[key]?.price ?? 0);
        return 0;
      };

      const findAddOnPrice = (pricing: any, addonName?: string) => {
        if (!pricing || !pricing.addOns || !addonName) return 0;
        if (pricing.addOns[addonName] && pricing.addOns[addonName].price !== undefined) return Number(pricing.addOns[addonName].price || 0);
        const key = Object.keys(pricing.addOns).find(k => k.toLowerCase() === String(addonName).toLowerCase());
        if (key) return Number(pricing.addOns[key]?.price ?? 0);
        return 0;
      };

      // If contract uses structured services[]
      if (Array.isArray(c.services) && c.services.length > 0) {
        for (const s of c.services) {
          try {
            const version = s.pricingVersion;
            const pricing = resolvePricing(s.serviceName, version);
            if (!pricing) {
              console.debug('[Revenue] pricing not found for', s.serviceName, 'version', version);
              continue;
            }
            const planPrice = findPlanPrice(pricing, s.subscriptionPlan);
            contractSum += planPrice;
            if (s.subscriptionAddOns) {
              for (const [addon, qty] of Object.entries(s.subscriptionAddOns)) {
                const addonPrice = findAddOnPrice(pricing, addon);
                contractSum += addonPrice * Number(qty || 0);
              }
            }
          } catch (e) {
            console.warn('Error resolving pricing for service', s.serviceName, e);
          }
        }
      } else {
        // fallback: use subscriptionPlans map and subscriptionAddOns map
        if (c.subscriptionPlans) {
          for (const [serviceName, planName] of Object.entries(c.subscriptionPlans || {})) {
            try {
              const pricing = resolvePricing(serviceName, undefined);
              if (!pricing) {
                console.debug('[Revenue] pricing not found for (map) service', serviceName);
                continue;
              }
              const planPrice = findPlanPrice(pricing, planName as string);
              contractSum += planPrice;
              const addonsForService = c.subscriptionAddOns ? (c.subscriptionAddOns as Record<string, Record<string, number>>)[serviceName] : undefined;
              if (addonsForService) {
                for (const [addon, qty] of Object.entries(addonsForService || {})) {
                  const addonPrice = findAddOnPrice(pricing, addon);
                  contractSum += addonPrice * Number(qty || 0);
                }
              }
            } catch (e) {
              console.warn('Error resolving pricing for service map', serviceName, e);
            }
          }
        }
      }

      if (contractSum === 0) {
        console.debug('[Revenue] contract contributed 0:', { user: c.userContact?.username, userId: (c as any).userId, billingPeriod: c.billingPeriod });
      }

      totalRevenue += contractSum;
    }

    return totalRevenue;
  }

  return {
    contracts,
    loading,
    error,
    totalContracts,
  plansDistribution,
  addonsByPlan,
    computeExpectedMonthlyRevenue,
    page,
    setPage,
    limit,
    setLimit,
    total,
    refresh: () => {
      if (!organizationId) return;
      setLoading(true);
      const body = serviceFilter ? { services: [serviceFilter] } : undefined;
      getContracts(apiKey, organizationId, { limit, page }, body)
        .then(result => {
          setContracts(result.data);
          setTotal(result.total);
        })
        .catch(e => setError(e.message || 'Failed to fetch contracts'))
        .finally(() => setLoading(false));
    },
    serviceFilter,
    setServiceFilter,
  };
}
