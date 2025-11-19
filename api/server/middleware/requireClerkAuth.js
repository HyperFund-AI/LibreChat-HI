const { clerkClient } = require('@clerk/backend');
const { logger } = require('@librechat/data-schemas');
const { getUserById, findUser, createUser, updateUser } = require('~/models');
const { SystemRoles } = require('librechat-data-provider');

// Validate Clerk configuration at module load (only warn, don't fail)
if (!process.env.CLERK_SECRET_KEY) {
  // Don't log warning at module load - it will be logged when middleware is actually used
}

/**
 * Clerk Authentication Middleware
 * Verifies Clerk session token and syncs user with local database
 */
const requireClerkAuth = async (req, res, next) => {
  try {
    // Check if Clerk is properly configured
    if (!process.env.CLERK_SECRET_KEY) {
      logger.error('[requireClerkAuth] CLERK_SECRET_KEY is not set. Cannot authenticate with Clerk.');
      return res.status(500).json({ message: 'Clerk authentication is not properly configured' });
    }

    // Get Clerk session token from Authorization header or cookie
    const authHeader = req.headers.authorization;
    // Clerk stores session token in __session cookie or Authorization header
    const sessionToken = authHeader?.replace('Bearer ', '') || req.cookies?.__session || req.cookies?.__clerk_db_jwt;

    if (!sessionToken) {
      return res.status(401).json({ message: 'No authentication token provided' });
    }

    // Verify the session token with Clerk
    const clerk = clerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const session = await clerk.sessions.verifyToken(sessionToken);

    if (!session || !session.userId) {
      return res.status(401).json({ message: 'Invalid or expired session' });
    }

    // Get user from Clerk
    const clerkUser = await clerk.users.getUser(session.userId);

    if (!clerkUser) {
      return res.status(401).json({ message: 'User not found in Clerk' });
    }

    // Get primary email address (Clerk may have multiple email addresses)
    const primaryEmail = clerkUser.emailAddresses?.find(email => email.id === clerkUser.primaryEmailAddressId)?.emailAddress 
                      || clerkUser.emailAddresses?.[0]?.emailAddress;

    // Find or create user in local database
    let user = await findUser({ clerkId: clerkUser.id });

    if (!user) {
      // Try to find by email for migration purposes
      if (primaryEmail) {
        user = await findUser({ email: primaryEmail });
      }

      if (user) {
        // Migrate existing user: add Clerk ID
        user = await updateUser(user._id.toString(), {
          clerkId: clerkUser.id,
          emailVerified: clerkUser.emailAddresses?.find(email => email.id === clerkUser.primaryEmailAddressId)?.verification?.status === 'verified' 
                      || clerkUser.emailAddresses?.[0]?.verification?.status === 'verified',
        });
      } else {
        // Create new user - handle OAuth providers
        const firstName = clerkUser.firstName || clerkUser.externalAccounts?.[0]?.firstName || '';
        const lastName = clerkUser.lastName || clerkUser.externalAccounts?.[0]?.lastName || '';
        const fullName = firstName && lastName ? `${firstName} ${lastName}` : (firstName || lastName || clerkUser.username || '');
        
        const userData = {
          clerkId: clerkUser.id,
          email: primaryEmail || '',
          name: fullName,
          username: clerkUser.username || primaryEmail?.split('@')[0] || '',
          avatar: clerkUser.imageUrl || clerkUser.externalAccounts?.[0]?.imageUrl || null,
          provider: 'clerk',
          emailVerified: clerkUser.emailAddresses?.find(email => email.id === clerkUser.primaryEmailAddressId)?.verification?.status === 'verified' 
                      || clerkUser.emailAddresses?.[0]?.verification?.status === 'verified',
          role: SystemRoles.USER,
        };

        // Check if this is the first user (make them admin)
        const { countUsers } = require('~/models');
        const userCount = await countUsers();
        if (userCount === 0) {
          userData.role = SystemRoles.ADMIN;
        }

        user = await createUser(userData);
      }
    } else {
      // Update user info from Clerk
      const primaryEmail = clerkUser.emailAddresses?.find(email => email.id === clerkUser.primaryEmailAddressId)?.emailAddress 
                        || clerkUser.emailAddresses?.[0]?.emailAddress;
      const firstName = clerkUser.firstName || clerkUser.externalAccounts?.[0]?.firstName || '';
      const lastName = clerkUser.lastName || clerkUser.externalAccounts?.[0]?.lastName || '';
      const fullName = firstName && lastName ? `${firstName} ${lastName}` : (firstName || lastName || user.name || '');
      
      const updateData = {
        email: primaryEmail || user.email,
        name: fullName || user.name || '',
        username: clerkUser.username || user.username || '',
        avatar: clerkUser.imageUrl || clerkUser.externalAccounts?.[0]?.imageUrl || user.avatar,
        emailVerified: clerkUser.emailAddresses?.find(email => email.id === clerkUser.primaryEmailAddressId)?.verification?.status === 'verified' 
                    || clerkUser.emailAddresses?.[0]?.verification?.status === 'verified',
      };

      user = await updateUser(user._id.toString(), updateData);
    }

    // Attach user to request object
    user.id = user._id.toString();
    req.user = user;
    req.clerkUser = clerkUser;
    req.clerkSession = session;

    next();
  } catch (error) {
    logger.error('[requireClerkAuth] Error:', error);
    return res.status(401).json({ message: 'Authentication failed' });
  }
};

/**
 * Optional Clerk Auth - doesn't fail if no token provided
 */
const optionalClerkAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken = authHeader?.replace('Bearer ', '') || req.cookies?.__session;

    if (sessionToken) {
      await requireClerkAuth(req, res, next);
    } else {
      next();
    }
  } catch (error) {
    // If auth fails, continue without user
    next();
  }
};

module.exports = requireClerkAuth;
module.exports.optionalClerkAuth = optionalClerkAuth;

