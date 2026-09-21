import React, { useEffect, useState } from "react";
import LightBackground from "@/layouts/background";
import Sidebar from "./components/sidebar";

interface LoggedLayoutProps {
  readonly children: React.ReactNode;
}

export default function LoggedLayout({ children }: LoggedLayoutProps) {
  
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const resize = () => setCollapsed(media.matches);
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);

  const paddingClass = collapsed ? 'pl-[64px]' : 'pl-[64px] md:pl-[280px]';
    
    return (
      <LightBackground>
        <div className="flex w-full min-h-screen">
          <div className={`min-w-0 flex-1 pr-0 ${paddingClass} transition-all duration-300`}>
            {children}
          </div>
          <Sidebar collapsed={collapsed} setCollapsed={setCollapsed}/>
        </div>
      </LightBackground>
    );
}
