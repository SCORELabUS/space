import { BrowserRouter, Route, Routes, Navigate, useLocation } from "react-router";
import SphereAuthPage from '../pages/sphere-auth';
import MainPage from "../pages/main";
import LoggedLayout from "@/layouts/logged-view";
import MembersPage from "@/pages/members";
import ApiKeysPage from "@/pages/api-keys";
import ServicesPage from "@/pages/services";
import ServiceDetailPage from "@/pages/services/ServiceDetailPage";
import SettingsPage from "@/pages/settings";
import ContractsDashboard from "@/pages/contracts/ContractsDashboard";
import ContractDetailPage from "@/pages/contracts/ContractDetailPage";
import InstanceMonitoringPage from "@/pages/instance-monitoring";
import OrganizationSettingsPage from "@/pages/organization-settings";
import RegisterPage from "@/pages/register";
import NotFoundPage from "@/pages/not-found";
import UsersPage from "@/pages/users";
import OrganizationsPage from "@/pages/organizations";
import useAuth from "@/hooks/useAuth";
import type { ReactNode } from "react";

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to={`/`} state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

function RequireRole({ children, allowedRoles }: { children: ReactNode; allowedRoles: string[] }) {
  const { user } = useAuth();
  const userRole = user?.role?.trim().toUpperCase();
  
  if (!allowedRoles.map(r => r.toUpperCase()).includes(userRole)) {
    return <NotFoundPage />;
  }
  
  return <>{children}</>;
}

export function SpaceRouter() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<MainPage/>}/>
        <Route path="/auth/sphere" element={<SphereAuthPage/>}/>
        <Route path="/register" element={<RegisterPage/>}/>
        <Route path="/contracts/dashboard" element={<RequireAuth><LoggedLayout><ContractsDashboard/></LoggedLayout></RequireAuth>} />
        <Route path="/contracts/:userId" element={<RequireAuth><LoggedLayout><ContractDetailPage/></LoggedLayout></RequireAuth>} />
        <Route path="/instance-monitoring" element={<RequireAuth><RequireRole allowedRoles={['ADMIN']}><LoggedLayout><InstanceMonitoringPage/></LoggedLayout></RequireRole></RequireAuth>} />
        <Route path="/users" element={<RequireAuth><RequireRole allowedRoles={['ADMIN']}><LoggedLayout><UsersPage/></LoggedLayout></RequireRole></RequireAuth>} />
        <Route path="/organizations" element={<RequireAuth><RequireRole allowedRoles={['ADMIN']}><LoggedLayout><OrganizationsPage/></LoggedLayout></RequireRole></RequireAuth>} />
        <Route path="/members" element={<RequireAuth><LoggedLayout><MembersPage/></LoggedLayout></RequireAuth>}/>
        <Route path="/api-keys" element={<RequireAuth><LoggedLayout><ApiKeysPage/></LoggedLayout></RequireAuth>}/>
        <Route path="/services" element={<RequireAuth><LoggedLayout><ServicesPage/></LoggedLayout></RequireAuth>}/>
        <Route path="/services/:name" element={<RequireAuth><LoggedLayout><ServiceDetailPage/></LoggedLayout></RequireAuth>}/>
        <Route path="/settings" element={<RequireAuth><LoggedLayout><SettingsPage/></LoggedLayout></RequireAuth>}/>
        <Route path="/organization-settings" element={<RequireAuth><LoggedLayout><OrganizationSettingsPage/></LoggedLayout></RequireAuth>}/>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}