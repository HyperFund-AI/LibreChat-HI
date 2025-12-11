// api/test/__mocks__/openid-client-passport.js
let verifyCallback;

const Strategy = jest.fn().mockImplementation((options, verify) => {
  verifyCallback = verify;
  return { name: 'mocked-openid-passport-strategy', options, verify };
});

// Export a method to get the verify callback for testing
const __getVerifyCallback = () => verifyCallback;

module.exports = { Strategy, __getVerifyCallback };
