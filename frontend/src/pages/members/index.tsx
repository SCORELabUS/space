import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiUserPlus, FiTrash2, FiSearch, FiLogOut, FiX } from 'react-icons/fi';
import useAuth from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { useCustomAlert } from '@/hooks/useCustomAlert';
import { useCustomConfirm } from '@/hooks/useCustomConfirm';
import { getOrganization, getOrganizations, addMember, removeMember, updateMemberRole, updateOrganization } from '@/api/organizations/organizationsApi';
import { searchUsers } from '@/api/users/usersApi';
import type { OrganizationMember } from '@/types/Organization';

interface SelectedUser {
  username: string;
  role: 'ADMIN' | 'MANAGER' | 'EVALUATOR';
}

export default function MembersPage() {
  const { user, isAuthenticated } = useAuth();
  const { currentOrganization, setCurrentOrganization, setOrganizations } = useOrganization();
  const { showAlert } = useCustomAlert();
  const { showConfirm, confirmElement } = useCustomConfirm();

  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [owner, setOwner] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<SelectedUser[]>([]);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ username: string; role: string }>>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string>('');
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSearchQueryRef = useRef<string>('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentOrganization?.id) return;
    loadMembers();
  }, [currentOrganization?.id]);

  // Debounced user search
  useEffect(() => {
    const trimmedQuery = userSearchQuery.trim();
    latestSearchQueryRef.current = trimmedQuery;

    if (!trimmedQuery || trimmedQuery.length < 4) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }

    // Clear previous timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // Set new timeout for debouncing
    debounceTimeoutRef.current = setTimeout(async () => {
      if (!isAuthenticated) return;
      
      setIsSearching(true);
      try {
        const results = await searchUsers(user.apiKey, trimmedQuery, 10);
        if (latestSearchQueryRef.current !== trimmedQuery) {
          return;
        }
        // Filter out already selected users and current members
        const filteredResults = results.data.filter(
          (result) =>
            !selectedUsers.some((selected) => selected.username === result.username) &&
            !members.some((member) => member.username === result.username) &&
            result.username !== owner
        );
        setSearchResults(filteredResults);
        setShowDropdown(true);
      } catch (error) {
        console.error('Failed to search users:', error);
        if (latestSearchQueryRef.current === trimmedQuery) {
          setSearchResults([]);
          setShowDropdown(true);
        }
      } finally {
        if (latestSearchQueryRef.current === trimmedQuery) {
          setIsSearching(false);
        }
      }
    }, 300); // 300ms debounce delay

    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [userSearchQuery, selectedUsers, members, owner, isAuthenticated, user?.apiKey]);

  // Click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadMembers = async () => {
    if (!currentOrganization || !isAuthenticated) return;

    setLoading(true);
    try {
      const org = await getOrganization(user.apiKey, currentOrganization.id);
      setMembers(org.members || []);
      setOwner(org.owner);
    } catch (error: any) {
      showAlert('Error', error.message || 'Failed to load members');
    } finally {
      setLoading(false);
    }
  };

  const handleAddMember = async () => {
    if (!currentOrganization || !isAuthenticated) {
      setModalError('Organization or user not found');
      return;
    }

    if (selectedUsers.length === 0) {
      setModalError('Please select at least one user to add');
      return;
    }

    setIsSubmitting(true);
    setModalError('');

    const errors: string[] = [];
    let successCount = 0;

    try {
      // Add members one by one
      for (const selectedUser of selectedUsers) {
        try {
          await addMember(user.apiKey, currentOrganization.id, {
            username: selectedUser.username,
            role: selectedUser.role,
          });
          successCount++;
        } catch (error: any) {
          let errorMsg = error.message || 'Failed to add member';
          if (errorMsg.includes('does not exist')) {
            errorMsg = `User ${selectedUser.username} not found`;
          } else if (errorMsg.includes('already a member')) {
            errorMsg = `${selectedUser.username} is already a member`;
          }
          errors.push(errorMsg);
        }
      }

      // Reload members after all additions
      await loadMembers();

      // Show results
      if (successCount > 0) {
        const message =
          errors.length === 0
            ? `Successfully added ${successCount} member${successCount > 1 ? 's' : ''}`
            : `Added ${successCount} member${successCount > 1 ? 's' : ''} with ${errors.length} error${errors.length > 1 ? 's' : ''}`;
        showAlert(message, errors.length === 0 ? 'success' : 'warning');
      }

      if (errors.length > 0 && successCount === 0) {
        setModalError(errors.join('; '));
      } else {
        // Only close modal if at least one member was added successfully
        if (successCount > 0) {
          setShowAddModal(false);
          setSelectedUsers([]);
          setUserSearchQuery('');
          setModalError('');
        }
      }
    } catch (error: any) {
      setModalError(error.message || 'Failed to add members');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSelectUser = (username: string) => {
    const user = searchResults.find((u) => u.username === username);
    if (user && !selectedUsers.some((u) => u.username === username)) {
      setSelectedUsers([...selectedUsers, { username: user.username, role: 'EVALUATOR' }]);
      setUserSearchQuery('');
      setSearchResults([]);
      setShowDropdown(false);
    }
  };

  const handleRemoveSelectedUser = (username: string) => {
    setSelectedUsers(selectedUsers.filter((u) => u.username !== username));
  };

  const handleChangeSelectedUserRole = (username: string, role: 'ADMIN' | 'MANAGER' | 'EVALUATOR') => {
    setSelectedUsers(
      selectedUsers.map((u) => (u.username === username ? { ...u, role } : u))
    );
  };

  const handleRemoveMember = async (username: string) => {
    if (!currentOrganization || !isAuthenticated) return;

    const confirmed = await showConfirm(
      `Are you sure you want to remove ${username} from the organization?`,
      'danger'
    );

    if (!confirmed) return;

    try {
      const updatedOrg = await removeMember(user.apiKey, currentOrganization.id, username);
      setMembers(updatedOrg.members || []);
      setOwner(updatedOrg.owner);
      showAlert('Member removed successfully', 'success');
    } catch (error: any) {
      showAlert(error.message || 'Failed to remove member', 'danger');
    }
  };

  const handleChangeRole = async (username: string, newRole: 'ADMIN' | 'MANAGER' | 'EVALUATOR') => {
    if (!currentOrganization || !isAuthenticated) return;

    try {
      const updatedOrg = await updateMemberRole(user.apiKey, currentOrganization.id, username, newRole);
      setMembers(updatedOrg.members || []);
      setOwner(updatedOrg.owner);
      showAlert('Member role updated successfully', 'success');
    } catch (error: any) {
      showAlert(error.message || 'Failed to update member role', 'danger');
    }
  };

  const filteredMembers = members.filter(member =>
    member.username.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Build display list: owner first, then other members
  const displayMembers = owner
    ? [
        { username: owner, role: 'OWNER' as const },
        ...filteredMembers
      ]
    : filteredMembers;

  // Check if current user can remove members
  const isOwner = user?.username === owner;
  const isAdmin = user?.role?.trim().toUpperCase() === 'ADMIN';
  const currentMemberRole = members.find(member => member.username === user?.username)?.role;
  const canRemoveMembers = isOwner || isAdmin;
  const canManageRoles = isAdmin || isOwner || currentMemberRole === 'ADMIN' || currentMemberRole === 'MANAGER';

  const canRemoveMember = (memberUsername: string) => {
    // Owner cannot be removed by anyone
    if (memberUsername === owner) return false;
    // Only owner or admin can remove members
    return canRemoveMembers;
  };

  const canChangeRole = (memberUsername: string, memberRole: OrganizationMember['role'] | 'OWNER') => {
    // Cannot change owner's role
    if (memberUsername === owner) return false;
    if (!canManageRoles) return false;
    if (isAdmin || isOwner || currentMemberRole === 'ADMIN') return true;
    if (currentMemberRole === 'MANAGER') {
      return memberRole === 'MANAGER' || memberRole === 'EVALUATOR';
    }
    return false;
  };

  const getAssignableRoles = () => {
    if (isAdmin || isOwner || currentMemberRole === 'ADMIN') {
      return ['ADMIN', 'MANAGER', 'EVALUATOR'] as const;
    }
    if (currentMemberRole === 'MANAGER') {
      return ['MANAGER', 'EVALUATOR'] as const;
    }
    return [] as const;
  };

  const getNextOwner = () => {
    const rolePriority: OrganizationMember['role'][] = ['ADMIN', 'MANAGER', 'EVALUATOR'];
    for (const role of rolePriority) {
      const candidate = members.find(member => member.role === role && member.username !== user?.username);
      if (candidate) return candidate.username;
    }
    return '';
  };

  const refreshOrganizations = async () => {
    if (!isAuthenticated) return;
    const orgs = await getOrganizations(user.apiKey);
    setOrganizations(orgs);
    if (orgs.length === 0) {
      setCurrentOrganization(null);
      return;
    }
    const nextOrg = orgs.find(org => org.default) || orgs[0];
    setCurrentOrganization(nextOrg);
  };

  const handleLeaveOrganization = async () => {
    if (!currentOrganization || !isAuthenticated || !user?.username) return;

    const confirmed = await showConfirm(
      'Are you sure you want to leave this organization?',
      'danger'
    );

    if (!confirmed) return;

    try {
      if (isOwner) {
        const nextOwner = getNextOwner();
        if (!nextOwner) {
          showAlert('You must transfer ownership before leaving.', 'danger');
          return;
        }

        const transferConfirmed = await showConfirm(
          `Ownership will be transferred to ${nextOwner} before you leave. Continue?`,
          'danger'
        );

        if (!transferConfirmed) return;

        const transferredOrg = await updateOrganization(user.apiKey, currentOrganization.id, {
          owner: nextOwner,
        });
        setMembers(transferredOrg.members || []);
        setOwner(transferredOrg.owner);
      }

      const updatedOrg = await removeMember(user.apiKey, currentOrganization.id, user.username);
      setMembers(updatedOrg.members || []);
      setOwner(updatedOrg.owner);
      await refreshOrganizations();
      showAlert('You left the organization successfully.', 'success');
    } catch (error: any) {
      showAlert(error.message || 'Failed to leave organization', 'danger');
    }
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'OWNER':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
      case 'ADMIN':
        return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      case 'MANAGER':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      case 'EVALUATOR':
        return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500 dark:text-gray-400">Loading members...</div>
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
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">
          Organization Members
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Manage members and their roles in {currentOrganization.name}
        </p>
      </motion.div>

      {/* Owner Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mb-6 p-4 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-indigo-900 dark:text-indigo-300">Owner:</span>
          <span className="text-sm text-indigo-700 dark:text-indigo-400">{owner}</span>
          <span className="ml-auto px-2 py-1 text-xs font-medium bg-indigo-200 text-indigo-900 dark:bg-indigo-800 dark:text-indigo-100 rounded">
            Full Control
          </span>
        </div>
      </motion.div>

      {/* Search and Add Button */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="flex gap-4 mb-6"
      >
        <div className="flex-1 relative">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search members..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <button
          onClick={() => {
            setShowAddModal(true);
            setSelectedUsers([]);
            setUserSearchQuery('');
            setModalError('');
          }}
          className="cursor-pointer flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
        >
          <FiUserPlus size={20} />
          <span>Add Member</span>
        </button>
      </motion.div>

      {/* Members List */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden"
      >
        {displayMembers.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            {searchTerm ? 'No members found matching your search' : 'No members yet'}
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {displayMembers.map((member, index) => (
              <motion.div
                key={member.username}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                className="p-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                      <span className="text-indigo-600 dark:text-indigo-400 font-semibold">
                        {member.username.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {member.username}
                      </div>
                      {canChangeRole(member.username, member.role) && member.role !== 'OWNER' ? (
                        <select
                          value={member.role}
                          onChange={(e) => handleChangeRole(member.username, e.target.value as 'ADMIN' | 'MANAGER' | 'EVALUATOR')}
                          className={`cursor-pointer px-2 py-1 text-xs font-medium rounded mt-1 border-0 focus:ring-2 focus:ring-indigo-500 ${getRoleBadgeColor(member.role)}`}
                        >
                          {getAssignableRoles().map(role => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                      ) : (
                        <div
                          className={`inline-block px-2 py-1 text-xs font-medium rounded mt-1 ${getRoleBadgeColor(member.role)}`}
                        >
                          {member.role}
                        </div>
                      )}
                    </div>
                  </div>
                  {member.username === user?.username ? (
                    <button
                      onClick={handleLeaveOrganization}
                      className="cursor-pointer p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                      title="Leave organization"
                    >
                      <FiLogOut size={18} />
                    </button>
                  ) : canRemoveMember(member.username) ? (
                    <button
                      onClick={() => handleRemoveMember(member.username)}
                      className="cursor-pointer p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                      title="Remove member"
                    >
                      <FiTrash2 size={18} />
                    </button>
                  ) : (
                    <div className="p-2 text-gray-300 dark:text-gray-600" title="Cannot remove this member">
                      <FiTrash2 size={18} />
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>

      {/* Add Member Modal */}
      <AnimatePresence>
        {showAddModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 z-40"
              onClick={() => {
                setShowAddModal(false);
                setModalError('');
              }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
            >
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6">
                <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-4">
                  Add Members
                </h2>
                {modalError && (
                  <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg">
                    <p className="text-sm text-red-700 dark:text-red-300">{modalError}</p>
                  </div>
                )}
                
                <div className="space-y-4">
                  {/* User Search Input with Autocomplete */}
                  <div className="relative" ref={dropdownRef}>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Search Users
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={userSearchQuery}
                        onChange={(e) => setUserSearchQuery(e.target.value)}
                        placeholder="Type username to search..."
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        autoComplete="off"
                      />
                      {isSearching && (
                        <div className="absolute right-3 top-1/2 -translate-y-1/2">
                          <div className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                        </div>
                      )}
                    </div>

                    {/* Autocomplete Dropdown */}
                    <AnimatePresence>
                      {showDropdown && userSearchQuery.trim().length >= 2 && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          transition={{ duration: 0.15 }}
                          className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg shadow-lg max-h-48 overflow-y-auto"
                        >
                          {searchResults.length > 0 ? (
                            searchResults.map((result) => (
                              <button
                                key={result.username}
                                onClick={() => handleSelectUser(result.username)}
                                className="cursor-pointer w-full px-3 py-2 text-left hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors flex items-center gap-2"
                              >
                                <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center flex-shrink-0">
                                  <span className="text-indigo-600 dark:text-indigo-400 font-semibold text-sm">
                                    {result.username.charAt(0).toUpperCase()}
                                  </span>
                                </div>
                                <div>
                                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                    {result.username}
                                  </div>
                                  <div className="text-xs text-gray-500 dark:text-gray-400">
                                    {result.role}
                                  </div>
                                </div>
                              </button>
                            ))
                          ) : (
                            !isSearching && (
                              <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                                No users found
                              </div>
                            )
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Selected Users (Chips) */}
                  {selectedUsers.length > 0 && (
                    <div className="space-y-3">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Selected Members ({selectedUsers.length})
                      </label>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        <AnimatePresence>
                          {selectedUsers.map((selectedUser) => (
                            <motion.div
                              key={selectedUser.username}
                              initial={{ opacity: 0, scale: 0.95 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.95 }}
                              transition={{ duration: 0.15 }}
                              className="flex items-center gap-3 p-2 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg"
                            >
                              <div className="flex items-center gap-2 flex-1">
                                <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center flex-shrink-0">
                                  <span className="text-indigo-600 dark:text-indigo-400 font-semibold text-sm">
                                    {selectedUser.username.charAt(0).toUpperCase()}
                                  </span>
                                </div>
                                <span className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-shrink-0">
                                  {selectedUser.username}
                                </span>
                              </div>
                              <select
                                value={selectedUser.role}
                                onChange={(e) =>
                                  handleChangeSelectedUserRole(
                                    selectedUser.username,
                                    e.target.value as 'ADMIN' | 'MANAGER' | 'EVALUATOR'
                                  )
                                }
                                className={`cursor-pointer px-2 py-1 text-xs font-medium rounded border-0 focus:ring-2 focus:ring-indigo-500 ${getRoleBadgeColor(selectedUser.role)}`}
                              >
                                <option value="EVALUATOR">EVALUATOR</option>
                                <option value="MANAGER">MANAGER</option>
                                <option value="ADMIN">ADMIN</option>
                              </select>
                              <button
                                onClick={() => handleRemoveSelectedUser(selectedUser.username)}
                                className="cursor-pointer p-1 text-red-600 hover:bg-red-100 dark:hover:bg-red-900/20 rounded transition-colors"
                                title="Remove"
                              >
                                <FiX size={16} />
                              </button>
                            </motion.div>
                          ))}
                        </AnimatePresence>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => {
                      setShowAddModal(false);
                      setSelectedUsers([]);
                      setUserSearchQuery('');
                      setModalError('');
                    }}
                    className="cursor-pointer flex-1 px-4 py-2 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddMember}
                    disabled={isSubmitting || selectedUsers.length === 0}
                    className="cursor-pointer flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? `Adding ${selectedUsers.length}...` : `Add ${selectedUsers.length || ''} Member${selectedUsers.length !== 1 ? 's' : ''}`}
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      
      {/* Confirm Dialog */}
      {confirmElement}
    </div>
  );
}
