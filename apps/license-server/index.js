// @asynx6/license-server — public facade (ARCHITECTURE rule 4).
export { LicenseStore, createLicenseKey, verifyLicenseKey } from './src/store.js';
export { makeLicenseApi } from './src/api.js';
export { startLicenseServer } from './src/server.js';