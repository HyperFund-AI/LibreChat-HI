# Clerk Authentication Migration Guide

This document explains how to migrate LibreChat from the existing Passport.js-based authentication system to Clerk.

## Overview

Clerk integration has been added to LibreChat with the following changes:

1. **Backend**: New Clerk middleware (`requireClerkAuth`) that verifies Clerk sessions and syncs users with the local database
2. **Frontend**: New Clerk-based auth context that works alongside the existing auth system
3. **Database**: Added `clerkId` field to user schema for linking Clerk users
4. **Migration Script**: Script to migrate existing users to Clerk

## Prerequisites

1. **Clerk Account**: Sign up at https://clerk.com and create an application
2. **Get API Keys**: 
   - `CLERK_SECRET_KEY` (backend)
   - `CLERK_PUBLISHABLE_KEY` (frontend)

## Migration Steps

### Step 1: Install Dependencies

```bash
npm install
```

This will install:
- `@clerk/backend` (backend)
- `@clerk/clerk-react` (frontend)

### Step 2: Configure Environment Variables

Add to your `.env` file:

**Backend (`api/.env` or root `.env`):**
```env
CLERK_ENABLED=true
CLERK_SECRET_KEY=sk_test_...
```

**Frontend (`client/.env` or root `.env`):**
```env
VITE_CLERK_ENABLED=true
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
```

### Step 3: Database Migration

The user schema has been updated to include a `clerkId` field. If you're using MongoDB, the schema will automatically update on next connection. No manual migration needed for the schema.

### Step 4: Migrate Existing Users (Optional)

If you have existing users, you can migrate them to Clerk:

```bash
# Dry run (preview changes)
node config/migrate-to-clerk.js --dry-run

# Migrate all users
node config/migrate-to-clerk.js

# Migrate single user
node config/migrate-to-clerk.js --email=user@example.com
```

**Important Notes:**
- The migration script creates users in Clerk if they don't exist
- It links existing database users to Clerk users by email
- Users without Clerk accounts will be created automatically
- **Back up your database before running migration**

### Step 5: Update Frontend Login Components

For Clerk, you'll want to replace the login form with Clerk's pre-built components. Update `client/src/components/Auth/Login.tsx`:

```tsx
import { SignIn } from '@clerk/clerk-react';

export default function Login() {
  const useClerk = import.meta.env.VITE_CLERK_ENABLED === 'true';
  
  if (useClerk) {
    return <SignIn routing="path" path="/login" />;
  }
  
  // Existing login form
  return <ExistingLoginForm />;
}
```

Similarly for registration:
```tsx
import { SignUp } from '@clerk/clerk-react';

export default function Registration() {
  const useClerk = import.meta.env.VITE_CLERK_ENABLED === 'true';
  
  if (useClerk) {
    return <SignUp routing="path" path="/register" />;
  }
  
  // Existing registration form
  return <ExistingRegistrationForm />;
}
```

### Step 6: Test the Integration

1. Start the backend: `npm run backend:dev`
2. Start the frontend: `npm run frontend:dev`
3. Navigate to `/login` - you should see Clerk's sign-in component
4. Create a test account or sign in
5. Verify that the user is created in both Clerk and your local database

## How It Works

### Backend Flow

1. Client sends request with Clerk session token (from `Authorization` header or `__session` cookie)
2. `requireClerkAuth` middleware:
   - Verifies token with Clerk API
   - Gets user info from Clerk
   - Finds or creates user in local database
   - Links Clerk user ID to local user
   - Attaches user to `req.user` (same format as existing auth)

### Frontend Flow

1. `ClerkAuthContextProvider` wraps the app with Clerk's `ClerkProvider`
2. Uses Clerk's `useUser()` and `useAuth()` hooks
3. Syncs Clerk user with backend on authentication
4. Provides same interface as existing `AuthContext` for compatibility

## Backward Compatibility

The integration is designed to work alongside the existing auth system:

- Set `CLERK_ENABLED=false` to use existing Passport.js auth
- Set `CLERK_ENABLED=true` to use Clerk auth
- Both systems can coexist during migration

## API Changes

### Authentication Middleware

Routes automatically use Clerk auth when `CLERK_ENABLED=true`:

```javascript
// Old way (still works)
router.get('/api/user', requireJwtAuth, getUserController);

// New way (automatic based on CLERK_ENABLED)
const { getAuthMiddleware } = require('~/server/middleware/getAuthMiddleware');
router.get('/api/user', getAuthMiddleware(), getUserController);
```

### User Object

The `req.user` object remains the same format, ensuring compatibility with existing controllers:

```javascript
{
  _id: ObjectId,
  id: "string",
  email: "user@example.com",
  name: "User Name",
  role: "USER" | "ADMIN",
  clerkId: "user_xxx", // New field
  // ... other fields
}
```

## Data Migration Considerations

### Required Migration

**Yes, data migration is required** if you have existing users:

1. **Existing Users**: Must be migrated to Clerk using the migration script
2. **User Data**: All user data (conversations, settings, etc.) is preserved
3. **Passwords**: Users will need to set new passwords in Clerk (or use passwordless auth)

### Migration Strategy

1. **Option A: Gradual Migration**
   - Keep both auth systems enabled
   - Migrate users in batches
   - Users can use either system during transition

2. **Option B: Full Cutover**
   - Migrate all users at once
   - Switch to Clerk-only
   - Disable old auth system

### What Gets Migrated

- ✅ User email, name, username
- ✅ User role (USER/ADMIN)
- ✅ User avatar
- ✅ Email verification status
- ✅ All conversations and messages
- ✅ All user settings and preferences
- ❌ Passwords (users set new ones in Clerk)
- ❌ 2FA secrets (Clerk handles 2FA)

## Troubleshooting

### "No authentication token provided"

- Check that `CLERK_SECRET_KEY` is set correctly
- Verify Clerk session token is being sent in requests
- Check browser console for Clerk initialization errors

### "User not found in Clerk"

- User may not have been migrated
- Run migration script for that user
- Check Clerk dashboard to verify user exists

### Frontend not showing Clerk components

- Verify `VITE_CLERK_PUBLISHABLE_KEY` is set
- Check that `VITE_CLERK_ENABLED=true`
- Clear browser cache and rebuild frontend

### Users can't log in

- Check Clerk dashboard for user status
- Verify email verification if required
- Check backend logs for authentication errors

## Rollback Plan

If you need to rollback to the old auth system:

1. Set `CLERK_ENABLED=false` in environment
2. Remove Clerk environment variables
3. Restart backend and frontend
4. Users can continue using existing auth

**Note**: Users migrated to Clerk will need to use Clerk to sign in. To fully rollback, you'd need to:
- Remove `clerkId` from user records
- Have users reset passwords in the old system

## Next Steps

1. ✅ Install dependencies
2. ✅ Set environment variables
3. ✅ Test with a new user
4. ⏳ Migrate existing users (if applicable)
5. ⏳ Update login/registration UI components
6. ⏳ Test all authentication flows
7. ⏳ Deploy to production

## Support

For issues:
- Check Clerk documentation: https://clerk.com/docs
- Review backend logs for authentication errors
- Check Clerk dashboard for user status

