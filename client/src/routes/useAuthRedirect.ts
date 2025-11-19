import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '~/hooks';

export default function useAuthRedirect() {
  const { user, isAuthenticated } = useAuthContext();
  const navigate = useNavigate();
  const [hasChecked, setHasChecked] = useState(false);

  useEffect(() => {
    // Give Clerk time to sync with backend before redirecting
    const timeout = setTimeout(() => {
      setHasChecked(true);
      if (!isAuthenticated) {
        navigate('/login', { replace: true });
      }
    }, 1000); // Increased timeout to allow backend sync

    return () => {
      clearTimeout(timeout);
    };
  }, [isAuthenticated, navigate]);

  return {
    user,
    isAuthenticated: hasChecked ? isAuthenticated : true, // Don't redirect until we've checked
  };
}
