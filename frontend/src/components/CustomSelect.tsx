import { FiChevronDown } from 'react-icons/fi';
import type { SelectHTMLAttributes } from 'react';

export default function CustomSelect({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative w-full">
      <select
        {...props}
        className={`appearance-none cursor-pointer pr-10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 dark:focus-visible:ring-indigo-500/60 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
      >
        {children}
      </select>
      <FiChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-indigo-500 dark:text-indigo-300"
        size={18}
      />
    </div>
  );
}
