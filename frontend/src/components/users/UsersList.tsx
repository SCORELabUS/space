import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiEdit2, FiCopy, FiKey, FiChevronDown, FiChevronUp, FiCheck } from 'react-icons/fi';
import useAuth from '@/hooks/useAuth';
import type { User } from '@/types/User';
import {
  updateUsername,
  changeUserRole,
  changeUserPassword,
  deleteUser,
} from '@/api/users/usersApi';
import { useCustomAlert } from '@/hooks/useCustomAlert';
import { useCustomConfirm } from '@/hooks/useCustomConfirm';
import ChangePasswordForm from './ChangePasswordForm';

const ROLE_COLORS: Record<string, string> = {
  ADMIN:
    'bg-red-100 text-red-700 border-red-300 dark:bg-red-900 dark:text-red-200 dark:border-red-700',
  USER:
    'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900 dark:text-blue-200 dark:border-blue-700',
};
const ROLE_TEXT_COLORS: Record<string, string> = {
  ADMIN: 'text-red-700 dark:text-red-200',
  USER: 'text-blue-700 dark:text-blue-200',
};
const ROLE_BG_HOVER: Record<string, string> = {
  ADMIN: 'hover:bg-red-100 dark:hover:bg-red-900',
  USER: 'hover:bg-blue-100 dark:hover:bg-blue-900',
};

const ROLES = ['ADMIN', 'USER'];

function censorApiKey(apiKey: string) {
  if (!apiKey) return '';
  return apiKey.slice(0, 6) + '****';
}

export default function UsersList({
  users,
  loading,
  page,
  setPage,
  totalPages,
  onUserChanged,
}: {
  users: User[];
  loading: boolean;
  page: number;
  setPage: (page: number) => void;
  totalPages: number;
  onUserChanged?: () => void;
}) {
  const { user: loggedUser, updateUser, logout, refreshOrganizations } = useAuth();
  const [editing, setEditing] = useState<string | null>(null);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [roleDropdown, setRoleDropdown] = useState<string | null>(null);
  const [passwordModal, setPasswordModal] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const {showAlert, alertElement} = useCustomAlert();
  const {showConfirm, confirmElement} = useCustomConfirm();
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setRoleDropdown(null);
      }
    }

    if (roleDropdown !== null) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [roleDropdown]);

  async function handleEditUsername(username: string) {
    setEditing(username);
    setUsernameDraft(username);
  }
  async function handleSaveUsername(username: string) {
    if (!usernameDraft || usernameDraft === username) {
      setEditing(null);
      return;
    }
    try {
      const updated = await updateUsername(loggedUser.apiKey, username, usernameDraft);
      showAlert('Username updated successfully', 'info');
      setEditing(null);
      if (username === loggedUser.username) {
        updateUser({ username: updated.username });
      }
      if (onUserChanged) onUserChanged();
    } catch (e) {
      showAlert((e as Error).message, 'danger');
    }
  }
  function handleCopy(apiKey: string, username: string) {
    navigator.clipboard.writeText(apiKey);
    setCopied(username);
    setTimeout(() => setCopied(null), 1200);
  }
  async function handleChangeRole(username: string, newRole: string) {
    // Confirmación antes de cambiar el rol
    showConfirm(
      `Are you sure you want to change the role of "${username}" to "${newRole}"?`,
      'warning'
    )
      .then(async confirmed => {
        if (confirmed) {
          const updated = await changeUserRole(
            loggedUser.apiKey,
            username,
            newRole as User['role']
          );
          showAlert('Role updated successfully', 'info');
          setRoleDropdown(null);
          if (username === loggedUser.username) {
            if (updated.role === 'USER') {
              // If admin degrades themselves to USER, logout (they lose access to this page)
              await logout();
            } else {
              updateUser({ role: updated.role });
            }
          }
        }
        if (onUserChanged) onUserChanged();
      })
      .catch(e => {
        showAlert(e.message, 'danger');
      });
  }
  // New function to pass to ChangePasswordForm
  async function handleChangePassword(username: string, password: string) {
    await changeUserPassword(loggedUser.apiKey, username, password);
    showAlert('Password changed successfully', 'info');
    setPasswordModal(null);
    if (onUserChanged) onUserChanged();
  }

  // Confirmación y borrado de usuario
  async function handleDeleteUser(username: string) {
    showConfirm(
      `Are you sure you want to permanently delete the user "${username}"? This action cannot be undone and all user data will be lost.`,
      'danger'
    )
      .then(async confirmed => {
        if (confirmed) {
          await deleteUser(loggedUser.apiKey, username);
          showAlert('User deleted successfully', 'info');
          // Refresh organizations in case the deleted user's organization was removed
          await refreshOrganizations();
          if (onUserChanged) onUserChanged();
        }
      })
      .catch(e => {
        showAlert(e.message, 'danger');
      });
  }

  return (
    <div className="rounded-xl bg-white/80 dark:bg-gray-900 shadow border border-gray-100 dark:border-gray-800 overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
              Username
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
              API Key
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
              Role
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
                Loading users...
              </td>
            </tr>
          ) : users.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-10 text-center text-gray-400 font-medium">
                No users found
              </td>
            </tr>
          ) : (
            users.map((u: User) => (
              <tr key={u.username} className="hover:bg-indigo-50/30 transition">
                {/* Editable username */}
                <td className="px-4 py-3">
                  {editing === u.username ? (
                    <div className="flex items-center gap-2">
                      <input
                        className="dark:text-white rounded border border-gray-200 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        value={usernameDraft}
                        onChange={e => setUsernameDraft(e.target.value)}
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveUsername(u.username);
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                      <button
                        className="text-indigo-600 hover:text-indigo-900 dark:text-white font-bold text-xs cursor-pointer"
                        onClick={() => handleSaveUsername(u.username)}
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
                        className="font-mono text-sm text-indigo-800 dark:text-white cursor-pointer hover:underline"
                        onClick={() => handleEditUsername(u.username)}
                      >
                        {u.username}
                      </span>
                      <FiEdit2
                        className="text-gray-400 cursor-pointer hover:text-indigo-500"
                        size={15}
                        onClick={() => handleEditUsername(u.username)}
                      />
                    </div>
                  )}
                </td>
                {/* Censored API Key and copy */}
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="dark:bg-gray-900 dark:text-white font-mono text-xs bg-gray-100 rounded px-2 py-0.5 text-gray-700 select-all">
                      {censorApiKey(u.apiKey)}
                    </span>
                    <button
                      className="dark:text-white dark:hover:text-indigo-900 p-1 rounded hover:bg-indigo-100 text-indigo-600 cursor-pointer"
                      onClick={() => handleCopy(u.apiKey, u.username)}
                      title="Copy API Key"
                    >
                      {copied === u.username ? (
                        <FiCheck size={16} className="text-green-600" />
                      ) : (
                        <FiCopy size={16} className="cursor-pointer" />
                      )}
                    </button>
                  </div>
                </td>
                {/* Rol with tag and dropdown */}
                <td className="px-4 py-3">
                  <div className="relative inline-block" ref={roleDropdown === u.username ? dropdownRef : null}>
                    <button
                      className={`px-3 py-1 rounded-full border text-xs font-semibold flex items-center gap-1 ${
                        ROLE_COLORS[u.role]
                      } cursor-pointer`}
                      onClick={() =>
                        setRoleDropdown(roleDropdown === u.username ? null : u.username)
                      }
                    >
                      {u.role}
                      {roleDropdown === u.username ? (
                        <FiChevronUp size={14} className="cursor-pointer" />
                      ) : (
                        <FiChevronDown size={14} className="cursor-pointer" />
                      )}
                    </button>
                    <AnimatePresence>
                      {roleDropdown === u.username && (
                        <motion.div
                          initial={{ opacity: 0, y: -8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -8 }}
                          transition={{ type: 'spring', duration: 0.18 }}
                          className="absolute left-0 mt-2 w-32 bg-white rounded-xl shadow-lg border border-gray-100 z-50 overflow-hidden"
                        >
                          {ROLES.filter(r => {
                            // Only show roles different from current role
                            return r !== u.role;
                          }).map(r => (
                            <button
                              key={r}
                              className={`w-full text-left px-4 py-2 text-xs font-medium bg-white ${ROLE_TEXT_COLORS[r]} ${ROLE_BG_HOVER[r]} cursor-pointer transition`}
                              onClick={() => handleChangeRole(u.username, r)}
                            >
                              {r}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </td>
                {/* Acciones */}
                <td className="px-4 py-3">
                  <div className="flex gap-2 items-center">
                    <button
                      className="flex items-center gap-1 px-3 py-1 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 text-xs font-semibold cursor-pointer disabled:opacity-50"
                      onClick={() => setPasswordModal(u.username)}
                      disabled={u.role === 'ADMIN' && loggedUser?.role !== 'ADMIN'}
                    >
                      <FiKey size={14} className="cursor-pointer" /> Change password
                    </button>
                    {loggedUser.role === 'ADMIN' && (
                      <button
                        className="flex items-center gap-1 px-3 py-1 rounded bg-red-50 text-red-700 hover:bg-red-100 text-xs font-semibold cursor-pointer transition-all"
                        onClick={() => handleDeleteUser(u.username)}
                        title="Delete user"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {/* Modal para cambiar contraseña */}
      <AnimatePresence>
        {passwordModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          >
            <ChangePasswordForm
              username={passwordModal}
              onSubmit={async (username, password) => {
                await handleChangePassword(username, password);
              }}
              onCancel={() => setPasswordModal(null)}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {/* Paginación debajo de la tabla */}
      <div className="flex justify-center gap-2 items-center py-4">
        <button
          className="px-2 py-1 rounded bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:opacity-50 cursor-pointer"
          onClick={() => setPage(page - 1)}
          disabled={page <= 1}
        >
          Prev
        </button>
        <span className="text-sm font-medium text-gray-700">
          {page} / {totalPages}
        </span>
        <button
          className="px-2 py-1 rounded bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:opacity-50 cursor-pointer"
          onClick={() => setPage(page + 1)}
          disabled={page >= totalPages}
        >
          Next
        </button>
      </div>
      {/* Justo antes del return principal, añade el alertElement para mostrar alertas */}
      {alertElement}
      {confirmElement}
    </div>
  );
}
