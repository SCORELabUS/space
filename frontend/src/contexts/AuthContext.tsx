import React, { createContext, useState, useContext, useEffect, useRef } from "react";
import axios from "../lib/axios";
import { endIdentitySession, getAuthConfig, signInWithSpacePassword, type AuthConfig } from "@/api/auth/identityApi";
import { getOrganizations } from "@/api/organizations/organizationsApi";
import { getCurrentUser } from "@/api/users/usersApi";
import { OrganizationContext } from "./OrganizationContext";

export interface UserData {
  username: string;
  apiKey: string;
  role: string;
}

export interface AuthContextType {
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  config: AuthConfig;
  acceptSession: (user: UserData) => void;
  user: UserData;
  updateUser: (newUser: Partial<UserData>) => void;
  refreshOrganizations: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const organizationContext = useContext(OrganizationContext);
  const organizationsLoadedRef = useRef(false);

  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [bootstrapError, setBootstrapError] = useState(false);
  const [retry, setRetry] = useState(0);
  const isDevelopmentEnvironment = config?.provider === 'local' && import.meta.env.VITE_ENVIRONMENT === 'development';
  const usesIdentity = config?.provider === 'scoretech';

  // Load user from localStorage if exists
  const loadStoredUser = (development: boolean): UserData => {
    if (development) {
      return {
        username: "devUser",
        apiKey: import.meta.env.VITE_SPACE_ADMIN_API_KEY,
        role: "",
      };
    }
    
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      try {
        return JSON.parse(storedUser) as UserData;
      } catch (error) {
        console.error('[AuthContext] Failed to parse stored user:', error);
      }
    }
    
    return { username: "", apiKey: "", role: "" };
  };

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<UserData>({ username: "", apiKey: "", role: "" });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function bootstrap() {
      try {
        const settings = await getAuthConfig(signal);
        let account: UserData | undefined;
        if (settings.provider === 'scoretech') {
          localStorage.removeItem('user');
          try {
            const { data } = await axios.get<Omit<UserData, 'apiKey'>>('/users/me', {
              withCredentials: true, timeout: 15_000, signal,
            });
            account = { ...data, apiKey: '' };
          } catch (error: any) {
            if (error.response?.status !== 401) throw error;
          }
        } else {
          const development = import.meta.env.VITE_ENVIRONMENT === 'development';
          const stored = loadStoredUser(development);
          if (development || stored.apiKey) account = stored;
        }
        if (signal.aborted) return;
        axios.defaults.withCredentials = settings.provider === 'scoretech';
        if (account) {
          setUser(account);
          setIsAuthenticated(true);
        }
        setConfig(settings);
      } catch {
        if (!signal.aborted) setBootstrapError(true);
      }
    }
    void bootstrap();
    return () => controller.abort();
  }, [retry]);

  // Load user role from API in development mode
  useEffect(() => {
    if (!isDevelopmentEnvironment || !user.apiKey || user.role) {
      return;
    }

    const loadUserRole = async () => {
      try {
        const currentUser = await getCurrentUser(user.apiKey);
        setUser(prev => ({
          ...prev,
          username: currentUser.username,
          role: currentUser.role
        }));
      } catch (error) {
        console.error('[AuthContext] Failed to load user role:', error);
      }
    };

    loadUserRole();
  }, [isDevelopmentEnvironment, user.apiKey, user.role]);

  // Log out when SPACE no longer recognises the stored API key (e.g. the user was
  // deleted or the database was reset). Some routes also answer 401 to a valid key
  // that lacks organization membership, so a 401 only triggers a check against
  // /users/me, and only a 401 from there ends the session.
  const logoutRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (isDevelopmentEnvironment || !isAuthenticated) {
      return;
    }

    const apiKey = user.apiKey;
    let checkingSession = false;

    const interceptor = axios.interceptors.response.use(undefined, error => {
      const sentApiKey = error.config?.headers?.get("x-api-key") ?? "";

      if (error.response?.status === 401 && sentApiKey === apiKey && !checkingSession) {
        checkingSession = true;
        axios
          .get("/users/me", { headers: { "x-api-key": apiKey }, timeout: 5000 })
          .catch(checkError => {
            if (checkError.response?.status === 401) {
              logoutRef.current();
            }
          })
          .finally(() => {
            checkingSession = false;
          });
      }

      return Promise.reject(error);
    });

    return () => {
      axios.interceptors.response.eject(interceptor);
    };
  }, [isDevelopmentEnvironment, isAuthenticated, user.apiKey]);

  // Load organizations when user is authenticated (for dev mode or after login)
  useEffect(() => {
    if (!isAuthenticated || !organizationContext) {
      return;
    }

    // Only load once per API key
    if (organizationsLoadedRef.current) {
      return;
    }

    let isMounted = true;

    const loadOrganizations = async () => {
      try {
        const organizations = await getOrganizations(user.apiKey);
        
        if (isMounted && organizations && organizations.length > 0) {
          // Mark as loaded ONLY after successful load
          organizationsLoadedRef.current = true;
          
          organizationContext.setOrganizations(organizations);
          
          // Keep the organization selected before a reload; fall back to the default one
          const savedOrgId = localStorage.getItem('currentOrganizationId');
          const initialOrg =
            organizations.find(org => org.id === savedOrgId) ||
            organizations.find(org => org.default) ||
            organizations[0];
          if (initialOrg) {
            organizationContext.setCurrentOrganization(initialOrg);
          } else {
            console.warn('[AuthContext] No default organization found, and organizations list is not empty');
          }
        } else if (isMounted) {
          console.warn('[AuthContext] No organizations returned from API');
        }
      } catch (error) {
        console.error('[AuthContext] Failed to load organizations:', error);
        // Don't mark as loaded on error so it can retry
      }
    };

    loadOrganizations();
    
    return () => {
      isMounted = false;
    };
  }, [isAuthenticated, user.apiKey, organizationContext]);

  const acceptSession = (userData: UserData) => {
    if (!['ADMIN', 'USER'].includes(userData.role) || !userData.apiKey) throw new Error('Invalid SPACE session');
    organizationsLoadedRef.current = false;
    const userInfo = { username: userData.username, apiKey: userData.apiKey, role: userData.role };
    localStorage.setItem('user', JSON.stringify(userInfo));
    setUser(userInfo);
    setIsAuthenticated(true);
  };

  const login = async (username: string, password: string) => {
    try {
      if (usesIdentity) {
        const account = await signInWithSpacePassword(username, password);
        organizationsLoadedRef.current = false;
        setUser({ ...account, apiKey: '' });
        setIsAuthenticated(true);
        return;
      }
      const response = await axios.post(
        "/users/authenticate",
        { username, password },
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      const userData = response.data;
      if (!userData) {
        throw new Error("Authentication failed");
      }

      if (userData.role !== "ADMIN" && userData.role !== "USER") {
        throw new Error("Unauthorized user. You must be ADMIN or USER to access SPACE.");
      }

      acceptSession(userData);
    } catch (error: any) {
      throw new Error(error.response?.data?.error || error.message || "Authentication failed");
    }
  };

  const clearSession = () => {
    organizationsLoadedRef.current = false;
    
    setUser({
      username: "",
      apiKey: "",
      role: "",
    });
    setIsAuthenticated(false);
    
    // Clear organization context
    if (organizationContext) {
      organizationContext.setCurrentOrganization(null);
      organizationContext.setOrganizations([]);
    }
    
    // Clear localStorage
    localStorage.removeItem('user');
    localStorage.removeItem('currentOrganizationId');
    localStorage.removeItem('organizations');
  };
  logoutRef.current = clearSession;

  const logout = async () => {
    if (usesIdentity) await endIdentitySession();
    clearSession();
  };

  // Allows updating the user from outside (e.g., after editing username or role)
  const updateUser = (newUser: Partial<UserData>) => {
    setUser((prev) => ({ ...prev, ...newUser }));
  };

  // Refresh organizations from the API
  const refreshOrganizations = async () => {
    if (!isAuthenticated || !organizationContext) {
      return;
    }

    try {
      const organizations = await getOrganizations(user.apiKey);
      
      if (organizations && organizations.length > 0) {
        organizationContext.setOrganizations(organizations);
        
        // Check if current organization still exists
        const currentOrgStillExists = organizations.find(
          org => org.id === organizationContext.currentOrganization?.id
        );
        
        if (!currentOrgStillExists) {
          // Current organization was deleted, switch to default or first
          const defaultOrg = organizations.find(org => org.default) || organizations[0];
          if (defaultOrg) {
            organizationContext.setCurrentOrganization(defaultOrg);
          }
        } else {
          // Update current organization data (in case members changed)
          organizationContext.setCurrentOrganization(currentOrgStillExists);
        }
      } else {
        // No organizations left
        organizationContext.setOrganizations([]);
        organizationContext.setCurrentOrganization(null);
      }
    } catch (error) {
      console.error('[AuthContext] Failed to refresh organizations:', error);
    }
  };

  if (!config) {
    return (
      <main className="grid min-h-screen place-content-center gap-4 bg-white p-4 text-center text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        {bootstrapError ? <>
          <p role="alert">SPACE could not check your sign-in. Please try again.</p>
          <button type="button" className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-white"
            onClick={() => { setBootstrapError(false); setRetry(value => value + 1); }}>Try again</button>
        </> : <p role="status">Checking sign-in…</p>}
      </main>
    );
  }

  return (
    <AuthContext.Provider value={{ config, isAuthenticated, login, logout, acceptSession, user, updateUser, refreshOrganizations }}>
      {children}
    </AuthContext.Provider>
  );
};
