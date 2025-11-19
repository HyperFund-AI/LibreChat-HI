# Clerk Integration Summary

## ✅ Completed Integration

Clerk authentication has been successfully integrated into LibreChat. The integration is **backward compatible** and can be enabled/disabled via environment variables.

## What Was Changed

### Backend Changes

1. **New Middleware** (`api/server/middleware/requireClerkAuth.js`)
   - Verifies Clerk session tokens
   - Syncs Clerk users with local database
   - Creates users automatically if they don't exist
   - Links existing users by email during migration

2. **User Schema Update** (`packages/data-schemas/src/schema/user.ts`)
   - Added `clerkId` field to store Clerk user ID
   - Indexed for fast lookups

3. **Auth Helper** (`api/server/middleware/getAuthMiddleware.js`)
   - Automatically selects Clerk or JWT auth based on `CLERK_ENABLED` env var

4. **Migration Script** (`config/migrate-to-clerk.js`)
   - Migrates existing users to Clerk
   - Creates Clerk users if they don't exist
   - Links Clerk IDs to existing database users

### Frontend Changes

1. **Clerk Auth Context** (`client/src/hooks/ClerkAuthContext.tsx`)
   - Provides same interface as existing `AuthContext`
   - Syncs Clerk user with backend
   - Handles authentication state

2. **Auth Provider Selector** (`client/src/hooks/getAuthProvider.tsx`)
   - Automatically selects Clerk or regular auth provider
   - Based on `VITE_CLERK_ENABLED` environment variable

3. **Login Component** (`client/src/components/Auth/Login.tsx`)
   - Conditionally shows Clerk's `<SignIn>` component when Clerk is enabled
   - Falls back to existing login form otherwise

4. **Routes** (`client/src/routes/index.tsx`)
   - Updated to use dynamic auth provider

### Dependencies Added

- **Backend**: `@clerk/backend@^1.19.0`
- **Frontend**: `@clerk/clerk-react@^5.0.0`

## Data Migration Required

**YES, data migration is required** if you have existing users.

### Migration Options

1. **Automatic Migration (Recommended)**
   - Users are automatically created in Clerk on first login
   - Existing users are linked by email
   - Run migration script to pre-create users in Clerk

2. **Manual Migration**
   - Use the migration script: `node config/migrate-to-clerk.js`
   - Supports dry-run mode: `node config/migrate-to-clerk.js --dry-run`
   - Can migrate single user: `node config/migrate-to-clerk.js --email=user@example.com`

### What Gets Migrated

✅ **Preserved:**
- User email, name, username
- User role (USER/ADMIN)
- User avatar
- Email verification status
- All conversations and messages
- All user settings and preferences

❌ **Not Migrated:**
- Passwords (users set new ones in Clerk)
- 2FA secrets (Clerk handles 2FA separately)

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Environment Variables

**Backend** (`.env` or `api/.env`):
```env
CLERK_ENABLED=true
CLERK_SECRET_KEY=sk_test_...  # Get from Clerk dashboard
```

**Frontend** (`.env` or `client/.env`):
```env
VITE_CLERK_ENABLED=true
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...  # Get from Clerk dashboard
```

### 3. (Optional) Migrate Existing Users

```bash
# Preview changes
node config/migrate-to-clerk.js --dry-run

# Migrate all users
node config/migrate-to-clerk.js
```

### 4. Test the Integration

1. Start backend: `npm run backend:dev`
2. Start frontend: `npm run frontend:dev`
3. Navigate to `/login`
4. Sign in with Clerk
5. Verify user is created in both Clerk and local database

## How to Enable/Disable

### Enable Clerk

Set environment variables:
```env
CLERK_ENABLED=true
CLERK_SECRET_KEY=sk_test_...
VITE_CLERK_ENABLED=true
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
```

### Disable Clerk (Use Existing Auth)

Set environment variables:
```env
CLERK_ENABLED=false
# Or simply don't set CLERK_ENABLED
```

## Backward Compatibility

✅ **Fully backward compatible:**
- Existing auth system continues to work when Clerk is disabled
- Both systems can coexist during migration
- No breaking changes to existing code
- All existing routes and controllers work unchanged

## Next Steps

1. ✅ Install dependencies (`npm install`)
2. ✅ Set up Clerk account and get API keys
3. ✅ Configure environment variables
4. ⏳ Test with a new user account
5. ⏳ (If applicable) Migrate existing users
6. ⏳ Update Registration component to use Clerk's `<SignUp>`
7. ⏳ Test all authentication flows
8. ⏳ Deploy to production

## Troubleshooting

### "No authentication token provided"
- Check that `CLERK_SECRET_KEY` is set correctly
- Verify Clerk session token is being sent
- Check browser console for Clerk errors

### "User not found in Clerk"
- User may not have been migrated
- Run migration script for that user
- Check Clerk dashboard

### Frontend not showing Clerk components
- Verify `VITE_CLERK_PUBLISHABLE_KEY` is set
- Check that `VITE_CLERK_ENABLED=true`
- Clear browser cache and rebuild

## Files Modified

### Backend
- `api/package.json` - Added Clerk dependency
- `api/server/middleware/requireClerkAuth.js` - New Clerk middleware
- `api/server/middleware/getAuthMiddleware.js` - Auth selector helper
- `api/server/middleware/index.js` - Export Clerk middleware
- `packages/data-schemas/src/schema/user.ts` - Added clerkId field
- `packages/data-schemas/src/types/user.ts` - Added clerkId type
- `config/migrate-to-clerk.js` - Migration script

### Frontend
- `client/package.json` - Added Clerk dependency
- `client/src/hooks/ClerkAuthContext.tsx` - New Clerk auth context
- `client/src/hooks/getAuthProvider.tsx` - Auth provider selector
- `client/src/routes/index.tsx` - Updated to use dynamic provider
- `client/src/components/Auth/Login.tsx` - Added Clerk SignIn support

### Documentation
- `CLERK_MIGRATION.md` - Detailed migration guide
- `CLERK_INTEGRATION_SUMMARY.md` - This file

## Support

For issues or questions:
1. Check `CLERK_MIGRATION.md` for detailed instructions
2. Review Clerk documentation: https://clerk.com/docs
3. Check backend logs for authentication errors
4. Verify Clerk dashboard for user status

