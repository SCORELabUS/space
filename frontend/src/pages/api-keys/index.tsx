import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiKey, FiTrash2, FiCopy, FiPlus } from 'react-icons/fi';
import useAuth from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { useCustomAlert } from '@/hooks/useCustomAlert';
import { useCustomConfirm } from '@/hooks/useCustomConfirm';
import { getOrganization, createApiKey, deleteApiKey } from '@/api/organizations/organizationsApi';
import type { OrganizationApiKey } from '@/types/Organization';

export default function ApiKeysPage() {
  const { user, isAuthenticated } = useAuth();
  const { currentOrganization } = useOrganization();
  const { showAlert } = useCustomAlert();
  const { showConfirm, confirmElement } = useCustomConfirm();

  const [apiKeys, setApiKeys] = useState<OrganizationApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyScope, setNewKeyScope] = useState<'ALL' | 'MANAGEMENT' | 'EVALUATION'>('EVALUATION');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrganization?.id) return;
    loadApiKeys();
  }, [currentOrganization?.id]);

  const loadApiKeys = async () => {
    if (!currentOrganization || !isAuthenticated) return;

    setLoading(true);
    try {
      const org = await getOrganization(user.apiKey, currentOrganization.id);
      setApiKeys(org.apiKeys || []);
    } catch (error: any) {
      showAlert('Error', error.message || 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateApiKey = async () => {
    if (!currentOrganization || !isAuthenticated) return;

    setIsSubmitting(true);
    try {
      const updatedOrg = await createApiKey(user.apiKey, currentOrganization.id, {
        scope: newKeyScope,
      });
      setApiKeys(updatedOrg.apiKeys || []);
      setShowAddModal(false);
      setNewKeyScope('EVALUATION');
      showAlert('API key created successfully', 'success');
    } catch (error: any) {
      showAlert(error.message || 'Failed to create API key', 'danger');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteApiKey = async (key: string) => {
    if (!currentOrganization || !isAuthenticated) return;

    const confirmed = await showConfirm(
      'Are you sure you want to delete this API key? This action cannot be undone.',
      'danger'
    );

    if (!confirmed) return;

    try {
      const updatedOrg = await deleteApiKey(user.apiKey, currentOrganization.id, key);
      setApiKeys(updatedOrg.apiKeys || []);
      showAlert('API key deleted successfully', 'success');
    } catch (error: any) {
      showAlert(error.message || 'Failed to delete API key', 'danger');
    }
  };

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const getScopeBadgeColor = (scope: string) => {
    switch (scope) {
      case 'ALL':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
      case 'MANAGEMENT':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      case 'EVALUATION':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300';
    }
  };

  const getScopeDescription = (scope: string) => {
    switch (scope) {
      case 'ALL':
        return 'Full access to all organization resources and management';
      case 'MANAGEMENT':
        return 'Full access to resources with limited management operations';
      case 'EVALUATION':
        return 'Read-only access to services and feature evaluation';
      default:
        return '';
    }
  };

  const maskApiKey = (key: string) => {
    if (key.length <= 12) return key;
    return `${key.substring(0, 12)}${'•'.repeat(32)}${key.substring(key.length - 8)}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500 dark:text-gray-400">Loading API keys...</div>
      </div>
    );
  }

  if (!currentOrganization) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500 dark:text-gray-400">Please select an organization</div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">API Keys</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Manage API keys for programmatic access to {currentOrganization.name}
        </p>
      </motion.div>

      {/* Create API Key Button */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mb-6"
      >
        <button
          onClick={() => setShowAddModal(true)}
          className="cursor-pointer flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
        >
          <FiPlus size={20} />
          <span>Create API Key</span>
        </button>
      </motion.div>

      {/* API Keys List */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="space-y-4"
      >
        {apiKeys.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-8 text-center text-gray-500 dark:text-gray-400">
            No API keys yet. Create one to get started.
          </div>
        ) : (
          apiKeys.map((apiKey, index) => (
            <motion.div
              key={apiKey.key}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
              className="bg-white dark:bg-gray-800 rounded-lg shadow p-6"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg">
                      <FiKey className="text-indigo-600 dark:text-indigo-400" size={20} />
                    </div>
                    <div>
                      <div
                        className={`inline-block px-2 py-1 text-xs font-medium rounded ${getScopeBadgeColor(apiKey.scope)}`}
                      >
                        {apiKey.scope}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {getScopeDescription(apiKey.scope)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm bg-gray-100 dark:bg-gray-900 px-3 py-2 rounded font-mono text-gray-800 dark:text-gray-200 overflow-x-auto">
                      {maskApiKey(apiKey.key)}
                    </code>
                    <button
                      onClick={() => handleCopyKey(apiKey.key)}
                      className="cursor-pointer p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                      title="Copy API key"
                    >
                      {copiedKey === apiKey.key ? (
                        <span className="text-green-600 dark:text-green-400 text-xs font-medium">
                          Copied!
                        </span>
                      ) : (
                        <FiCopy size={18} />
                      )}
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteApiKey(apiKey.key)}
                  className="cursor-pointer p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors flex-shrink-0"
                  title="Delete API key"
                >
                  <FiTrash2 size={18} />
                </button>
              </div>
            </motion.div>
          ))
        )}
      </motion.div>

      {/* Create API Key Modal */}
      <AnimatePresence>
        {showAddModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 z-40"
              onClick={() => setShowAddModal(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
            >
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
                <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                  Create API Key
                </h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Scope
                    </label>
                    <select
                      value={newKeyScope}
                      onChange={e =>
                        setNewKeyScope(e.target.value as 'ALL' | 'MANAGEMENT' | 'EVALUATION')
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="EVALUATION">EVALUATION</option>
                      <option value="MANAGEMENT">MANAGEMENT</option>
                      <option value="ALL">ALL</option>
                    </select>
                    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                      {getScopeDescription(newKeyScope)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="cursor-pointer flex-1 px-4 py-2 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateApiKey}
                    disabled={isSubmitting}
                    className="cursor-pointer flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      {confirmElement}
    </div>
  );
}
