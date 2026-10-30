import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiMoreVertical, FiPlus, FiSlash } from 'react-icons/fi';

interface ServiceOptionsMenuProps {
  onAddVersion?: () => void;
  canDisableService: boolean;
  onDisableService: () => void;
}

export default function ServiceOptionsMenu({
  onAddVersion,
  canDisableService,
  onDisableService,
}: ServiceOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  if (!onAddVersion && !canDisableService) return null;

  // Cierra el menú si se hace click fuera
  function handleBlur(e: React.FocusEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setOpen(false);
    }
  }

  return (
    <div className="relative" onBlur={handleBlur} onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    }}>
      <button
        type="button"
        ref={btnRef}
        className="dark:text-white cursor-pointer min-h-11 min-w-11 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:focus:ring-indigo-600 transition"
        aria-label="Service options"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <FiMoreVertical size={22} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', duration: 0.18 }}
            className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-900 rounded-xl shadow-lg border border-gray-100 dark:border-gray-700 z-50 overflow-hidden"
          >
            {onAddVersion && <button
              type="button"
              className="cursor-pointer min-h-11 w-full flex items-center gap-2 px-4 py-3 text-sm text-indigo-700 dark:text-indigo-300 hover:bg-gray-200 dark:hover:bg-gray-800 transition font-medium"
              onClick={() => {
                setOpen(false);
                onAddVersion();
              }}
            >
              <FiPlus className="text-indigo-500 dark:text-indigo-300" /> Add Version
            </button>}
            {canDisableService && (
              <button
                type="button"
                className={`cursor-pointer min-h-11 w-full flex items-center gap-2 px-4 py-3 text-sm text-red-700 dark:text-red-400 hover:bg-gray-200 dark:hover:bg-gray-800 transition font-medium ${onAddVersion ? 'border-t border-gray-100 dark:border-gray-700' : ''}`}
                onClick={() => {
                  setOpen(false);
                  onDisableService();
                }}
              >
                <FiSlash className="text-red-500 dark:text-red-400" /> Disable Service
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
