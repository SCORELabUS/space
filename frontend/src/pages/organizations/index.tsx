import { useState, useEffect } from 'react';
import useAuth from '@/hooks/useAuth';
import { useCustomAlert } from '@/hooks/useCustomAlert';
import OrganizationsFilters from '@/components/organizations/OrganizationsFilters';
import OrganizationsList from '@/components/organizations/OrganizationsList';
import { getOrganizationsPaginated } from '@/api/organizations/organizationsApi';
import type { Organization } from '@/types/Organization';

export default function OrganizationsPage() {
  const { user, isAuthenticated } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [totalOrganizations, setTotalOrganizations] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<{
    search: string;
    pageSize: number;
  }>({
    search: '',
    pageSize: 10,
  });
  const [page, setPage] = useState(1);
  const { showAlert, alertElement } = useCustomAlert();
  const [refreshKey, setRefreshKey] = useState(0);

  // Refresca organizaciones desde el server
  const refreshOrganizationsList = () => {
    setRefreshKey(k => k + 1);
  };

  useEffect(() => {
    if (!isAuthenticated) return;

    setLoading(true);
    const offset = (page - 1) * filters.pageSize;
    getOrganizationsPaginated(user.apiKey, offset, filters.pageSize, filters.search)
      .then((response) => {
        const data = Array.isArray(response.data) ? response.data : [];
        setOrganizations(data);
        setTotalOrganizations(response.pagination?.total ?? 0);
      })
      .catch((e) => {
        showAlert(e.message ?? 'Failed to fetch organizations', 'danger');
        setOrganizations([]);
        setTotalOrganizations(0);
      })
      .finally(() => setLoading(false));
  }, [isAuthenticated, user?.apiKey, filters, page, refreshKey]);

  const totalPages = Math.ceil(totalOrganizations / filters.pageSize) || 1;

  return (
    <div className="max-w-6xl mx-auto py-10 px-2 md:px-0">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-indigo-800 dark:text-gray-100">Organizations</h1>
      </div>
      {alertElement}
      <OrganizationsFilters
        filters={filters}
        setFilters={setFilters}
      />
      <OrganizationsList
        organizations={organizations}
        loading={loading}
        page={page}
        setPage={setPage}
        totalPages={totalPages}
        onOrganizationChanged={refreshOrganizationsList}
      />
    </div>
  );
}
