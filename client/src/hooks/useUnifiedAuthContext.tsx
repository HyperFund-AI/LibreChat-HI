import { useContext } from 'react';
import { AuthContext } from './AuthContext';
import { useClerkAuthContext } from './ClerkAuthContext';

/**
 * Unified auth context hook that works with both Clerk and regular auth
 * Automatically detects which provider is available
 */
export const useUnifiedAuthContext = () => {
  const useClerk = import.meta.env.VITE_CLERK_ENABLED === 'true';
  
  if (useClerk) {
    try {
      return useClerkAuthContext();
    } catch (e) {
      // If Clerk context not available, fall back to regular auth
      // This can happen during initial render or if Clerk isn't properly initialized
      const regularContext = useContext(AuthContext);
      if (regularContext === undefined) {
        throw new Error('No auth provider available');
      }
      return regularContext;
    }
  }
  
  // Regular auth
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuthContext should be used inside AuthProvider');
  }
  return context;
};

