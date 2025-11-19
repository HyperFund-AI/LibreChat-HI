import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, useUser } from '@clerk/clerk-react';

/**
 * Clerk SSO Callback Handler
 * This component handles Clerk's SSO callback and redirects to the app
 */
export default function ClerkCallback() {
  const { isSignedIn, isLoaded: authLoaded, getToken } = useAuth();
  const { user: clerkUser, isLoaded: userLoaded } = useUser();
  const navigate = useNavigate();
  const [attemptedRedirect, setAttemptedRedirect] = useState(false);
  const [backendSynced, setBackendSynced] = useState(false);

  // Sync with backend first
  useEffect(() => {
    if (!authLoaded || !userLoaded || !isSignedIn || !clerkUser || backendSynced) {
      return;
    }

    const syncWithBackend = async () => {
      try {
        const token = await getToken();
        if (!token) {
          console.error('[ClerkCallback] No token available');
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
          console.log('[ClerkCallback] Backend sync successful:', userData);
          setBackendSynced(true);
        } else {
          console.error('[ClerkCallback] Backend sync failed:', response.status, response.statusText);
        }
      } catch (error) {
        console.error('[ClerkCallback] Error syncing with backend:', error);
      }
    };

    syncWithBackend();
  }, [authLoaded, userLoaded, isSignedIn, clerkUser, getToken, backendSynced]);

  // Redirect once backend is synced
  useEffect(() => {
    if (!authLoaded || !userLoaded) {
      return;
    }

    // If not signed in after loading, redirect to login
    if (!isSignedIn && !attemptedRedirect) {
      setAttemptedRedirect(true);
      navigate('/login', { replace: true });
      return;
    }

    // If signed in and backend synced, redirect to app
    if (isSignedIn && backendSynced && !attemptedRedirect) {
      setAttemptedRedirect(true);
      // Small delay to ensure state is updated
      setTimeout(() => {
        navigate('/c/new', { replace: true });
      }, 500);
    }

    // Fallback: if signed in but backend sync is taking too long, redirect anyway
    if (isSignedIn && !backendSynced && !attemptedRedirect) {
      const timeout = setTimeout(() => {
        if (!attemptedRedirect) {
          console.warn('[ClerkCallback] Backend sync timeout, redirecting anyway');
          setAttemptedRedirect(true);
          navigate('/c/new', { replace: true });
        }
      }, 3000);

      return () => clearTimeout(timeout);
    }
  }, [isSignedIn, authLoaded, userLoaded, backendSynced, navigate, attemptedRedirect]);

  // Show loading state while Clerk processes the callback
  return (
    <div className="flex min-h-screen items-center justify-center bg-white dark:bg-gray-900">
      <div className="text-center">
        <div className="mb-4">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-600 border-r-transparent"></div>
        </div>
        <p className="text-lg text-gray-900 dark:text-white">Completing sign in...</p>
        {!authLoaded || !userLoaded ? (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Loading user information...</p>
        ) : isSignedIn ? (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Redirecting to app...</p>
        ) : null}
      </div>
    </div>
  );
}

