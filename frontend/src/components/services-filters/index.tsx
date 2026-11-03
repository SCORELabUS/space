import type { ServiceQueryFilters } from "@/types/Services";
import { FiSearch, FiSliders, FiList, FiChevronDown } from "react-icons/fi";
import { motion } from "framer-motion";

interface Props {
  readonly filters: ServiceQueryFilters;
  readonly setFilters: (f: ServiceQueryFilters) => void;
}

export default function ServicesFilters({ filters, setFilters }: Props) {
  return (
    <motion.form
      className="flex flex-wrap md:flex-nowrap gap-4 items-end mb-8 p-4 rounded-xl bg-white/70 dark:bg-gray-900 shadow border border-gray-100 dark:border-gray-800 backdrop-blur-sm"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, type: 'spring', stiffness: 80 }}
      onSubmit={e => { e.preventDefault(); }}
    >
      <div className="flex flex-col flex-grow min-w-[180px] md:min-w-0 md:basis-0">
        <label className="flex items-center gap-1 text-xs font-semibold text-gray-500 dark:text-gray-300 mb-1">
          <FiSearch className="inline-block" /> Name
        </label>
        <input
          type="text"
          value={filters.name ?? ''}
          onChange={e => setFilters({ ...filters, name: e.target.value, page: 1 })}
          className="px-3 py-2 border border-gray-300 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900 bg-white/90 dark:bg-gray-800 text-gray-800 dark:text-gray-100 shadow-sm transition w-full"
          placeholder="Service name..."
        />
      </div>
      <div className="flex flex-col min-w-[120px] md:w-40">
        <label htmlFor="service-status" className="mb-1 text-xs font-semibold text-gray-500 dark:text-gray-300">Status</label>
        <select id="service-status" value={filters.disabled ? 'disabled' : 'active'} onChange={event => setFilters({ ...filters, disabled: event.target.value === 'disabled', page: 1 })} className="cursor-pointer min-h-11 rounded-lg border border-gray-300 bg-white/90 px-3 py-2 text-gray-800 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-gray-800 dark:bg-gray-800 dark:text-gray-100">
          <option value="active">Active</option><option value="disabled">Disabled</option>
        </select>
      </div>
      <div className="flex flex-col min-w-[120px] md:w-40 relative">
        <label className="flex items-center gap-1 text-xs font-semibold text-gray-500 dark:text-gray-300 mb-1">
          <FiSliders className="inline-block" /> Order
        </label>
        <div className="relative">
          <select
            value={filters.order ?? 'asc'}
            onChange={e => setFilters({ ...filters, order: e.target.value as 'asc' | 'desc', page: 1 })}
            className="cursor-pointer appearance-none w-full px-3 py-2 border border-gray-300 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900 bg-white/90 dark:bg-gray-800 text-gray-800 dark:text-gray-100 shadow-sm transition pr-8"
          >
            <option value="asc">A-Z</option>
            <option value="desc">Z-A</option>
          </select>
          <FiChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none" size={18} />
        </div>
      </div>
      <div className="flex flex-col min-w-[120px] md:w-40 relative">
        <label className="flex items-center gap-1 text-xs font-semibold text-gray-500 dark:text-gray-300 mb-1">
          <FiList className="inline-block" /> Per page
        </label>
        <div className="relative">
          <select
            value={filters.limit ?? 10}
            onChange={e => setFilters({ ...filters, limit: Number(e.target.value), page: 1 })}
            className="cursor-pointer appearance-none w-full px-3 py-2 border border-gray-300 dark:border-gray-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900 bg-white/90 dark:bg-gray-800 text-gray-800 dark:text-gray-100 shadow-sm transition pr-8"
          >
            {[5, 10, 20, 50].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <FiChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none" size={18} />
        </div>
      </div>
    </motion.form>
  );
}
