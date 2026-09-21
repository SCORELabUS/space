import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface FileOrUrlInputProps {
  file: File | null;
  url: string;
  onFileChange: (f: File | null) => void;
  onUrlChange: (u: string) => void;
  accept?: string;
  placeholder?: string;
  error?: string;
  showUrl?: boolean;
}

export default function FileOrUrlInput({
  file,
  url,
  onFileChange,
  onUrlChange,
  accept = '.yml,.yaml',
  placeholder = 'Enter direct URL to .yml or .yaml pricing file',
  error,
  showUrl = true,
}: FileOrUrlInputProps) {
  const [dragActive, setDragActive] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (selected: File | null) => {
    setLocalError(null);
    if (selected) {
      // accept may be a comma-separated list like '.yml,.yaml'.
      // Build a proper alternation regex: (?:\.yml|\.yaml)$
      const parts = accept.split(',').map(p => p.trim()).filter(Boolean);
      const escaped = parts.map(p => p.replace(/\./g, '\\.'));
      const pattern = `(?:${escaped.join('|')})$`;
      if (!new RegExp(pattern, 'i').test(selected.name)) {
        setLocalError(`Unsupported file type. Allowed: ${parts.join(', ')}`);
        onFileChange(null);
        return;
      }
    }
    onFileChange(selected);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFile(e.target.files?.[0] || null);
    if (e.target.files) e.currentTarget.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    // Some browsers populate dataTransfer.items instead of files when dragging
    // from certain sources—use items as fallback to get the File object.
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
      return;
    }

    if (e.dataTransfer.items && e.dataTransfer.items[0]) {
      const item = e.dataTransfer.items[0];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        handleFile(file || null);
        return;
      }
    }
    // If nothing found, clear selection
    handleFile(null);
  };

  const handleDrag = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  return (
    <div className="w-full">
      <AnimatePresence>
        <motion.div
          className={`w-full flex flex-col items-center justify-center border-2 border-dashed rounded-lg transition-all duration-200 cursor-pointer ${
            dragActive ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-900/40' : 'border-indigo-200 dark:border-gray-600 bg-indigo-100/60 dark:bg-gray-800/60'
          }`}
          onClick={() => inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDrag}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          role="button"
          tabIndex={0}
          aria-label="Select a YAML pricing file"
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          style={{ minHeight: 120 }}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={handleFileChange}
          />
          <div className="flex flex-col items-center py-6">
            <svg
              className="w-10 h-10 text-indigo-400 dark:text-indigo-300 mb-2"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-8m0 0l-4 4m4-4l4 4m-8 8h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-indigo-700 dark:text-indigo-200 font-medium">Drag & drop your .yml or .yaml file here</span>
            <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">or click to select a file</span>
            {file && <span className="mt-2 text-indigo-600 dark:text-indigo-200 text-sm font-semibold">{file.name}</span>}
            {localError && <div className="mt-2 text-red-500 text-sm">{localError}</div>}
          </div>
        </motion.div>
      </AnimatePresence>

      {showUrl && <div className="mt-3">
        <label className="block text-xs font-semibold text-indigo-700 dark:text-white mb-1">Or provide URL</label>
        <input
          type="url"
          placeholder={placeholder}
          value={url}
          onChange={e => onUrlChange(e.target.value)}
          className="w-full rounded px-3 py-2 border border-indigo-700 bg-white dark:bg-gray-900 dark:border-gray-700 text-sm text-indigo-700 dark:text-indigo-200 placeholder:text-gray-500 dark:placeholder:text-white"
        />
        {error && <div className="text-red-500 dark:text-red-400 text-sm mt-2">{error}</div>}
      </div>}
      {!showUrl && error && <div className="text-red-500 dark:text-red-400 text-sm mt-2">{error}</div>}
    </div>
  );
}
