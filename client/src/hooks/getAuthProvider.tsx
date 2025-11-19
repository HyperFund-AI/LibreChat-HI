import React from 'react';
import { AuthContextProvider } from './AuthContext';
import { ClerkAuthContextProvider } from './ClerkAuthContext';

/**
 * Get the appropriate auth provider based on environment configuration
 */
export const getAuthProvider = () => {
  const useClerk = import.meta.env.VITE_CLERK_ENABLED === 'true';
  const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

  if (useClerk && clerkPublishableKey) {
    return ({ children }: { children: React.ReactNode }) => (
      <ClerkAuthContextProvider publishableKey={clerkPublishableKey}>
        {children}
      </ClerkAuthContextProvider>
    );
  }

  return ({ children }: { children: React.ReactNode }) => (
    <AuthContextProvider>{children}</AuthContextProvider>
  );
};

