import React, { createContext, useState, useContext, useEffect, useRef } from "react";
import axios from "../lib/axios";
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
  logout: () => void;
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

  const isDevelopmentEnvironment: boolean = import.meta.env.VITE_ENVIRONMENT === "development"

  // Load user from localStorage if exists
  const loadStoredUser = (): UserData => {
    if (isDevelopmentEnvironment) {
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

  const storedUser = loadStoredUser();
  const [isAuthenticated, setIsAuthenticated] = useState(isDevelopmentEnvironment || !!storedUser.apiKey);
  const [user, setUser] = useState<UserData>(storedUser);

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
    if (isDevelopmentEnvironment || !user.apiKey) {
      return;
    }

    const apiKey = user.apiKey;
    let checkingSession = false;

    const interceptor = axios.interceptors.response.use(undefined, error => {
      const sentApiKey = error.config?.headers?.["x-api-key"];

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
  }, [isDevelopmentEnvironment, user.apiKey]);

  // Load organizations when user is authenticated (for dev mode or after login)
  useEffect(() => {
    if (!isAuthenticated || !user.apiKey || !organizationContext) {
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

  const login = async (username: string, password: string) => {
    try {
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

      // Reset organizations loaded flag for new user
      organizationsLoadedRef.current = false;

      const userInfo = {
        username: userData.username,
        apiKey: userData.apiKey,
        role: userData.role,
      };

      // Persist user to localStorage
      localStorage.setItem('user', JSON.stringify(userInfo));

      setUser(userInfo);
      setIsAuthenticated(true);
      // Organizations will be loaded by the useEffect above
    } catch (error: any) {
      throw new Error(error.response?.data?.error || error.message || "Authentication failed");
    }
  };

  const logout = () => {
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
  logoutRef.current = logout;

  // Allows updating the user from outside (e.g., after editing username or role)
  const updateUser = (newUser: Partial<UserData>) => {
    setUser((prev) => ({ ...prev, ...newUser }));
  };

  // Refresh organizations from the API
  const refreshOrganizations = async () => {
    if (!user.apiKey || !organizationContext) {
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

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout, user, updateUser, refreshOrganizations }}>
      {children}
    </AuthContext.Provider>
  );
};
