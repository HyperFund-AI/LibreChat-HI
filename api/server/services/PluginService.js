const { logger } = require('@librechat/data-schemas');
const { encrypt, decrypt } = require('@librechat/api');
const { findOnePluginAuth, updatePluginAuth, deletePluginAuth } = require('~/models');

/**
 * Asynchronously retrieves and decrypts the authentication value for a user's plugin, based on a specified authentication field.
 *
 * @param {string} userId - The unique identifier of the user for whom the plugin authentication value is to be retrieved.
 * @param {string} authField - The specific authentication field (e.g., 'API_KEY', 'URL') whose value is to be retrieved and decrypted.
 * @param {boolean} throwError - Whether to throw an error if the authentication value does not exist. Defaults to `true`.
 * @param {string} [pluginKey] - Optional plugin key to make the lookup more specific to a particular plugin.
 * @returns {Promise<string|null>} A promise that resolves to the decrypted authentication value if found, or `null` if no such authentication value exists for the given user and field.
 *
 * The function throws an error if it encounters any issue during the retrieval or decryption process, or if the authentication value does not exist.
 *
 * @example
 * // To get the decrypted value of the 'token' field for a user with userId '12345':
 * getUserPluginAuthValue('12345', 'token').then(value => {
 *   console.log(value);
 * }).catch(err => {
 *   console.error(err);
 * });
 *
 * @example
 * // To get the decrypted value of the 'API_KEY' field for a specific plugin:
 * getUserPluginAuthValue('12345', 'API_KEY', true, 'mcp-server-name').then(value => {
 *   console.log(value);
 * }).catch(err => {
 *   console.error(err);
 * });
 *
 * @throws {Error} Throws an error if there's an issue during the retrieval or decryption process, or if the authentication value does not exist.
 * @async
 */
const getUserPluginAuthValue = async (userId, authField, throwError = true, pluginKey) => {
  try {
    const searchParams = { userId, authField };
    if (pluginKey) {
      searchParams.pluginKey = pluginKey;
    }

    const pluginAuth = await findOnePluginAuth(searchParams);
    if (!pluginAuth) {
      const pluginInfo = pluginKey ? ` for plugin ${pluginKey}` : '';
      throw new Error(`No plugin auth ${authField} found for user ${userId}${pluginInfo}`);
    }

    const decryptedValue = await decrypt(pluginAuth.value);
    return decryptedValue;
  } catch (err) {
    if (!throwError) {
      return null;
    }
    logger.error('[getUserPluginAuthValue]', err);
    throw err;
  }
};

// const updateUserPluginAuth = async (userId, authField, pluginKey, value) => {
//   try {
//     const encryptedValue = encrypt(value);

//     const pluginAuth = await PluginAuth.findOneAndUpdate(
//       { userId, authField },
//       {
//         $set: {
//           value: encryptedValue,
//           pluginKey
//         }
//       },
//       {
//         new: true,
//         upsert: true
//       }
//     );

//     return pluginAuth;
//   } catch (err) {
//     logger.error('[getUserPluginAuthValue]', err);
//     return err;
//   }
// };

/**
 *
 * @async
 * @param {string} userId
 * @param {string} authField
 * @param {string} pluginKey
 * @param {string} value
 * @returns {Promise<IPluginAuth>}
 * @throws {Error}
 */
const updateUserPluginAuth = async (userId, authField, pluginKey, value) => {
  try {
    // Validate CREDS_KEY is properly configured before attempting encryption
    const credsKey = process.env.CREDS_KEY;
    if (!credsKey) {
      const error = new Error(
        'CREDS_KEY environment variable is not set. Please set CREDS_KEY to a 64-character hex string (generate with: openssl rand -hex 32)',
      );
      logger.error('[updateUserPluginAuth]', error);
      return error;
    }

    // Validate CREDS_KEY length (should be 64 hex characters = 32 bytes)
    const keyBuffer = Buffer.from(credsKey, 'hex');
    if (keyBuffer.length !== 32) {
      const error = new Error(
        `CREDS_KEY has invalid length: expected 64 hex characters (32 bytes), got ${credsKey.length} characters. ` +
          'Please generate a new key with: openssl rand -hex 32',
      );
      logger.error('[updateUserPluginAuth]', error);
      return error;
    }

    const encryptedValue = await encrypt(value);
    return await updatePluginAuth({
      userId,
      authField,
      pluginKey,
      value: encryptedValue,
    });
  } catch (err) {
    // Check if it's the specific "Invalid key length" error from encryption
    if (err.message && err.message.includes('Invalid key length')) {
      const error = new Error(
        'Encryption key configuration error: CREDS_KEY must be a 64-character hex string. ' +
          'Generate one with: openssl rand -hex 32',
      );
      logger.error('[updateUserPluginAuth]', error);
      return error;
    }
    logger.error('[updateUserPluginAuth]', err);
    return err;
  }
};

/**
 * @async
 * @param {string} userId
 * @param {string | null} authField - The specific authField to delete, or null if `all` is true.
 * @param {boolean} [all=false] - Whether to delete all auths for the user (or for a specific pluginKey if provided).
 * @param {string} [pluginKey] - Optional. If `all` is true and `pluginKey` is provided, delete all auths for this user and pluginKey.
 * @returns {Promise<import('mongoose').DeleteResult>}
 * @throws {Error}
 */
const deleteUserPluginAuth = async (userId, authField, all = false, pluginKey) => {
  try {
    return await deletePluginAuth({
      userId,
      authField,
      pluginKey,
      all,
    });
  } catch (err) {
    logger.error(
      `[deleteUserPluginAuth] Error deleting ${all ? 'all' : 'single'} auth(s) for userId: ${userId}${pluginKey ? ` and pluginKey: ${pluginKey}` : ''}`,
      err,
    );
    return err;
  }
};

module.exports = {
  getUserPluginAuthValue,
  updateUserPluginAuth,
  deleteUserPluginAuth,
};
