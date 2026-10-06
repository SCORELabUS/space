import type { Pricing } from '@/types/Services';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiZap, FiArchive, FiMoreVertical, FiDownload, FiExternalLink } from 'react-icons/fi';
import { useCustomConfirm } from '@/hooks/useCustomConfirm';
import { deletePricingVersion, getPublicPricingUrl } from '@/api/services/servicesApi';
import useAuth from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { useCustomAlert } from '@/hooks/useCustomAlert';

interface DragDropPricingsProps {
  activePricings: Pricing[];
  archivedPricings: Pricing[];
  onMove: (pricing: Pricing, to: 'active' | 'archived' | 'deleted', toIndex?: number) => void;
}

export default function DragDropPricings({
  activePricings,
  archivedPricings,
  onMove,
}: DragDropPricingsProps) {
  const [dragged, setDragged] = useState<null | { pricing: Pricing; from: 'active' | 'archived' }>(
    null
  );
  const [dropTarget, setDropTarget] = useState<null | { to: 'active' | 'archived'; index: number }>(
    null
  );
  const [overDelete, setOverDelete] = useState(false);
  const [openMenuVersion, setOpenMenuVersion] = useState<string | null>(null);
  const [menuActionLoadingVersion, setMenuActionLoadingVersion] = useState<string | null>(null);
  const {showConfirm, confirmElement} = useCustomConfirm();
  const {showAlert, alertElement} = useCustomAlert();

  const { user } = useAuth();
  const { currentOrganization } = useOrganization();
  const serviceName = decodeURIComponent(window.location.pathname.split('/').pop() || '');

  function getAbsoluteUrlFromPath(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }

    const apiBaseUrl = (import.meta.env.VITE_SPACE_BASE_URL ?? 'http://localhost:3000/api/v1').replace(/\/+$/, '');
    const apiOrigin = apiBaseUrl.replace(/\/api\/v1$/, '');
    const withoutPublicPrefix = path.startsWith('public/') ? path.replace(/^public\/+/, '') : path;
    const normalizedPath = withoutPublicPrefix.startsWith('/') ? withoutPublicPrefix : `/${withoutPublicPrefix}`;

    // The API URL may be relative (/api/v1) in the release image; resolve it against this origin.
    return `${new URL(apiOrigin || '/', window.location.origin).href.replace(/\/+$/, '')}${normalizedPath}`;
  }

  async function resolvePublicYamlUrl(pricing: Pricing): Promise<string | null> {
    if (pricing.yamlPath) {
      return getAbsoluteUrlFromPath(pricing.yamlPath);
    }

    if (!currentOrganization?.id) {
      await showAlert('Organization not found. Please select an organization and try again.');
      return null;
    }

    try {
      setMenuActionLoadingVersion(pricing.version);
      const result = await getPublicPricingUrl(
        user.apiKey,
        currentOrganization.id,
        serviceName,
        pricing.version
      );
      return result.url;
    } catch (error: any) {
      await showAlert(error.message || 'Failed to prepare public pricing YAML URL');
      return null;
    } finally {
      setMenuActionLoadingVersion(null);
    }
  }

  async function resolveViewYamlUrl(pricing: Pricing): Promise<string | null> {
    if (pricing.url) {
      return getAbsoluteUrlFromPath(pricing.url);
    }

    return resolvePublicYamlUrl(pricing);
  }

  async function downloadYamlFile(url: string, fileName: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  }

  async function handleViewYaml(pricing: Pricing) {
    const yamlUrl = await resolveViewYamlUrl(pricing);

    if (!yamlUrl) {
      return;
    }

    window.open(yamlUrl, '_blank', 'noopener,noreferrer');
  }

  async function handleDownloadYaml(pricing: Pricing) {
    const yamlUrl = await resolveViewYamlUrl(pricing);

    if (!yamlUrl) {
      return;
    }

    await downloadYamlFile(yamlUrl, `${pricing.version}.yaml`);
  }

  async function handleOpenInSphere(pricing: Pricing) {
    const publicYamlUrl = await resolvePublicYamlUrl(pricing);

    if (!publicYamlUrl) {
      return;
    }

    const sphereUrl = `https://sphere.score.us.es/editor?pricingUrl=${encodeURI(publicYamlUrl)}`;
    window.open(sphereUrl, '_blank', 'noopener,noreferrer');
  }

  function handleDragStart(e: React.DragEvent, pricing: Pricing, from: 'active' | 'archived') {
    setDragged({ pricing, from });
    e.dataTransfer.effectAllowed = 'move';
    // Para Firefox
    e.dataTransfer.setData('text/plain', pricing.version);
  }
  function handleDragEnd() {
    setDragged(null);
    setDropTarget(null);
  }
  function handleDragOver(e: React.DragEvent, to: 'active' | 'archived', index: number) {
    e.preventDefault();
    setDropTarget({ to, index });
  }
  function handleDrop(e: React.DragEvent, to: 'active' | 'archived', index: number) {
    e.preventDefault();
    if (
      dragged &&
      (dragged.from !== to ||
        dragged.pricing.version !==
          (to === 'active' ? activePricings[index]?.version : archivedPricings[index]?.version))
    ) {
      onMove(dragged.pricing, to, index);
    }
    setDragged(null);
    setDropTarget(null);
  }
  function handleListDrop(e: React.DragEvent, to: 'active' | 'archived') {
    e.preventDefault();
    if (dragged) {
      onMove(dragged.pricing, to, undefined);
    }
    setDragged(null);
    setDropTarget(null);
  }

  // Zona de eliminación
  function handleDeleteDrop(e: React.DragEvent) {
    e.preventDefault();
    if (dragged && currentOrganization?.id) {
      showConfirm(
        `Are you sure you want to delete version ${dragged.pricing.version}?`,
        'danger'
      ).then(confirmed => {
        if (confirmed && currentOrganization?.id) {
          deletePricingVersion(user.apiKey, currentOrganization.id, serviceName, dragged.pricing.version)
            .then(isDeleted => {
              if (isDeleted) {
                onMove(dragged.pricing, 'deleted');
              }
            })
            .catch(error => {
              showAlert(error.message || 'Failed to delete pricing version');
            });
        }
        setDragged(null);
        setOverDelete(false);
      });
    }
  }

  function renderList(pricings: Pricing[], type: 'active' | 'archived') {
    return (
      <motion.ul
        layout
        className={`space-y-2 min-h-[60px] ${
          type === 'active'
            ? 'bg-green-50/30 border-green-100 dark:bg-green-900/30 dark:border-green-800'
            : 'bg-gray-50/50 border-gray-200 dark:bg-gray-900/40 dark:border-gray-800'
        } rounded-lg p-2 border relative`}
        onDragOver={e => {
          e.preventDefault();
          // Calcular la posición exacta del hueco
          const bounding = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const offsetY = e.clientY - bounding.top;
          let index = pricings.length;
          let accHeight = 0;
          for (let i = 0; i < pricings.length; i++) {
            const el = document.getElementById(`${type}-pricing-${pricings[i].version}`);
            if (el) {
              const elHeight = el.offsetHeight + 8; // 8px de gap
              if (offsetY < accHeight + elHeight / 2) {
                index = i;
                break;
              }
              accHeight += elHeight;
            }
          }
          setDropTarget({ to: type, index });
        }}
        onDrop={e => handleListDrop(e, type)}
      >
        {pricings.map((pricing, i) => (
          <div key={pricing.version} className="relative">
            {/* Hueco animado */}
            <AnimatePresence>
              {dropTarget && dropTarget.to === type && dropTarget.index === i && (
                <motion.div
                  layoutId={`drop-gap-${type}-${i}`}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 56, opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="rounded border-2 border-dashed border-indigo-400 bg-indigo-100/40 my-1"
                />
              )}
            </AnimatePresence>
            <li
              id={`${type}-pricing-${pricing.version}`}
              draggable
              onDragStart={e => handleDragStart(e, pricing, type)}
              onDragEnd={handleDragEnd}
              onDragOver={e => handleDragOver(e, type, i)}
              onDrop={e => handleDrop(e, type, i)}
              className={`bg-white/80 dark:bg-gray-900 rounded shadow border border-gray-200 dark:border-gray-800 px-4 py-3 flex flex-col md:flex-row md:items-center gap-2 cursor-move hover:bg-$
                {type === 'active' ? 'green-50 dark:bg-green-900/40' : 'gray-100 dark:bg-gray-800/60'} transition $
                {dragged && dragged.pricing.version === pricing.version ? 'opacity-40' : ''}`}
              style={{ zIndex: dragged && dragged.pricing.version === pricing.version ? 50 : 1 }}
            >
              <span className="font-mono text-xs bg-gray-100 dark:bg-gray-800 rounded px-2 py-0.5 text-indigo-700 dark:text-indigo-300">
                {pricing.version}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-300">{pricing.currency}</span>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {new Date(pricing.createdAt).toLocaleDateString()}
                </span>
                <div
                  className="relative"
                  tabIndex={0}
                  onBlur={e => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setOpenMenuVersion(null);
                    }
                  }}
                >
                  <button
                    type="button"
                    draggable={false}
                    aria-label={`Pricing ${pricing.version} options`}
                    className="cursor-pointer p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
                    onMouseDown={e => {
                      e.stopPropagation();
                    }}
                    onClick={e => {
                      e.stopPropagation();
                      setOpenMenuVersion(current =>
                        current === pricing.version ? null : pricing.version
                      );
                    }}
                  >
                    <FiMoreVertical size={14} />
                  </button>

                  <AnimatePresence>
                    {openMenuVersion === pricing.version && (
                      <motion.div
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.12 }}
                        className="absolute right-0 mt-1 w-44 bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-700 shadow-lg z-50"
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          disabled={menuActionLoadingVersion === pricing.version}
                          className="cursor-pointer w-full px-3 py-2 text-left text-xs text-indigo-700 dark:text-indigo-300 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-2 disabled:opacity-60"
                          onClick={() => {
                            setOpenMenuVersion(null);
                            void handleViewYaml(pricing);
                          }}
                        >
                          <FiExternalLink size={13} /> View YAML
                        </button>
                        <button
                          type="button"
                          disabled={menuActionLoadingVersion === pricing.version}
                          className="cursor-pointer w-full px-3 py-2 text-left text-xs text-indigo-700 dark:text-indigo-300 hover:bg-gray-100 dark:hover:bg-gray-800 border-t border-gray-100 dark:border-gray-700 flex items-center gap-2 disabled:opacity-60"
                          onClick={() => {
                            setOpenMenuVersion(null);
                            void handleDownloadYaml(pricing);
                          }}
                        >
                          <FiDownload size={13} /> Download YAML
                        </button>
                        <button
                          type="button"
                          disabled={menuActionLoadingVersion === pricing.version}
                          className="cursor-pointer w-full px-3 py-2 text-left text-xs text-indigo-700 dark:text-indigo-300 hover:bg-gray-100 dark:hover:bg-gray-800 border-t border-gray-100 dark:border-gray-700 flex items-center gap-2 disabled:opacity-60"
                          onClick={() => {
                            setOpenMenuVersion(null);
                            void handleOpenInSphere(pricing);
                          }}
                        >
                          <FiExternalLink size={13} /> View in SPHERE
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </li>
          </div>
        ))}
        {/* Hueco al final de la lista */}
        <AnimatePresence>
          {dropTarget && dropTarget.to === type && dropTarget.index === pricings.length && (
            <motion.div
              layoutId={`drop-gap-${type}-end`}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 56, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="rounded border-2 border-dashed border-indigo-400 bg-indigo-100/40 my-1"
            />
          )}
        </AnimatePresence>
      </motion.ul>
    );
  }

  return (
    <div className="flex flex-col md:flex-row gap-6 relative">
      <div className="flex-1">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase text-gray-500 mb-1 mt-2">
          <span className="text-green-500">
            <FiZap size={18} />
          </span>{' '}
          Active pricings
        </div>
        {renderList(activePricings, 'active')}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase text-gray-500 mb-1 mt-2">
          <span className="text-gray-400">
            <FiArchive size={18} />
          </span>{' '}
          Archived pricings
        </div>
        {renderList(archivedPricings, 'archived')}
      </div>
      {/* Drag preview: la tarjeta real sigue el cursor */}
      <AnimatePresence>
        {dragged && (
          <motion.div
            layoutId="dragged-card"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed pointer-events-none z-50"
            style={{ left: 0, top: 0, transform: `translate(-9999px, -9999px)` }}
          >
            {/* No se puede seguir el cursor nativamente con HTML5 DnD, pero se puede simular con libs externas si se desea */}
          </motion.div>
        )}
      </AnimatePresence>
      {/* Zona de eliminación en la parte inferior */}
      {user.role.toLowerCase() === 'admin' && (
        <AnimatePresence>
          {dragged && (
            <motion.div
              initial={{ y: 100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 100, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.3 }}
              className={`fixed left-0 right-0 bottom-0 z-40 flex items-center justify-center h-24 ${
                overDelete ? 'bg-red-600/90' : 'bg-red-500/80'
              } text-white font-bold text-lg select-none`}
              onDragOver={e => {
                e.preventDefault();
                setOverDelete(true);
              }}
              onDragEnter={e => {
                e.preventDefault();
                setOverDelete(true);
              }}
              onDragLeave={e => {
                e.preventDefault();
                setOverDelete(false);
              }}
              onDrop={handleDeleteDrop}
            >
              Drop here to <span className="ml-2">delete version</span>
            </motion.div>
          )}
        </AnimatePresence>
      )}
      {confirmElement}
      {alertElement}
    </div>
  );
}
