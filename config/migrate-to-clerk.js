/**
 * Migration Script: Migrate existing users to Clerk
 * 
 * This script helps migrate existing users to Clerk by:
 * 1. Creating users in Clerk (if not already exists)
 * 2. Linking Clerk user IDs to existing database users
 * 
 * IMPORTANT: Before running this script:
 * 1. Set up Clerk account and get CLERK_SECRET_KEY
 * 2. Back up your database
 * 3. Test with a single user first
 * 
 * Usage:
 *   node config/migrate-to-clerk.js --dry-run  # Preview changes
 *   node config/migrate-to-clerk.js             # Run migration
 *   node config/migrate-to-clerk.js --email=user@example.com  # Migrate single user
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { clerkClient } = require('@clerk/backend');
const { logger } = require('@librechat/data-schemas');
const { findUser, updateUser, getAllUsers } = require('../api/models');
const { connectDB } = require('../api/db');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const emailFilter = args.find(arg => arg.startsWith('--email='))?.split('=')[1];

async function migrateUserToClerk(user, clerk) {
  try {
    // Skip if user already has Clerk ID
    if (user.clerkId) {
      logger.info(`[migrate-to-clerk] User ${user.email} already has Clerk ID: ${user.clerkId}`);
      return { skipped: true, reason: 'Already has Clerk ID' };
    }

    // Check if user exists in Clerk by email
    const clerkUsers = await clerk.users.getUserList({
      emailAddress: [user.email],
    });

    let clerkUser;
    if (clerkUsers.data.length > 0) {
      // User exists in Clerk, link them
      clerkUser = clerkUsers.data[0];
      logger.info(`[migrate-to-clerk] Found existing Clerk user for ${user.email}: ${clerkUser.id}`);
    } else {
      // Create user in Clerk
      if (isDryRun) {
        logger.info(`[migrate-to-clerk] [DRY RUN] Would create Clerk user for ${user.email}`);
        return { wouldCreate: true };
      }

      const userData = {
        emailAddress: [user.email],
        firstName: user.name || user.username || undefined,
        username: user.username || undefined,
        publicMetadata: {
          librechatUserId: user._id.toString(),
          migratedFrom: 'librechat',
        },
      };

      clerkUser = await clerk.users.createUser(userData);
      logger.info(`[migrate-to-clerk] Created Clerk user for ${user.email}: ${clerkUser.id}`);
    }

    // Update local user with Clerk ID
    if (!isDryRun) {
      await updateUser(user._id.toString(), {
        clerkId: clerkUser.id,
        emailVerified: clerkUser.emailAddresses?.[0]?.verification?.status === 'verified',
      });
      logger.info(`[migrate-to-clerk] Linked Clerk ID ${clerkUser.id} to user ${user.email}`);
    }

    return { success: true, clerkId: clerkUser.id };
  } catch (error) {
    logger.error(`[migrate-to-clerk] Error migrating user ${user.email}:`, error);
    return { error: error.message };
  }
}

async function main() {
  try {
    // Check for Clerk secret key
    if (!process.env.CLERK_SECRET_KEY) {
      logger.error('[migrate-to-clerk] CLERK_SECRET_KEY environment variable is required');
      process.exit(1);
    }

    // Connect to database
    await connectDB();
    logger.info('[migrate-to-clerk] Connected to database');

    // Initialize Clerk client
    const clerk = clerkClient();

    // Get users to migrate
    let users;
    if (emailFilter) {
      const user = await findUser({ email: emailFilter });
      users = user ? [user] : [];
    } else {
      users = await getAllUsers();
    }

    logger.info(`[migrate-to-clerk] Found ${users.length} users to migrate`);
    if (isDryRun) {
      logger.info('[migrate-to-clerk] DRY RUN MODE - No changes will be made');
    }

    const results = {
      total: users.length,
      success: 0,
      skipped: 0,
      errors: 0,
    };

    // Migrate each user
    for (const user of users) {
      const result = await migrateUserToClerk(user, clerk);
      
      if (result.success) {
        results.success++;
      } else if (result.skipped) {
        results.skipped++;
      } else if (result.error) {
        results.errors++;
      } else if (result.wouldCreate) {
        results.success++; // Count as success in dry run
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info('[migrate-to-clerk] Migration complete:', results);
    
    if (isDryRun) {
      logger.info('[migrate-to-clerk] This was a dry run. Run without --dry-run to apply changes.');
    }

    process.exit(0);
  } catch (error) {
    logger.error('[migrate-to-clerk] Fatal error:', error);
    process.exit(1);
  }
}

main();

