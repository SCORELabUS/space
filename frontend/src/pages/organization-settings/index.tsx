import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { FiSave, FiLoader, FiAlertCircle, FiArrowRight } from 'react-icons/fi';
import useAuth from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { updateOrganization, getOrganization } from '@/api/organizations/organizationsApi';
import type { Organization } from '@/types/Organization';

export default function OrganizationSettingsPage() {
  const { user, isAuthenticated } = useAuth();
  const { currentOrganization, setCurrentOrganization, setOrganizations } = useOrganization();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [organizationName, setOrganizationName] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Check permissions
  const canManageOrganization = 
    user?.role?.trim().toUpperCase() === 'ADMIN' || // Space Admin
    (organization && organization.owner === user?.username) || // Org Owner
    (organization && organization.members?.some(m => m.username === user?.username && ['ADMIN', 'MANAGER'].includes(m.role))); // Org Admin/Manager;

  const canTransferOwnership = 
    user?.role?.trim().toUpperCase() === 'ADMIN' || // Space Admin
    (organization && organization.owner === user?.username); // Org Owner only

  useEffect(() => {
    const loadOrganization = async () => {
      if (!currentOrganization?.id || !isAuthenticated) return;

      setIsLoading(true);
      setError(null);

      try {
        const response = await getOrganization(user.apiKey, currentOrganization.id);
        setOrganization(response);
        setOrganizationName(response.name);
      } catch (err: any) {
        setError(err.message || 'Failed to load organization details');
      } finally {
        setIsLoading(false);
      }
    };

    loadOrganization();
  }, [currentOrganization?.id, isAuthenticated, user?.apiKey]);

  const handleSaveName = async () => {
    if (!organization || !isAuthenticated) return;

    if (!organizationName.trim()) {
      setError('Organization name is required');
      return;
    }

    if (organizationName.trim() === organization.name) {
      setSuccess('No changes to save');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const updatedOrg = await updateOrganization(user.apiKey, organization.id, {
        name: organizationName.trim(),
      });

      // Update local state with the response
      setOrganization(updatedOrg);
      if (currentOrganization?.id === updatedOrg.id) {
        setCurrentOrganization(updatedOrg);
      }
      setOrganizations((prev: Organization[]) =>
        prev.map((org: Organization) => (org.id === updatedOrg.id ? updatedOrg : org))
      );
      setSuccess('Organization name updated successfully');
    } catch (err: any) {
      setError(err.message || 'Failed to update organization name');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTransferOwnership = async () => {
    if (!organization || !isAuthenticated || !newOwner.trim()) return;

    setIsSaving(true);
    setError(null);

    try {
      const updatedOrg = await updateOrganization(user.apiKey, organization.id, {
        owner: newOwner.trim(),
      });

      // Update local state with the response which includes updated members array
      setOrganization(updatedOrg);
      if (currentOrganization?.id === updatedOrg.id) {
        setCurrentOrganization(updatedOrg);
      }
      setOrganizations((prev: Organization[]) =>
        prev.map((org: Organization) => (org.id === updatedOrg.id ? updatedOrg : org))
      );
      setNewOwner('');
      setShowTransferConfirm(false);
      setSuccess('Ownership transferred successfully');
    } catch (err: any) {
      setError(err.message || 'Failed to transfer ownership');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <FiLoader className="animate-spin text-indigo-600" size={32} />
      </div>
    );
  }

  if (!canManageOrganization) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <FiAlertCircle className="mx-auto text-red-600 mb-4" size={48} />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
            Access Denied
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            You don't have permission to manage this organization's settings.
          </p>
        </div>
      </div>
    );
  }

  if (!organization) {
    return null;
  }

  return (
    <div className="p-24 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
          Organization Settings
        </h1>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          Manage your organization's settings and members
        </p>
      </div>

      {/* Messages */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
        >
          <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
        </motion.div>
      )}

      {success && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800"
        >
          <p className="text-sm text-green-800 dark:text-green-300">{success}</p>
        </motion.div>
      )}

      {/* Basic Settings */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-6">
          Basic Settings
        </h2>

        <div className="space-y-4">
          {/* Organization Name */}
          <div>
            <label htmlFor="org-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Organization Name
            </label>
            <div className="flex gap-3">
              <input
                id="org-name"
                type="text"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                disabled={isSaving}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 disabled:opacity-50"
              />
              <button
                onClick={handleSaveName}
                disabled={isSaving || organizationName === organization.name}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-2 transition-colors cursor-pointer"
              >
                {isSaving ? (
                  <FiLoader className="animate-spin" size={16} />
                ) : (
                  <FiSave size={16} />
                )}
                Save
              </button>
            </div>
          </div>

          {/* Organization ID */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Organization ID
            </label>
            <div className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-mono text-sm">
              {organization.id}
            </div>
          </div>

          {/* Owner Information */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Owner
            </label>
            <div className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
              {organization.owner}
              {organization.owner === user?.username && (
                <span className="ml-2 inline-block px-2 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 text-xs rounded font-medium">
                  You
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Transfer Ownership */}
      {canTransferOwnership && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-6">
            Transfer Ownership
          </h2>

          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Transfer this organization's ownership to another member.
          </p>

          {!showTransferConfirm ? (
            <button
              onClick={() => setShowTransferConfirm(true)}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-medium transition-colors cursor-pointer"
            >
              Transfer Ownership
            </button>
          ) : (
            <div className="space-y-4">
              <div>
                <label htmlFor="new-owner" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  New Owner (select a member)
                </label>
                <select
                  id="new-owner"
                  value={newOwner}
                  onChange={(e) => setNewOwner(e.target.value)}
                  disabled={isSaving}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 disabled:opacity-50"
                >
                  <option value="">Select a member...</option>
                  {organization.members.map(member => (
                    <option key={member.username} value={member.username}>
                      {member.username} ({member.role})
                    </option>
                  ))}
                </select>
              </div>

              {newOwner && (
                <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                  <p className="text-sm text-amber-800 dark:text-amber-300">
                    You are about to transfer ownership to <strong>{newOwner}</strong>. This action cannot be undone.
                  </p>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowTransferConfirm(false);
                    setNewOwner('');
                  }}
                  disabled={isSaving}
                  className="flex-1 px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg font-medium transition-colors disabled:opacity-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleTransferOwnership}
                  disabled={isSaving || !newOwner}
                  className="flex-1 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  {isSaving ? (
                    <FiLoader className="animate-spin" size={16} />
                  ) : (
                    <FiArrowRight size={16} />
                  )}
                  Confirm Transfer
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Members Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-6">
          Members ({organization.members.length})
        </h2>

        {organization.members.length === 0 ? (
          <p className="text-gray-600 dark:text-gray-400">No members in this organization.</p>
        ) : (
          <div className="space-y-2">
            {organization.members.map(member => (
              <div
                key={member.username}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                    <span className="text-indigo-600 dark:text-indigo-400 font-bold text-sm">
                      {member.username.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {member.username}
                    </p>
                    <p className="text-xs text-gray-600 dark:text-gray-400">
                      {member.role}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
