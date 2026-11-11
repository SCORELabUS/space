import { useState, useEffect, useRef } from 'react';
import useAuth from '@/hooks/useAuth';
import { useCustomAlert } from '@/hooks/useCustomAlert';
import UsersFilters from '@/components/users/UsersFilters';
import UsersList from '@/components/users/UsersList';
import AddUserModal from '@/components/users/AddUserModal';
import { getUsers } from '@/api/users/usersApi';

// Tipado para usuario
interface UserEntry {
  username: string;
  apiKey: string;
  role: 'ADMIN' | 'USER';
}

export default function UsersPage() {
  const { user, isAuthenticated } = useAuth();
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [totalUsers, setTotalUsers] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<{
    search: string;
    pageSize: number;
  }>({
    search: '',
    pageSize: 10,
  });
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const {showAlert, alertElement} = useCustomAlert();
  const [refreshKey, setRefreshKey] = useState(0);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refresca usuarios desde el server
  const refreshUsers = () => {
    setRefreshKey(k => k + 1);
  };

  useEffect(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }

    searchDebounceRef.current = setTimeout(() => {
      setDebouncedSearch(filters.search.trim());
    }, 1000);

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, [filters.search]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const normalizedSearch = filters.search.trim();
    if (normalizedSearch !== debouncedSearch) {
      return;
    }
    
    setLoading(true);
    const offset = (page - 1) * filters.pageSize;
    let cancelled = false;

    getUsers(user.apiKey, offset, filters.pageSize, debouncedSearch)
      .then((response) => {
        if (cancelled) return;
        const data = Array.isArray(response.data) ? response.data : [];
        setUsers(data);
        setTotalUsers(response.pagination?.total ?? 0);
      })
      .catch((e) => {
        if (cancelled) return;
        showAlert(e.message ?? 'Failed to fetch users', 'danger');
        setUsers([]);
        setTotalUsers(0);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.apiKey, filters.search, filters.pageSize, page, refreshKey, debouncedSearch, showAlert]);

  const totalPages = Math.ceil(totalUsers / filters.pageSize) || 1;

  return (
    <div className="max-w-3xl mx-auto py-10 px-2 md:px-0">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-indigo-800 dark:text-gray-100">Users</h1>
        <button
          className="cursor-pointer flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold shadow hover:bg-indigo-700 dark:hover:bg-indigo-800 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:focus:ring-indigo-900"
          onClick={() => setAddUserOpen(true)}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add user
        </button>
      </div>
      {alertElement}
      <UsersFilters
        filters={filters}
        setFilters={setFilters}
        setPage={setPage}
      />
      <UsersList
        users={users}
        loading={loading}
        page={page}
        setPage={setPage}
        totalPages={totalPages}
        onUserChanged={refreshUsers}
      />
      <AddUserModal
        open={addUserOpen}
        onClose={() => setAddUserOpen(false)}
        onUserCreated={() => {
          showAlert('User created successfully', 'info');
          refreshUsers();
        }}
      />
    </div>
  );
}
