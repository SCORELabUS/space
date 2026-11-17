import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiEdit2, FiUsers, FiChevronDown, FiChevronUp, FiCheck, FiTrash2 } from 'react-icons/fi';
import useAuth from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import type { Organization } from '@/types/Organization';
import {
  updateOrganization,
  deleteOrganization,
} from '@/api/organizations/organizationsApi';
import { useCustomAlert } from '@/hooks/useCustomAlert';
import { useCustomConfirm } from '@/hooks/useCustomConfirm';

const ROLE_COLORS: Record<string, string> = {
  ADMIN: 'text-red-600 bg-red-50 dark:bg-red-900 dark:text-red-200',
  MANAGER: 'text-yellow-600 bg-yellow-50 dark:bg-yellow-900 dark:text-yellow-200',
  EVALUATOR: 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900 dark:text-indigo-200',
};

export default function OrganizationsList({
  organizations,
  loading,
  page,
  setPage,
  totalPages,
  onOrganizationChanged,
}: {
  organizations: Organization[];
  loading: boolean;
  page: number;
  setPage: (page: number) => void;
  totalPages: number;
  onOrganizationChanged?: () => void;
}) {
  const { user: loggedUser, refreshOrganizations } = useAuth();
  const { switchOrganization, currentOrganization } = useOrganization();
  const [editing, setEditing] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [membersDropdown, setMembersDropdown] = useState<string | null>(null);
  const { showAlert, alertElement } = useCustomAlert();
  const { showConfirm, confirmElement } = useCustomConfirm();
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setMembersDropdown(null);
      }
    }

    if (membersDropdown !== null) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [membersDropdown]);

  async function handleEditName(org: Organization) {
    setEditing(org.id);
    setNameDraft(org.name);
  }

  async function handleSaveName(orgId: string, currentName: string) {
    if (!nameDraft || nameDraft === currentName) {
      setEditing(null);
      return;
    }
    try {
      await updateOrganization(loggedUser.apiKey, orgId, { name: nameDraft });
      showAlert('Organization name updated successfully', 'info');
      setEditing(null);
      // Refresh organizations in context
      await refreshOrganizations();
      if (onOrganizationChanged) onOrganizationChanged();
    } catch (e) {
      showAlert((e as Error).message, 'danger');
    }
  }

  async function handleDeleteOrganization(org: Organization) {
    showConfirm(
      `Are you sure you want to permanently delete the organization "${org.name}"? This action cannot be undone and all organization data will be lost.`,
      'danger'
    )
      .then(async confirmed => {
        if (confirmed) {
          await deleteOrganization(loggedUser.apiKey, org.id);
          showAlert('Organization deleted successfully', 'info');
          // Refresh organizations in context
          await refreshOrganizations();
          if (onOrganizationChanged) onOrganizationChanged();
        }
      })
      .catch(e => {
        showAlert(e.message, 'danger');
      });
  }

  async function handleLoadOrganization(org: Organization) {
    switchOrganization(org.id);
    showAlert(`Switched to organization: ${org.name}`, 'info');
  }

  return (
    <div className="rounded-xl bg-white/80 dark:bg-gray-900 shadow border border-gray-100 dark:border-gray-800 overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
              Owner
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
              Members
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800">
          {loading ? (
            <tr>
              <td colSpan={4} className="py-10 text-center text-indigo-500 font-semibold">
                Loading organizations...
              </td>
            </tr>
          ) : organizations.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-10 text-center text-gray-400 font-medium">
                No organizations found
              </td>
            </tr>
          ) : (
            organizations.map((org: Organization) => (
              <tr key={org.id} className={`hover:bg-indigo-50/30 transition ${currentOrganization?.id === org.id ? 'bg-indigo-50/50 dark:bg-indigo-900/20' : ''}`}>
                {/* Editable name */}
                <td className="px-4 py-3">
                  {editing === org.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        className="dark:text-white rounded border border-gray-200 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        value={nameDraft}
                        onChange={e => setNameDraft(e.target.value)}
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveName(org.id, org.name);
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                      <button
                        className="text-indigo-600 hover:text-indigo-900 dark:text-white font-bold text-xs cursor-pointer"
                        onClick={() => handleSaveName(org.id, org.name)}
                      >
                        Save
                      </button>
                      <button
                        className="text-gray-400 hover:text-gray-600 font-bold text-xs cursor-pointer"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span
                        className="text-sm text-indigo-800 dark:text-white font-semibold cursor-pointer hover:underline"
                        onClick={() => handleEditName(org)}
                      >
                        {org.name}
                      </span>
                      <FiEdit2
                        className="text-gray-400 cursor-pointer hover:text-indigo-500"
                        size={15}
                        onClick={() => handleEditName(org)}
                      />
                      {currentOrganization?.id === org.id && (
                        <span className="ml-2 px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200">
                          Active
                        </span>
                      )}
                    </div>
                  )}
                </td>
                {/* Owner */}
                <td className="px-4 py-3">
                  <span className="text-sm text-gray-700 dark:text-gray-300">{org.ownerAlias ?? org.owner}</span>
                </td>
                {/* Members dropdown */}
                <td className="px-4 py-3">
                  <div className="relative inline-block" ref={membersDropdown === org.id ? dropdownRef : null}>
                    <button
                      className="px-3 py-1 rounded-lg border border-gray-200 text-xs font-semibold flex items-center gap-1 bg-gray-50 text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700 dark:hover:bg-gray-700 cursor-pointer transition"
                      onClick={() =>
                        setMembersDropdown(membersDropdown === org.id ? null : org.id)
                      }
                    >
                      <FiUsers size={14} />
                      {org.members?.length || 0} members
                      {membersDropdown === org.id ? (
                        <FiChevronUp size={14} className="cursor-pointer" />
                      ) : (
                        <FiChevronDown size={14} className="cursor-pointer" />
                      )}
                    </button>
                    <AnimatePresence>
                      {membersDropdown === org.id && (
                        <motion.div
                          initial={{ opacity: 0, y: -8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -8 }}
                          transition={{ type: 'spring', duration: 0.18 }}
                          className="absolute left-0 mt-2 w-64 bg-white rounded-xl shadow-lg border border-gray-100 z-50 overflow-hidden dark:bg-gray-800 dark:border-gray-700"
                        >
                          <div className="max-h-48 overflow-y-auto">
                            {org.members && org.members.length > 0 ? (
                              org.members.map((member) => (
                                <div
                                  key={member.username}
                                  className="px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center justify-between"
                                >
                                  <span className="text-sm text-gray-700 dark:text-gray-200 font-medium">
                                    {member.identityAlias ?? member.username}
                                  </span>
                                  <span className={`px-2 py-0.5 text-xs font-semibold rounded ${ROLE_COLORS[member.role] || 'bg-gray-100 text-gray-600'}`}>
                                    {member.role}
                                  </span>
                                </div>
                              ))
                            ) : (
                              <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                                No members
                              </div>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </td>
                {/* Actions */}
                <td className="px-4 py-3">
                  <div className="flex gap-2 items-center justify-end">
                    <button
                      className="flex items-center gap-1 px-3 py-1 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 text-xs font-semibold cursor-pointer transition-all dark:bg-indigo-900 dark:text-indigo-200 dark:hover:bg-indigo-800"
                      onClick={() => handleLoadOrganization(org)}
                      disabled={currentOrganization?.id === org.id}
                    >
                      <FiCheck size={14} className="cursor-pointer" /> 
                      {currentOrganization?.id === org.id ? 'Loaded' : 'Load'}
                    </button>
                    <button
                      className="flex items-center gap-1 px-3 py-1 rounded bg-red-50 text-red-700 hover:bg-red-100 text-xs font-semibold cursor-pointer transition-all dark:bg-red-900 dark:text-red-200 dark:hover:bg-red-800"
                      onClick={() => handleDeleteOrganization(org)}
                      title="Delete organization"
                    >
                      <FiTrash2 size={14} />
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {/* Paginación debajo de la tabla */}
      <div className="flex justify-center gap-2 items-center py-4 bg-gray-50 dark:bg-gray-800">
        <button
          className="px-3 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 cursor-pointer dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm font-medium"
          onClick={() => setPage(page - 1)}
          disabled={page <= 1}
        >
          Prev
        </button>
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {page} / {totalPages}
        </span>
        <button
          className="px-3 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 cursor-pointer dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 text-sm font-medium"
          onClick={() => setPage(page + 1)}
          disabled={page >= totalPages}
        >
          Next
        </button>
      </div>
      {alertElement}
      {confirmElement}
    </div>
  );
}
