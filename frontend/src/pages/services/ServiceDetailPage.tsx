import SphereSyncPanel from '@/components/services/SphereSyncPanel';
import { getSynchronization } from '@/api/services/sphereApi';
import type { SyncState } from '@/api/services/sphereApi';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  changePricingAvailability,
  disableService,
  getPricingsFromService,
} from '@/api/services/servicesApi';
import useAuth from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { motion } from 'framer-motion';
import DragDropPricings from '../../components/drag-and-drop-pricings';
import type { Pricing, Service } from '@/types/Services';
import { useCustomAlert } from '@/hooks/useCustomAlert';
import AddVersionModal from '../../components/AddVersionModal';
import ServiceOptionsMenu from '../../components/ServiceOptionsMenu';
import { useCustomConfirm } from '@/hooks/useCustomConfirm';

export default function ServiceDetailPage() {
  const { name } = useParams<{ name: string }>();
  const { user } = useAuth();
  const { currentOrganization } = useOrganization();
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [activePricings, setActivePricings] = useState<Pricing[]>([]);
  const [archivedPricings, setArchivedPricings] = useState<Pricing[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<null | { pricing: Pricing; to: 'active' | 'archived' }>(
    null
  );
  const { showAlert, alertElement } = useCustomAlert();
  const [addVersionOpen, setAddVersionOpen] = useState(false);
  const { showConfirm, confirmElement } = useCustomConfirm();

  const router = useNavigate();

  useEffect(() => {
    if (!currentOrganization?.id) return;
    let mounted = true;
    setLoading(true);
    Promise.all([
      getPricingsFromService(user.apiKey, currentOrganization.id, name!, 'active'),
      getPricingsFromService(user.apiKey, currentOrganization.id, name!, 'archived'),
    ]).then(([active, archived]) => {
      if (mounted) {
        setActivePricings(active);
        setArchivedPricings(archived);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, [name, user.apiKey, currentOrganization?.id]);

  useEffect(() => {
    if (!currentOrganization?.id || !name) return;
    const controller = new AbortController();
    const refresh = () => getSynchronization(user.apiKey, currentOrganization.id, name, controller.signal)
      .then(state => { if (!controller.signal.aborted) setSyncState(state); }).catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [name, user.apiKey, currentOrganization?.id]);

  function handleMove(pricing: Pricing, to: 'active' | 'archived' | 'deleted') {
    if (to === 'deleted') {
      setActivePricings(activePricings.filter(p => p.version !== pricing.version));
      setArchivedPricings(archivedPricings.filter(p => p.version !== pricing.version));
    } else {
      // Solo mostrar confirmación si la disponibilidad realmente cambia
      const isActive = activePricings.some(p => p.version === pricing.version);
      const isArchived = archivedPricings.some(p => p.version === pricing.version);
      if ((to === 'archived' && isActive) || (to === 'active' && isArchived)) {
        setConfirm({ pricing, to });
      }
    }
  }

  function confirmArchive() {
    if (!confirm || !currentOrganization?.id) return;
    changePricingAvailability(user.apiKey, currentOrganization.id, name!, confirm.pricing.version, confirm.to)
      .then(() => {
        if (confirm.to === 'archived') {
          setActivePricings(activePricings.filter(p => p.version !== confirm.pricing.version));
          setArchivedPricings([...archivedPricings, confirm.pricing]);
        } else {
          setArchivedPricings(archivedPricings.filter(p => p.version !== confirm.pricing.version));
          setActivePricings([...activePricings, confirm.pricing]);
        }
      })
      .catch(async error => {
        console.log(error.message);
        await showAlert(error.message);
      });
    setConfirm(null);
  }

  async function handleAddVersionClose(service?: Service) {
    if (service && currentOrganization?.id) {
      const [serviceActivePricings, serviceArchivedPricings] = await Promise.all([
        getPricingsFromService(user.apiKey, currentOrganization.id, service.name, 'active'),
        getPricingsFromService(user.apiKey, currentOrganization.id, service.name, 'archived'),
      ]);

      // Actualizar las listas de precios después de agregar una nueva versión
      setActivePricings(serviceActivePricings);
      setArchivedPricings(serviceArchivedPricings);
    }

    setAddVersionOpen(false);
  }

  // Handler para el menú de opciones
  function handleDisableService() {
    if (!currentOrganization?.id) return;
    showConfirm(
      `Are you sure you want to disable service ${name}? This action is potentially destructive. It will remove this service from all contracts. Any contract that includes only this service will be deactivated.`,
      'danger'
    ).then(confirmed => {
      if (confirmed && currentOrganization?.id) {
        disableService(user.apiKey, currentOrganization.id, name!)
          .then(async isDisabled => {
            if (!isDisabled) {
              await showAlert(`Service ${name} could not be disabled. Please try again later.`);
            } else {
              await showAlert(`Service ${name} has been successfully disabled.`);
              router('/services');
            }
          })
          .catch(error => {
            showAlert(`Failed to disable service ${name}. Error: ${error.message}`);
          });
      }
    });
  }

  return (
    <div className={`${syncState?.source === 'sphere' ? 'max-w-6xl' : 'max-w-2xl'} mx-auto py-8 px-4 sm:px-6`}>
      {alertElement}
      {confirmElement}
      {syncState?.source === 'sphere' && <button type="button" onClick={() => router('/services')} className="cursor-pointer mb-5 min-h-11 text-sm font-medium text-gray-500 hover:text-indigo-600 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-gray-400 dark:hover:text-indigo-300">← Services / Pricing overview</button>}
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-3xl font-bold text-indigo-800 dark:text-gray-100">{name}</h1>
        {syncState?.source !== 'sphere' && <ServiceOptionsMenu
          onAddVersion={() => setAddVersionOpen(true)}
          onDisableService={handleDisableService}
        />}
      </div>
      {syncState?.source === 'sphere' && <p className="mb-7 text-sm text-gray-500 dark:text-gray-400">Monitor pricing releases, synchronization and contract updates in one place.</p>}
      {syncState?.source === 'sphere' && currentOrganization && <SphereSyncPanel state={syncState} apiKey={user.apiKey} organizationId={currentOrganization.id} service={name!} onChange={setSyncState} canManage={user.role === 'ADMIN' || currentOrganization.owner === user.username || currentOrganization.members.some(member => member.username === user.username && ['ADMIN', 'MANAGER'].includes(member.role))} />}
      <AddVersionModal
        open={addVersionOpen}
        onClose={handleAddVersionClose}
        serviceName={name ?? ''}
      />
      {syncState?.source !== 'sphere' && <p className="text-gray-500 dark:text-gray-300 mb-6">All pricing versions for this service. Drag & drop to archive a pricing.</p>}
      {syncState?.source === 'sphere' ? null : loading ? (
        <div className="flex flex-col items-center py-20">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
            className="rounded-full border-4 border-indigo-300 border-t-indigo-600 dark:border-indigo-700 dark:border-t-indigo-400 w-12 h-12 mb-4"
            style={{ borderRightColor: 'transparent' }}
          />
          <span className="text-indigo-600 dark:text-indigo-300 font-medium mt-2">Loading pricings...</span>
        </div>
      ) : (
        <DragDropPricings
          activePricings={activePricings}
          archivedPricings={archivedPricings}
          onMove={handleMove}
        />
      )}
      {/* Confirmación personalizada */}
      {confirm && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/60"
        >
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl p-8 max-w-sm w-full flex flex-col items-center border border-gray-100 dark:border-gray-800">
            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-2">
              {confirm.to === 'archived' ? 'Archive pricing version?' : 'Activate pricing version?'}
            </h2>
            <p className="text-gray-600 dark:text-gray-300 mb-4 text-center">
              You are about to {confirm.to === 'archived' ? 'archive' : 'activate'} the pricing
              version <span className="font-mono text-indigo-700 dark:text-indigo-300">{confirm.pricing.version}</span>.
              {confirm.to === 'archived' && (
                <>
                  This means that all users whose contracts include this pricing version will be
                  novated to the most recent remaining active version.
                </>
              )}
              <br />
              This action will move it to the {confirm.to === 'archived'
                ? 'archived'
                : 'active'}{' '}
              section.
            </p>
            <div className="flex gap-4 mt-2">
              <button
                className="px-4 py-2 rounded bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-200 font-semibold hover:bg-gray-300 dark:hover:bg-gray-700 transition"
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded bg-indigo-600 text-white font-semibold hover:bg-indigo-700 dark:hover:bg-indigo-800 transition"
                onClick={confirmArchive}
              >
                Yes, {confirm.to === 'archived' ? 'archive' : 'activate'}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
