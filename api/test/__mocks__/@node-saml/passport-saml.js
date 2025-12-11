// Manual mock for @node-saml/passport-saml to avoid missing xml-crypto dependency
module.exports = {
  Strategy: jest.fn().mockImplementation(() => ({
    name: 'saml',
    authenticate: jest.fn(),
  })),
};
