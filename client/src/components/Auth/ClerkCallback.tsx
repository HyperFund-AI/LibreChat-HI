import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';

/**
 * Clerk SSO Callback Handler
 * This component handles Clerk's SSO callback and redirects to the app
 */
export default function ClerkCallback() {
  const { isSignedIn } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // Wait for Clerk to finish authentication
    if (isSignedIn) {
      // Redirect to the main app
      navigate('/c/new', { replace: true });
    }
  }, [isSignedIn, navigate]);

  // Show loading state while Clerk processes the callback
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <p className="text-lg">Completing sign in...</p>
      </div>
    </div>
  );
}

