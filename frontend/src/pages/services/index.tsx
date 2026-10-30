import { getServices } from "@/api/services/servicesApi";
import { useEffect, useState } from "react";
import type { Service, ServiceQueryFilters } from "@/types/Services";
import useAuth from "@/hooks/useAuth";
import { useOrganization } from "@/hooks/useOrganization";
import ServicesLoader from "../../components/services-loader";
import ServicesFilters from "../../components/services-filters";
import { useNavigate } from "react-router";
import { motion, AnimatePresence } from "framer-motion";
import { FiServer } from "react-icons/fi";
import AddServiceModal from '../../components/AddServiceModal';

function AddServiceButton({ onClick, small = false }: { onClick: () => void; small?: boolean }) {
  return (
    <button
      className={`flex items-center gap-2 cursor-pointer ${small ? 'px-3 py-2 text-sm' : 'px-5 py-3'} rounded-lg bg-indigo-600 text-white font-semibold shadow hover:bg-indigo-700 transition focus:outline-none focus:ring-2 focus:ring-indigo-300 ${small ? '' : 'mx-auto'}`}
      onClick={onClick}
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
      </svg>
      Add Service
    </button>
  );
}

export default function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [filters, setFilters] = useState<ServiceQueryFilters>({ page: 1, limit: 10, order: 'asc' });
  const [loading, setLoading] = useState<boolean>(true);
  const [total, setTotal] = useState<number>(0);
  const [addModalOpen, setAddModalOpen] = useState(false);

  const { user } = useAuth();
  const { currentOrganization } = useOrganization();
  const navigate = useNavigate();

  function handleCreateClose(service?: Service) {
    if (service) {
      setServices(prev => [...prev, service]);
      setTotal(prev => prev + 1);
    }
    
    setAddModalOpen(false)
  }

  useEffect(() => {
    if (!currentOrganization) return;
    let cancelled = false;
    setLoading(true);
    getServices(user.apiKey, currentOrganization.id, { ...filters, page: 1, limit: 1000, order: 'asc' }).then((data: Service[]) => {
      if (!cancelled) setTotal(data.length);
    }).catch(() => { if (!cancelled) setTotal(0); });
    getServices(user.apiKey, currentOrganization.id, filters).then((data: Service[]) => {
      if (!cancelled) { setServices(data); setLoading(false); }
    }).catch(() => { if (!cancelled) { setServices([]); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filters, user.apiKey, currentOrganization]);

  const totalPages = Math.max(1, Math.ceil(total / (filters.limit ?? 10)));
  const currentPage = filters.page ?? 1;

  const isTrulyEmpty = total === 0 && !loading;

  return (
    <div className="max-w-3xl mx-auto py-10 px-2 md:px-0">
      {!isTrulyEmpty && (
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl font-bold text-indigo-800 dark:text-gray-100">Services Management</h1>
          <AddServiceButton onClick={() => setAddModalOpen(true)} small />
        </div>
      )}
      <p className="text-gray-500 dark:text-gray-300 mb-6">Browse and manage all available services. Click on a service to view its pricing versions and details.</p>
      <AddServiceModal open={addModalOpen} onClose={handleCreateClose} />
      <ServicesFilters filters={filters} setFilters={setFilters} />
      {loading ? (
        <ServicesLoader />
      ) : isTrulyEmpty ? (
        <motion.div
          key="empty-true"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="flex flex-col items-center justify-center py-24"
        >
          <div className="text-2xl font-bold text-indigo-700 dark:text-gray-100 mb-2">No services found</div>
          <div className="text-gray-500 dark:text-gray-300 mb-6 text-center max-w-md">It looks like you haven't created any services yet. Start by adding your first service to manage pricing versions and more!</div>
          <AddServiceButton onClick={() => setAddModalOpen(true)} />
        </motion.div>
      ) : (
        <>
          <AnimatePresence>
            {services.length === 0 ? (
              <motion.div
                key="empty-filter"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="text-center text-gray-400 dark:text-gray-500 py-20"
              >
                No services found with the current filters.
              </motion.div>
            ) : (
              <motion.div layout className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {services.map(service => (
                  <motion.button
                    key={service.name}
                    layout
                    whileHover={{ scale: 1.03, boxShadow: "0 4px 24px 0 rgba(99,102,241,0.10)" }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => navigate(`/services/${encodeURIComponent(service.name)}`)}
                    className="flex items-center gap-4 w-full bg-white/80 dark:bg-gray-900 rounded-lg shadow border border-gray-200 dark:border-gray-800 px-6 py-5 transition cursor-pointer hover:bg-indigo-50 dark:hover:bg-gray-800 focus:outline-none"
                  >
                    <span className="bg-indigo-100 dark:bg-gray-800 text-indigo-600 dark:text-indigo-300 rounded-full p-2">
                      <FiServer size={28} />
                    </span>
                    <div className="flex-1 text-left">
                      <div className="font-semibold text-lg text-indigo-800 dark:text-gray-100">{service.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-300 mt-1">
                        {Object.keys(service.activePricings).length} active pricing{Object.keys(service.activePricings).length === 1 ? '' : 's'}
                        {service.archivedPricings && Object.keys(service.archivedPricings).length > 0 && (
                          <span> &middot; {Object.keys(service.archivedPricings).length} archived</span>
                        )}
                      </div>
                    </div>
                  </motion.button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-6">
              <button
                className="px-3 py-1 rounded border text-sm font-medium bg-white dark:bg-gray-900 shadow hover:bg-indigo-50 dark:hover:bg-gray-800 disabled:opacity-50 dark:text-gray-200 dark:border-gray-800"
                onClick={() => setFilters(f => ({ ...f, page: Math.max(1, currentPage - 1) }))}
                disabled={currentPage === 1}
              >
                Previous
              </button>
              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={`page-${i+1}`}
                  className={`px-3 py-1 rounded border text-sm font-medium ${currentPage === i + 1 ? 'bg-indigo-100 dark:bg-gray-800 text-indigo-700 dark:text-indigo-300 border-indigo-400 dark:border-indigo-600' : 'bg-white dark:bg-gray-900 hover:bg-indigo-50 dark:hover:bg-gray-800 dark:text-gray-200 dark:border-gray-800'}`}
                  onClick={() => setFilters(f => ({ ...f, page: i + 1 }))}
                >
                  {i + 1}
                </button>
              ))}
              <button
                className="px-3 py-1 rounded border text-sm font-medium bg-white dark:bg-gray-900 shadow hover:bg-indigo-50 dark:hover:bg-gray-800 disabled:opacity-50 dark:text-gray-200 dark:border-gray-800"
                onClick={() => setFilters(f => ({ ...f, page: Math.min(totalPages, currentPage + 1) }))}
                disabled={currentPage === totalPages}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
