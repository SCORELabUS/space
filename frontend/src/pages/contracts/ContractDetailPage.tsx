import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { motion } from 'framer-motion';
import useAuth from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { getContractDetail } from '@/api/contracts/contractsApi';
import type { Subscription } from '@/types/Subscription';
import ContractUserSection from '@/components/contracts/ContractUserSection';
import ContractServicesSection from '@/components/contracts/ContractServicesSection';
import ContractBillingSection from '@/components/contracts/ContractBillingSection';
import ContractAddOnsSection from '@/components/contracts/ContractAddOnsSection';
import ContractUsageLevelsSection from '@/components/contracts/ContractUsageLevelsSection';

const normalizePlanName = (plan?: string | null) => {
  const normalized = String(plan ?? '').trim();
  return normalized ? normalized.toUpperCase() : 'UNKNOWN';
};

export default function ContractDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const { currentOrganization } = useOrganization();

  const [contract, setContract] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !isAuthenticated || !currentOrganization?.id) {
      setLoading(false);
      return;
    }

    let mounted = true;

    getContractDetail(user.apiKey, currentOrganization.id, userId)
      .then(data => {
        if (mounted) {
          // Calculate createdAt from history or billingPeriod.startDate
          let calculatedCreatedAt = data.billingPeriod?.startDate;
          
          if (data.history && data.history.length > 0) {
            // Find the oldest startDate in history
            const oldestEntry = data.history.reduce((oldest, entry) => {
              if (!entry.startDate) return oldest;
              if (!oldest || new Date(entry.startDate) < new Date(oldest)) {
                return entry.startDate;
              }
              return oldest;
            }, data.billingPeriod?.startDate);
            calculatedCreatedAt = oldestEntry;
          }
          
          setContract({
            ...data,
            createdAt: calculatedCreatedAt,
            services: (data.services || []).map(service => ({
              ...service,
              subscriptionPlan: normalizePlanName(service.subscriptionPlan),
            })),
            subscriptionPlans: data.subscriptionPlans
              ? Object.fromEntries(
                  Object.entries(data.subscriptionPlans).map(([serviceName, planName]) => [
                    serviceName,
                    normalizePlanName(planName),
                  ]),
                )
              : data.subscriptionPlans,
          });
          setError(null);
        }
      })
      .catch(err => {
        if (mounted) {
          setError(err.message || 'Failed to load contract details');
          setContract(null);
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [userId, isAuthenticated, user?.apiKey, currentOrganization?.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          className="w-12 h-12 border-4 border-indigo-200 dark:border-indigo-800 border-t-indigo-600 dark:border-t-indigo-400 rounded-full"
        />
      </div>
    );
  }

  if (error || !contract) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center max-w-md"
        >
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4v.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Error Loading Contract</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6">{error || 'Contract not found'}</p>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate(`/contracts/dashboard`)}
            className="inline-flex items-center px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Dashboard
          </motion.button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto py-10 px-4 md:px-0">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex items-center justify-between mb-8"
      >
        <div>
          <div className="flex items-center gap-3 mb-2">
            <motion.button
              whileHover={{ scale: 1.1, x: -4 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => navigate(`/contracts/dashboard`)}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors cursor-pointer"
            >
              <svg className="w-6 h-6 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </motion.button>
            <h1 className="text-3xl font-bold text-indigo-800 dark:text-gray-100">Contract Details</h1>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Complete information for contract {userId}</p>
        </div>
      </motion.div>

      {/* Content Grid */}
      <div className="space-y-6">
        {/* Row 1: User Information */}
        <ContractUserSection userContact={contract.userContact} />

        {/* Row 2: Billing Information */}
        <ContractBillingSection billingPeriod={contract.billingPeriod} createdAt={contract.createdAt} />

        {/* Row 3: Usage Levels */}
        <ContractUsageLevelsSection usageLevels={contract.usageLevels} />

        {/* Row 4: Services */}
        <ContractServicesSection services={contract.services} subscriptionPlans={contract.subscriptionPlans} />

        {/* Row 5: Add-ons */}
        <ContractAddOnsSection subscriptionAddOns={contract.subscriptionAddOns} />
      </div>

      {/* Bottom Action Button */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.4 }}
        className="mt-8 flex items-center justify-center"
      >
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => navigate(`/contracts/dashboard`)}
          className="inline-flex items-center px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors shadow-lg hover:shadow-xl cursor-pointer"
        >
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Dashboard
        </motion.button>
      </motion.div>
    </div>
  );
}
