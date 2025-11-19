import { useUser, useAuth, ClerkProvider } from '@clerk/clerk-react';
import { useMemo, createContext, useContext, ReactNode, useEffect } from 'react';
import { useRecoilState } from 'recoil';
import { SystemRoles } from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import store from '~/store';
import { useGetRole } from '~/data-provider';
import { AuthContext } from './AuthContext';

// Use the same AuthContext instance so useAuthContext() works with both providers

/**
 * Clerk-based Auth Context Provider
 * Wraps the app with Clerk authentication and provides user context
 */
const ClerkAuthContextProvider = ({
  children,
  publishableKey,
}: {
  children: ReactNode;
  publishableKey: string;
}) => {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkAuthContextInner>{children}</ClerkAuthContextInner>
    </ClerkProvider>
  );
};

const ClerkAuthContextInner = ({ children }: { children: ReactNode }) => {
  const { user: clerkUser, isLoaded: clerkLoaded } = useUser();
  const { isSignedIn, getToken } = useAuth();
  const [user, setUser] = useRecoilState(store.user);

  // Fetch user roles from backend
  const { data: userRole = null } = useGetRole(SystemRoles.USER, {
    enabled: !!(isSignedIn && (user?.role ?? '')),
  });
  const { data: adminRole = null } = useGetRole(SystemRoles.ADMIN, {
    enabled: !!(isSignedIn && user?.role === SystemRoles.ADMIN),
  });

  // Sync Clerk user with local user state
  useEffect(() => {
    if (!clerkLoaded) {
      return;
    }

    if (!isSignedIn || !clerkUser) {
      setUser(undefined);
      return;
    }

    // Get auth token from Clerk and fetch user from backend
    const syncUser = async () => {
      try {
        const token = await getToken();
        if (!token) {
          return;
        }

        // Fetch user from backend (which will sync with Clerk)
        const response = await fetch('/api/user', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const userData = await response.json();
          setUser(userData);
        } else if (response.status === 401) {
          // If backend returns 401, user might not be synced yet - retry once
          console.warn('[ClerkAuthContext] Backend returned 401, retrying sync...');
          setTimeout(async () => {
            try {
              const retryToken = await getToken();
              if (retryToken) {
                const retryResponse = await fetch('/api/user', {
                  headers: {
                    Authorization: `Bearer ${retryToken}`,
                  },
                });
                if (retryResponse.ok) {
                  const userData = await retryResponse.json();
                  setUser(userData);
                }
              }
            } catch (error) {
              console.error('[ClerkAuthContext] Retry sync failed:', error);
            }
          }, 1000);
        }
      } catch (error) {
        console.error('Failed to fetch user from backend:', error);
      }
    };

    syncUser();
  }, [clerkUser, isSignedIn, clerkLoaded, getToken, setUser]);

  const logout = async (redirect?: string) => {
    const { signOut } = await import('@clerk/clerk-react');
    await signOut();
    setUser(undefined);
    if (redirect) {
      window.location.href = redirect;
    }
  };

  const login = (data: t.TLoginUser) => {
    // Clerk handles login through its UI components
    // This is kept for compatibility but redirects to Clerk sign-in
    window.location.href = '/login';
  };

  const memoedValue = useMemo(
    () => ({
      user,
      token: undefined, // Clerk manages tokens internally
      error: undefined,
      login,
      logout,
      setError: () => {}, // Clerk handles errors
      roles: {
        [SystemRoles.USER]: userRole,
        [SystemRoles.ADMIN]: adminRole,
      },
      // For Clerk, isAuthenticated should be true if Clerk says user is signed in
      // The backend sync will happen asynchronously, but we shouldn't block on it
      isAuthenticated: isSignedIn,
    }),
    [user, isSignedIn, userRole, adminRole],
  );

  return <AuthContext.Provider value={memoedValue}>{children}</AuthContext.Provider>;
};

const useClerkAuthContext = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useClerkAuthContext should be used inside ClerkAuthContextProvider');
  }
  return context;
};

export { ClerkAuthContextProvider, useClerkAuthContext };

