import SphereFields from './services/SphereFields';
import { createSphereService, sphereError } from '@/api/services/sphereApi';
import type { SphereConfig, SyntaxUpgrade } from '@/api/services/sphereApi';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Service } from '@/types/Services';
import { createService } from '@/api/services/servicesApi';
import useAuth from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import FileOrUrlInput from './FileOrUrlInput';
import CustomSelect from './CustomSelect';


interface AddServiceModalProps {
  open: boolean;
  onClose: (service?: Service) => void;
}

export default function AddServiceModal({ open, onClose }: AddServiceModalProps) {
  const [source, setSource] = useState<'file' | 'url' | 'sphere'>('file');
  const [sphere, setSphere] = useState<SphereConfig>({ permanentUrl: '', policy: 'new_last', pollIntervalMinutes: 5 });
  const [validated, setValidated] = useState(false);
  const [syntaxUpgrade, setSyntaxUpgrade] = useState<SyntaxUpgrade>();
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement;
    dialog.current?.focus();
    return () => previous?.focus();
  }, [open]);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const { user } = useAuth();
  const { currentOrganization } = useOrganization();



  const handleUpload = async () => {
    if (!currentOrganization) { setError('Please select an organization first.'); return; }
    if (busy) return;
    if (source === 'sphere' && (!validated || (sphere.policy.endsWith('_pick') && !sphere.selectedVersionId))) {
      setError('Check the SPHERE pricing and select a public version.'); return;
    }
    if (source === 'sphere' && syntaxUpgrade && sphere.acceptedSyntaxUpgradeVersionId !== syntaxUpgrade.versionId) {
      setError('Confirm the Pricing2Yaml update before linking this service.'); return;
    }
    if (source === 'file' && (!file || !/\.ya?ml$/i.test(file.name))) { setError('Please select a YAML file.'); return; }
    if (source === 'url') {
      try { const parsed = new URL(url); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(); }
      catch { setError('Please provide a valid YAML URL.'); return; }
    }
    setBusy(true); setError('');
    try {
      const service = source === 'sphere' ? await createSphereService(user.apiKey, currentOrganization.id, sphere)
        : await createService(user.apiKey, currentOrganization.id, source === 'file' ? file! : url);
      setFile(null); setUrl(''); setValidated(false); setSyntaxUpgrade(undefined); setSphere({ permanentUrl: '', policy: 'new_last', pollIntervalMinutes: 5 }); onClose(service);
    } catch (error) { setError(sphereError(error)); } finally { setBusy(false); }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 dark:bg-black/60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', duration: 0.3 }}
            ref={dialog} role="dialog" aria-modal="true" aria-labelledby="add-service-title" tabIndex={-1}
            onKeyDown={event => {
              if (event.key === 'Escape' && !busy) onClose(undefined);
              if (event.key === 'Tab') {
                const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, a[href]') ?? [])];
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
              }
            }}
            className="h-[90vh] max-h-[90vh] overflow-hidden bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 sm:p-8 max-w-lg w-[calc(100%-2rem)] flex flex-col items-center border border-indigo-100 dark:border-gray-800"
          >
            <div className="min-h-0 flex-1 w-full overflow-y-auto pr-1">
              <h2 id="add-service-title" className="text-xl font-bold text-indigo-700 dark:text-gray-100 mb-2 text-center">Add New Service</h2>
              <p className="text-gray-600 dark:text-gray-300 mb-4 text-center">
                Add a pricing file, a YAML URL, or a live link to SPHERE.
              </p>
              <label className="w-full mb-4 text-gray-700 dark:text-gray-200">Pricing source
                <CustomSelect className="mt-1 min-h-11 w-full rounded-lg border border-indigo-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-800 dark:text-gray-100 shadow-sm hover:border-indigo-400 dark:hover:border-indigo-500" value={source} onChange={e => { setSource(e.target.value as typeof source); setError(''); setValidated(false); setSyntaxUpgrade(undefined); }}>
                  <option value="file">Upload YAML file</option><option value="url">YAML URL</option><option value="sphere">Link to SPHERE</option>
                </CustomSelect>
              </label>
              {source === 'sphere' ? <><SphereFields value={sphere} onChange={setSphere} apiKey={user.apiKey} organizationId={currentOrganization?.id ?? ''} onValidated={setValidated} onSyntaxUpgrade={setSyntaxUpgrade} />
                {syntaxUpgrade && <section role="alert" className="w-full rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                  <p className="font-semibold">Pricing2Yaml update required</p>
                  <p className="mt-1">The selected pricing uses syntax {syntaxUpgrade.from}. SPACE will update it to {syntaxUpgrade.to} before linking it. Review the resulting pricing after creation.</p>
                  <label className="mt-3 flex cursor-pointer items-start gap-2"><input type="checkbox" className="mt-1 cursor-pointer" checked={sphere.acceptedSyntaxUpgradeVersionId === syntaxUpgrade.versionId} onChange={event => setSphere({ ...sphere, acceptedSyntaxUpgradeVersionId: event.target.checked ? syntaxUpgrade.versionId : undefined })} />
                    <span>I understand and want to apply this update.</span>
                  </label>
                </section>}</>
                : source === 'file' ? <div className="w-full">
                  <label className="block text-gray-700 dark:text-gray-200 mb-2">Pricing file</label>
                  <FileOrUrlInput
                    file={file}
                    url=""
                    onFileChange={selectedFile => { setFile(selectedFile); setError(''); }}
                    onUrlChange={() => undefined}
                    accept=".yaml,.yml"
                    showUrl={false}
                  />
                </div>
                : <label className="w-full text-gray-700 dark:text-gray-200">YAML URL<input type="url" className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 p-2" value={url} onChange={e => setUrl(e.target.value)} /></label>}
              {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
            </div>
            <div className="flex-shrink-0 z-10 bg-white dark:bg-gray-900 flex gap-3 mt-4 pt-4 border-t border-gray-200 dark:border-gray-800 w-full">
              <button
                className="cursor-pointer flex-1 px-4 py-2 rounded bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-200 font-semibold hover:bg-gray-300 dark:hover:bg-gray-700 transition"
                disabled={busy} onClick={() => {
                  onClose(undefined);
                }}
              >
                Cancel
              </button>
              <button
                className="cursor-pointer flex-1 px-4 py-2 rounded bg-indigo-600 text-white font-semibold hover:bg-indigo-700 dark:hover:bg-indigo-800 transition"
                disabled={busy} onClick={handleUpload}
              >
                {busy ? 'Adding…' : source === 'sphere' ? 'Link service' : 'Add service'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
